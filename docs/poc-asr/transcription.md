# Transcription pipeline

Files: `src/worker.ts`, `src/worker-client.ts`, `src/config.ts`, `src/segment.ts`, `src/transcribe.ts`,
`src/gpu-cleanup.ts`, `src/App.tsx`.

## Worker architecture

- **Main thread** (`App.tsx`): decodes the file with `new AudioContext({sampleRate: 16000})`, takes channel 0 with
  `.slice()` (own `Float32Array`), closes the context, and **transfers** the buffer to the worker (no copy). The file's
  `ArrayBuffer` only lives inside the decode call and the file input is cleared. (Added after the first Safari
  "reloaded because it was using significant memory" report.)
- **`worker-client.ts`**: module-level singleton worker (created once, so React StrictMode does not create two;
  terminated on Vite HMR dispose). `subscribe()` fans messages out; a `recycle` message makes it terminate the worker,
  spawn a new one and resume at `nextIndex` (results live in React state, so nothing is lost). Passes
  `{type:"init", search, vendor: navigator.vendor}` because `navigator.vendor` is `undefined` inside workers (seen in the
  first Chrome log). Logs `worker failed to load` on a worker `error` event.
- **`worker.ts`**: `init` resolves options; `load()` walks the attempts chain; `getPipeline(failed?)` gives the segment
  loop its pipeline and, after a runtime failure, disposes the failed one and moves to the remaining configs;
  `freeGenerateOutputs(asr)` is applied to every pipeline; optional recycling (`pipeline` or `worker`).
  Messages posted: `plan`, `partial`, `segment`, `complete`, `recycle`, `log`, `device`, `progress`, `error`.
- **Never two models in memory**: `disposeCurrent()` (`await asr.dispose()`) runs before every fallback/recycle. A failed
  `pipeline()` call returns nothing to dispose.
- **Single-thread safety net**: if the whole chain fails while `numThreads > 1`, log `falling back to single-threaded
  WASM` and retry the chain with `numThreads = 1` (spawns no nested workers).
- Threads are only set when `self.crossOriginIsolated`; otherwise ORT prints warnings (seen in the Firefox log).

## Config chain (`src/config.ts`, unit-tested by `AILab/test_config.mjs`)

| Browser | Default chain | Why |
|---|---|---|
| Chrome / Edge with WebGPU | WebGPU q4 -> WASM q8 -> WASM q4w | WebGPU fast, memory flat with gpu-cleanup |
| Safari (and every iOS browser, all WebKit) | WASM q8 -> q4w | WebKit WebGPU leaks memory even with recycling; also slow |
| Firefox | WASM q8 -> q4w | Firefox WebGPU hangs on the first transcription call |
| No WebGPU | WASM q8 -> q4w | |

Safari detection: `navigator.vendor` contains "apple", else UA contains "safari" without chrome/chromium/crios/fxios/edg/opr/android/firefox.
Tested UAs: Chrome, Edge, Safari mac, iPad with desktop UA, Chrome on iOS, Firefox, Safari with vendor missing.

URL overrides: `?device=wasm|webgpu` `?dtype=q4|q4w|q8` (setting either runs **exactly that config, no fallback**;
`?device=wasm` alone defaults to q8, `?device=webgpu` alone to q4) `?fallback=1` (keep the default chain after the chosen
config) `?threads=1..8` (default `min(cores, 4)`) `?recycle=off|pipeline|worker` (default off) `?recycleSegments=20`
`?recycleSeconds=300` `?debug=1` (extra logs, collects events on `window.__events` for the CDP harness).

History of the defaults: the first worker used q4 for WebGPU and WASM with q8 as fallback (user request). The user's
Safari/Firefox tests showed WASM q4 fails, so it became WebGPU q4 -> WASM q8; Firefox was then special-cased to WASM;
Safari was moved to WASM after the leak finding; q4w was added as the second WASM fallback.

## Segmentation (`src/segment.ts`)

**Why silence-based:** Whisper only looks at 30 s; naive fixed windows cut words in half and the user wants progressive
results. Cuts go in the middle of silences only, never inside speech; segments may exceed 30 s (those are chunked with
`chunk_length_s: 30, stride_length_s: 5` or Whisper silently drops audio after 30 s).

- 20 ms RMS frames converted to dB; minimum silence 300 ms; segments with < 200 ms of speech dropped.
- **First version: fixed relative threshold.** On `1.mp3` pauses sit at 12-18 % of loud-speech level for ~400 ms; a 6 %
  threshold found no cuts, so 15 % was used.
- **Adaptive threshold (user decision):** floor = 10th percentile dB, speech = 90th percentile dB, threshold =
  floor + 30 % of the range. The floor is clamped to within 45 dB of speech so digital-silence padding does not drag it
  down. Fractions 0.25 and 0.35 gave similar counts, so it is not sensitive.
- **Retry for long regions:** a region > 30 s is re-split with fraction +0.1 steps up to 0.95; if still no pause of 300 ms,
  the longest pause >= 100 ms is used. Forced test (`AILab/test_retry.mjs`, fraction 0.02 on `1.mp3`): 7 -> 8 segments
  with 1 retry; max 5 s -> 19 segments with 8 retries. It never triggered on the real files (longest segment 21 s).
- Logged per run: threshold, floor, speech level, segment count, longest segment, retries.

