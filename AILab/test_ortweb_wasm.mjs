// Creates sessions with the real onnxruntime-web WASM backend (the one that rejected q4's GatherBlockQuantized).
import * as ort from "../node_modules/.pnpm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs";
import { readFileSync } from "node:fs";
ort.env.wasm.numThreads = 1;
for (const f of process.argv.slice(2)) {
  try {
    const t = performance.now();
    const s = await ort.InferenceSession.create(readFileSync(f), { executionProviders: ["wasm"] });
    console.log("OK  ", f.split("/").pop(), `(${((performance.now()-t)/1000).toFixed(1)}s, ${s.outputNames.length} outputs)`);
    await s.release();
  } catch (e) { console.log("FAIL", f.split("/").pop(), String(e).slice(0, 170)); }
}
