# Browsers, memory and performance

## 1. WebGPU KV-cache leak in Transformers.js 4.3.2 (`src/gpu-cleanup.ts`)

**Report:** Safari, `27.mp3`, WebGPU q4: results stream fine but memory grows forever; in Activity Monitor it is
`kernel_task` (up to 12.5 GB, mostly swap), not the web content process; eventually Safari reloads the page.
**How found:** the user's WASM q8 run in Safari was flat, so the leak is WebGPU-only. I read the library source
(`modeling_whisper.js`, `DynamicCache`) since Safari/WebGPU cannot run here.
**Cause:**
1. On WebGPU the decoder's `present.*` outputs (KV cache) stay on the GPU as `gpu-buffer` tensors.
2. `generate()` normally disposes the cache at the end but skips this when `return_dict_in_generate` is true, which
   Whisper sets for word timestamps. `DynamicCache.dispose()` exists; nobody calls it.
3. The ASR pipeline only reads `sequences` and `token_timestamps`.
4. ~37 MB per call (mostly the encoder part: 6 layers x key+value x [1, 8, 1500, 64] fp32). 233 segments ~ 8.3 GB,
   matching the observed growth. Cross attentions are CPU tensors and are not part of the leak.

**Fix:** `freeGenerateOutputs(asr)` wraps `asr.model.generate` and disposes every `gpu-buffer` tensor in the returned
object (including inside the cache). Verified with a fake of the library's output (`AILab/test_gpu_cleanup.mjs`):
5,592 tensors freed across 233 calls, 0 failures, CPU tensors never touched. `?debug=1` logs the stats every 10 groups.
**Real WebGPU numbers:** Chrome WebGPU stayed flat (user report; headless Chrome run: 1236 MB at start, 590-650 MB afterwards).

**Why it depends on `max_new_tokens`:** the wrapper only wraps plain `generate()`. Whisper's internal seek loop calls
`super.generate()` and cannot be wrapped from outside. Setting `max_new_tokens` skips that loop, so we stay on the
wrappable path. If someone removes the cap the leak returns.

## 2. Recycling (safety net, default OFF)

`?recycle=pipeline` disposes and recreates the pipeline every N groups / seconds (model files come from the browser
cache); `?recycle=worker` terminates and recreates the whole worker (audio comes back to the main thread without a copy).
Tested with the real model in Node on `82.mp3` recycling every 5 segments: identical output (82 words, same timestamps),
plan announced once, ~0.37 s per recycle. The `worker` mode was only type-checked/built, not run. **In Safari recycling
did not stop the leak (even `recycle=worker`), so it is a WebKit bug**, and recycling is off by default and applies only
on WebGPU.

## 3. Safari: why WASM

User test results: Safari WebGPU q4 is slow (~2.3 s minimum per segment) **and** still leaks with worker recycling;
Safari WASM q8 is flat. WebKit's WebGPU memory accounting (Metal buffers in `kernel_task`) is outside our control, so
Safari is forced to WASM by default. WebGPU on Safari is still reachable with `?device=webgpu`.
The very first Safari complaint ("reloaded because it was using significant memory" on `1.mp3`) was never conclusively
attributed: the default chain at the time tried WASM q4 first, which fails after creating sessions; the chain was fixed
and that exact symptom was not reported again in this session, but the cause was never proven.

## 4. WASM q4 fails: `GatherBlockQuantized`

`Can't create a session. ERROR_CODE: 9, ERROR_MESSAGE: Could not find an implementation for GatherBlockQuantized(1) node
with name '/model/decoder/embed_tokens/Gather_Q4'`. onnxruntime-web's WASM (CPU) provider has no kernel for it;
onnxruntime-node does (that is why the Node test passed); WebGPU worked. Found by the user in Safari, then Firefox;
reproduced in Chrome. Consequences: default chain never uses WASM q4; `q4w` was built (see `model.md`).

## 5. Firefox WebGPU

q4 and q8 on WebGPU hang: console showed `model load end` after ~1 s and then `transcription start` with no result.
WebGPU session creation is lazy, so the stall is the first (shader-compiling) call inside Firefox's WebGPU
implementation. Not investigated further (no timeout-and-fallback added, since a timeout would be a guess). Firefox
defaults to WASM q8. Open question if ever revisited: does the first call ever finish, and does `about:support` list WebGPU?

## 6. Cross-origin isolation and threads

