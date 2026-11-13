// Shared helpers for the alignment tests. ASR dumps come from AILab/dump_transcript.mjs and AILab/dump_segments.mjs.
import fs from "node:fs";
import { parseQuranCore } from "../../src/quran-data.ts";
import { buildQuranIndex } from "../../src/align/quran-index.ts";

export const root = new URL("../../", import.meta.url).pathname;
export function loadIndex() {
  const t = performance.now();
  const core = parseQuranCore(fs.readFileSync(root + "scripts/data/out/quran-core.bin"));
  const t1 = performance.now();
  const idx = buildQuranIndex(core);
  return { core, idx, loadMs: t1 - t, indexMs: performance.now() - t1 };
}
/** AsrGroup[] from a dump: breaks = starts of the 2nd.. segments inside each group; unrecognized = segments without any word. */
export function loadGroups(dir, name, { withSegments = true } = {}) {
  const asr = JSON.parse(fs.readFileSync(`${dir}/${name}.q8.json`));
  const segs = withSegments ? JSON.parse(fs.readFileSync(`${dir}/${name}.segments.json`)) : [];
  return asr.groups.map((g) => {
    const words = g.words.map((w) => ({ text: w.text.trim(), start: w.timestamp[0], end: w.timestamp[1] ?? w.timestamp[0] + 0.1 }));
    const members = segs.filter((s) => s.start >= g.start - 1e-6 && s.end <= g.end + 1e-6);
    const breaks = members.slice(1).map((s) => s.start);
    const unrecognized = members.filter((s) => !words.some((w) => w.start >= s.start - 0.05 && w.start < s.end)).map((s) => ({ start: s.start, end: s.end }));
    return { start: g.start, end: g.end, words, breaks, unrecognized };
  });
}
export const label = (o) => (o.surah === null ? "-" : `${o.surah}:${o.ayah}:${o.word}`);
