// Scores the alignment of 18.mp3 against what a person heard (fixtures/18-human.json): every listed Quran word must be output
// at least twice (kind matched/substituted, i.e. not `extra`/`inferred`) inside the human time window (± tolerance), the later one flagged `repeat`.
// Usage: node --no-warnings scripts/align/test-human.mjs [asr-dir] [--verbose]   (asr-dir holds 18.q8.json + 18.segments.json; default: fixtures)
import fs from "node:fs";
import { alignTranscript } from "../../src/align/align.ts";
import { loadIndex, loadGroups } from "./common.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const verbose = process.argv.includes("--verbose");
const dir = args[0] ?? new URL("./fixtures", import.meta.url).pathname;
const human = JSON.parse(fs.readFileSync(new URL("./fixtures/18-human.json", import.meta.url)));
const { idx, core } = loadIndex();
const groups = loadGroups(dir, "18");
const r = alignTranscript(idx, groups);
const lab = (o) => `${o.surah}:${o.ayah}:${o.word}`;
const f = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const rows = [];
let pass = 0, scored = 0;
for (const c of human.cases) {
  const [a, b] = c.window, tol = human.tolerance;
  if (c.type === "boundary") { rows.push({ case: c.id, words: c.words.join(" "), result: "manual (no reference times)", detail: "" }); continue; }
  scored++;
  const detail = [];
  let ok = true;
  for (const w of c.words) {
    const occ = r.occurrences.filter((o) => o.surah !== null && lab(o) === w && o.start >= a - tol && o.start <= b + tol);
    const real = occ.filter((o) => o.kind === "matched" || o.kind === "substituted");
    const rep = real.some((o) => o.repeat);
    const good = real.length >= 2 && rep;
    if (!good) ok = false;
    detail.push(`${w.split(":").slice(1).join(":")}: ${real.length}× at ${real.map((o) => f(o.start)).join(",") || "-"}${rep ? "" : " (no repeat flag)"}`);
    if (!good && verbose) {
      const extras = r.occurrences.filter((o) => o.kind === "extra" && o.start >= a - tol && o.end <= b + tol).map((o) => `${o.text}@${f(o.start)}`);
      if (extras.length) detail.push(`extras in window: ${extras.join(" ")}`);
    }
  }
  if (ok) pass++;
  rows.push({ case: c.id, words: c.words.length > 2 ? `${c.words[0]}…${c.words.at(-1).split(":")[2]}` : c.words.join(" "), result: ok ? "PASS" : "FAIL", detail: detail.join(" | ") });
}
console.table(rows);
console.log(`${pass} / ${scored} scored cases correct (+ ${human.cases.length - scored} manual); alignment: ${r.stats.quranWordsMatched} matched, ${r.stats.substituted} substituted, ${r.stats.extra} extra, ${r.jumps.filter((j) => j.type === "repeat").length} repeats, ${r.stats.ayahsCompleted} ayahs`);
