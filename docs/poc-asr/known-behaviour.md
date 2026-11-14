# Known behaviour and quirks

## Basmala

- Whisper (this model) **skips a basmala that is joined to the following speech** in the same window. The first file in
  the project, `1.mp3` (Al-Fatiha), starts with a basmala; the full-file run starts at `الْحَمْدُ` (6.36 s).
- It **does transcribe an isolated basmala**: segment 0-6 s of `1.mp3` alone gives `بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ`
  (the extra 4 words in the first segmented test, 29 vs 25 words). In the 4x-repeated synthetic file only the first copy
  showed it.
- **User decision:** keep basmala-only segments (they carry real word timings); the Quran-matching step decides whether to
  show them. The model card states the "joined: skipped / isolated: transcribed" behaviour.
- **Grouping side effect:** merging up to 25 s means a basmala in the middle of a file (before a new surah) is no longer
  isolated and is usually skipped. Only a basmala that begins the first group survives. **Deferred by the user** to the
  Quran-matching step: re-transcribe the segment before each new surah on its own (see `../next-phase.md`).

## First-word start: Python vs Transformers.js

Python's reference says the first word starts at 0.0 s because it merges the basmala into it; Transformers.js says
6.36 s, the real start of `الْحَمْدُ`. 6.36 s is correct (user confirmed). Every "max timestamp diff 6.36 s" in the
accuracy tables is this word. Mean/median differences vs Python are therefore slightly inflated.

## Timestamp quirks

- **Last word end** is wrong in the library; always corrected by `fixWordEnds` (see `transcription.md`). Never trust the raw end of a segment's final word.
- **Out-of-order word starts** occasionally happen *inside one segment*: at ~532 s a word starts 0.04 s before the previous
  one, at ~578 s 0.64 s before (found in the Node run of `27.mp3` per segment; none in the first 700 s; none in the grouped
  run). It is the cross-attention alignment placing adjacent words in the wrong order, not a segmentation issue. **Sort
  words by start time** before matching if strict order is needed. Segment order is always correct.
- Word end is the next word's start in practice (the DTW alignment gives contiguous words); do not expect pauses inside a group.

## q8 vs q4 vs q4w word differences

- `1.mp3`: q8 omits `صِرَاطَ`; q4/q4w/fp32 are exact. Per-tensor int8 made it worse; per-channel QUInt8 helps (fixed `إِهْدِنَا`).
- With grouped transcription, `1.mp3`/`82.mp3`: all variants 100 % vs fp32. `51.mp3` (360 words): q8 100 % (max diff 0.14 s),
  q4w 99.4 % (max diff 9.28 s, a dropped word).
- On the synthetic repeated-clip 3-minute file, segmented q8 dropped 10 words; not representative of real files.
- Segmented and full-file runs sometimes spell the same word differently (`اهْدِنَا` vs `إِهْدِنَا`) because each sees a
  different context. Quran matching must normalize diacritics/hamza variants.

## Dropped or looping output

