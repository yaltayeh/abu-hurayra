// Transcribe audio files with the current pipeline (grouped, Node) and dump words+timestamps as JSON.
// Usage: [GROUPING=0] node --no-warnings AILab/dump_transcript.mjs <dtype> <outdir> <audio…>   (GROUPING=0: one Whisper call per silence segment; output <n>.<dtype>.seg.json)
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments } from "../src/transcribe.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here; env.allowRemoteModels = false;
const [dtype, outDir, ...files] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const asr = await pipeline("automatic-speech-recognition", "whisper-quran-onnx", { dtype });
for (const file of files) {
  const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(file),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1 << 30 });
  const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const groups = []; const t0 = Date.now();
  await transcribeSegments(audio, { getPipeline: async () => asr, onLog: process.env.LOG ? (l) => /long word|gap |segment by segment/.test(l) && console.log("   " + l) : undefined, ...(process.env.GROUPING === "0" ? { grouping: false } : {}), onSegment: (r) => groups.push({ index: r.index, start: r.start, end: r.end, words: r.words }) });
  const out = path.join(outDir, path.basename(file, path.extname(file)) + `.${dtype}${process.env.GROUPING === "0" ? ".seg" : ""}.json`);
  fs.writeFileSync(out, JSON.stringify({ file: path.basename(file), dtype, audioSec: audio.length / 16000, groups }));
  console.log(path.basename(file), groups.length, "groups", groups.reduce((n, g) => n + g.words.length, 0), "words", ((Date.now() - t0) / 1000).toFixed(1) + "s");
}
