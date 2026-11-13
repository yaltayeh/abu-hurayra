// Grouped (default) vs one-call-per-segment transcription of the same file. Usage: node --no-warnings compare_grouping.mjs <audio> [dtype]
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments } from "../src/transcribe.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here; env.allowRemoteModels = false;
const [file, dtype = "q4"] = process.argv.slice(2);
const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(file),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
const asr = await pipeline("automatic-speech-recognition", "whisper-quran-onnx", { dtype });
async function run(grouping) { const words = []; let first = null, units = 0, line = ""; const t0 = Date.now();
  await transcribeSegments(audio, { getPipeline: async () => asr, grouping, onLog: l => { if (/segmentation|total:/.test(l)) line += l + " | "; },
    onSegment: r => { first ??= Date.now() - t0; units++; words.push(...r.words); } });
  return { words, first, units, total: Date.now() - t0, line }; }
const per = await run(false), grp = await run(undefined);
const norm = w => w.text.trim();
const A = grp.words, B = per.words; const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
for (let i = A.length-1; i >= 0; i--) for (let j = B.length-1; j >= 0; j--) L[i][j] = norm(A[i]) === norm(B[j]) ? L[i+1][j+1]+1 : Math.max(L[i+1][j], L[i][j+1]);
const d = []; let i = 0, j = 0, onlyG = 0, onlyP = 0;
while (i < A.length && j < B.length) { if (norm(A[i]) === norm(B[j])) { d.push(Math.abs(A[i].timestamp[0]-B[j].timestamp[0]), Math.abs(A[i].timestamp[1]-B[j].timestamp[1])); i++; j++; } else if (L[i+1][j] >= L[i][j+1]) { onlyG++; i++; } else { onlyP++; j++; } }
onlyG += A.length - i; onlyP += B.length - j; d.sort((x, y) => x - y);
const nonMono = A.filter((w, k) => k && w.timestamp[0] < A[k-1].timestamp[0] - 1e-6).length;
console.log(JSON.stringify({ file: path.basename(file), dtype, audioSec: +(audio.length/16000).toFixed(1),
  perSegment: { calls: per.units, words: B.length, firstResultSec: +(per.first/1000).toFixed(1), totalSec: +(per.total/1000).toFixed(1), rtf: +(per.total/1000/(audio.length/16000)).toFixed(3) },
  grouped: { calls: grp.units, words: A.length, firstResultSec: +(grp.first/1000).toFixed(1), totalSec: +(grp.total/1000).toFixed(1), rtf: +(grp.total/1000/(audio.length/16000)).toFixed(3), nonMonotonicStarts: nonMono },
  matchedWords: d.length/2, onlyInGrouped: onlyG, onlyInPerSegment: onlyP,
  tsDiffSec: { mean: +(d.reduce((a,b)=>a+b,0)/d.length).toFixed(3), median: +d[d.length>>1].toFixed(3), p99: +d[Math.floor(d.length*0.99)].toFixed(2), max: +d.at(-1).toFixed(2) }, details: grp.line }, null, 1));
