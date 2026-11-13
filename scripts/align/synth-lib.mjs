// Builders for synthetic transcripts made of REAL ASR words (82 / 51 / 1 dumps). Used by synthetic.mjs and make-demo-groups.mjs.
import fs from "node:fs";
import { alignTranscript } from "../../src/align/align.ts";
import { normalize } from "../../src/normalize.ts";
import { loadIndex, loadGroups } from "./common.mjs";

const arg = process.argv[2];
export const dir = arg && fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? arg : new URL("./fixtures", import.meta.url).pathname;
export const { core, idx } = loadIndex();

// ---- chunk store: ASR words (text + duration) per Quran ayah, taken from the real alignment of each file ----
const store = new Map(); // "s:a" -> [{text, dur}]
export const flatAsr = {};
for (const name of ["1", "82", "51"]) {
  const groups = loadGroups(dir, name);
  const flat = groups.flatMap((g) => g.words);
  flatAsr[name] = flat;
  const r = alignTranscript(idx, groups);
  for (const o of r.occurrences) {
    if (o.kind === "extra" || o.kind === "inferred" || o.repeat) continue;
    const key = `${o.surah}:${o.ayah}`;
    if (!store.has(key)) store.set(key, new Map());
    for (const a of o.asr) store.get(key).set(a, { text: flat[a].text, dur: flat[a].end - flat[a].start });
  }
}
export const ayah = (s, a, from = 1, to = Infinity) => [...store.get(`${s}:${a}`).entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]).slice(from - 1, to);
export const ayahs = (s, a, b) => { const out = []; for (let k = a; k <= b; k++) out.push(...ayah(s, k)); return out; };
/** ASR-like words simulated from the Quran text (strict-normalized, no diacritics): only where no real ASR exists. */
export const simulate = (s, a, b) => { const out = []; for (let j = 0; j < idx.n; j++) if (idx.surah[j] === s && idx.ayah[j] >= a && idx.ayah[j] <= b && !idx.skippableBasmala[j]) out.push({ text: normalize(core.textWords[idx.textIndex[j]]), dur: 0.4 }); return out; };
export const basmala = () => ayah(1, 1).slice(0, 4);
/** parts: arrays of {text,dur}; each part is its own group (pause before it) unless wrapped in join() */
export function build(parts, { gap = 1.2 } = {}) {
  const groups = []; let t = 0.2;
  for (const p of parts) {
    const words = p.words ?? p;
    if (!p.joined || !groups.length) { groups.push({ start: t, end: t, words: [], breaks: [], unrecognized: [] }); t += gap; }
    const g = groups.at(-1);
    for (const w of words) { g.words.push({ text: w.text, start: t, end: t + w.dur }); t += w.dur; }
    g.end = t;
  }
  return groups;
}
export const join = (words) => ({ words, joined: true });
export const seq = (r, { basmala: b = false } = {}) => r.occurrences.filter((o) => o.kind !== "extra" && (b || !o.basmala)).map((o) => `${o.surah}:${o.ayah}:${o.word}`);
const expectSeq = (s, a, b, from = 1) => { const out = []; for (let k = a; k <= b; k++) for (let w = k === a ? from : 1; w <= ayah(s, k).length + 0; w++) out.push(null); return out; };
void expectSeq;
export function rng(seed) { let x = seed; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

