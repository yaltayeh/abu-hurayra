# Scripts in `AILab/`

Tracked: the `.py` and `.mjs` scripts. Ignored: `.venv-export/`, `.hub-cache/`, `export-fp32/`, `out*/`, `ref-fp32/`,
`tmp/`, `whisper-quran-onnx/`, `__pycache__/`, `*.wav`, `*.onnx`. Run all `.mjs` from `AILab/` (they use relative paths)
with `node --no-warnings`; scripts that import `../src/*.ts` rely on Node 22 type stripping (the repo allows
`erasableSyntaxOnly` and `.ts` imports). They need `ffmpeg` on PATH to decode audio.
Python scripts run in `AILab/.venv-export` (`optimum`, `onnx`, `onnxruntime`, `accelerate`, `numpy`), **not** the user's `.venv`.

Two debug scripts used for the last-word bug (`probe.mjs`, `probe2.mjs`) were deleted after use and are not in the repo.

## Export and quantization (Python)

| Script | What | Usage / output |
|---|---|---|
| `export.py` | Optimum export with cross-attention outputs patched in, opset 18, task `automatic-speech-recognition-with-past` | `python export.py` -> `export-fp32/` (encoder, merged decoder, tokenizer/config files) |
| `quantize_q8.py` | int8 per-channel QUInt8; decoders quantized separately then merged (`strict=False`) | `python quantize_q8.py [outdir=out/onnx] [pc\|pt] [s8]` -> `encoder_model_quantized.onnx`, `decoder_model_merged_quantized.onnx` |
| `quantize_q4.py` | MatMulNBits (block 32, symmetric) + GatherBlockQuantized | `python quantize_q4.py [outdir=out-q4/onnx] [asym]` |
| `quantize_q4_wasm.py` | q4w: 4-bit MatMuls + int8 per-row embedding (no GatherBlockQuantized) | -> `decoder_model_merged_bnb4.onnx` (out-q4w/) |

## Verification and measurement (Node)

| Script | What | Usage |
|---|---|---|
| `test_node.mjs` | Original verification: transcribe `1.mp3` with a variant, compare to `result.json` (sizes, text match, mean/median/max ts diff) | `node test_node.mjs <local\|remote> <folder-or-repo> <dtype> [device]` |
| `test_hub_default.mjs` | Loads from the Hub with a fresh `.hub-cache` (no dtype or given dtype), checks word timestamps vs the reference | `node --no-warnings test_hub_default.mjs [dtype]` |
| `test_segments.mjs` | Segmented transcription vs full run, ts diff, invalid ends | `node --no-warnings test_segments.mjs <audio> <local\|remote> <dtype>` (`SKIPFULL=1` skips the full run) |
| `test_segmentation.mjs` | Segmentation only (no model): counts, threshold, longest segment | `node --no-warnings test_segmentation.mjs files…` |
| `test_retry.mjs` | Forces the long-region retry path (low thresholds, max length) | `node --no-warnings test_retry.mjs` (needs `reverb_heavy.wav`) |
| `compare_grouping.mjs` | Grouped vs per-segment: calls, time, RTF, ts diff | `node --no-warnings compare_grouping.mjs <audio> [dtype]` |
| `compare_variants.mjs` | Accuracy of dtypes vs fp32 on a file | `node --no-warnings compare_variants.mjs <audio> [fp32 q4 q4w q8]` |
| `test_gpu_cleanup.mjs` | Unit test of `freeGenerateOutputs` with a fake GPU result | `node test_gpu_cleanup.mjs` |
| `test_recycle.mjs` | Pipeline dispose + recreate every N segments with the real model | `node --no-warnings test_recycle.mjs <audio> <N>` |
| `test_config.mjs` | Config/browser detection across user agents | `node test_config.mjs` |
| `test_ortweb_wasm.mjs` | Creates sessions with the real onnxruntime-web WASM backend (what rejected q4) | `node test_ortweb_wasm.mjs <onnx files…>` |
| `dbg_segments.mjs`, `dbg_mono.mjs` | Per-segment output; `dbg_mono` transcribes `[start, start+len]` of a file | `node --no-warnings dbg_mono.mjs <audio> <start> <len>` |
| `energy.mjs` | Percentiles and silence profile of a file (used to tune the threshold) | `node energy.mjs <audio>` |
| `mem.mjs` | RSS after load / run per dtype in Node | `node --no-warnings mem.mjs <dtype>` |
| `browser_test.mjs` | Headless Chrome via DevTools Protocol against `vite preview`; uploads audio, collects console + `window.__events`, samples process memory | `node --no-warnings browser_test.mjs "<query>" <audio> [timeoutSec] [--headed]` |

Local-model scripts read from `AILab/whisper-quran-onnx/` (`env.localModelPath`, `allowRemoteModels = false`).

## Re-export, re-quantize, re-upload

```bash
cd AILab && source .venv-export/bin/activate
python export.py                       # -> export-fp32/
python quantize_q8.py out/onnx
python quantize_q4.py out-q4/onnx
python quantize_q4_wasm.py out-q4w/onnx
# assemble whisper-quran-onnx/ (config/tokenizer/preprocessor from export-fp32, generation_config.json from openai/whisper-base,
# onnx/ with: encoder_model.onnx, decoder_model_merged.onnx (fp32), *_quantized, *_q4, decoder_model_merged_bnb4.onnx)
node --no-warnings test_node.mjs local whisper-quran-onnx q8      # and q4; sizes + text + timestamps
hf auth login                                                    # the user does this themselves; never handle tokens
python - <<'EOF'
from huggingface_hub import HfApi
HfApi().upload_folder(folder_path="whisper-quran-onnx", repo_id="yaltaieh/whisper-base-ar-quran-onnx", repo_type="model")
EOF
node --no-warnings test_hub_default.mjs                           # verify from the Hub
```

Check a decoder has cross attentions before uploading (an fp32 without them silently breaks default-dtype loads):
```python
import onnx; m = onnx.load("onnx/decoder_model_merged.onnx", load_external_data=False)
print(sum(o.name.startswith("cross_attentions") for o in m.graph.output))   # expect 6 (31 outputs in total)
```
Sizes to expect: `encoder_model.onnx` 82,427,000 B, `decoder_model_merged.onnx` 208,343,667 B, `encoder_model_quantized` 23,297,122 B,
`decoder_model_merged_quantized` 52,852,969 B, `encoder_model_q4` 18,731,373 B, `decoder_model_merged_q4` 46,306,133 B,
`decoder_model_merged_bnb4` 60,566,201 B.

The exact CLI used for the upload and the venv's package versions were not recorded in the session; the snippets above are
the straightforward equivalents, not a transcript.
