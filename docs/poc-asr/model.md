# Model: choice, export, variants, Hub repo

## Why `tarteel-ai/whisper-base-ar-quran`

Whisper-base fine-tuned on Quran recitation by Tarteel AI (Apache-2.0). It is small enough for the browser
(74 M parameters, see sizes below) and it already works in Python for the user (`test-tarteel-ai/main.ipynb`,
reference output `test-tarteel-ai/result.json`). The user chose it; no other model was compared in this session.

## Prior failed attempts (background supplied by the user, not reproduced in this session)

The user's task description listed these as the reason a custom export was needed. Only the fp16 failure was
re-reproduced here (see below).

| Problem | Source | Notes |
|---|---|---|
| Existing public ONNX export (`iqbalaesthetic/Basira`) fails in Transformers.js: `Model outputs must contain cross attentions to extract timestamps...` | user | The export has no `cross_attentions.*` outputs, so `return_timestamps: "word"` cannot work |
| Basira fp16 decoder fails with a float16/float type mismatch | user, then re-reproduced | Same failure in our own fp16 attempt (below) |
| The model's own `generation_config.json` is incomplete: `is_multilingual: false`, no `lang_to_id`, `task_to_id`, `alignment_heads` | user | Without those Transformers.js cannot set language/task tokens; the user mentioned garbage output such as `eng!eng!`. We did not reproduce this; we avoided it by shipping the `openai/whisper-base` generation config |
| `scripts/convert.py` no longer exists in transformers.js | user | So we used Hugging Face Optimum directly |

## Python reference

The user's Python code replaces the generation config with `GenerationConfig.from_pretrained("openai/whisper-base")`
and runs the HF pipeline with `return_timestamps="word", chunk_length_s=30, generate_kwargs={"language":"arabic","task":"transcribe"}`.
Result for `1.mp3`: 25 words (Al-Fatiha) in `result.json`. Python merges the basmala into the first word, so its first
word starts at 0.0 s; Transformers.js (correctly) starts `الْحَمْدُ` at 6.36 s. This is the reference every Node test
compares against.

## The export (`AILab/export.py`)

1. **Optimum export**: `main_export(..., task="automatic-speech-recognition-with-past", model_kwargs={"output_attentions": True})`.
   First run worked but warned that opset 17 is below the recommended minimum and that weight deduplication was skipped
   because `accelerate` was missing. Fix: opset 18 and `pip install accelerate`. Size of the merged decoder dropped
   from 314 MB to 208 MB (shared token embedding stored once).
2. **Cross attentions**: `output_attentions=True` alone did **not** add `cross_attentions.*` to the ONNX outputs. That
   is exactly why the public exports fail. The script monkeypatches `WhisperOnnxConfig.outputs` to declare
   `cross_attentions.0 … cross_attentions.5` (dynamic axes `{0: batch_size, 2: decoder_sequence_length, 3: encoder_sequence_length}`)
   for `ConfigBehavior.DECODER`. Verified in the graph: the merged decoder has 31 outputs, 6 of them cross attentions.
   (How we found it: read how optimum builds the decoder output list, then added the entries ourselves.)
3. **Merged decoder**: one `decoder_model_merged.onnx` (If-subgraph choosing first-step vs with-past) instead of shipping
   `decoder_model` + `decoder_with_past_model`.
4. **generation_config.json** comes from `openai/whisper-base`; `config.json`, tokenizer files and
   `preprocessor_config.json` are from the fine-tuned model.

Output of the export is in `AILab/export-fp32/` (fp32 encoder 82,427,000 bytes, merged decoder 208,343,667 bytes).

## Variants

