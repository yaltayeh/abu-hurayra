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

When the reciter says a phrase twice inside one group (a group is up to 25 s of silence-delimited segments), Whisper often writes it once
and the alignment stretches the word before it over the lost audio: in 18.mp3 `لَدُنْكَ` lasted 9.1 s (1:46–1:55, "من لدنك رحمة" said twice)
and `كَنْزٌ` 6.3 s (25:44–25:50, "وكان تحته كنز لهما" twice); the review page showed no repeat there. 20 words of 18.mp3 last ≥ 4 s; most were
the same thing (a repeated phrase or a skipped stretch: "قل ربي أعلم بعدتهم…" after `كَلْبُهُمْ` 10 s).
- **Not a window-length effect.** The same audio transcribed one *silence segment* at a time gives both occurrences; a single Whisper call over
  both (even a 13 s window) did not, in the cases tried. Window variants around the long word were unreliable; re-running the group's segments one
  by one was reliable (same path as the existing "group looped" fallback).
- **Fix (`refineLongWords` in `src/transcribe.ts`, on by default, `?refine=0` disables):** for every word of a group lasting ≥ 4 s
  (`src/long-word.ts`), the group's segments that word spans are transcribed one by one; their words replace the group's words of that time
  range only when there are more of them. Pauses and real elongations (same words) are kept.
- **Result on 18.mp3** (Node, q8): 1,616 → 1,670 words, repeat jumps found by the aligner 6 → 19, both reported spots recovered
  (1:46–1:55: "فقالوا ربنا آتنا من لدنك رحمة" twice; 25:44–25:50 the second "وكان تحته كنز لهما"), 110/110 ayahs, 98.3 % of Quran words
  matched. Cost: transcription time +32 % (217 → 286 s for 33 min), +40 % on 27.mp3 (204 → 288 s).
  27.mp3 gained 3 repeats (27:18:13-15, 27:28:6-8, 27:90:4-7), each acoustically as close to its first recitation as the 7 known ones;
  one span at 8:28–8:36 (27:31) now contains slightly garbled words (the old output had one spurious 4.8 s `اللَّهُ`) and is reported as a rejected span.
- Words that still last ≥ 4 s after this are flagged "long words" in the review page.

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
