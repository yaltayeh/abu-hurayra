import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { transcribeSegments } from "../src/transcribe.ts";
env.localModelPath = "/Users/yacoub/workspace/abu-hurayra/AILab"; env.allowRemoteModels = false;
const file = "/Users/yacoub/Projects/Quran-video/data/reciters/7/mp3/18.mp3";
const raw = execFileSync("ffmpeg", ["-v","error","-i",file,"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1 << 30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const asr = await pipeline("automatic-speech-recognition", "whisper-quran-onnx", { dtype: "q8" });
const groups = JSON.parse(fs.readFileSync(process.argv[2] + "/k18/18.q8.json")).groups;
for (const g of groups) g.words.forEach((w, i) => {
  const d = w.timestamp[1] - w.timestamp[0];
  if (w.timestamp[1] == null || d < 4) return;
  const prev = g.words[i - 1], next = g.words[i + 1];
  const s = prev ? prev.timestamp[0] : w.timestamp[0], e = next ? next.timestamp[1] : w.timestamp[1];
  globalThis.jobs ??= []; globalThis.jobs.push({ w, s, e, old: g.words.filter((x) => x.timestamp[0] >= s - 0.01 && x.timestamp[0] < e).map((x) => `${x.text.trim()}(${x.timestamp[0].toFixed(1)}-${x.timestamp[1]?.toFixed(1)})`).join(" "), d });
});
for (const j of globalThis.jobs) {
  const words = [];
  await transcribeSegments(audio.subarray(Math.round(j.s * 16000), Math.round(j.e * 16000)), { getPipeline: async () => asr, onSegment: (r) => words.push(...r.words.map((w) => `${w.text.trim()}(${(w.timestamp[0] + j.s).toFixed(1)}-${w.timestamp[1] == null ? "?" : (w.timestamp[1] + j.s).toFixed(1)})`)) });
  console.log(`\n#${j.w.text.trim()} ${j.d.toFixed(1)}s [${j.s.toFixed(1)}-${j.e.toFixed(1)}]\n  old: ${j.old}\n  new: ${words.join(" ")}`);
}
