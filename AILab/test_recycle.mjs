// Mirrors the worker's pipeline-recycle loop with the real model: dispose + recreate every N segments, resume by index.
// Usage: node --no-warnings test_recycle.mjs <audio> <recycleEverySegments>
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments } from "../src/transcribe.ts";
import { freeGenerateOutputs } from "../src/gpu-cleanup.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here; env.allowRemoteModels = false;
const [file, every] = [process.argv[2], +process.argv[3]];
const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(file),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
const rss = () => Math.round(process.memoryUsage().rss/1e6);
const make = async () => { const a = await pipeline("automatic-speech-recognition","whisper-quran-onnx",{dtype:"q4"}); freeGenerateOutputs(a); return a; };

async function run(everySegs) {
  let asr = await make(); const words = []; let recycles = 0, recycleMs = 0, planned = 0, peak = 0; const rssAfterRecycle = [];
  const t0 = performance.now(); let startIndex = 0;
  for (;;) {
    const r = await transcribeSegments(audio, { getPipeline: async () => asr, startIndex,
      onPlan: () => planned++, onSegment: (s) => words.push(...s.words), onSegmentDone: () => { peak = Math.max(peak, rss()); },
      shouldRecycle: everySegs ? (since) => since.segments >= everySegs : undefined });
    if (r.finished) break;
    const t = performance.now(); await asr.dispose(); asr = await make(); recycleMs += performance.now() - t; recycles++;
    rssAfterRecycle.push(rss()); startIndex = r.nextIndex;
  }
  await asr.dispose();
  return { words, recycles, recycleMs, planned, totalMs: performance.now() - t0, peak, rssAfterRecycle };
}
const base = await run(0), rec = await run(every);
const same = base.words.length === rec.words.length && base.words.every((w, i) => w.text === rec.words[i].text && Math.abs(w.timestamp[0] - rec.words[i].timestamp[0]) < 1e-6 && Math.abs(w.timestamp[1] - rec.words[i].timestamp[1]) < 1e-6);
console.log(JSON.stringify({ file: path.basename(file), recycleEvery: every, wordsBase: base.words.length, wordsRecycled: rec.words.length, identicalOutput: same,
  planAnnouncedTimes: rec.planned, recycles: rec.recycles, recycleCostSec: +(rec.recycleMs/1000).toFixed(1), perRecycleSec: +(rec.recycleMs/1000/Math.max(rec.recycles,1)).toFixed(2),
  totalSecBase: +(base.totalMs/1000).toFixed(1), totalSecRecycled: +(rec.totalMs/1000).toFixed(1), rssPeakMB: { base: base.peak, recycled: rec.peak }, rssAfterEachRecycleMB: rec.rssAfterRecycle }, null, 1));
