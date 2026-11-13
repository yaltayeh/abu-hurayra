// Round-trip: decode every word of quran-core.bin with src/quran-data.ts and compare with the source files.
// Usage: node --no-warnings scripts/data/verify.mjs   (after python3 scripts/data/build.py)
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseQuranCore } from "../../src/quran-data.ts";

const root = new URL("../../", import.meta.url).pathname;
const src = root + "data/QPC-V2/";
const g = JSON.parse(fs.readFileSync(src + "qpc-v2.json")), h = JSON.parse(fs.readFileSync(src + "qpc-hafs-word-by-word.json"));
const G = Object.values(g).sort((a, b) => a.id - b.id), H = Object.values(h).sort((a, b) => a.id - b.id);
const layout = new DatabaseSync(src + "layout/qpc-v2-15-lines.db");
const pageOf = new Map();
for (const r of layout.prepare("select page_number p, first_word_id a, last_word_id b from pages where line_type='ayah'").all())
  for (let i = +r.a; i <= +r.b; i++) pageOf.set(i, r.p);

const q = parseQuranCore(fs.readFileSync(root + "scripts/data/out/quran-core.bin"));
let bad = 0, firstBad = null;
const fail = (msg) => { bad++; firstBad ??= msg; };
if (q.wordCount !== G.length) fail(`wordCount ${q.wordCount} != ${G.length}`);
for (let i = 0; i < G.length; i++) {
  const w = q.wordAt(i), x = G[i];
  const want = { surah: +x.surah, ayah: +x.ayah, word: +x.word, page: pageOf.get(x.id), glyph: x.text, text: H[i].text };
  for (const k of Object.keys(want)) if (w[k] !== want[k]) fail(`id ${x.id} ${k}: want ${want[k]} got ${w[k]}`);
  if (w.isMarker !== (H[i].text.replace(/[٠-٩]/g, "") === "")) fail(`id ${x.id} isMarker`);
}
console.log(`words: ${G.length} decoded, ${bad} field mismatches`, firstBad ?? "-> 100% match");

// ayah markers: one per ayah, the last word of the ayah, exposed by ayah and by page
let markers = 0, mbad = 0;
for (let s = 1; s <= 114; s++) for (let a = 1; a <= q.surahAyahCount(s); a++) {
  const info = q.ayah(s, a), m = q.ayahMarker(s, a);
  markers++;
  if (!(m.isMarker && m.id === info.markerId && m.surah === s && m.ayah === a && q.wordAt(info.markerId + 0).id === info.markerId)) mbad++;
  if (info.markerId !== G.findLast((x) => +x.surah === s && +x.ayah === a).id - 1) mbad++;
}
let onPages = 0; for (let p = 1; p <= 604; p++) onPages += q.pageMarkers(p).length;
console.log(`ayah markers: ${markers} ayahs, ${mbad} errors; markers across 604 pages: ${onPages}; matching words (markers skipped): ${q.textWordIds.length}`);
if (q.textWordIds.some((id) => q.isMarker(id))) { mbad++; console.log("textWordIds contains a marker"); }
if (bad || mbad || onPages !== 6236 || markers !== 6236 || q.textWordIds.length !== 77432) { console.log("FAILED"); process.exitCode = 1; } else console.log("OK");
