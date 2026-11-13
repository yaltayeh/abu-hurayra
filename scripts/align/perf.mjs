// Speed: align the 28-minute real file (27.mp3) and 3x / 6x concatenations of it. Usage: node --no-warnings scripts/align/perf.mjs [asr-dir]
import { alignTranscript } from "../../src/align/align.ts";
import { loadIndex, loadGroups } from "./common.mjs";
const dir = process.argv[2] ?? new URL("./fixtures", import.meta.url).pathname;
const { idx, loadMs, indexMs } = loadIndex();
console.log(`one-time: parse quran-core ${loadMs.toFixed(0)} ms + build matching index ${indexMs.toFixed(0)} ms`);
const base = loadGroups(dir, "27");
const dur = base.at(-1).end + 2;
for (const k of [1, 3, 6]) {
  const groups = Array.from({ length: k }, (_, c) => base.map((g) => ({ ...g, start: g.start + c * dur, end: g.end + c * dur, words: g.words.map((w) => ({ ...w, start: w.start + c * dur, end: w.end + c * dur })), breaks: g.breaks.map((b) => b + c * dur), unrecognized: g.unrecognized.map((u) => ({ start: u.start + c * dur, end: u.end + c * dur })) }))).flat();
  const times = [];
  let r;
  for (let i = 0; i < 5; i++) { const t = performance.now(); r = alignTranscript(idx, groups); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  const words = groups.reduce((n, g) => n + g.words.length, 0);
  console.log(`${k}x 27.mp3: ${(k * dur / 60).toFixed(0)} min audio, ${words} ASR words → median ${times[2].toFixed(0)} ms (min ${times[0].toFixed(0)}, max ${times[4].toFixed(0)}), ${r.stats.cells} beam states, ${(1000 * times[2] / words).toFixed(0)} µs/word, ayahs completed ${r.stats.ayahsCompleted}, passage jumps ${r.jumps.filter((j) => j.type === "passage").length}`);
}
