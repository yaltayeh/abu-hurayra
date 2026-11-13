# abu-hurayra

Browser app that transcribes Quran recitation on-device (no server): upload audio/video -> word-level timestamps, streamed
group by group. Next phase: match the transcript to the Quran text and render videos.

## Stack
React + Vite + TypeScript, **pnpm** (never npm), `@huggingface/transformers` 4.3.2 (ONNX Runtime Web) in a Web Worker.
Model: `yaltaieh/whisper-base-ar-quran-onnx` on the Hub (export of `tarteel-ai/whisper-base-ar-quran`; scripts in `AILab/`).

## Commands
```bash
pnpm install
pnpm dev                    # http://localhost:5173
pnpm exec tsc -b && pnpm lint && pnpm build   # all must pass
pnpm preview                # production build, same headers
node --no-warnings AILab/<script>.mjs …       # Node tests; see docs/poc-asr/scripts.md (needs ffmpeg)
```

## URL params (testing)
`?debug=1` (logs, `window.__events`) · `?device=wasm|webgpu` · `?dtype=q4|q4w|q8` (device/dtype set -> that config only, no
fallback; add `&fallback=1` to keep the chain) · `?threads=1..8` · `?recycle=off|pipeline|worker` ·
`?recycleSegments=20` · `?recycleSeconds=300`.

Defaults: Chrome/Edge WebGPU q4; Safari and Firefox WASM q8; fallbacks WASM q8 -> q4w.

## Must not break
1. **COOP + COEP + CORP on every response, including 304s** (Vite plugin in `vite.config.ts`, `public/_headers` for production).
   A 304 without COEP made Safari refuse the nested onnxruntime worker. New cross-origin assets need CORS/CORP.
2. **`max_new_tokens` must stay set** in `src/transcribe.ts` (it stops loops and makes Whisper skip its seek loop, which keeps
   `gpu-cleanup.ts` effective; removing it brings back the WebGPU memory leak).
3. **Never default to WebGPU on Safari** (WebKit leaks even with recycling) or on Firefox (hangs). Never use WASM `q4`
   (no `GatherBlockQuantized` kernel in onnxruntime-web).
4. Never keep two models in memory (dispose before fallback/recycle); transfer audio to the worker, don't copy.
5. **Never commit** models (`*.onnx`), audio (`*.mp3 *.wav`), venvs (`AILab/.venv-export`, `.venv`), `logs/`, tokens, or
   `AILab/whisper-quran-onnx/`, `test-tarteel-ai/`. Check `git status` first. Never handle HF tokens; the user runs `hf auth login`.
6. Commits use the GitHub noreply address (the account blocks pushes exposing the private email).

## Where things are
- `src/config.ts` browser defaults · `src/worker.ts` loader/loop · `src/worker-client.ts` replaceable worker ·
  `src/segment.ts` silence segmentation · `src/transcribe.ts` grouping, streaming, fixes · `src/gpu-cleanup.ts` GPU leak fix.
- `src/quran-data.ts` quran-core decoder · `src/normalize.ts` Uthmani-vs-imla'i normalizer · `src/align/` transcript → Quran alignment
  (`docs/alignment.md`; tests: `node --no-warnings scripts/align/synthetic.mjs`, `real.mjs`, `perf.mjs`; data: `scripts/data/README.md`).
- **Read `docs/poc-asr/README.md` first** (why everything is the way it is, what failed, benchmarks, known quirks), then
  `docs/next-phase.md` (agreed plan: Quran matching, data, video).
