// Accuracy of each dtype against the fp32 model on the same audio (grouped transcription, Node CPU).
// Usage: node --no-warnings compare_variants.mjs <audio> [variants...]   (variants: fp32 q4 q4w q8)
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments } from "../src/transcribe.ts";
import { statSync } from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here; env.allowRemoteModels = false;
const file = process.argv[2]; const variants = process.argv.slice(3).length ? process.argv.slice(3) : ["fp32", "q4", "q4w", "q8"];
const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(file),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
const spec = { fp32: ["ref-fp32", "fp32"], q4: ["whisper-quran-onnx", "q4"], q4w: ["whisper-quran-onnx", { encoder_model: "q4", decoder_model_merged: "bnb4" }], q8: ["whisper-quran-onnx", "q8"] };
const sizeMB = v => { const d = v === "fp32" ? ["ref-fp32/onnx/encoder_model.onnx", "ref-fp32/onnx/decoder_model_merged.onnx"] : v === "q4" ? ["whisper-quran-onnx/onnx/encoder_model_q4.onnx","whisper-quran-onnx/onnx/decoder_model_merged_q4.onnx"] : v === "q4w" ? ["whisper-quran-onnx/onnx/encoder_model_q4.onnx","whisper-quran-onnx/onnx/decoder_model_merged_bnb4.onnx"] : ["whisper-quran-onnx/onnx/encoder_model_quantized.onnx","whisper-quran-onnx/onnx/decoder_model_merged_quantized.onnx"];
  return +d.reduce((a, f) => a + statSync(path.join(here, f)).size, 0) / 1e6; };
const norm = t => t.trim().replace(/[ً-ٰٟ]/g, ""); // compare ignoring tashkeel too
async function run(v) { const [m, dtype] = spec[v]; const asr = await pipeline("automatic-speech-recognition", m, { dtype }); const words = []; const t = Date.now();
  await transcribeSegments(audio, { getPipeline: async () => asr, onSegment: r => words.push(...r.words) }); const ms = Date.now() - t; await asr.dispose(); return { words, ms }; }
function align(A, B, key) { const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length-1; i >= 0; i--) for (let j = B.length-1; j >= 0; j--) L[i][j] = key(A[i]) === key(B[j]) ? L[i+1][j+1]+1 : Math.max(L[i+1][j], L[i][j+1]);
  const pairs = []; let i = 0, j = 0; while (i < A.length && j < B.length) { if (key(A[i]) === key(B[j])) { pairs.push([A[i++], B[j++]]); } else if (L[i+1][j] >= L[i][j+1]) i++; else j++; } return pairs; }
const ref = await run("fp32"); const rows = [];
for (const v of variants) { const r = v === "fp32" ? ref : await run(v);
  const exact = align(r.words, ref.words, w => w.text.trim()), loose = align(r.words, ref.words, w => norm(w.text));
  const d = exact.flatMap(([a, b]) => [Math.abs(a.timestamp[0]-b.timestamp[0]), Math.abs(a.timestamp[1]-b.timestamp[1])]).sort((x, y) => x - y);
  rows.push({ variant: v, sizeMB: +sizeMB(v).toFixed(1), words: r.words.length, refWords: ref.words.length,
    wordsEqualToFp32: `${(100*exact.length/ref.words.length).toFixed(1)}%`, ignoringTashkeel: `${(100*loose.length/ref.words.length).toFixed(1)}%`,
    tsDiffVsFp32: d.length ? `mean ${(d.reduce((a,b)=>a+b,0)/d.length).toFixed(2)} / median ${d[d.length>>1].toFixed(2)} / max ${d.at(-1).toFixed(2)}` : "-", sec: +(r.ms/1000).toFixed(1) }); }
console.log(path.basename(file)); console.table(rows);
