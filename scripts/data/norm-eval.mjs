// Normalization quality against REAL model output.
// Usage: node --no-warnings scripts/data/norm-eval.mjs <asr-dir> [--top 50] [--steps a,b,c]
//   <asr-dir> contains <n>.q8.json (AILab/dump_transcript.mjs) and <n>.segments.json (AILab/dump_segments.mjs); file n = surah n.
// Alignment is fixed (a loose key) so the exact-match % of each rule set is measured on the same word pairs.
import fs from "node:fs";
import { parseQuranCore } from "../../src/quran-data.ts";
import { normalize, STEPS } from "../../src/normalize.ts";

const args = process.argv.slice(2);
const dir = args[0];
const top = args.includes("--top") ? +args[args.indexOf("--top") + 1] : 50;
const only = args.includes("--steps") ? args[args.indexOf("--steps") + 1].split(",") : null;
const core = parseQuranCore(fs.readFileSync(new URL("./out/quran-core.bin", import.meta.url)));
const SURAHS = [1, 82, 51, 27];

// ---------- rule sets ----------
const ORDER = ["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "alefless", "daggerAlef", "base", "dropMedialAlef", "dropNonInitialAlef"];
const pipeline = (set) => ORDER.filter((k) => set.has(k) || k === "base");
const norm = (t, set) => normalize(t, pipeline(set));
const LOOSE = new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "daggerAlef", "dropNonInitialAlef"]);

// ---------- alignment ----------
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => (a.length + b.length === 0 ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length));
const sc = (s) => 3 * s - 1.5;

/** semi-global alignment: free leading/trailing Quran words; ASR extras cost 1, Quran gaps inside cost 0.8. */
function align(A, Q) {
  const m = A.length, n = Q.length, W = n + 1;
  const dp = new Float32Array((m + 1) * W), bp = new Uint8Array((m + 1) * W); // 1 diag, 2 asr extra, 3 quran gap, 4 split(2 asr:1 q), 5 merge(1 asr:2 q)
  for (let i = 1; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      let best = -1e9, how = 0;
      const set = (v, h) => { if (v > best) { best = v; how = h; } };
      set(dp[(i - 1) * W + j] - 1.0, 2);
      if (j > 0) {
        set(dp[i * W + j - 1] - 0.8, 3);
        const s = sim(A[i - 1], Q[j - 1]);
        if (s >= 0.5) set(dp[(i - 1) * W + j - 1] + sc(s), 1);
        if (i > 1) { const s2 = sim(A[i - 2] + A[i - 1], Q[j - 1]); if (s2 >= 0.7) set(dp[(i - 2) * W + j - 1] + sc(s2) - 0.2, 4); }
        if (j > 1) { const s3 = sim(A[i - 1], Q[j - 2] + Q[j - 1]); if (s3 >= 0.7) set(dp[(i - 1) * W + j - 2] + sc(s3) - 0.2, 5); }
      }
      dp[i * W + j] = best; bp[i * W + j] = how;
    }
  }
  let bj = 0; for (let j = 0; j <= n; j++) if (dp[m * W + j] > dp[m * W + bj]) bj = j;
  const pairs = []; // {type, a:[i..], q:[j..]}
  let i = m, j = bj;
  while (i > 0) {
    const h = bp[i * W + j];
    if (h === 1) { pairs.push({ type: "1-1", a: [i - 1], q: [j - 1] }); i--; j--; }
    else if (h === 2) { pairs.push({ type: "extra", a: [i - 1], q: [] }); i--; }
    else if (h === 3) { j--; }
    else if (h === 4) { pairs.push({ type: "split", a: [i - 2, i - 1], q: [j - 1] }); i -= 2; j--; }
    else if (h === 5) { pairs.push({ type: "merge", a: [i - 1], q: [j - 2, j - 1] }); i--; j -= 2; }
    else break;
  }
  return pairs.reverse();
}

// ---------- load ----------
const surahWords = (s) => { const out = []; for (let k = 0; k < core.textWordIds.length; k++) { const w = core.wordAt(core.textWordIds[k]); if (w.surah === s) out.push({ k, text: w.text }); } return out; };
const data = SURAHS.map((s) => {
  const asr = JSON.parse(fs.readFileSync(`${dir}/${s}.q8.json`));
  const segs = JSON.parse(fs.readFileSync(`${dir}/${s}.segments.json`));
  const words = []; const groupStart = [];
  for (const g of asr.groups) { groupStart.push(words.length); for (const w of g.words) words.push({ text: w.text.trim(), start: w.timestamp[0] }); }
  const A = words.map((w) => norm(w.text, LOOSE)), qw = surahWords(s), Q = qw.map((w) => norm(w.text, LOOSE));
  const pairs = align(A, Q);
  // segment starts: first ASR word whose start falls inside each segment
  const segStart = []; let wi = 0;
  for (const sg of segs) { while (wi < words.length && words[wi].start < sg.start - 0.05) wi++; if (wi < words.length && words[wi].start < sg.end) segStart.push(wi); }
  return { s, words, qw, pairs, groupStart, segStart };
});