Segment counts (ffmpeg decode; Chrome's decoder gives slightly different levels, e.g. 27.mp3 = 243 segments in the browser vs 233 here):

| File | Duration | Old fixed 15 % | Adaptive | Longest | floor / speech / used (dB) |
|---|---|---|---|---|---|
| 1.mp3 | 46 s | 7 | 8 | 7.1 s | -29 / -15 / -25.2 |
| 1.mp3 + pink noise | 46 s | 7 | 8 | 7.1 s | -32 / -18 / -28.1 |
| 1.mp3 + reverb | 47 s | 1 | 8 | 7.1 s | -29 / -18 / -25.5 |
| 1.mp3 + heavy reverb | 47 s | 1 | 6 | 14.1 s | -26 / -17 / -23.2 |
| 82.mp3 | 2.2 min | 17 | 26 | 10.7 s | -26 / -10 / -21.1 |
| 51.mp3 | 9.2 min | 69 | 81 | 15.4 s | -31 / -16 / -26.3 |
| 27.mp3 | 27.9 min | 152 | 233 | 20.6 s | -26 / -12 / -22.0 |

The noisy/reverb WAVs (`noisy.wav`, `reverb.wav`, `reverb_heavy.wav`) are local test files, git-ignored.

## Grouping (`groupSegments` in `src/transcribe.ts`)

**Why:** Whisper pads every input to 30 s, so each call has a large fixed cost; 233 short calls are wasteful.
Consecutive silence-delimited segments are merged while the group stays <= 25 s (never > 30 s; a segment longer than
the target stays alone). The first group is at most 2 segments within 8 s so the first result is fast.
Cuts therefore still happen only at silences. There is no URL option for grouping; tests pass `grouping: false` to get one call per segment.

Node CPU, `27.mp3`, q4 (`AILab/compare_grouping.mjs`):

| | Calls | Total | RTF | First result | Words |
|---|---|---|---|---|---|
| Per segment | 233 | 235.9 s | 0.141 | 0.7 s | 1255 |
| Grouped | 82 | 148.7 s | 0.089 | 0.7 s | 1199 |

(37 % less time.) Word timestamps, grouped vs per-segment, over 1,115 matched words: mean 0.069 s, median 0 s, p99 1.26 s,
max 9.7 s; no out-of-order starts in the grouped run. The 56 fewer words were not checked against the Quran text.
In the browser the same file gives 243 segments -> 85 groups, longest group 24.9 s.

**Trade-off:** a basmala in the middle of a file is no longer isolated, so it is usually skipped (see `known-behaviour.md`).

## Streaming

- `onPlan` once (`{total, duration, segments}`); not re-announced after a recycle.
- `TextStreamer` (`skip_prompt: true`) calls `onPartial(index, text)` with timestamp tokens stripped (`<|12.34|>`); only for
  the first attempt of a group (not for the per-segment retry).
- `onSegment(result, {done, total, processedSec})` after each group with absolute timestamps; empty groups are
  reported (so progress advances) but the UI skips rendering them. `complete` at the end.
- UI: finished groups with `start-end` under each word, grey draft below, `<progress>`.
- Per-call log: audio seconds, processing seconds, RTF; at the end `total:`.

## Last-word end bug in Transformers.js 4.3.2 and `fixWordEnds`

Symptom: the last word of a file ended at `20` (46 s clip) or `0` (20 s and 25 s clips, with or without chunking).
Cause: the final EOS token is never fed through the decoder, so it has no cross-attention row; the library pads its
timestamp with `0`, and a word's end is "next token timestamp + chunk time offset" -> `0 + offset`. Offset is 0 for one
chunk and 20 = 30 - 2*5 for the last of several (user's guess about 20 was right, the 0 case was found by testing).
All other timestamps were monotonic and inside the audio duration.

`fixWordEnds(words, segmentEnd, hardEnd)`: a word whose end is missing or not after its start ends at the next word's
start; the last word ends at `speechEnd` (last non-silent frame of the segment) if after its start, else the segment
end, else `start + 0.02`. `speechEnd` was chosen over the segment end because the segment includes half of the following
pause. The two extra fallbacks were added when 51.mp3 produced 3 invalid ends.

## Repetition loops, `max_new_tokens`, unrecognized segments

- **Loop found on `82.mp3`:** segment #11 (51.5-53.9 s, probably one long elongated word «بِالدِّينِ») made the model emit
  `د د د …` for 444 words (432 invalid ends; 526 words from the segmented run vs 81 from the full run).
- **Fix 1:** `max_new_tokens = ceil(min(dur, 30) * 12) + 20` (real speech is ~4 tokens/s).
- **Fix 2:** `isDegenerate`: >= 8 words with one word >= 60 % of them -> output dropped. For a merged group the group is redone
  segment by segment, so only the looping segment is lost. The real word of that segment is lost too; a retry with a
  repetition penalty might recover it (not tried).
- **Unrecognized:** output without Arabic letters (`/[ء-ي]/`) is dropped and logged ("no Arabic letters, dropped").
  On 27.mp3 one segment (#109 in the per-segment run) came back empty.
- **`max_new_tokens` has a second job:** with it set, Transformers.js' Whisper `generate` skips its internal seek loop and
  takes the plain `generate()` path that `gpu-cleanup` can wrap. **Do not remove it.** See `browsers-and-performance.md`.
- Chunking options are only passed when the input is > 30 s.

## Test-file notes

`dbg_*.mjs` and `test_segments.mjs` reproduce per-segment output. The 3-minute test file used early on was 1.mp3 repeated 4
times with silence (no real long recording existed then); real 82/51/27 files replaced it.
