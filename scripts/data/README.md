# Quran data (QPC V2) and matching normalization

Scripts that turn the QUL "QPC V2" exports into the single file the browser downloads (`quran-core.bin`), verify it,
and measure how well the normalizer bridges the Uthmani text and the model's spelling. Decoder: `src/quran-data.ts`.
Normalizer: `src/normalize.ts`. Nothing here is wired into the UI yet.

## Source files (not in git: `data/` is ignored)

Expected at `data/QPC-V2/` (downloaded from Tarteel's QUL exports; URLs are listed in the untracked `resources.md`):

| File | Content | Origin (QUL export) |
|---|---|---|
| `qpc-v2.json` | per word: `id, surah, ayah, word, location, text` where `text` is the QCF v2 glyph string (private-use code points U+FC41…) | "QPC V2 Glyph - Word by Word" (`…/quran-script/1748436812-314xq-qpc-v2.json.zip`) |
| `qpc-hafs-word-by-word.json` | same ids, `text` = Uthmani Arabic word (KFGQPC Hafs) | "KFGQPC Hafs script - Word by word" (`…/1748437073-fifcb-qpc-hafs-word-by-word.json.zip`) |
| `layout/qpc-v2-15-lines.db` | SQLite, table `pages(page_number, line_number, line_type, is_centered, first_word_id, last_word_id, surah_number)` | QUL layout export for QPC V2, 15 lines |
| `woff2/p1.woff2 … p604.woff2` (also `woff/`, `ttf/`) | one font per mushaf page | "QPC V2 Font" (woff2 zip, ttf zip, woff zip) |

The build needs only the two JSON files and the layout db. The fonts are for deployment (see below).
**The font license has not been checked** (open item in `docs/next-phase.md`).

Facts about the sources (checked by `build.py` assertions):

- 83,668 word ids = 77,432 real words + 6,236 **ayah-end markers** (one per ayah, the last word of the ayah; own id, own glyph;
  in the Hafs file the text is the ayah number in Arabic-Indic digits). 114 surahs, 6,236 ayahs, 604 pages.
- **The JSON key order is not canonical** (ids jump 6 → 39 → 6442 …). Sort by `id`; then ids are 1..83668 and the order is the
  mushaf order (0 breaks).
- Glyph codes are sequential within each page and every page starts at U+FC41, so they are derived from page + position.
  A word occupies 1 code (79,154 words), 2 (4,510) or 3 (4) codes (waqf signs and `۞` have their own code); that is not
  derivable from the text (32 exceptions to the obvious rule), so the 4,514 irregular word indexes are stored.
- Hafs text of 209 words contains a space (`۞ إِنَّ`), so the text separator is `|`.

## Rebuild

```bash
python3 scripts/data/build.py              # -> scripts/data/out/quran-core.bin (stdlib only)
python3 scripts/data/build.py --candidates # also quran.sqlite and quran-core.json (the formats compared below)
node --no-warnings scripts/data/verify.mjs # decode every word with src/quran-data.ts, compare with the sources
```

`out/` is git-ignored: the bin is a build product. Copy it to `public/data/quran-core.bin` when the app uses it
(serve it same-origin; the app is COEP `require-corp`).

## Format (`quran-core.bin`, 1,345,214 B)

`"QCR1"` + six sections, each `[u32 length][bytes]`, little endian:
`surahAyahs` (114 × u16) · `ayahWords` (6,236 × u8, words per ayah incl. the marker) · `pageDelta` (604 × u8, words per page)
· `multiDelta` (varint deltas of the word indexes with ≠ 1 glyph code) · `multi3` (varint indexes with 3 codes) ·
`text` (UTF-8 Uthmani text of the 77,432 real words joined by `|`; markers are not stored: their text is the ayah number).
Word id = index over all 83,668 words. Everything else (surah/ayah/word, page, glyph, marker position) is derived.

`src/quran-data.ts` exposes, per ayah, the marker needed for rendering (`ayah(s,a)`, `ayahMarker(s,a)`, `pageMarkers(p)`),
and `textWordIds` / `textWords` (markers skipped) for matching.

## Format comparison (Chrome headless, localhost, median of 7; compressed = gzip -9 / brotli -q11)

| | SQLite (6 cols) | compact JSON | **compact binary** |
|---|---|---|---|
| raw | 3,222,528 | 1,364,417 | **1,345,214** |
| gzip / brotli | 1,312,136 / 963,750 | 275,709 / 187,525 | 274,587 / **185,364** |
| runtime | sql.js 660 KB wasm + 49 KB JS (brotli 278 + 15 KB); wa-sqlite 236 + 13 KB | none | none |
| parse (+ table build) | 9.5 ms wasm init + 9.5 ms open (first) | – | 3.8 + 11 ms first, 3.5 + 5.3 ms warm |
| lookup id → all fields | 6.5 µs | – | 0.15 µs |
| full scan | 29 ms (83,668 rows) | – | 0.3 ms (77,432 words, trigram compare) |
| round trip vs sources | 83,668 words, 0 mismatches | 0 | **0** |

The benchmark harness (a throwaway page + sql.js installed outside the repo) is not kept; the numbers above are what it printed.
Fetch time was localhost, so network time is excluded.

## Normalization (`src/normalize.ts`)

The Quran text is Uthmani; the model writes closer to imla'i spelling. Both sides go through `normalize()`.
Steps (named, ordered; each measured below):

| Step | Effect | Example |
|---|---|---|
| `kashidaHamza` | hamza on a tatweel after a ya → ي | شَيۡـٔٗا ~ شيئا |
| `wawDagger` | و directly followed by dagger alef → ا (silent waw spelled as alef) | ٱلصَّلَوٰةَ ~ الصلاة |
| `yaDaggerFinal` | final ى + dagger alef → ى | مُوسَىٰ ~ موسى |
| `yaDaggerMedial` | medial ى + dagger alef → ا | أَدۡرَىٰكَ ~ أدراك |
| `alefless` | dagger alef is **removed** (not restored) in a closed word list: هذا هذه ذلك الرحمن إله لكن أولئك هؤلاء هكذا (+ prefixes) | ٱلرَّحۡمَٰنِ ~ الرحمن |
| `daggerAlef` | any other dagger alef → ا | ٱلۡكِتَٰبُ ~ الكتاب |
| `base` | remove tashkeel, small signs, tatweel, ۞ ۩, standalone hamza, spaces; ٱأإآ→ا, ؤ→و, ئىی→ي, ة→ه | |
| `dropMedialAlef` (loose tier only) | drop alefs that are neither first nor last letter | قال → قل |

Two bugs found on the way (both fixed, kept here because they look right at first): a waw/ya that carries its own vowel before
the dagger is a real letter (سَمَٰوَٰتِ, يَٰقَوۡمِ), so `wawDagger`/`yaDagger*` only fire when the dagger directly follows;
and the Quranic sukun U+06E1 is outside U+064B-065F, so mark classes must include U+06D6-06ED.

`normalize()` = strict (all steps except `dropMedialAlef`). `normalizeLoose()` = strict + `dropMedialAlef`.

### Evaluation on real model output

`node --no-warnings scripts/data/norm-eval.mjs <asr-dir>` with `AILab/dump_transcript.mjs` (Node, q8, the current grouped
pipeline) and `AILab/dump_segments.mjs` outputs for `test-tarteel-ai/{1,82,51,27}.mp3` (surah = file number). Words are
aligned to the surah text by a similarity DP (loose key, 1-1 / split / merge / extra / skipped), so every rule set is scored on the same pairs.
**Caveats:** 1,655 ASR words, 72% from one file (27.mp3); ground truth is my own alignment, not a human check; the model is q8.

| rule set | exact 1-1 (% of ASR words) | exact of aligned 1-1 | distinct normalized Quran words | base forms merged | unique 3-grams / 4-grams |
|---|---|---|---|---|---|
| 0 base (previous normalizer) | 87.4% | 90.9% | 14,542 | 0 | 75.58% / 86.22% |
| + kashidaHamza | 87.5% | 91.0% | 14,543 | 0 | 75.58% / 86.22% |
| + wawDagger | 87.6% | 91.1% | 14,544 | 0 | 75.58% / 86.22% |
| + yaDaggerFinal | 87.6% | 91.1% | 14,544 | 0 | 75.58% / 86.22% |
| + yaDaggerMedial | 88.0% | 91.6% | 14,562 | 0 | 75.58% / 86.22% |
| + daggerAlef | 92.5% | 96.2% | 14,664 | 88 | 75.54% / 86.18% |
| **+ alefless (strict, default)** | **93.9%** | **97.7%** | 14,663 | 88 | 75.54% / 86.18% |
| + dropMedialAlef (loose) | 94.4% | 98.2% | 13,980 | 1,130 | 75.44% / 86.12% |
| alt: dropNonInitialAlef instead | 94.7% | 98.6% | 13,115 | 2,684 | 75.07% / 85.94% |

"Base forms merged" = how many of the 14,542 distinct `base` forms share their normalized form with a different one (strict: 60
colliding forms touching 773 of 77,432 occurrences, e.g. قال/قل; loose: 558 forms, 10,936 occurrences, e.g. قال/قل, كان/كن, في/فاي).
A 3-gram of the strict form is unique in the Quran for 75.5% of positions (4-gram 86.2%); the rest recur (repeated verses).

**Trigram anchor** (first words of every unit; hit = the correct Quran position is among the candidates; "scored" = starts whose
first words are 1-1 aligned):

| rule set | unit | starts / scored | 3-gram@0 hit | …and unique | 4-gram@0 | 5-gram@0 | any 3-gram in first 5 words |
|---|---|---|---|---|---|---|---|
| previous | group | 118 / 97 | 69.1% | 42.3% | 60.8% | 57.7% | 81.3% |
| previous | segment | 319 / 295 | 71.2% | 48.5% | 64.1% | 59.0% | 84.3% |
| strict | group | 118 / 97 | 87.6% | 56.7% | 84.5% | 83.5% | 95.5% |
| strict | segment | 319 / 295 | 89.5% | 63.1% | 86.8% | 83.1% | 93.9% |
| loose | group | 118 / 97 | 89.7% | 57.7% | 87.6% | 87.6% | 95.5% |
| loose | segment | 319 / 295 | 91.5% | 63.1% | 88.8% | 85.4% | 94.2% |

Reading: a group's first 3 words find the right place in 88-90% of cases, in 95% if the next two windows are also tried; but
only ~57-63% of the time is the hit the *only* candidate, so the aligner must still choose among candidates (repeated verses).

### Mismatches left with the strict form (top of the list; 32 distinct pairs in total)

```
 1.   5x  االه  |  اله
 2.   3x  الملا  |  الملوا
 3.   2x  الليل  |  اليل
 4.   2x  داوود  |  داود
 5.   1x  يسالون  |  يسلون
 6.   1x  بايد  |  باييد
 7.   1x  طسم  |  طس
 8.   1x  الاخره  |  الاخسرون
 9.   1x  حسن  |  حسنا
10.   1x  سحرون  |  سحر
11.   1x  ممله  |  نمله
12.   1x  رباوزعني  |  اوزعني [split]
13.   1x  لاذبحنه  |  لااذبحنه
14.   1x  احطفات  |  احطت [split]
15.   1x  عرض  |  عرش
16.   1x  تخرجون  |  تخفون
17.   1x  اصبقت  |  اصدقت
18.   1x  الله  |  الا
19.   1x  اولو  |  اولوا
20.   1x  واولو  |  واولوا
21.   1x  اتاني  |  اتان
22.   1x  ااشكر  |  اشكر
23.   1x  وقيل  |  قيل
24.   1x  تفرحون  |  تفتنون
25.   1x  ثملنقولن  |  لنقولن [split]
26.   1x  قل  |  قليلا
27.   1x  يبدا  |  يبدوا
28.   1x  ااذا  |  اذا
29.   1x  اسراييل  |  اسرايل
30.   1x  بهاد  |  بهادي
31.   1x  جاوا  |  جاو
32.   1x  اتلو  |  اتلوا
```

What remains is mostly real ASR error or spelling the rules cannot decide: `االه|اله` (أَءِلَٰه: ASR writes two alefs), `الملا|الملوا`,
`داوود|داود`, silent alef after waw (`اولو|اولوا`, `يبدا|يبدوا`), doubled ya (`بايد|باييد`), and `يا`+`أيها` split in two words
(exact after joining; counted separately as "split").

The same list for the previous normalizer (top 50) is reproducible with `--steps x`; its leaders were `ياايها|يايها` (split, 6×),
`سليمان|سليمن` (5×), `االه|اله` (5×), `السماوات|السموت` (4×), then `العالمين|العلمين`, `ايات|ايت`, `عاقبه|عقبه`, `الملا|الملوا`,
`باياتنا|بايتنا` (3× each): almost all are the dagger alef that the imla'i spelling writes as ا.

## Deployment note for fonts

Serve only the woff2 files, same origin, as `fonts/<style>/p001.woff2 … p604.woff2` (zero-padded; the source files are
`p1.woff2`). The renderer picks the font by `QuranWord.page`. Not done yet.