// ---------- exact match ----------
function evaluate(set, collect) {
  const mism = new Map(); const tot = { asr: 0, exact11: 0, aligned11: 0, exactSM: 0, sm: 0, extra: 0 };
  for (const d of data) {
    tot.asr += d.words.length;
    for (const p of d.pairs) {
      if (p.type === "extra") { tot.extra++; continue; }
      const a = norm(p.a.map((i) => d.words[i].text).join(" "), set), q = norm(p.q.map((k) => d.qw[k].text).join(" "), set); // joined BEFORE normalizing (alef-drop sees the join)
      if (p.type === "1-1") { tot.aligned11++; if (a === q) tot.exact11++; else if (collect) { const key = a + "\t" + q; mism.set(key, (mism.get(key) ?? 0) + 1); } }
      else { tot.sm += p.a.length; if (a === q) tot.exactSM += p.a.length; else if (collect) { const key = a + "\t" + q + " [" + p.type + "]"; mism.set(key, (mism.get(key) ?? 0) + 1); } }
    }
  }
  return { tot, mism };
}

// ---------- ambiguity ----------
const quranText = Array.from(core.textWords);
const v0 = new Set(["base"]);
function ambiguity(set) {
  const forms = quranText.map((t) => norm(t, set));
  const vocab = new Set(forms);
  const base = new Map(); // base-form -> new form
  for (let k = 0; k < quranText.length; k++) base.set(norm(quranText[k], v0), forms[k]);
  const groups = new Map(); for (const [b, f] of base) { if (!groups.has(f)) groups.set(f, new Set()); groups.get(f).add(b); }
  let merged = 0; for (const g of groups.values()) if (g.size > 1) merged += g.size;
  const tri = (n) => { const c = new Map(); for (let k = 0; k + n <= forms.length; k++) { const key = forms.slice(k, k + n).join(" "); c.set(key, (c.get(key) ?? 0) + 1); } let uniq = 0; for (const v of c.values()) if (v === 1) uniq++; return uniq / (forms.length - n + 1); };
  return { vocab: vocab.size, baseVocab: new Set(quranText.map((t) => norm(t, v0))).size, mergedBaseForms: merged, uniq3: tri(3), uniq4: tri(4), uniq5: tri(5) };
}

// ---------- anchor ----------
function anchor(set) {
  const forms = quranText.map((t) => norm(t, set));
  const index = new Map();
  for (const n of [3, 4, 5]) { const m = new Map(); for (let k = 0; k + n <= forms.length; k++) { const key = forms.slice(k, k + n).join(" "); (m.get(key) ?? m.set(key, []).get(key)).push(k); } index.set(n, m); }
  const res = {};
  for (const [name, pick] of [["group", (d) => d.groupStart], ["segment", (d) => d.segStart]]) {
    const r = { starts: 0, scored: 0, scoredAny: 0, hit3: 0, uniq3: 0, hit4: 0, hit5: 0, any: 0, anyUniqueCorrect: 0, noTruth: 0, cand3: [] };
    for (const d of data) {
      const truth = new Map(); // asr idx -> global quran text idx (1-1 pairs only)
      for (const p of d.pairs) if (p.type === "1-1") truth.set(p.a[0], d.qw[p.q[0]].k);
      const asrN = d.words.map((w) => norm(w.text, set));
      for (const st of pick(d)) {
        r.starts++;
        const q = (n, o) => asrN.slice(st + o, st + o + n).join(" ");
        const ok = (n, o) => { if (st + o + n > asrN.length) return null; const t = truth.get(st + o); if (t === undefined) return null; const c = index.get(n).get(q(n, o)) ?? []; return { hit: c.includes(t), c }; };
        const a3 = ok(3, 0);
        if (!a3) { r.noTruth++; }
        else { r.scored++; if (a3.hit) r.hit3++; if (a3.hit && a3.c.length === 1) r.uniq3++; r.cand3.push(a3.c.length); }
        const a4 = ok(4, 0); if (a4?.hit) r.hit4++;
        const a5 = ok(5, 0); if (a5?.hit) r.hit5++;
        let any = false, anyU = false, has = false;
        for (let o = 0; o <= 2; o++) { const a = ok(3, o); if (a) has = true; if (a?.hit) any = true; if (a && a.c.length === 1 && a.hit) anyU = true; }
        if (has) r.scoredAny++; if (any) r.any++; if (anyU) r.anyUniqueCorrect++;
      }
    }
    r.cand3.sort((x, y) => x - y); r.medianCand3 = r.cand3[r.cand3.length >> 1]; delete r.cand3;
    res[name] = r;
  }
  return res;
}

