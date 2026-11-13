// Transcribe [start, end) of a file on its own with the current pipeline and print words with absolute times.
// Usage: node --no-warnings AILab/transcribe_range.mjs <audio> <dtype> <start> <end> [start end …]
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments } from "../src/transcribe.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here; env.allowRemoteModels = false;
const [file, dtype, ...ranges] = process.argv.slice(2);
const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(file),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1 << 30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const asr = await pipeline("automatic-speech-recognition", "whisper-quran-onnx", { dtype });
for (let i = 0; i < ranges.length; i += 2) {
  const s = +ranges[i], e = +ranges[i + 1];
  const words = [];
  await transcribeSegments(audio.subarray(Math.round(s * 16000), Math.round(e * 16000)), { getPipeline: async () => asr, onSegment: (r) => words.push(...r.words.map((w) => ({ t: w.text.trim(), a: +(w.timestamp[0] + s).toFixed(1), b: w.timestamp[1] == null ? null : +(w.timestamp[1] + s).toFixed(1) }))) });
  console.log(`[${s}-${e}] ${words.map((w) => `${w.t}(${w.a}-${w.b})`).join(" ")}`);
}
