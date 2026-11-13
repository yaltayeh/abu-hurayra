# Proof of concept: on-device Quran ASR

Everything that was built, tried and decided while proving that a browser can transcribe Quran recitation with
word-level timestamps and no server. Written so that a fresh session can continue without the original chat.

Merged in PR #1 (`feat/on-device-quran-asr`). All work happened on 2026-11-13. Times in `decisions.md` are UTC.

## What exists

| Piece | Where |
|---|---|
| Model on the Hub (public) | https://huggingface.co/yaltaieh/whisper-base-ar-quran-onnx |
| App (React + Vite + TS, pnpm) | `src/` |
| Export / quantization / test scripts | `AILab/` (scripts tracked, models/audio/venvs ignored) |
| Test audio (not in git) | `test-tarteel-ai/` : `1.mp3` (46 s, Al-Fatiha), `82.mp3` (2.2 min), `51.mp3` (9.2 min), `27.mp3` (27.9 min), `result.json` (Python reference for 1.mp3) |
| Model card source (not in git) | `AILab/whisper-quran-onnx/README.md` (uploaded to the Hub from there) |

## What the app does

Upload audio/video -> decode to 16 kHz mono on the main thread -> transfer to a worker -> split at silences ->
group into <= 25 s windows -> Whisper (Transformers.js 4.3.2, custom ONNX export) per group -> word timestamps stream
back group by group -> UI shows finished groups (word times) and grey draft text.

## Index

| File | Contents |
|---|---|
| [model.md](model.md) | Model choice, prior failed ONNX exports, the export, variants, accuracy, Hub repo |
| [transcription.md](transcription.md) | Worker architecture, config chain, segmentation, grouping, streaming, timestamp and loop fixes |
| [browsers-and-performance.md](browsers-and-performance.md) | GPU leaks, Safari/Firefox/Chrome behaviour, COOP/COEP, threads, benchmarks |
| [known-behaviour.md](known-behaviour.md) | Quirks a future session must know (basmala, timestamps, spelling, unverified claims) |
| [scripts.md](scripts.md) | Every script in `AILab/`, how to re-run, how to re-export and re-upload |
| [decisions.md](decisions.md) | Chronological decision log |
| [../next-phase.md](../next-phase.md) | Agreed plan for the next phase (Quran matching, data, video) |

## Status summary (honest)

| Area | State |
|---|---|
| Export with cross attentions, fp32/q8/q4/q4w | Done, uploaded, verified in Node (local and from the Hub) |
| Chrome WebGPU q4 / WASM q8 | Measured (headless via DevTools Protocol, plus the user's real-tab logs) |
| Firefox WASM q8, Safari WASM q8 | Measured only through logs the user pasted (`?debug=1`); no automated run possible here |
| Memory behaviour in browsers | Observed by the user (Activity Monitor / `kernel_task`); logs show `mem=n/a` outside Chromium |
| Word counts vs the real Quran text | **Not verified**. Quran matching is the next phase |

## Conventions used by the user in this project

- Package manager: `pnpm`. Never `npm`.
- The user's Python reference venv is `.venv` (for `test-tarteel-ai`); do not touch it. The export venv is `AILab/.venv-export`.
- The user wants real numbers and honest "not verified" notes, not guesses.