- Looping segments are dropped (`82.mp3` segment #11, probably an elongated «بِالدِّينِ»); that word is missing from the output.
  Matching should treat it as a gap.
- Empty output happens (one segment of `27.mp3`); no Arabic letters -> dropped.

## Whisper drops repeated phrases inside one call (found with 18.mp3)

When the reciter says a word or a phrase twice, Whisper often writes it once and the alignment stretches the word before it over the lost
audio (18.mp3: `لَدُنْكَ` 9.1 s, "من لدنك رحمة" said twice; `كَنْزٌ` 6.3 s). Later a person listened to the whole file and listed 12 places
(`scripts/align/fixtures/18-human.json`, scored by `scripts/align/test-human.mjs`); the causes found:

| Loss | Where it happens | What the data showed | Fix (`refineLongWords`, `src/transcribe.ts`) |
|---|---|---|---|
| a phrase said twice inside one 20-25 s group | the group's single Whisper call | the same audio transcribed segment by segment gives both | words of ≥ 4 s: redo the group's segments that word spans, one by one |
| a word said twice with a breath of 0.3-0.7 s | below the silence segmenter's minimum, so one segment, one call | one 3-4 s "word"; an energy dip of 0.4-0.7 s inside it; each side transcribed alone gives the word | a word of 1.8 s+ that has a group segment boundary inside it, or 2.4 s+ with a pause inside (`src/audio-dips.ts`): transcribe each side |
| speech left out entirely | 7 s hole after the last word of a group (the repeat of ayah 74:7-12) | audio is loud, no words | a hole of 1.5 s+ whose audio is mostly voiced is transcribed alone; ≥ 3 words and ≥ 0.4 words/s are inserted |

A refinement replaces the original words only when the result keeps the old words (each found in order, similarity ≥ 0.6) **and** has more
of them; for words under 4 s the added words must also be respellings of the old ones (≥ 0.65). Without these guards elongated words (madd)
split at their natural dips produced garbage on 51.mp3 and 82.mp3 (halves "تسرمون / تجلون" for `تَسْتَعْجِلُونَ`). `?refine=0` disables
everything. Words that still last ≥ 4 s are flagged "long words" in the review page.

Not window length: windows of 13-20 s around the repeat, single Whisper call, did **not** recover it; per silence segment did.

**Results** (Node, q8, `scripts/align/real.mjs` / `test-human.mjs`; "before" = the previous commit's pipeline):

| | before | after |
|---|---|---|
| 18.mp3 words / repeat jumps / extras | 1,670 / 19 / 18 | 1,700 / 32 / 10; 111 ayah completions (110 ayahs + a repeated ayah end) |
| 18.mp3 human cases correct | 0 / 11 | **11 / 11** (+ 1 manual) |
| 1.mp3 | 20 words, 6/7 ayahs (I had assumed the file ended at 1:6:3) | 29 words, 7/7 ayahs: the tail 1:6-7 had been dropped by Whisper |
| 82.mp3 | 81 words, 80 matched, 19/19 | identical |
| 51.mp3 | 360 words, 358 matched, 0 extras | 362 words, 357 matched, 2 extras (`غفِرُونَ`, `وَالْمَحْسَرِ`: garbled halves of two elongated words) |
| 27.mp3 | 1,194 words, 7 repeats (11 with the new aligner), 93/93 | 1,227 words, 20 repeats, 93/93; 19 of the 20 repeats are acoustically closer to their first recitation than every random span (the 20th, 16:32, now has a 0.7 s first span and cannot be judged) |
| transcription time | 18: 217 s, 27: 204 s, 51: 53 s | 361 s (+66 %), 333 s (+63 %), 109 s (+105 %) |

The time cost is the extra Whisper calls (every call pays for a padded 30 s window). `?refine=0` brings the old speed back.

## Unverified claims (do not rely on them)

- Word counts per surah: from memory I said grouped output (81 for surah 82, 360 for 51, 1,199 for 27) "would match" the
  standard counts. **Not verified**; the user must confirm against the Quran text (the next phase does this).
- Quran text accuracy of any transcription was only checked by eye on the first ~12 words of each segment of `82.mp3`
  (correct Al-Infitar) and by comparison with fp32/Python outputs, never against the Quran text.
- `?recycle=worker` was only type-checked/built, never run end to end.
- Memory numbers in Firefox/Safari are user observations; no automated measurement exists.
- Whether the first Safari "significant memory" reload on `1.mp3` came from the failing WASM q4 attempt: unproven.

## Other things a future session must know

- `max_new_tokens` must stay set (GPU cleanup relies on it; also stops loops). See `browsers-and-performance.md`.
- Chrome and ffmpeg decoders give slightly different levels, so segment counts differ (`27.mp3`: 243 browser vs 233 ffmpeg).
- The ORT-web version in the lockfile is 1.31.0-dev.20260914-8d85527a0 (path used by `test_ortweb_wasm.mjs`); the script breaks if the dependency changes.
- Transformers.js 4.3.2 supports per-file dtype objects (used for q4w) and does not have a suffix for `bnb4`; the name
  `decoder_model_merged_bnb4.onnx` is a trick to get a custom file loaded.
- The Hub repo is public; the model card is maintained from `AILab/whisper-quran-onnx/README.md` (git-ignored folder).
  If you edit the card, re-upload it (see `scripts.md`).
- `src/normalize.ts` and `src/types.ts` and `src/components/Progress.tsx` predate this work (user's own files); they were not changed.
