// Usage: node test_node.mjs <local|remote> <modelIdOrFolder> <dtype> [device]
// local : model folder name inside AILab/ (e.g. whisper-quran-onnx)
// remote: HF repo id (e.g. user/repo)
import { pipeline, env } from "../node_modules/@huggingface/transformers/dist/transformers.node.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode, model, dtype = "q8", device = "cpu"] = process.argv.slice(2);
if (mode === "local") {
  env.localModelPath = here; env.allowRemoteModels = false; env.allowLocalModels = true;
} else {
  env.allowLocalModels = false; env.allowRemoteModels = true; env.cacheDir = path.join(here, ".hub-cache");
}

// decode mp3 -> 16 kHz mono float32
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path.join(here, "../test-tarteel-ai/1.mp3"),
  "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

const ref = JSON.parse(readFileSync(path.join(here, "../test-tarteel-ai/result.json"), "utf8"));
const t0 = Date.now();
const session_options = process.env.NOARENA ? { enableCpuMemArena: false, enableMemPattern: false } : undefined;
const asr = await pipeline("automatic-speech-recognition", model, { dtype, device, session_options });
const tLoad = Date.now() - t0;
const t1 = Date.now();
const out = await asr(audio, { language: "arabic", task: "transcribe", return_timestamps: "word", chunk_length_s: 30 });
const tRun = Date.now() - t1;

const strip = s => s.replace(/[ً-ٰٟ]/g, "").replace(/\s+/g, " ").trim(); // drop tashkeel for lenient compare
const exact = out.text.trim() === ref.text.trim();
const loose = strip(out.text) === strip(ref.text);
const duration = audio.length / 16000;
// same workaround as src/worker.ts: transformers.js 4.3.2 gives the last word a bogus end (EOS timestamp padded with 0)
const fixEnds = (chunks, dur) => chunks.map((c, i) => {
  const [s, e] = c.timestamp, next = chunks[i + 1];
  if (e != null && e > s) return c;
  return { ...c, timestamp: [s, next && next.timestamp[0] > s ? next.timestamp[0] : Math.max(dur, s)] };
});
const sane = ch => ch.every((c, i) => c.timestamp[1] > c.timestamp[0] && c.timestamp[1] <= duration + 0.5 &&
  (i === 0 || c.timestamp[0] >= ch[i - 1].timestamp[0]));
const rawSane = sane(out.chunks);
out.chunks = fixEnds(out.chunks, duration);
const a = out.chunks, b = ref.chunks;
const n = Math.min(a.length, b.length);
const diffs = [];
for (let i = 0; i < n; i++) for (const k of [0, 1]) {
  diffs.push(Math.abs((a[i].timestamp[k] ?? NaN) - b[i].timestamp[k]));
}
const valid = diffs.filter(Number.isFinite).sort((x, y) => x - y);
const max = valid.at(-1), mean = valid.reduce((x, y) => x + y, 0) / valid.length, median = valid[valid.length >> 1];
const lastEnd = a.at(-1)?.timestamp[1];

let sizes = {};
if (mode === "local") {
  const suffix = { q8: "_quantized", q4: "_q4", fp16: "_fp16", fp32: "" }[dtype];
  for (const f of ["encoder_model", "decoder_model_merged"]) {
    const p = path.join(here, model, "onnx", `${f}${suffix}.onnx`);
    if (existsSync(p)) sizes[f] = +(statSync(p).size / 1e6).toFixed(1);
  }
}
console.log(JSON.stringify({ model, dtype, device, sizesMB: sizes, loadMs: tLoad, runMs: tRun,
  textExactMatch: exact, textMatchIgnoringTashkeel: loose, words: a.length, refWords: b.length,
  tsMaxDiffSec: +max.toFixed(2), tsMeanDiffSec: +mean.toFixed(2), tsMedianDiffSec: +median.toFixed(2), timestampsSaneRaw: rawSane, timestampsSaneAfterFix: sane(out.chunks), lastWordEndFixed: lastEnd, audioSec: +duration.toFixed(2), text: out.text }, null, 1));
if (process.env.DUMP) console.log(JSON.stringify(a.map(c => [c.text, c.timestamp])));
