// Where is each human-heard repeat lost? For every case of fixtures/18-human.json: how many times does each ASR output contain the repeated words
// inside the human time window (before alignment)? Sources are 18.q8.json-style dumps: name=path pairs.
// Usage: node --no-warnings scripts/align/diagnose-human.mjs grouped=<dump.json> refined=<dump.json> segment=<dump.seg.json> …
import fs from "node:fs";
import { loadIndex } from "./common.mjs";
import { normalize } from "../../src/normalize.ts";

const human = JSON.parse(fs.readFileSync(new URL("./fixtures/18-human.json", import.meta.url)));
const { idx, core } = loadIndex();
const sources = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")).map(([n, f]) => [n, JSON.parse(fs.readFileSync(f)).groups.flatMap((g) => g.words)]));
const find = (label) => { const [s, a, w] = label.split(":").map(Number); for (let j = 0; j < idx.n; j++) if (idx.surah[j] === s && idx.ayah[j] === a && idx.pos[j] === w) return j; };
const sim = (a, b) => { const m = a.length, n = b.length; let p = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return 1 - p[n] / Math.max(m, n, 1); };
const rows = [];
for (const c of human.cases) {
  if (c.type !== "repeat") continue;
  const [a, b] = c.window, tol = human.tolerance;
  const row = { case: c.id, words: c.words.length > 1 ? `${c.words[0]}…${c.words.at(-1).split(":")[2]}` : c.words[0] };
  for (const [name, words] of Object.entries(sources)) {
    // for each repeated Quran word: ASR words in the window whose strict form is (almost) that word
    const counts = c.words.map((w) => { const q = idx.strictStr[idx.strict[find(w)]]; return words.filter((x) => x.timestamp[0] >= a - tol && x.timestamp[0] <= b + tol && sim(normalize(x.text), q) >= 0.7).length; });
    row[name] = counts.join("/");
  }
  rows.push(row);
}
console.log("ASR occurrences of each repeated word inside the human window (2 or more per word = the ASR has the repeat):");
console.table(rows);
void core;
