# Decision log (chronological)

All on 2026-11-13; times are UTC, taken from the nearest transcript message (approximate, one-hour-or-so granularity for the later entries). "User" = decision by the project owner.

| # | Time | Decision | Reason | Alternatives rejected | Evidence |
|---|---|---|---|---|---|
| 1 | 06:27 | Export with Optimum, opset 18, merged decoder, `accelerate` installed | opset 17 is below optimum's recommended minimum for Whisper; without `accelerate` weights were not deduplicated | opset 17; separate `decoder_model` + `decoder_with_past_model` | merged decoder 314 -> 208 MB after `accelerate` |
| 2 | 06:29 | Patch `WhisperOnnxConfig.outputs` to declare `cross_attentions.0-5` | `output_attentions=True` alone does not add the outputs; that is why public exports fail | relying on `model_kwargs` only | merged decoder has 31 outputs (6 cross attentions) |
| 3 | 06:31 | Quantize the two decoders separately, then `merge_decoders(strict=False)` | `quantize_dynamic` skips `If` subgraphs; the merged decoder stayed 208 MB | quantizing the merged file | q8 decoder 52.9 MB, q4 46.3 MB |
| 4 | 06:35 | q8 uses per-channel QUInt8 | per-tensor dropped/changed words (`إِهْدِنَا`) | per-tensor; per-row embedding quantization (no gain, removed) | 1.mp3 text compare; `صِرَاطَ` still omitted by q8 |
| 5 | 06:39 | Drop fp16 | float16/float mismatch at `/model/decoder/Add_1` (same as Basira); ~145 MB anyway | converting separately (retried; not rescued) | load error; size estimate |
| 6 | 06:40 | Keep the q4 embedding duplicated (~16 MB) | graph rewrite for sharing is untestable on WebGPU in Node | custom rewrite | q4 = 65.0 MB |
| 7 | 06:47 | Public repo `yaltaieh/whisper-base-ar-quran-onnx` (User) | serverless app, browser needs it without a token | private | |
| 8 | 06:48 | Fix the last-word end in code (User asked) | Transformers.js 4.3.2 pads the EOS timestamp with 0 -> `0 + offset` | documenting only | 25 s and 20 s clips -> end 0; 46 s clip -> 20; fixed -> 46.45 s |
| 9 | 06:47 | Describe first-word start 6.36 s as correct (User) | it is the real start of `الْحَمْدُ`; Python merges the basmala | calling it a library artifact | listening/reference |
| 10 | 06:47 | q4 default for WebGPU and WASM, q8 fallback (User) | q4 smaller and more accurate on the 46 s test | | q4 exact, q8 one word off |
| 11 | 06:59 | URL params, per-stage logging, dispose on fallback, audio transfer, single worker (User request after Safari memory reload) | isolate which config dies; never two models in memory | | worker log lines |
| 12 | 07:06 | Default chain WebGPU q4 -> WASM q8; never WASM q4 | user's tests: wasm+q4 fails on `GatherBlockQuantized`; wasm+q8, webgpu+q4/q8 work | keep q4 on WASM | Safari + Firefox + Chrome errors |
| 13 | 07:15 | Firefox defaults to WASM q8 | Firefox WebGPU q4/q8 never return from the first call | timeout + fallback (would be a guess) | user's console log |
| 14 | 07:17 | Only set `numThreads` when `crossOriginIsolated` | removes two ORT warnings | | Firefox log |
| 15 | 07:34 | Segment at silences, stream results segment by segment, TextStreamer drafts (User) | progressive UI, Whisper 30 s limit | fixed windows; cutting in speech | first draft 0.7 s, first segment ~1 s (Node) |
| 16 | 07:44 | Keep basmala-only segments; update model card (User) | they have real word timings; Quran matching decides display | dropping them | isolated basmala transcribed |
| 17 | 07:44 | Adaptive silence threshold (floor p10 + 30 % of range), retry for regions > 30 s (User) | fixed 15 % found 1 segment on reverb files | fixed relative threshold | see segment table in `transcription.md` |
| 18 | 07:51 | `max_new_tokens = ceil(min(dur,30)*12)+20`, drop looping output, last-word fallbacks (beyond the brief; reported) | 82.mp3 looped `د` 444 times (432 invalid ends); 51.mp3 had 3 invalid last ends | repetition penalty (not tried) | 82.mp3: 526 vs 81 words before; 0 invalid ends after |
| 19 | 08:20 | `gpu-cleanup.ts` wraps `generate` and disposes `gpu-buffer` tensors | Transformers.js never disposes the KV cache when `return_dict_in_generate` is set; ~37 MB/call | fixing the library; keeping cross-attentions on GPU | 5,592 tensors freed over 233 fake calls; Chrome flat |
| 20 | 08:21 | Recycling (pipeline / worker), default OFF, WebGPU only | safety net; Safari showed it does not fix the WebKit leak | recycle by default | Node: 0.37 s per recycle, identical output |
| 21 | 08:53 | Safari and Firefox default to WASM; Chrome/Edge to WebGPU q4 (User) | Safari WebGPU leaks even with worker recycling and is slow; Firefox WebGPU hangs | WebGPU on Safari | user test reports |
| 22 | 08:56 | Group segments to <= 25 s, first group <= 2 segments / 8 s (User) | Whisper pads to 30 s; per-call fixed cost | per-segment calls | Node 27.mp3: 235.9 s -> 148.7 s |
| 23 | 08:56 | Thread cap 4 | 8 threads were slower on q4w (49 s vs 30 s) | `hardwareConcurrency` uncapped | Chrome measurement |
| 24 | 08:55 | Build q4w (int8 embedding) | WASM has no `GatherBlockQuantized` | | loads in ORT-web WASM; 99.4-100 % vs fp32 |
| 25 | 09:10 | WASM default stays q8 although q4w matched q4 (User agreed later) | q8 RTF 0.14 vs 0.23, 3 MB smaller, 100 % vs 99.4 % | q4w default (the user's stated rule) | Chrome 82.mp3; 51.mp3 compare |
| 26 | 09:26 | COOP + COEP headers (dev, preview, `public/_headers`) | multithreaded WASM; every log had `isolated=false` | single-threaded | Chrome `wasmThreads=4` |
| 27 | 10:07 | Replace the old fp32 files on the Hub with the cross-attention export (User) | old decoder had 25 outputs, 0 cross attentions | deleting them | Hub test: 25 words exact text |
| 28 | 10:07 | Leave the mid-file basmala for the Quran-matching step (User) | matching knows where a surah begins | handling it now | |
| 29 | 11:55 | Set COOP/COEP/CORP in a Vite middleware on every response; single-thread fallback; log worker load errors (User listed causes) | Safari rejects the nested worker when the 304 reply lacks COEP | `server.headers` only | curl 200 vs 304; Safari log after fix: works |
| 30 | after 12:08 | Commit with GitHub noreply email; scaffold commit on `main` as PR base | push rejected for private email; repo had no commits | rewriting global git config | PR #1 |
