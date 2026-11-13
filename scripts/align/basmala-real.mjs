// End to end with the real model: surah 82, then a basmala, then the start of surah 51, as ONE audio file.
// The basmala is joined to 51's first words in the same group, so the ASR usually skips it; resolveBasmalas then
// re-transcribes the isolated gap with the real pipeline. Needs ffmpeg and AILab/whisper-quran-onnx. Usage:
//   node --no-warnings scripts/align/basmala-real.mjs <test-audio-dir> [work-dir]
import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { transcribeSegments } from "../../src/transcribe.ts";
import { alignTranscript, fromSegmentResult, resolveBasmalas } from "../../src/align/index.ts";
import { loadIndex, root } from "./common.mjs";

const [audioDir, work = fs.mkdtempSync("/tmp/align-") ] = process.argv.slice(2);
const SR = 16000;
const decode = (f, extra = []) => { const raw = execFileSync("ffmpeg", ["-v", "error", ...extra, "-i", path.resolve(f), "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 }); return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); };
const silence = (s) => new Float32Array(Math.round(s * SR));
const a82 = decode(`${audioDir}/82.mp3`), bas = decode(`${audioDir}/1.mp3`, ["-t", "5.9"]), a51 = decode(`${audioDir}/51.mp3`, ["-t", "30"]);
const parts = [a82, silence(1.5), bas, silence(0.5), a51];
const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
let o = 0; for (const p of parts) { audio.set(p, o); o += p.length; }
const t82 = a82.length / SR, tBasStart = t82 + 1.5, tBasEnd = tBasStart + bas.length / SR;
console.log(`audio ${(audio.length / SR).toFixed(1)} s: 82 [0, ${t82.toFixed(1)}], basmala [${tBasStart.toFixed(1)}, ${tBasEnd.toFixed(1)}], 51 starts ${(tBasEnd + 0.5).toFixed(1)}`);

env.localModelPath = path.join(root, "AILab");
env.allowRemoteModels = false;
const asr = await pipeline("automatic-speech-recognition", "whisper-quran-onnx", { dtype: "q8" });
const transcribe = async (a, offset = 0) => { const groups = []; await transcribeSegments(a, { getPipeline: async () => asr, onSegment: (r) => groups.push(fromSegmentResult({ ...r, start: r.start + offset, end: r.end + offset, words: r.words.map((w) => ({ ...w, timestamp: [w.timestamp[0] + offset, w.timestamp[1] == null ? null : w.timestamp[1] + offset] })), breaks: r.breaks?.map((b) => b + offset), unrecognized: r.unrecognized?.map((u) => ({ start: u.start + offset, end: u.end + offset })) })) }); return groups; };

const t0 = performance.now();
const groups = await transcribe(audio);
console.log(`transcribed in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${groups.length} groups`);
for (const g of groups.slice(-3)) console.log(`  group ${g.start.toFixed(1)}-${g.end.toFixed(1)}: ${g.words.slice(0, 6).map((w) => w.text).join(" ")} …`);
const { idx } = loadIndex();
const r = alignTranscript(idx, groups);
const b51 = r.occurrences.filter((x) => x.surah === 51 && x.basmala);
console.log(`\nbefore resolveBasmalas: jumps ${r.jumps.map((j) => `${j.type} ${j.from ?? "-"}→${j.to}`).join(" | ")}`);
console.log(`  basmala of 51 in the output: ${b51.map((x) => x.kind).join(",") || "none"}; gaps: ${JSON.stringify(r.basmalaGaps.map((g) => ({ surah: g.surah, recognized: g.recognized, start: +g.start.toFixed(2), end: +g.end.toFixed(2) })))}`);
let probes = 0;
const probe = { transcribe: async (s, e) => { probes++; const gs = await transcribe(audio.subarray(Math.round(s * SR), Math.round(e * SR)), s); console.log(`  probe [${s.toFixed(2)}, ${e.toFixed(2)}] → "${gs.flatMap((g) => g.words.map((w) => w.text)).join(" ")}"`); return gs.flatMap((g) => g.words); } };
const { result, notes } = await resolveBasmalas(idx, r, probe);
const after = result.occurrences.filter((x) => x.surah === 51 && x.basmala);
console.log(`after: notes ${JSON.stringify(notes)}; probes ${probes}; basmala words ${after.map((x) => `${x.kind}[${x.start.toFixed(2)}-${x.end.toFixed(2)}]`).join(" ")}`);
console.log(`  expected basmala inside [${tBasStart.toFixed(1)}, ${tBasEnd.toFixed(1)}]: ${after.length === 4 && after.every((x) => x.start >= tBasStart - 0.5 && x.end <= tBasEnd + 0.8) ? "yes" : "NO"}`);
fs.rmSync(work, { recursive: true, force: true });
