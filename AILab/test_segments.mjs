// Usage: node --no-warnings test_segments.mjs <audio file> <local|remote> <dtype>
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments, fixWordEnds } from "../src/transcribe.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const [file, mode = "local", dtype = "q4"] = process.argv.slice(2);
if (mode === "local") { env.localModelPath = here; env.allowRemoteModels = false; }
else { env.allowLocalModels = false; env.cacheDir = path.join(here, ".hub-cache"); }
const model = mode === "local" ? "whisper-quran-onnx" : "yaltaieh/whisper-base-ar-quran-onnx";

const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(file),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const duration = audio.length / 16000;
const asr = await pipeline("automatic-speech-recognition", model, { dtype });

// --- segmented run ---
const words = []; let partials = 0, firstPartialAt = null, firstSegAt = null; const t0 = Date.now();
let samplePartial = "";
await transcribeSegments(audio, {
  getPipeline: async () => asr,
  onLog: l => console.log("  ", l),
  onPlan: p => console.log(`  plan: ${p.total} segments`),
  onPartial: (i, t) => { partials++; firstPartialAt ??= Date.now() - t0; if (i === 0) samplePartial = t; },
  onSegment: r => { firstSegAt ??= Date.now() - t0; words.push(...r.words); },
});
const segTotal = Date.now() - t0;

// --- full-file reference run (previous behaviour) ---
const t1 = Date.now();
const full = process.env.SKIPFULL ? { chunks: [] } : await asr(audio, { language: "arabic", task: "transcribe", return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
const fullMs = Date.now() - t1;
const ref = fixWordEnds(full.chunks, duration);

// --- align by LCS on word text, then compare timestamps ---
const norm = w => w.text.trim();
const A = words, B = ref;
const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
  L[i][j] = norm(A[i]) === norm(B[j]) ? L[i+1][j+1] + 1 : Math.max(L[i+1][j], L[i][j+1]);
const diffs = []; let i = 0, j = 0; const onlySeg = [], onlyRef = [];
while (i < A.length && j < B.length) {
  if (norm(A[i]) === norm(B[j])) { for (const k of [0, 1]) diffs.push(Math.abs(A[i].timestamp[k] - B[j].timestamp[k])); i++; j++; }
  else if (L[i+1][j] >= L[i][j+1]) onlySeg.push(`${A[i].text.trim()}@${A[i++].timestamp[0]}`); else onlyRef.push(`${B[j].text.trim()}@${B[j++].timestamp[0]}`);
}
diffs.sort((a, b) => a - b);
const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
const bad = words.filter(w => !(w.timestamp[1] > w.timestamp[0]));
const mono = words.every((w, k) => k === 0 || w.timestamp[0] >= words[k-1].timestamp[0]);
console.log(JSON.stringify({
  file: path.basename(file), dtype, audioSec: +duration.toFixed(1),
  segmented: { words: words.length, totalSec: +(segTotal/1000).toFixed(1), firstPartialSec: +(firstPartialAt/1000).toFixed(1), firstSegmentSec: +(firstSegAt/1000).toFixed(1), partialUpdates: partials },
  fullFile: { words: ref.length, totalSec: +(fullMs/1000).toFixed(1) },
  matchedWords: diffs.length / 2,
  tsDiffSec: diffs.length ? { mean: +mean.toFixed(2), median: +diffs[diffs.length >> 1].toFixed(2), max: +diffs.at(-1).toFixed(2) } : null,
  invalidEnds: bad.length, monotonicStarts: mono, lastEnd: words.at(-1)?.timestamp[1],
  onlyInSegmentedCount: onlySeg.length, onlyInFullRunCount: onlyRef.length,
  samplePartialSeg0: samplePartial.slice(0, 80),
}, null, 1));
