// Dump the silence segments (the units before grouping) of audio files. Usage: node --no-warnings AILab/dump_segments.mjs <outdir> <audio…>
import { execFileSync } from "node:child_process"; import fs from "node:fs"; import path from "node:path";
import { analyzeSegments } from "../src/segment.ts";
const [outDir, ...files] = process.argv.slice(2); fs.mkdirSync(outDir, { recursive: true });
for (const f of files) {
  const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(f),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1 << 30 });
  const { segments } = analyzeSegments(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), 16000);
  fs.writeFileSync(path.join(outDir, path.basename(f, path.extname(f)) + ".segments.json"), JSON.stringify(segments));
  console.log(path.basename(f), segments.length, "segments");
}