- Multithreaded WASM needs `SharedArrayBuffer`, i.e. `crossOriginIsolated === true`: COOP `same-origin` + COEP `require-corp`.
- Before this, every log had `isolated=false`, so WASM ran **single-threaded** (ORT even warned `env.wasm.numThreads is
  set to 2, but this will not work unless you enable crossOriginIsolated`). That likely explains Firefox's ~3 s minimum per segment (inference; after isolation Firefox ran at RTF 0.22).
- `huggingface.co` model files load under COEP (CORS); verified in Chrome. Anything else cross-origin on the page
  (fonts, analytics) must send CORS/CORP headers.
- **Thread count:** default `min(hardwareConcurrency, 4)`, max 8. On WASM q4w, 8 threads took 49 s against 30 s with 4
  (Chrome). The real count is logged: `model load end ... wasmThreads=N`.
- Production needs three headers on **every** response (HTML, JS, wasm, workers, 304s):
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Resource-Policy: same-origin`. `public/_headers` is in Cloudflare Pages/Netlify format.

## 7. The Vite 304 bug (Safari)

Safari showed: `Refused to load '.../node_modules/.vite/deps/@huggingface_transformers.js?v=…' worker because of
Cross-Origin-Embedder-Policy`. That file is the Transformers.js bundle that onnxruntime-web re-uses as its nested worker
script. `server.headers` in `vite.config.ts` only reached 200 responses: a conditional request
(`If-None-Match`) to that dep got `304 Not Modified` with **no** COOP/COEP. Safari revalidates cached deps and rejects
the nested worker; Chrome/Firefox do not. Found by `curl -I` with and without `If-None-Match` against my own dev server
(port 5199). Fix: an `isolation-headers` Vite plugin that unshifts a middleware setting COOP/COEP/CORP before anything
else in both dev and preview, so even 304/404/504 carry them (checked with curl on 404 and 504; a fresh 304 for the
dep could not be reproduced afterwards because the dep hash kept changing). The user then ran Safari after clearing caches
and on a cached reload: both worked with `crossOriginIsolated=true`, `wasmThreads=4`. The single-thread fallback in the
worker was not needed. Unused next steps (if it breaks again): serve the onnxruntime-web files from `/public` or set the
wasm paths.

## 8. Final benchmark: `27.mp3` (1671.9 s, 243 segments -> 85 groups, `?debug=1`, 4 threads, isolated)

| | Chrome | Firefox | Safari |
|---|---|---|---|
| Config | WebGPU q4 | WASM q8 | WASM q8 |
| Model load | 1.2 s | 1.0 s | 7.4 s (3.1 s on a cached reload) |
| First result after start | 1.9 s | 2.2 s | 11.5 s (6.4 s cached) |
| Processing total | 256.8 s | 366.2 s | 458.2 s |
| RTF | 0.15 | 0.22 | 0.28 |
| Memory | flat (user) | flat (user) | flat on WASM (user) |

Notes: logs show `mem=n/a` outside Chromium, so memory statements come from the user's Activity Monitor observations on
earlier runs, not from these logs. The Chrome log came from a real tab with other work running. Safari's early groups are
slow (RTF 0.89 / 0.53 for groups 1-2, 0.74 / 0.70 / 0.49 for groups 1-3 on the cached run); the whole-file average is 0.28.
The cached Safari run was only seen up to group 3 (no `total:`).

Earlier headless-Chrome runs through DevTools Protocol (`AILab/browser_test.mjs`, 85 groups): WebGPU q4 first result
9.4 s, total 285 s, RTF 0.17, memory 1236 MB at the start then 590-650 MB; WASM q8 4 threads 10.1 s / 277 s / 0.16, ~1000 MB.
Those first-result times include model loading, unlike the per-log "after start" numbers above.

Other timings: Chrome WASM on `82.mp3`: q8 RTF 0.14 vs q4w 0.23. Node CPU `27.mp3` q4: per-segment RTF 0.141, grouped 0.089.
User-measured before multithreading/grouping: Chrome WebGPU RTF 0.14-0.3 (0.6-0.9 s minimum per segment), Firefox WASM
~3 s minimum per segment, Safari WebGPU ~2.3 s minimum per segment.

## 9. Tooling notes

- Chrome was driven headless via the DevTools Protocol with Node 22's built-in WebSocket (`AILab/browser_test.mjs`):
  uploads a file through `<input type=file>`, reads `window.__events`, samples process-tree memory.
- Firefox and Safari cannot be automated from here; the user runs them and pastes console logs (`logs/`, git-ignored).
