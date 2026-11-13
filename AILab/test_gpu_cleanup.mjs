// Verifies the generate() wrapper against a fake of what Transformers.js returns on WebGPU for word timestamps:
// { sequences (cpu), past_key_values (DynamicCache of gpu-buffer tensors), cross_attentions (cpu), token_timestamps (cpu) }
import { freeGenerateOutputs, gpuStats } from "../src/gpu-cleanup.ts";
let alive = 0;
const gpu = (n) => { alive++; return { location: "gpu-buffer", size: n, type: "float32", dispose() { alive--; } }; };
const cpu = () => ({ location: "cpu", size: 10, type: "float32", dispose() { throw new Error("must not dispose CPU tensors"); } });
class DynamicCache { constructor() { for (let i = 0; i < 6; i++) { this[`past_key_values.${i}.encoder.key`] = gpu(8*1500*64); this[`past_key_values.${i}.encoder.value`] = gpu(8*1500*64); this[`past_key_values.${i}.decoder.key`] = gpu(8*20*64); this[`past_key_values.${i}.decoder.value`] = gpu(8*20*64); } } async dispose() { /* real one disposes gpu tensors */ } }
const fakeModel = { async generate() { return { sequences: cpu(), token_timestamps: cpu(), cross_attentions: [[cpu(), cpu()], [cpu()]], past_key_values: new DynamicCache() }; } };
const asr = { model: fakeModel };
freeGenerateOutputs(asr); freeGenerateOutputs(asr); // second call must not double-wrap
for (let i = 0; i < 233; i++) await asr.model.generate({});
console.log(JSON.stringify({ calls: gpuStats.generateCalls, gpuTensorsStillAlive: alive, disposed: gpuStats.tensorsDisposed, mbDisposed: Math.round(gpuStats.mbDisposed), failed: gpuStats.failedDisposals }));
console.log(alive === 0 && gpuStats.failedDisposals === 0 && gpuStats.generateCalls === 233 ? "PASS" : "FAIL");
