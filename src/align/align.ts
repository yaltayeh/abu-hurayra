// Alignment of a recitation transcript to the Quran text. Design and costs: docs/alignment.md.
//
// A beam search (Viterbi with at most `beam` hypotheses per ASR word) over states (j, e):
//   j = index in the matching sequence of the last Quran word consumed (-1 before the first anchor),
//   e = number of recent unmatched ASR words (capped at `lostAfter`; "lost" paths may re-anchor anywhere).
// Moves per ASR word: next word / skip 1-3 / extra ASR word / split (يا + أيها) / merge / backward jump inside the
// current or previous ayah / passage jump anywhere (only at the start, after a completed ayah + pause, or when lost).
import { normalize, normalizeLoose } from "../normalize.ts";
import { triKey, type QuranIndex } from "./quran-index.ts";
import {
  DEFAULT_CONFIG,
  type AlignConfig,
  type AlignResult,
  type AsrGroup,
  type AyahEvent,
  type BasmalaGap,
  type JumpEvent,
  type Occurrence,
  type Rejection,
} from "./types.ts";

const OP_START = 0, OP_MATCH = 1, OP_EXTRA = 2, OP_SPLIT = 3, OP_MERGE = 4, OP_BACK = 5, OP_JUMP = 6;
const BONUS = 0.02; // an exact match is slightly better than 0: of two explanations with equal cost, the one that matches more words wins
const PRUNE = 10; // drop hypotheses this much worse than the best one

type Node = { j: number; e: number; cost: number; prev: Node | null; op: number; a: number; skipped: number; na: number };

type Asr = {
  m: number; // words in the DP (non-empty after normalization)
  str: string[];
  sid: Int32Array; // strict interned id or -1
  lid: Int32Array;
  start: Float64Array;
  end: Float64Array;
  group: Int32Array;
  orig: Int32Array; // flat index over ALL words
  pause: Uint8Array;
  gapAllow: Int32Array; // extra skippable Quran words because an unrecognized span lies before this word
  text: string[];
};

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Int32Array(n + 1), cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const c = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const d = prev[j] + 1 < cur[j - 1] + 1 ? prev[j] + 1 : cur[j - 1] + 1;
      cur[j] = c < d ? c : d;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const similarity = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

