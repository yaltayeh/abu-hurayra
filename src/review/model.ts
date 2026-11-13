// Turns an AlignResult into what the page renders: blocks of words (one per ayah pass, as recited) and a flat list of flags.
import type { AlignResult, Occurrence } from "../align/types.ts";
import type { QuranIndex } from "../align/quran-index.ts";
import { LONG_WORD_SEC } from "../long-word.ts";

export type Item = {
  k: number; // index in result.occurrences
  o: Occurrence;
  page: number | null;
  glyph: string | null;
  /** The ayah-end marker drawn after this word (the ayah was completed here). */
  marker: { page: number; glyph: string; complete: boolean; label: string } | null;
  rejected: boolean;
};
export type Block = {
  key: string;
  surah: number | null;
  /** Labels shown above the block: how the recitation arrived here. */
  notes: { kind: "jump" | "repeat" | "reanchor" | "skip" | "reject"; text: string; time: number }[];
  items: Item[];
  heading: boolean; // first block of a surah
};

export type FlagType = "long" | "jump" | "rejected" | "substituted" | "inferred" | "repeat" | "extra" | "incomplete" | "basmala" | "ambiguous";
export type Flag = { id: string; type: FlagType; time: number; end: number; text: string; k: number | null };

export const FLAG_COLORS: Record<FlagType, string> = {
  long: "var(--c-long)", jump: "var(--c-jump)", rejected: "var(--c-rej)", substituted: "var(--c-sub)", inferred: "var(--c-inf)", repeat: "var(--c-rep)",
  extra: "var(--c-ext)", incomplete: "var(--c-inc)", basmala: "var(--c-bas)", ambiguous: "var(--c-amb)",
};

