# Next phase: Quran matching, data, video

Agreed plan as given by the user at the end of the proof-of-concept phase. Nothing here is implemented yet.
Background: [poc-asr/README.md](poc-asr/README.md).

## Inputs from the ASR phase

- Groups of words with absolute timestamps `{index, start, end, words: [{text (diacritized Arabic), timestamp: [start, end]}]}`.
- Words can be missing (dropped looping/empty segments), extra (repeats, Whisper errors), mis-spelled (hamza/alef variants,
  diacritics), and occasionally out of order within a segment (sort by start). See `poc-asr/known-behaviour.md`.
- A basmala at a surah boundary is usually skipped after grouping.

## 1. Quran matching

1. **Normalize** both sides: strip diacritics/tatweel, unify alef/hamza/ya/ta marbuta variants.
2. **Anchor search:** a word-trigram index of the whole Quran (normalized). Find candidate positions for the first
   confident trigrams of the transcript.
3. **Monotonic DP alignment** from the anchor, allowing:
   - small skips (words the model missed),
   - extra words (insertions / Whisper noise),
   - **backward jumps only within the current or previous ayah** (the reciter repeats),
   - **no far jumps.**
4. **Reject** the file if the match ratio is too low, or if a forbidden jump would be needed.
5. A repeated recitation is shown **as recited** (the repeat is displayed, not collapsed).
6. **Missing words** get times inside the gap between neighbouring matched words, or inside an unrecognized segment.
7. **Basmala:** re-transcribe the segment before each new surah on its own (an isolated basmala *is* transcribed);
   otherwise split by silence.

## 2. Data

- Turn the big Quran JSON into: (a) a **small normalized matching index** for the whole Quran; (b) **per-page JSON**
  (604 files) with word id, surah, ayah, line, glyph code.
- **Per-page fonts** (QCF style: one font per mushaf page), supporting several mushaf styles.
- Serve everything as static files from the **same origin** (e.g. Cloudflare Pages) so COEP/CORS stay simple (the app
  runs with COOP `same-origin` + COEP `require-corp` + CORP `same-origin`; cross-origin assets need CORS/CORP). Use R2 only if
  Pages limits are exceeded.
- **Check the fonts' license** before shipping (open item).

## 3. Video

- Canvas rendering + **WebCodecs** encoding + **Mediabunny** (mux/demux); the **same draw function** drives the live
  preview and the export.
- `ffmpeg.wasm` only as a fallback.

## 4. Phases

| Phase | Scope |
|---|---|
| A. Data prep | Matching index, per-page JSON, fonts, licensing check, static hosting layout |
| B. Matching | Normalization, trigram anchor, DP alignment, rejection rules, basmala re-transcription, gap timing |
| C. Preview | Canvas page renderer with word highlighting driven by aligned timestamps |
| D. Export | WebCodecs + Mediabunny export using the same renderer; ffmpeg.wasm fallback |

## Constraints carried over

- Keep COOP/COEP/CORP on every response; new static assets must be same-origin or send CORS/CORP.
- Keep `max_new_tokens` set. A basmala re-transcription call must also pass it.
- Safari uses WASM; Chrome/Edge WebGPU. Do not change defaults without re-measuring.