export function alignTranscript(idx: QuranIndex, groups: readonly AsrGroup[], partial: Partial<AlignConfig> = {}): AlignResult {
  const t0 = performance.now();
  const cfg: AlignConfig = { ...DEFAULT_CONFIG, ...partial, cost: { ...DEFAULT_CONFIG.cost, ...partial.cost } };
  const C = cfg.cost;
  const N = idx.n;

  // ---------- flatten the ASR words ----------
  type Flat = { text: string; start: number; end: number; group: number };
  const flat: Flat[] = [];
  const breaksAll: number[] = [];
  const unrec: { start: number; end: number }[] = [];
  groups.forEach((g, gi) => {
    for (const w of g.words) flat.push({ text: w.text.trim(), start: w.start, end: w.end, group: gi });
    for (const b of g.breaks ?? []) breaksAll.push(b);
    for (const u of g.unrecognized ?? []) unrec.push(u);
  });
  breaksAll.sort((x, y) => x - y);
  const A: Asr = {
    m: 0, str: [], sid: new Int32Array(flat.length), lid: new Int32Array(flat.length), start: new Float64Array(flat.length),
    end: new Float64Array(flat.length), group: new Int32Array(flat.length), orig: new Int32Array(flat.length),
    pause: new Uint8Array(flat.length), gapAllow: new Int32Array(flat.length), text: [],
  };
  const dropped: number[] = []; // orig indexes of words that normalize to nothing
  let prevEnd = 0, prevGroup = -1, bp = 0;
  flat.forEach((w, o) => {
    const s = normalize(w.text);
    if (!s) {
      dropped.push(o);
      return;
    }
    const i = A.m++;
    A.str.push(s);
    A.text.push(w.text);
    A.sid[i] = idx.strictId.get(s) ?? -1;
    A.lid[i] = idx.looseId.get(normalizeLoose(w.text)) ?? -1;
    A.start[i] = w.start;
    A.end[i] = w.end;
    A.group[i] = w.group;
    A.orig[i] = o;
    // pause before this word: group boundary, a silence boundary inside the group, or a real gap
    let pause = i === 0 || w.group !== prevGroup || w.start - prevEnd >= cfg.pauseGap;
    while (bp < breaksAll.length && breaksAll[bp] < prevEnd - 0.2) bp++;
    if (!pause && bp < breaksAll.length && breaksAll[bp] <= w.start + 0.2) pause = true;
    A.pause[i] = pause ? 1 : 0;
    let gapSec = 0;
    for (const u of unrec) gapSec += Math.max(0, Math.min(u.end, w.start) - Math.max(u.start, i === 0 ? 0 : prevEnd));
    A.gapAllow[i] = Math.floor(gapSec * cfg.wordsPerSecond);
    prevEnd = w.end;
    prevGroup = w.group;
  });
  const m = A.m;
  const emptyResult = (): AlignResult => ({
    occurrences: flat.map((w, o) => ({ kind: "extra", wordId: null, textIndex: null, surah: null, ayah: null, word: null, entry: null, start: w.start, end: w.end, confidence: 0, asr: [o], group: w.group, text: w.text })),
    ayahs: [], jumps: [], rejections: [], accepted: false, alternatives: [], basmalaGaps: [],
    stats: { asrWords: flat.length, quranWordsMatched: 0, substituted: 0, inferred: 0, extra: flat.length, ayahsCompleted: 0, cost: 0, ms: 0, cells: 0 },
  });
  if (m < 3) return emptyResult();

  // ---------- match cost ----------
  const memo = new Map<number, number>();
  const uniq = new Map<string, number>();
  const uid = new Int32Array(m);
  for (let i = 0; i < m; i++) uid[i] = uniq.get(A.str[i]) ?? (uniq.set(A.str[i], uniq.size), uniq.size - 1);
  let kind = 0; // 0 strict equal, 1 loose equal, 2 near (similar), 3 different
  let simOut = 1;
  const V = idx.strictStr.length;
  function matchCost(i: number, q: number): number {
    if (A.sid[i] >= 0 && A.sid[i] === idx.strict[q]) { kind = 0; simOut = 1; return -BONUS; }
    if (A.lid[i] >= 0 && A.lid[i] === idx.loose[q]) { kind = 1; simOut = 0.95; return C.loose - BONUS; }
    const key = uid[i] * V + idx.strict[q];
    let s = memo.get(key);
    if (s === undefined) memo.set(key, (s = similarity(A.str[i], idx.strictStr[idx.strict[q]])));
    simOut = s;
    if (s >= 0.6) { kind = 2; return 0.2 + (1 - s) * 1.2; }
    kind = 3;
    return C.substituted;
  }

  // ---------- anchor candidates ("seeds") ----------
  type Seed = { q: number; pen: number; look: number; split?: boolean };
  function seedsAt(i: number): Seed[] {
    const best = new Map<number, number>();
    const splitAt = new Map<number, number>();
    for (const tier of [0, 1]) {
      const ids = tier === 0 ? A.sid : A.lid;
      const map = tier === 0 ? idx.triStrict : idx.triLoose;
      for (let o = 0; o <= 2; o++) {
        if (i + o + 2 >= m) continue;
        const a = ids[i + o], b = ids[i + o + 1], c = ids[i + o + 2];
        if (a < 0 || b < 0 || c < 0) continue;
        const list = map.get(triKey(a, b, c));
        if (!list) continue;
        const pen = (tier === 1 ? 0.3 : 0) + 0.1 * o;
        const lim = Math.min(list.length, 4000);
        for (let k = 0; k < lim; k++) {
          const q = list[k] - o;
          if (q < 0) continue;
          const old = best.get(q);
          if (old === undefined || pen < old) best.set(q, pen);
        }
      }
    }
    // ASR splits one Quran word in two (يا + أيها): a window whose first token is the concatenation of words i and i+1
    if (i + 3 < m) {
      const cat = idx.strictId.get(A.str[i] + A.str[i + 1]);
      if (cat !== undefined && A.sid[i + 2] >= 0 && A.sid[i + 3] >= 0) {
        const list = idx.triStrict.get(triKey(cat, A.sid[i + 2], A.sid[i + 3]));
        if (list) for (const p of list.slice(0, 4000)) splitAt.set(p, 0.1);
      }
    }
    const seeds: Seed[] = [];
    for (const [q, pen] of splitAt) {
      let look = 0;
      for (let t = 1; t <= 5 && i + 1 + t < m && q + t < N; t++) if (A.sid[i + 1 + t] === idx.strict[q + t] || A.lid[i + 1 + t] === idx.loose[q + t]) look++;
      seeds.push({ q, pen, look: look + 1, split: true });
    }
    for (const [q, pen] of best) {
      let look = 0;
      for (let t = 1; t <= 6 && i + t < m && q + t < N; t++) if (A.sid[i + t] === idx.strict[q + t] || A.lid[i + t] === idx.loose[q + t]) look++;
      seeds.push({ q, pen, look });
    }
    seeds.sort((x, y) => y.look - x.look || x.pen - y.pen || x.q - y.q);
    return seeds.length > cfg.seeds ? seeds.slice(0, cfg.seeds) : seeds;
  }

  // ---------- beam search ----------
  const LOST = cfg.lostAfter;
  const layers: Map<number, Node>[] = Array.from({ length: m + 2 }, () => new Map());
  const keyOf = (j: number, e: number) => (j + 1) * 8 + e;
  let cells = 0;
  const push = (L: number, j: number, e: number, cost: number, prev: Node, op: number, a: number, skipped = 0, na = 1) => {
    const k = keyOf(j, e);
    const old = layers[L].get(k);
    if (old === undefined || cost < old.cost) layers[L].set(k, { j, e, cost, prev, op, a, skipped, na });
  };
  layers[0].set(keyOf(-1, LOST), { j: -1, e: LOST, cost: 0, prev: null, op: OP_START, a: 0, skipped: 0, na: 0 });
  const completeAyah = (j: number) => idx.ayahLast[idx.ayahId[j]] - j <= 1;

  for (let i = 0; i < m; i++) {
    let nodes = [...layers[i].values()].sort((x, y) => x.cost - y.cost || x.j - y.j);
    layers[i].clear();
    if (nodes.length === 0) break;
    const bestCost = nodes[0].cost;
    nodes = nodes.filter((n) => n.cost <= bestCost + PRUNE).slice(0, cfg.beam);
    const allow = cfg.maxSkip + A.gapAllow[i];
    let jumpFrom: Node | null = null;
    for (const n of nodes) {
      cells++;
      // extra ASR word
      push(i + 1, n.j, Math.min(n.e + 1, LOST), n.cost + C.extra, n, OP_EXTRA, i);
      if (n.j >= 0) {
        // next word, skipping up to `allow` Quran words (basmala words are cheap to skip)
        let skipCost = 0, skippedReal = 0, skippedAll = 0;
        for (let q = n.j + 1; q < N; q++) {
          const c = matchCost(i, q);
          if (skippedAll === 0 || kind <= 2) push(i + 1, q, kind <= 2 ? 0 : Math.min(n.e + 1, LOST), n.cost + skipCost + c, n, OP_MATCH, i, skippedAll);
          if (skippedAll > 0 && i + 1 < m && A.str[i] + A.str[i + 1] === idx.strictStr[idx.strict[q]]) push(i + 2, q, 0, n.cost + skipCost + 0.25, n, OP_SPLIT, i, skippedAll);
          if (idx.skippableBasmala[q]) skipCost += C.skipBasmala;
          else {
            skippedReal++;
            if (skippedReal > allow) break;
            skipCost += skippedReal <= A.gapAllow[i] ? C.skipInGap : C.skip; // words missing inside an unrecognized span are expected
          }
          skippedAll++;
        }
        // split: two ASR words are one Quran word; merge: one ASR word is two Quran words
        if (i + 1 < m && n.j + 1 < N) {
          const q = n.j + 1;
          const cat = A.str[i] + A.str[i + 1];
          const t = idx.strictStr[idx.strict[q]];
          const s = cat === t ? 1 : similarity(cat, t);
          if (s >= 0.85) push(i + 2, q, 0, n.cost + (s === 1 ? 0.25 : 0.3 + (1 - s) * 1.5), n, OP_SPLIT, i);
        }
        if (n.j + 2 < N) {
          const cat = idx.strictStr[idx.strict[n.j + 1]] + idx.strictStr[idx.strict[n.j + 2]];
          const s = cat === A.str[i] ? 1 : similarity(cat, A.str[i]);
          if (s >= 0.85) push(i + 1, n.j + 2, 0, n.cost + (s === 1 ? 0.25 : 0.3 + (1 - s) * 1.5), n, OP_MERGE, i);
        }
        // backward jump: restart inside the current or the previous ayah of the same surah
        const ay = idx.ayahId[n.j];
        let lo = idx.ayahFirst[ay];
        if (ay > 0 && idx.surah[idx.ayahFirst[ay - 1]] === idx.surah[n.j]) lo = idx.ayahFirst[ay - 1];
        for (let t = lo; t <= n.j; t++) {
          const pen = t === idx.ayahFirst[idx.ayahId[t]] ? 0 : 0.1; // repeating a whole ayah is more likely than restarting mid-ayah
          if (A.sid[i] >= 0 && A.sid[i] === idx.strict[t]) push(i + 1, t, 0, n.cost + C.back + pen, n, OP_BACK, i);
          else if (A.lid[i] >= 0 && A.lid[i] === idx.loose[t]) push(i + 1, t, 0, n.cost + C.back + pen + C.loose, n, OP_BACK, i);
        }
      }
      // passage jump allowed: at the start, when lost, or after a completed ayah and a pause
      if (cfg.passageJumps || n.j < 0) {
        const ok = n.j < 0 || n.e >= LOST || (A.pause[i] === 1 && completeAyah(n.j) && n.e <= 1);
        if (ok && (jumpFrom === null || n.cost < jumpFrom.cost)) jumpFrom = n;
      }
    }
    if (jumpFrom) {
      for (const s of seedsAt(i)) {
        if (jumpFrom.j >= 0 && s.q === jumpFrom.j + 1) continue; // that is the normal next word
        if (s.split) {
          push(i + 2, s.q, 0, jumpFrom.cost + C.jump + s.pen + 0.25, jumpFrom, OP_JUMP, i, 0, 2);
          continue;
        }
        const c = matchCost(i, s.q);
        push(i + 1, s.q, kind <= 2 ? 0 : 1, jumpFrom.cost + C.jump + s.pen + c, jumpFrom, OP_JUMP, i);
      }
    }
  }
  const finals = [...layers[m].values()].sort((x, y) => x.cost - y.cost || x.j - y.j);
  if (finals.length === 0) return emptyResult();
  const best = finals[0];

  // ---------- ambiguity: different anchors with (almost) the same cost ----------
  const rootOf = (n: Node): number => {
    let r = -1;
    for (let p: Node | null = n; p; p = p.prev) if (p.op === OP_JUMP) r = p.j;
    return r;
  };
  const bestRoot = rootOf(best);
  const altRoots = new Set<number>();
  for (const f of finals) if (f.cost <= best.cost + cfg.ambiguityMargin && rootOf(f) !== bestRoot) altRoots.add(rootOf(f));
  const alternatives = [...altRoots].slice(0, 20).map((q) => idx.label(q));
  const ambiguous = alternatives.length > 0;

  // ---------- trace back ----------
  const chain: Node[] = [];
  for (let n: Node | null = best; n && n.op !== OP_START; n = n.prev) chain.push(n);
  chain.reverse();

  type Item = { j: number; kind: Occurrence["kind"]; conf: number; asr: number[]; op: number; inferred: boolean; split?: boolean; merged?: boolean; half?: 0 | 1; repeat?: boolean; from: Node | null; asrFirst: number };
  const items: (Item | { extra: number })[] = [];
  const quality = (i: number, q: number): { kind: Occurrence["kind"]; conf: number } => {
    matchCost(i, q);
    if (kind === 0) return { kind: "matched", conf: 1 };
    if (kind === 1) return { kind: "matched", conf: 0.9 };
    return { kind: "substituted", conf: kind === 2 ? 0.3 + 0.4 * simOut : 0.3 };
  };
  let reached = -1; // furthest matching-sequence entry recited so far in the current passage
  for (const n of chain) {
    if (n.op === OP_EXTRA) { items.push({ extra: n.a }); continue; }
    if (n.op === OP_JUMP) reached = n.j - 1;
    if (n.op === OP_MATCH || n.op === OP_SPLIT) for (let s = n.skipped; s > 0; s--) items.push({ j: n.j - s, kind: "inferred", conf: 0.3, asr: [], op: OP_MATCH, inferred: true, from: null, asrFirst: n.a });
    if (n.op === OP_MERGE) {
      [n.j - 1, n.j].forEach((q, h) => items.push({ j: q, kind: "matched", conf: 0.9, asr: [n.a], op: OP_MERGE, inferred: false, merged: true, half: h as 0 | 1, from: n.prev, asrFirst: n.a }));
      continue;
    }
    if (n.op === OP_JUMP && n.na === 2) {
      items.push({ j: n.j, kind: "matched", conf: 0.9, asr: [n.a, n.a + 1], op: n.op, inferred: false, split: true, from: n.prev, asrFirst: n.a });
      reached = Math.max(reached, n.j);
      continue;
    }
    const q = quality(n.a, n.j);
    const rep = n.j <= reached && n.op !== OP_JUMP;
    reached = Math.max(reached, n.j);
    if (n.op === OP_SPLIT) {
      items.push({ j: n.j, kind: "matched", conf: 0.9, asr: [n.a, n.a + 1], op: n.op, inferred: false, split: true, repeat: rep, from: n.prev, asrFirst: n.a });
      continue;
    }
    items.push({ j: n.j, kind: q.kind, conf: q.conf, asr: [n.a], op: n.op, inferred: false, repeat: rep, from: n.prev, asrFirst: n.a });
  }

  // ---------- occurrences with times ----------
  const flatOf = (i: number) => A.orig[i];
  const occ: Occurrence[] = [];
  const entryOf: number[] = []; // matching-sequence entry per occurrence (-1 for extra)
  const mk = (q: number, p: Partial<Occurrence> & Pick<Occurrence, "kind" | "start" | "end" | "confidence" | "asr" | "group">): Occurrence => ({
    wordId: idx.coreId[q], textIndex: idx.textIndex[q], surah: idx.surah[q], ayah: idx.ayah[q], word: idx.pos[q], entry: q, ...p,
    ...(idx.isBasmala[q] ? { basmala: true } : {}),
  });
  for (const it of items) {
    if ("extra" in it) {
      const i = it.extra;
      occ.push({ kind: "extra", wordId: null, textIndex: null, surah: null, ayah: null, word: null, entry: null, start: A.start[i], end: A.end[i], confidence: 0, asr: [flatOf(i)], group: A.group[i], text: A.text[i] });
      entryOf.push(-1);
    } else if (it.inferred) {
      occ.push(mk(it.j, { kind: "inferred", start: NaN, end: NaN, confidence: it.conf, asr: [], group: A.group[it.asrFirst] }));
      entryOf.push(it.j);
    } else if (it.merged) {
      // one ASR word spans two Quran words: split its time by letter count
      const i = it.asr[0];

      const first = it.half === 0;
      const wFirst = Math.max(1, idx.letters[first ? it.j : it.j - 1]), wSecond = Math.max(1, idx.letters[first ? it.j + 1 : it.j]);
      const cut = A.start[i] + ((A.end[i] - A.start[i]) * wFirst) / (wFirst + wSecond);
      occ.push(mk(it.j, { kind: "matched", start: first ? A.start[i] : cut, end: first ? cut : A.end[i], confidence: it.conf, asr: [flatOf(i)], group: A.group[i], merged: true }));
      entryOf.push(it.j);
    } else {
      const a0 = it.asr[0], a1 = it.asr[it.asr.length - 1];
      const o = mk(it.j, { kind: it.kind, start: A.start[a0], end: A.end[a1], confidence: it.conf, asr: it.asr.map(flatOf), group: A.group[a0] });
      if (it.split) o.split = true;
      if (it.op === OP_BACK || it.repeat) o.repeat = true;
      occ.push(o);
      entryOf.push(it.j);
    }
  }
  // inferred words: times inside the gap between the neighbours, proportional to letter count
  for (let k = 0; k < occ.length; k++) {
    if (occ[k].kind !== "inferred" || !Number.isNaN(occ[k].start)) continue;
    let a = k;
    while (a > 0 && (occ[a - 1].kind === "inferred" || occ[a - 1].kind === "extra")) a--;
    let b = k;
    while (b < occ.length && (occ[b].kind === "inferred" || occ[b].kind === "extra")) b++;
    const prevO = a > 0 ? occ[a - 1] : null, nextO = b < occ.length ? occ[b] : null;
    const run: number[] = [];
    for (let r = a; r < b; r++) if (occ[r].kind === "inferred") run.push(r);
    const cnt = run.length;
    let from = prevO ? prevO.end : nextO ? nextO.start : 0, to = nextO ? nextO.start : from;
    const need = 0.12 * cnt;
    if (to - from < need) {
      // contiguous ASR words leave no gap: borrow a little time from the neighbours (at most 35 % of their duration)
      const deficit = need - (to - from);
      const gp = prevO ? Math.min(deficit / 2, (prevO.end - prevO.start) * 0.35) : 0;
      const gn = nextO ? Math.min(deficit - gp, (nextO.end - nextO.start) * 0.35) : 0;
      if (prevO) prevO.end -= gp;
      if (nextO) nextO.start += gn;
      from -= gp;
      to += gn;
    }
    const total = run.reduce((s, r) => s + Math.max(1, idx.letters[entryOf[r]]), 0);
    let t = from;
    for (const r of run) {
      const d = ((to - from) * Math.max(1, idx.letters[entryOf[r]])) / total;
      occ[r].start = t;
      occ[r].end = t + d;
      t += d;
    }
  }
  if (ambiguous) for (const o of occ) if (o.kind !== "extra") { o.confidence *= 0.5; o.ambiguous = true; }

  // ---------- jumps ----------
  const jumps: JumpEvent[] = [];
  const firstOcc = new Map<Node, number>();
  {
    let k = 0;
    for (const n of chain) {
      if (n.op === OP_EXTRA) { k++; continue; }
      if (n.op === OP_MATCH || n.op === OP_SPLIT) k += n.skipped;
      if (n.op === OP_MERGE) { firstOcc.set(n, k); k += 2; continue; }
      firstOcc.set(n, k);
      k++;
    }
  }
  const labelOf = (j: number) => `${idx.surah[j]}:${idx.ayah[j]}:${idx.pos[j]}`;
  for (const n of chain) {
    if (n.op !== OP_JUMP && n.op !== OP_BACK) continue;
    const k = firstOcc.get(n) ?? 0;
    const from = n.prev && n.prev.j >= 0 ? labelOf(n.prev.j) : null;
    const time = occ[Math.min(k, occ.length - 1)]?.start ?? 0;
    if (n.op === OP_BACK) {
      jumps.push({ type: "repeat", time, asrIndex: A.orig[n.a], from, to: labelOf(n.j), reason: "restarted inside the current/previous ayah" });
      continue;
    }
    let type: JumpEvent["type"] = "passage", reason = "after a completed ayah and a pause";
    let skipped: string[] | undefined;
    if (!n.prev || n.prev.j < 0) {
      type = "start";
      reason = "anchor at the start of the file";
    } else if (n.prev.e >= LOST) {
      type = "reanchor";
      reason = `path lost (${LOST} unmatched words), re-anchored`;
    } else if (idx.surah[n.j] === idx.surah[n.prev.j] && idx.ayahId[n.j] > idx.ayahId[n.prev.j]) {
      type = "skip-forward";
      skipped = [];
      for (let a = idx.ayahId[n.prev.j] + 1; a < idx.ayahId[n.j]; a++) skipped.push(`${idx.surah[idx.ayahFirst[a]]}:${idx.ayah[idx.ayahFirst[a]]}`);
      reason = skipped.length ? "forward past ayahs that were not recited" : "continued at the next ayah after a pause";
    }
    if (type === "skip-forward" && skipped && skipped.length === 0) type = "passage";
    jumps.push({ type, time, asrIndex: A.orig[n.a], from, to: labelOf(n.j), ...(skipped ? { skippedAyahs: skipped } : {}), reason });
    if (type !== "start" && occ[k]) occ[k].jump = type === "skip-forward" || type === "reanchor" ? type : "passage";
  }

  // words that normalize to nothing are extras too; merge them in by original index
  if (dropped.length) {
    const key = (o: Occurrence, k: number) => (o.asr.length ? o.asr[0] : (() => { for (let r = k + 1; r < occ.length; r++) if (occ[r].asr.length) return occ[r].asr[0] - 0.5; return Infinity; })());
    const withKey = occ.map((o, k) => ({ o, k, e: entryOf[k], key: key(o, k) }));
    for (const o of dropped) withKey.push({ o: { kind: "extra", wordId: null, textIndex: null, surah: null, ayah: null, word: null, entry: null, start: flat[o].start, end: flat[o].end, confidence: 0, asr: [o], group: flat[o].group, text: flat[o].text }, k: -1, e: -1, key: o });
    withKey.sort((x, y) => x.key - y.key || x.k - y.k);
    occ.length = 0;
    entryOf.length = 0;
    for (const w of withKey) { occ.push(w.o); entryOf.push(w.e); }
  }
  const ayahs = ayahEvents(idx, occ);
  const basmalaGaps = findBasmalaGaps(idx, occ);

  // ---------- rejection: matched ratio too low in a window ----------
  const okAsr = new Uint8Array(m);
  {
    const pos = new Map<number, number>();
    A.orig.forEach((o, i) => pos.set(o, i));
    for (const o of occ) if ((o.kind === "matched" || (o.kind === "substituted" && o.confidence >= 0.62)) && o.asr.length) for (const f of o.asr) { const i = pos.get(f); if (i !== undefined) okAsr[i] = 1; }
  }
  const rejections: Rejection[] = [];
  {
    const W = Math.min(cfg.window, m);
    const bad = new Uint8Array(m);
    let sum = 0;
    for (let i = 0; i < m; i++) {
      sum += okAsr[i];
      if (i >= W) sum -= okAsr[i - W];
      if (i >= W - 1 && sum / W < cfg.minRatio) for (let t = i - W + 1; t <= i; t++) bad[t] = 1;
    }
    // a run of `minSpan` or more unmatched words in a row is a rejected span whatever the window says
    for (let i = 0; i < m; ) {
      if (okAsr[i]) { i++; continue; }
      let j = i;
      while (j < m && !okAsr[j]) j++;
      if (j - i >= cfg.minSpan) for (let t = i; t < j; t++) bad[t] = 1;
      i = j;
    }
    for (let i = 0; i < m; ) {
      if (!bad[i]) { i++; continue; }
      let j = i;
      while (j < m && bad[j]) j++;
      let a = i, b = j - 1;
      while (a <= b && okAsr[a]) a++;
      while (b >= a && okAsr[b]) b--;
      if (b - a + 1 >= cfg.minSpan) {
        let ok = 0;
        for (let t = a; t <= b; t++) ok += okAsr[t];
        let reason: Rejection["reason"] = "no-match";
        let detail = "no stretch of this span exists in the Quran (3-gram search found nothing consistent)";
        for (let t = a; t <= b - 2; t++) {
          const s = seedsAt(t).find((x) => x.look >= 3);
          if (s) {
            reason = "forbidden-jump";
            const before = [...occ].reverse().find((o) => o.entry !== null && o.asr.length && o.asr[o.asr.length - 1] < A.orig[a]);
            let why = "no earlier recited word";
            if (before && before.entry !== null) {
              const q = before.entry;
              const total = idx.pos[idx.ayahLast[idx.ayahId[q]]];
              why = !completeAyah(q)
                ? `the previous recited word ${idx.label(q)} is mid-ayah (${idx.pos[q]} of ${total})`
                : A.pause[a] === 0
                  ? `the previous ayah is complete (${idx.label(q)}) but there is no pause before the span`
                  : `jumps are disabled or the path was not lost`;
            }
            detail = `matches ${idx.label(s.q)} elsewhere in the Quran, but a jump there is not allowed: ${why}`;
            break;
          }
        }
        rejections.push({ asrFrom: A.orig[a], asrTo: A.orig[b], start: A.start[a], end: A.end[b], ratio: ok / (b - a + 1), reason, detail });
      }
      i = j;
    }
  }
  const okTotal = okAsr.reduce((s, v) => s + v, 0);
  const accepted = okTotal / m >= 0.4;

  const count = (kd: Occurrence["kind"]) => occ.filter((o) => o.kind === kd).length;
  return {
    occurrences: occ, ayahs, jumps, rejections, accepted, alternatives, basmalaGaps,
    stats: {
      asrWords: flat.length, quranWordsMatched: count("matched"), substituted: count("substituted"), inferred: count("inferred"), extra: count("extra"),
      ayahsCompleted: ayahs.length, cost: best.cost, ms: performance.now() - t0, cells,
    },
  };
}

