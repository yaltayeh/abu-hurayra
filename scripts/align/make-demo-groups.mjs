// Writes a demo transcript (no audio) with one of every problem the review page shows: skipped ayah, repeat, junk (rejected span),
// Al-Fatiha then a non-adjacent surah, a passage cut mid-ayah followed by another surah (forbidden jump), an unrecognized span.
// Load it into the page with ?view=review&debug=1 and window.__loadGroups(json). Usage: node --no-warnings scripts/align/make-demo-groups.mjs <out.json>
import fs from "node:fs";
import { ayah, ayahs, build, join, flatAsr, rng } from "./synth-lib.mjs";

const R = rng(11);
const pool = flatAsr["51"].slice(100, 300).map((w) => ({ text: w.text, dur: 0.4 }));
const junk = (n) => Array.from({ length: n }, () => pool[Math.floor(R() * pool.length)]);
const fatiha = [...ayah(1, 1), ...ayahs(1, 2, 6)];
const parts = [
  ayahs(82, 1, 4), // start
  ayahs(82, 6, 7), // skips 82:5 after a pause -> skip-forward
  join(ayah(82, 7)), // repeats 82:7 right away
  join(junk(14)), // junk -> rejected span (no-match)
  join(ayahs(82, 8, 10)), // the recitation goes on
  fatiha, // jump to Al-Fatiha after a pause (new passage)
  [...ayahs(82, 11, 12), ...ayahs(82, 14, 15), ...ayah(82, 16).slice(0, 2)], // another passage: 82:13 is missing (unrecognized span), cut mid-ayah at the end
  ayahs(51, 20, 22), // jump out of the incomplete ayah: forbidden -> rejected span, re-anchor
];
const groups = build(parts);
// an unrecognized 3 s span where 82:13 should be, inside the second-to-last group
const g = groups.at(-2), n = ayahs(82, 11, 12).length, gapStart = g.words[n - 1].end;
for (let k = n; k < g.words.length; k++) { g.words[k].start += 3; g.words[k].end += 3; }
g.end += 3; g.unrecognized = [{ start: gapStart, end: gapStart + 3 }];
for (const later of groups.slice(groups.indexOf(g) + 1)) { later.start += 3; later.end += 3; later.words.forEach((w) => { w.start += 3; w.end += 3; }); }
fs.writeFileSync(process.argv[2], JSON.stringify(groups));
console.log(`${groups.length} groups, ${groups.reduce((n, x) => n + x.words.length, 0)} words -> ${process.argv[2]}`);
