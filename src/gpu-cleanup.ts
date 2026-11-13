import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

/**
 * Transformers.js 4.3.2 leaks GPU memory on WebGPU when word timestamps are requested.
 *
 * With `device: "webgpu"` the decoder's `present.*` outputs (the KV cache) are kept on the GPU (`gpu-buffer`).
 * `generate()` disposes that cache at the end unless `return_dict_in_generate` is set, and Whisper sets it for
 * word timestamps. Nobody disposes the returned `past_key_values` afterwards (the ASR pipeline only reads
 * `sequences` and `token_timestamps`), so every `generate()` call leaves its cache on the GPU:
 * 6 layers x (key+value) x [1, 8, 1500, 64] fp32 for the encoder cache alone = ~37 MB per call.
 *
 * Fix: wrap `model.generate` and dispose every GPU tensor in what it returns. (This only intercepts the plain
 * `generate()` path, which is the one used because we pass `max_new_tokens`; Whisper's internal seek loop calls
 * `super.generate()` and could not be wrapped from outside.)
 */
export type GpuStats = {
  generateCalls: number;
  tensorsDisposed: number;
  mbDisposed: number;
  /** GPU tensors still found in a generate() result after cleanup attempt (should stay 0) */
  failedDisposals: number;
};
export const gpuStats: GpuStats = { generateCalls: 0, tensorsDisposed: 0, mbDisposed: 0, failedDisposals: 0 };

type GpuTensorLike = { location?: string; dispose: () => unknown; size?: number; type?: string };
const isGpuTensor = (x: unknown): x is GpuTensorLike =>
  typeof x === "object" && x !== null && (x as GpuTensorLike).location === "gpu-buffer" && typeof (x as GpuTensorLike).dispose === "function";

function collectGpuTensors(value: unknown, out: Set<GpuTensorLike>, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return;
  if (isGpuTensor(value)) { out.add(value); return; }
  // DynamicCache (a record of tensors), arrays of tensors (cross_attentions), plain result objects
  for (const v of Object.values(value)) collectGpuTensors(v, out, depth + 1);
}

export async function disposeGpuTensors(result: unknown): Promise<void> {
  const tensors = new Set<GpuTensorLike>();
  collectGpuTensors(result, tensors);
  await Promise.all(
    [...tensors].map(async (t) => {
      try {
        const bytes = (t.size ?? 0) * (t.type === "float16" ? 2 : 4);
        await t.dispose();
        gpuStats.tensorsDisposed++;
        gpuStats.mbDisposed += bytes / 1048576;
      } catch {
        gpuStats.failedDisposals++;
      }
    }),
  );
}

const WRAPPED = Symbol.for("gpu-cleanup-wrapped");

export function freeGenerateOutputs(asr: AutomaticSpeechRecognitionPipeline) {
  const model = asr.model as unknown as Record<PropertyKey, unknown> & { generate: (...args: unknown[]) => Promise<unknown> };
  if (model[WRAPPED]) return;
  const original = model.generate.bind(model);
  model.generate = async (...args: unknown[]) => {
    const result = await original(...args);
    gpuStats.generateCalls++;
    await disposeGpuTensors(result);
    return result;
  };
  model[WRAPPED] = true;
}