/** Ayah completion events: every time the path passes the last word of an ayah (a skipped last word counts). */
export function ayahEvents(idx: QuranIndex, occ: readonly Occurrence[]): AyahEvent[] {
  const out: AyahEvent[] = [];
  let curAyah = -1;
  const cover = new Set<number>();
  for (let k = 0; k < occ.length; k++) {
    const q = occ[k].entry;
    if (q === null) continue;
    const a = idx.ayahId[q];
    if (a !== curAyah) { curAyah = a; cover.clear(); }
    cover.add(idx.pos[q]);
    if (idx.isLast[q] && idx.ayah[q] > 0) {
      out.push({ surah: idx.surah[q], ayah: idx.ayah[q], markerId: idx.core.ayahMarker(idx.surah[q], idx.ayah[q]).id, time: occ[k].end, complete: cover.size === idx.pos[q], occurrence: k });
    }
  }
  return out;
}

/** For every surah start (not Al-Fatiha, not At-Tawbah): is its basmala recognized, inferred, or absent, and where would it be. */
export function findBasmalaGaps(idx: QuranIndex, occ: readonly Occurrence[]): BasmalaGap[] {
  const gaps: BasmalaGap[] = [];
  for (let k = 0; k < occ.length; k++) {
    const q = occ[k].entry;
    if (q === null || occ[k].basmala) continue;
    if (!(idx.ayah[q] === 1 && idx.pos[q] === 1) || idx.surah[q] === 1 || idx.surah[q] === 9) continue;
    let a = k;
    const basmala: number[] = [];
    while (a > 0 && occ[a - 1].entry !== null && occ[a - 1].basmala && idx.surah[occ[a - 1].entry!] === idx.surah[q]) basmala.unshift(--a);
    let p = a - 1;
    while (p >= 0 && (occ[p].kind === "extra" || occ[p].kind === "inferred")) p--;
    gaps.push({
      surah: idx.surah[q], first: k, basmala,
      recognized: basmala.length > 0 && basmala.every((x) => occ[x].kind !== "inferred"),
      start: p >= 0 ? occ[p].end : 0, end: occ[k].start,
    });
  }
  return gaps;
}