// ---------- report ----------
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "n/a");
console.log(`files: ${data.map((d) => `${d.s}.mp3 (${d.words.length} ASR words, ${d.qw.length} Quran words)`).join(", ")}`);
const alignedStats = data.map((d) => { const c = {}; for (const p of d.pairs) c[p.type] = (c[p.type] ?? 0) + 1; return `${d.s}: ${JSON.stringify(c)}`; });
console.log("alignment pair types:", alignedStats.join(" | "));

const configs = only ? [["custom", new Set(only)]] : [
  ["0 base (current)", new Set([])],
  ["1 + kashidaHamza", new Set(["kashidaHamza"])],
  ["2 + wawDagger", new Set(["kashidaHamza", "wawDagger"])],
  ["3 + yaDaggerFinal", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal"])],
  ["4 + yaDaggerMedial", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial"])],
  ["5 + daggerAlef", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "daggerAlef"])],
  ["6 + dropMedialAlef", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "daggerAlef", "dropMedialAlef"])],
  ["5b + alefless (closed word list)", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "alefless", "daggerAlef"])],
  ["6b + alefless + dropMedialAlef", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "alefless", "daggerAlef", "dropMedialAlef"])],
  ["alt: 5 + dropNonInitialAlef", new Set(["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "daggerAlef", "dropNonInitialAlef"])],
  ["alt: base + dropMedialAlef only", new Set(["dropMedialAlef"])],
  ["alt: base + dropNonInitialAlef only", new Set(["dropNonInitialAlef"])],
];
console.log("\n| rule set | exact 1-1 (% of ASR words) | exact incl. split/merge | exact of aligned 1-1 | Quran vocab (base %s) | base forms merged | unique 3-grams | unique 4-grams |".replace("%s", ambiguity(v0).baseVocab));
console.log("|---|---|---|---|---|---|---|---|");
for (const [name, set] of configs) {
  const { tot } = evaluate(set); const a = ambiguity(set);
  console.log(`| ${name} | ${pct(tot.exact11, tot.asr)} | ${pct(tot.exact11 + tot.exactSM, tot.asr)} | ${pct(tot.exact11, tot.aligned11)} | ${a.vocab} | ${a.mergedBaseForms} | ${(100 * a.uniq3).toFixed(2)}% | ${(100 * a.uniq4).toFixed(2)}% |`);
}
for (const [name, set] of configs) {
  const { tot, mism } = evaluate(set, true);
  console.log(`\n## ${name}: ASR words ${tot.asr}, 1-1 aligned ${tot.aligned11} (exact ${tot.exact11}), split/merge ${tot.sm} words (exact ${tot.exactSM}), extra ASR words ${tot.extra}`);
  if (name === "0 base (current)" || name === configs.at(-1)[0] || only) {
    console.log(`top ${top} mismatch pairs (normalized ASR, normalized Quran):`);
    [...mism.entries()].sort((x, y) => y[1] - x[1]).slice(0, top).forEach(([k, n], i) => console.log(`${String(i + 1).padStart(2)}. ${String(n).padStart(3)}x  ${k.replace("\t", "  |  ")}`));
  }
}
console.log("\n## anchor hit rate");
console.log("| rule set | starts | scored | trigram@0 hit | …and unique | 4-gram@0 | 5-gram@0 | any of 3 windows in first 5 words | …of which unique & correct | median candidates |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const [name, set] of configs) {
  const a = anchor(set);
  for (const kind of ["group", "segment"]) { const r = a[kind]; console.log(`| ${name} (${kind}) | ${r.starts} | ${r.scored} | ${pct(r.hit3, r.scored)} | ${pct(r.uniq3, r.scored)} | ${pct(r.hit4, r.scored)} | ${pct(r.hit5, r.scored)} | ${pct(r.any, r.scoredAny)} | ${pct(r.anyUniqueCorrect, r.scoredAny)} | ${r.medianCand3} |`); }
}
void STEPS;