| Name (`dtype`) | Files | Size enc + dec | Runs on | Why it exists |
|---|---|---|---|---|
| `fp32` (default dtype) | `encoder_model.onnx`, `decoder_model_merged.onnx` | 82.4 + 208.3 = 290.7 MB | everywhere | Reference; makes the default dtype give word timestamps |
| `q8` | `*_quantized.onnx` | 23.3 + 52.9 = 76.2 MB | WASM + WebGPU | int8; **WASM default** |
| `q4` | `*_q4.onnx` | 18.7 + 46.3 = 65.0 MB | WebGPU, Node | Smallest; WebGPU default. **Not WASM** |
| `q4w` (`{encoder_model:"q4", decoder_model_merged:"bnb4"}`) | `encoder_model_q4.onnx` + `decoder_model_merged_bnb4.onnx` | 18.7 + 60.6 = 79.3 MB | WASM + WebGPU | 4-bit that works on WASM; fallback |
| fp16 | – | ~145 MB (estimate) | – | **Dropped** |

### q8 (`AILab/quantize_q8.py`)
- `quantize_dynamic`, **per-channel QUInt8**. It skips `If` subgraphs, so on the merged decoder it left the file at
  208 MB (first attempt). Fix: quantize `decoder_model` and `decoder_with_past_model` separately, then merge them
  with `merge_decoders(strict=False)` (Optimum itself merges with `strict=False` because the with-past graph omits
  the encoder presents). Result 52.9 MB with the tied embedding shared.
- Accuracy history on `1.mp3`: per-tensor quantization dropped words. Per-channel fixed `إِهْدِنَا`. The word
  `صِرَاطَ` is still omitted by q8 on `1.mp3`. Diagnosis: quantizing either encoder or decoder alone flips the same
  close call, and putting fp32 for one half did not fix it, so it looks like int8 noise rather than one broken part.
  Quantizing only the MatMuls kept the text intact, pointing at the embedding/logits path, but a per-row embedding
  quantization experiment did not help and was removed.
- Later, with grouped transcription: q8 matched fp32 on 100 % of words on `1.mp3`, `82.mp3` and `51.mp3` (360 words,
  max timestamp diff 0.14 s). On the synthetic 3-minute file (1.mp3 repeated 4 times with silences) segmented q8 was
  worse (dropped 10 words, max timestamp diff 9.1 s). The synthetic file is a poor test; real files agree with fp32.

### q4 (`AILab/quantize_q4.py`)
- `MatMulNBitsQuantizer`, block size 32, symmetric, plus `GatherBlockQuantized` for the token embedding.
- Exact text on `1.mp3` (mean/median timestamp diff 0.66 / 0.24 s vs Python).
- The embedding is stored twice (~16 MB extra) because Gather and the logits MatMulNBits need different packed
  layouts. A graph rewrite to share them was judged too risky since WebGPU could not be tested in Node.
- **Fails on onnxruntime-web WASM**: `Could not find an implementation for GatherBlockQuantized(1) node with name
  '/model/decoder/embed_tokens/Gather_Q4'` (found by the user in Safari and Firefox, reproduced in Chrome). It works in
  Node (onnxruntime-node has the kernel) and on WebGPU. My first claim that "both ORT-web wasm builds ship the kernel"
  was wrong: the kernels are inside the wasm binaries, which I could not inspect usefully.

### q4w (`AILab/quantize_q4_wasm.py`)
- Un-shares the logits weight, applies MatMulNBits to every MatMul (block 32, symmetric), then replaces the embedding
  `Gather` with int8 `Gather + Cast + Gather(scales) + Unsqueeze + Mul` (per-row symmetric int8). Standard ops only.
- File name `decoder_model_merged_bnb4.onnx` is only because Transformers.js has no suffix for it; `bnb4` maps to `_bnb4`.
  Shares the q4 encoder, so the dtype is a per-file object.
- Verified with the real onnxruntime-web WASM runtime in Node (`AILab/test_ortweb_wasm.mjs`) and in Chrome.
- Accuracy vs fp32 (grouped, Node): `1.mp3` and `82.mp3` 100 %; `51.mp3` 99.4 % (max timestamp diff 9.28 s).