const t = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`;
export const fmtTime = t;
export const wordLabel = (o: Occurrence) => (o.surah === null ? "extra" : `${o.surah}:${o.ayah}:${o.word}`);

export function buildModel(result: AlignResult, idx: QuranIndex, asrText: (i: number) => string) {
  const occ = result.occurrences;
  const core = idx.core;
  const markerAt = new Map(result.ayahs.map((a) => [a.occurrence, a]));
  const occOfAsr = new Map<number, number>();
  occ.forEach((o, k) => o.asr.forEach((a) => !occOfAsr.has(a) && occOfAsr.set(a, k)));

  const jumpAt = new Map<number, (typeof result.jumps)[number]>();
  for (const j of result.jumps) {
    const k = occOfAsr.get(j.asrIndex);
    if (k !== undefined) jumpAt.set(k, j);
  }
  const rejAt = new Map<number, (typeof result.rejections)[number]>();
  const rejected = new Uint8Array(occ.length);
  for (const r of result.rejections) {
    const from = occOfAsr.get(r.asrFrom);
    if (from !== undefined) rejAt.set(from, r);
    for (let k = from ?? 0; from !== undefined && k < occ.length; k++) {
      if (occ[k].asr.length && occ[k].asr[0] > r.asrTo) break;
      if (occ[k].kind === "extra" || occ[k].kind === "substituted") rejected[k] = 1;
    }
  }

  const blocks: Block[] = [];
  let cur: Block | null = null;
  let lastSurah = -1;
  const open = (k: number, surah: number | null) => {
    cur = { key: `b${k}`, surah, notes: [], items: [], heading: surah !== null && surah !== lastSurah };
    blocks.push(cur);
    return cur;
  };
  occ.forEach((o, k) => {
    const j = jumpAt.get(k);
    const rej = rejAt.get(k);
    // a new block starts at the first word, at a surah change, and wherever the recitation did something unusual (jump, repeat, rejected span)
    const newBlock = !cur || (o.surah !== null && o.surah !== lastSurah) || (j && j.type !== "start") || !!rej;
    if (newBlock) open(k, o.surah);
    const b = cur as Block | null;
    if (!b) return;
    if (j && j.type !== "start") {
      const text =
        j.type === "repeat" ? `↺ repeat: back to ${j.to} (from ${j.from})`
        : j.type === "skip-forward" ? `⇥ skip: ${j.from} → ${j.to}, not recited: ${j.skippedAyahs?.join(", ") || "-"}`
        : j.type === "reanchor" ? `⚠ re-anchored after being lost: ${j.from} → ${j.to}`
        : `→ new passage: ${j.from} → ${j.to}`;
      b.notes.push({ kind: j.type === "repeat" ? "repeat" : j.type === "skip-forward" ? "skip" : j.type === "reanchor" ? "reanchor" : "jump", text, time: o.start });
    }
    if (rej) b.notes.push({ kind: "reject", text: `✖ rejected span (${rej.reason}): ${rej.detail}`, time: rej.start });
    let page: number | null = null, glyph: string | null = null;
    if (o.wordId !== null) {
      const w = core.wordAt(o.wordId);
      page = w.page;
      glyph = w.glyph;
    }
    const ev = markerAt.get(k);
    let marker: Item["marker"] = null;
    if (ev) {
      const m = core.wordAt(ev.markerId);
      marker = { page: m.page, glyph: m.glyph, complete: ev.complete, label: `end of ${ev.surah}:${ev.ayah}${ev.complete ? "" : " (not every word recited)"}` };
    }
    b.items.push({ k, o, page, glyph, marker, rejected: rejected[k] === 1 });
    if (o.surah !== null) lastSurah = o.surah;
  });

  // flags for the side panel
  const flags: Flag[] = [];
  const add = (type: FlagType, o: Occurrence, k: number, text: string, end = o.end) => flags.push({ id: `${type}-${k}`, type, time: o.start, end, text, k });
  for (const j of result.jumps) {
    if (j.type === "start") continue;
    const k = occOfAsr.get(j.asrIndex) ?? null;
    flags.push({ id: `jump-${j.asrIndex}`, type: j.type === "repeat" ? "repeat" : "jump", time: j.time, end: j.time, text: `${j.type}: ${j.from} → ${j.to}${j.skippedAyahs?.length ? ` (skipped ${j.skippedAyahs.join(", ")})` : ""}`, k });
  }
  for (const r of result.rejections) {
    const k = occOfAsr.get(r.asrFrom) ?? null;
    flags.push({ id: `rej-${r.asrFrom}`, type: "rejected", time: r.start, end: r.end, text: `rejected (${r.reason}), ${r.asrTo - r.asrFrom + 1} ASR words, ${(100 * r.ratio).toFixed(0)}% ok: ${r.detail}`, k });
  }
  for (let k = 0; k < occ.length; k++) {
    const o = occ[k];
    // a word that lasts seconds: a pause or a real elongation, or speech the ASR dropped (a repeated phrase, 18.mp3 1:41)
    if (o.kind !== "extra" && o.kind !== "inferred" && o.end - o.start >= LONG_WORD_SEC) {
      add("long", o, k, `${wordLabel(o)} ${core.textWords[o.textIndex!]} lasts ${(o.end - o.start).toFixed(1)} s: check for a repeat or dropped words`);
    }
    if (o.kind === "substituted") add("substituted", o, k, `${wordLabel(o)} ${core.textWords[o.textIndex!]}  ← ASR "${o.asr.map(asrText).join(" ")}" (conf ${o.confidence.toFixed(2)})`);
    else if (o.kind === "inferred" && !o.basmala) {
      let e = k;
      while (e + 1 < occ.length && occ[e + 1].kind === "inferred" && !occ[e + 1].basmala) e++;
      add("inferred", o, k, e > k ? `${e - k + 1} words not recited/recognized: ${wordLabel(o)} … ${wordLabel(occ[e])}` : `${wordLabel(o)} not recognized`, occ[e].end);
      k = e;
    } else if (o.kind === "extra") {
      let e = k;
      while (e + 1 < occ.length && occ[e + 1].kind === "extra") e++;
      add("extra", o, k, `${e - k + 1} extra ASR word${e > k ? "s" : ""}: ${occ.slice(k, e + 1).map((x) => x.text).join(" ")}`, occ[e].end);
      k = e;
    }
  }
  for (const a of result.ayahs) if (!a.complete) flags.push({ id: `inc-${a.occurrence}`, type: "incomplete", time: a.time, end: a.time, text: `${a.surah}:${a.ayah} completed but not every word was recited/recognized`, k: a.occurrence });
  for (const g of result.basmalaGaps) {
    if (g.recognized || (g.basmala.length === 0 && g.end - g.start < 1.2)) continue; // no room for a basmala: nothing to report
    flags.push({ id: `bas-${g.surah}`, type: "basmala", time: g.start, end: g.end, text: `basmala of surah ${g.surah} not recognized${g.basmala.length ? " (inferred)" : ""}; audio gap ${t(g.start)}–${t(g.end)}`, k: g.first });
  }
  if (result.alternatives.length) flags.push({ id: "amb", type: "ambiguous", time: 0, end: 0, text: `ambiguous start: also fits ${result.alternatives.slice(0, 6).join(", ")}${result.alternatives.length > 6 ? ` … (${result.alternatives.length})` : ""}`, k: null });
  if (!result.accepted && occ.length) flags.push({ id: "rejected-all", type: "rejected", time: 0, end: 0, text: "the whole input does not match the Quran well enough (accepted = false)", k: null });
  flags.sort((a, b) => a.time - b.time);
  return { blocks, flags };
}
