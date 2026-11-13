// Real files: alignment of the ASR output of 1, 82, 51, 27 against the Quran. Usage: node --no-warnings scripts/align/real.mjs [asr-dir]  (default: scripts/align/fixtures)
import { alignTranscript } from "../../src/align/align.ts";
import { loadIndex, loadGroups, label } from "./common.mjs";
const dir = process.argv[2] ?? new URL("./fixtures", import.meta.url).pathname;
const { core, idx, loadMs, indexMs } = loadIndex();
console.log(`quran-core parse ${loadMs.toFixed(0)} ms, matching index (${idx.n} entries, ${idx.triStrict.size} strict trigrams) ${indexMs.toFixed(0)} ms`);
const EXPECT = { 1: [1, 1, 7], 82: [82, 1, 19], 51: [51, 1, 60], 27: [27, 1, 93] };
const rows = [];
for (const name of ["1", "82", "51", "27"]) {
  const groups = loadGroups(dir, name);
  const r = alignTranscript(idx, groups);
  const s = +name;
  const surahWords = [...Array(idx.n).keys()].filter((j) => idx.surah[j] === s && !idx.skippableBasmala[j]).length;
  const distinct = (f) => new Set(r.occurrences.filter((o) => o.surah === s && !o.repeat && f(o)).map((o) => o.textIndex)).size;
  const matchedWords = distinct((o) => o.kind === "matched");
  const substitutedWords = distinct((o) => o.kind === "substituted");
  const inferredWords = distinct((o) => o.kind === "inferred" && !o.basmala);
  const covered = matchedWords + substitutedWords + inferredWords;
  const ayahsDone = new Set(r.ayahs.filter((a) => a.surah === s).map((a) => a.ayah)).size;
  const ayahTotal = core.surahAyahCount(s);
  const t = r.stats;
  const idxs = r.occurrences.filter((o) => o.surah === s && o.kind !== "extra" && !o.basmala).map((o) => o.textIndex);
  const spanWords = idxs.length ? Math.max(...idxs) - Math.min(...idxs) + 1 : 0;
  rows.push({ file: name + ".mp3", asr: t.asrWords, surahWords, span: spanWords, matched: matchedWords, substituted: substitutedWords, inferred: inferredWords, "repeated words": r.occurrences.filter((o) => o.repeat).length, extra: t.extra, "% of Quran words matched": (100 * matchedWords / surahWords).toFixed(1), "% +substituted": (100 * (matchedWords + substitutedWords) / surahWords).toFixed(1), "% +inferred": (100 * covered / surahWords).toFixed(1), "not covered": surahWords - covered, ayahs: `${ayahsDone}/${ayahTotal}`, complete: r.ayahs.filter((a) => a.complete).length, rejections: r.rejections.length, jumps: r.jumps.map((j) => j.type).join(","), alt: r.alternatives.length, ms: +t.ms.toFixed(0) });
  console.log(`\n== ${name}.mp3: accepted=${r.accepted} cost=${t.cost.toFixed(1)} cells=${t.cells} first=${label(r.occurrences.find((o) => o.kind !== "extra"))} last=${label([...r.occurrences].reverse().find((o) => o.kind !== "extra"))}`);
  for (const j of r.jumps) console.log("  jump", j.type, j.from, "->", j.to, "t=" + j.time.toFixed(1), j.skippedAyahs ? "skipped " + j.skippedAyahs : "", "|", j.reason);
  for (const x of r.rejections) console.log("  REJECT", x.reason, `asr ${x.asrFrom}-${x.asrTo} t=${x.start.toFixed(1)}-${x.end.toFixed(1)} ratio ${x.ratio.toFixed(2)}`, x.detail);
  for (const o of r.occurrences.filter((o) => o.kind === "inferred" || o.kind === "substituted" || o.kind === "extra").slice(0, 400)) if (o.kind === "extra" || o.kind === "inferred") process.env.VERBOSE && console.log("   ", o.kind, label(o), (o.text ?? ""), o.start.toFixed(2));
  const times = r.occurrences.filter((o) => o.kind !== "extra");
  let bad = 0; for (let k = 1; k < times.length; k++) if (times[k].start < times[k - 1].start - 1e-6 || times[k].end < times[k].start - 1e-9) bad++;
  console.log(`  time order violations: ${bad}; alternatives: ${r.alternatives.join(" ") || "none"}`);
}
console.table(rows);
