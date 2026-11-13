// Loads from the Hub with NO dtype (library default for node = fp32) and checks word timestamps against the Python reference.
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
env.allowLocalModels = false; env.cacheDir = path.join(here, ".hub-cache");
const raw = execFileSync("ffmpeg", ["-v","error","-i",path.join(here,"../test-tarteel-ai/1.mp3"),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<28 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
const ref = JSON.parse(readFileSync(path.join(here,"../test-tarteel-ai/result.json"),"utf8"));
const opts = process.argv[2] ? { dtype: process.argv[2] } : {};
const asr = await pipeline("automatic-speech-recognition", "yaltaieh/whisper-base-ar-quran-onnx", opts);
const out = await asr(audio, { language: "arabic", task: "transcribe", return_timestamps: "word", chunk_length_s: 30 });
const d = out.chunks.slice(0, -1).flatMap((c, i) => [Math.abs(c.timestamp[0]-ref.chunks[i].timestamp[0]), Math.abs(c.timestamp[1]-ref.chunks[i].timestamp[1])]).sort((a,b)=>a-b);
console.log(JSON.stringify({ dtypeArg: process.argv[2] ?? "(none)", words: out.chunks.length, refWords: ref.chunks.length, textExact: out.text.trim() === ref.text.trim(),
  firstWord: out.chunks[0], tsDiffVsPython: { mean: +(d.reduce((a,b)=>a+b,0)/d.length).toFixed(2), median: +d[d.length>>1].toFixed(2), max: +d.at(-1).toFixed(2), note: "max = first word (Python merges the basmala into it); last word end excluded (known library bug)" } }));
