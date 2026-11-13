// Usage: node --no-warnings test_segmentation.mjs file1 file2 ...   (segmentation only, no model)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { analyzeSegments } from "../src/segment.ts";

const load = f => { const raw = execFileSync("ffmpeg", ["-v","error","-i",f,"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); };

// the previous fixed method (15% of the 95th-percentile RMS), only for comparison
function legacyCount(a) {
  const fr = 320, n = Math.floor(a.length / fr), rms = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; for (let i = f*fr; i < f*fr+fr; i++) s += a[i]*a[i]; rms[f] = Math.sqrt(s/fr); }
  const th = Float32Array.from(rms).sort()[Math.floor(n*0.95)] * 0.15; let cuts = 0;
  for (let f = 0; f < n; ) { if (rms[f] >= th) { f++; continue; } let g = f; while (g < n && rms[g] < th) g++; if (g-f >= 15 && f > 0 && g < n) cuts++; f = g; }
  return cuts + 1;
}

console.log("file".padEnd(18), "dur".padStart(7), "legacy15%", "| frac  segs  >30s  longest  floor/speech/thr dB   retries  (ms)");
for (const f of process.argv.slice(2)) {
  const a = load(f), dur = a.length / 16000, legacy = legacyCount(a);
  for (const frac of [0.25, 0.3, 0.35]) {
    const t = performance.now();
    const { segments, info } = analyzeSegments(a, 16000, { thresholdFraction: frac });
    const over = segments.filter(s => s.end - s.start > 30).length;
    console.log(path.basename(f).padEnd(18), (dur.toFixed(0)+"s").padStart(7), String(legacy).padStart(9), "|", frac.toFixed(2),
      String(info.segments).padStart(5), String(over).padStart(5), (info.longestSec.toFixed(1)+"s").padStart(8),
      `${info.floorDb.toFixed(0)}/${info.speechDb.toFixed(0)}/${info.thresholdDb.toFixed(1)}`.padStart(16), String(info.retries).padStart(8), (performance.now()-t).toFixed(0).padStart(6));
  }
}