### fp16 (dropped)
Fails to load with the same float16/float mismatch as Basira, at `/model/decoder/Add_1`. The converter skips the `If`
subgraphs of the merged decoder. A retry converting the two decoders separately and merging was made; the final
outcome recorded in the session is "fp16 dropped" (the exact result of that retry was not written down).
It would also be ~145 MB, bigger than q8 and q4.

## Accuracy numbers (Node CPU, `@huggingface/transformers` 4.3.2)

`1.mp3`, ungrouped, vs the Python reference (last-word end excluded):

| Variant | Total | Text | Mean / median ts diff | Max |
|---|---|---|---|---|
| fp32 | 290.7 MB | exact | 0.65 s / 0.24 s | 6.36 s (first word, basmala merged in Python) |
| q4 | 65.0 MB | exact | 0.66 s / 0.24 s | 6.36 s |
| q8 | 76.2 MB | 1 word omitted (`صِرَاطَ`) | 0.92 / 0.40 s locally, 1.04 / 0.66 s from the Hub | 6.53 s |

Grouped, vs fp32 (`AILab/compare_variants.mjs`): q4, q4w, q8 all 100 % on `1.mp3` and `82.mp3`; on `51.mp3` q4w 99.4 %,
q8 100 %.

## Why q8 is the WASM default

User asked for q4w to be the WASM default if it matched q4; it did match, but q8 was kept (user later agreed):
- Chrome, `82.mp3`, 4 threads: q8 RTF **0.14** vs q4w **0.23** (1.6x faster).
- q8 is 3 MB smaller than q4w (76.2 vs 79.3 MB) and at least as accurate (100 % vs 99.4 % on `51.mp3`).
- The premise "q4 is more accurate and smaller" was measured on the ungrouped 46 s clip; after grouping it no longer holds.
- `WASM_DEFAULT` in `src/config.ts` flips it; q4w stays as `?dtype=q4w` and as the second WASM fallback.

## Memory (Node, indicative)

Loading adds ~230 MB (q4) / ~320 MB (q8) RSS for 65 / 76 MB of files (q8 keeps an fp32 copy of the 106 MB embedding
in its graph). Running a 46 s clip adds 400-500 MB (peak ~0.8 GB). Disabling the ORT memory arena saved ~10 %.
Whisper's encoder always processes a padded 30 s window, so activation memory does not depend on clip length.

## The Hub repo

`yaltaieh/whisper-base-ar-quran-onnx`, public (the app is serverless, so the browser must load it without a token).
- Layout: `config.json`, `generation_config.json`, `preprocessor_config.json`, `tokenizer.json`, `tokenizer_config.json`,
  `README.md`, `onnx/` with the files in the table above.
- **Pre-existing fp32 files**: the repo already contained the user's old `onnx/decoder_model_merged.onnx` (314 MB) and
  `onnx/encoder_model.onnx` (82 MB) from an earlier "Upload folder" commit (05:06 UTC). My first upload used
  `exist_ok=True` and did not notice. The old decoder had 25 outputs and **0 cross_attentions**, so loading without a
  `dtype` could not give word timestamps. At the user's request they were replaced by the cross-attention fp32 export
  (commit `9a3926d3…`).
- **Verified from the Hub** (fresh `AILab/.hub-cache`, `AILab/test_hub_default.mjs`): downloaded sizes equal the new
  files; default dtype and explicit `fp32` both return 25 words with exact text vs Python, first word `الْحَمْدُ` [6.36, 7.2].
  Earlier (before the fp32 swap) the same test passed for q4 and q8 from the Hub.
- **Model card** content: base model credit (Tarteel AI, Apache-2.0), the cross-attention note, the variants table,
  usage snippet, COOP/COEP note, and known limitations: basmala skipped when joined to following speech but
  transcribed when isolated (so silence-based segmentation is recommended); repetition-loop guard; the Safari WebGPU
  leak and the Transformers.js WebGPU leak with its fix; q4 is WebGPU/Node only.
  The first-word start of 6.36 s is described as the correct start (not a library artifact), per the user.
