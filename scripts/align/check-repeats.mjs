// Are the `repeat` jumps real restarts by the reciter, or ASR artifacts? Lists every repeat with the evidence:
// time ranges, the repeated words, the previous group's last words, and an ACOUSTIC check: DTW distance between the audio of the
// first recitation of those words and the audio of the repeat (MFCC), compared with the distance to random spans of the same length.
// Usage: node --no-warnings scripts/align/check-repeats.mjs <27.mp3> [asr-dir] [clip-dir]   (needs ffmpeg; clips are written to clip-dir if given)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { alignTranscript } from "../../src/align/align.ts";
import { loadIndex, loadGroups } from "./common.mjs";

const [audioFile, dir = new URL("./fixtures", import.meta.url).pathname, clipDir] = process.argv.slice(2);
const SR = 16000, HOP = 160, WIN = 400, NFFT = 512, NMEL = 40;
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", audioFile, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

// ---- MFCC ----
const hann = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)));
const mel = (f) => 2595 * Math.log10(1 + f / 700), imel = (m) => 700 * (10 ** (m / 2595) - 1);
const fb = (() => { const pts = Array.from({ length: NMEL + 2 }, (_, i) => imel((mel(8000) * i) / (NMEL + 1))); const bins = pts.map((f) => Math.floor(((NFFT + 1) * f) / SR)); return Array.from({ length: NMEL }, (_, m) => { const w = new Float64Array(NFFT / 2 + 1); for (let k = bins[m]; k < bins[m + 1]; k++) w[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]); for (let k = bins[m + 1]; k < bins[m + 2]; k++) w[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]); return w; }); })();
const dct = Array.from({ length: 13 }, (_, c) => Float64Array.from({ length: NMEL }, (_, m) => Math.cos((Math.PI * c * (m + 0.5)) / NMEL)));
function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } } for (let len = 2; len <= n; len <<= 1) { const a = (-2 * Math.PI) / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(a * k), wi = Math.sin(a * k); const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } } }
function mfcc(from, to) { // seconds -> frames x 12 (c1..c12), mean-normalized per span
  const a = Math.round(from * SR), b = Math.min(audio.length, Math.round(to * SR)), out = [];
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let s = a; s + WIN <= b; s += HOP) {
    re.fill(0); im.fill(0); for (let i = 0; i < WIN; i++) re[i] = audio[s + i] * hann[i]; fft(re, im);
    const p = new Float64Array(NFFT / 2 + 1); for (let k = 0; k <= NFFT / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    const lm = fb.map((w) => { let e = 0; for (let k = 0; k < w.length; k++) e += w[k] * p[k]; return Math.log(e + 1e-10); });
    out.push(Float64Array.from({ length: 12 }, (_, c) => { let v = 0; for (let m = 0; m < NMEL; m++) v += dct[c + 1][m] * lm[m]; return v; }));
  }
  const mean = new Float64Array(12); for (const f of out) for (let c = 0; c < 12; c++) mean[c] += f[c] / out.length; for (const f of out) for (let c = 0; c < 12; c++) f[c] -= mean[c];
  return out;
}
function dtw(A, B) { const n = A.length, m = B.length; let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1); prev[0] = 0; for (let i = 1; i <= n; i++) { cur[0] = Infinity; for (let j = 1; j <= m; j++) { let d = 0; for (let c = 0; c < 12; c++) { const x = A[i - 1][c] - B[j - 1][c]; d += x * x; } d = Math.sqrt(d); cur[j] = d + Math.min(prev[j], cur[j - 1], prev[j - 1]); } [prev, cur] = [cur, prev]; } return prev[m] / (n + m); }
const energy = (a, b) => { let e = 0, n = 0; for (let i = Math.round(a * SR); i < Math.min(audio.length, Math.round(b * SR)); i++) { e += audio[i] ** 2; n++; } return Math.sqrt(e / Math.max(1, n)); };

// ---- find the repeats ----
const { idx, core } = loadIndex();
const name = process.env.NAME ?? "27"; // which dump in <asr-dir>: <name>.q8.json + <name>.segments.json
const groups = loadGroups(dir, name);
const r = alignTranscript(idx, groups);
const occ = r.occurrences;
const runs = [];
for (let k = 0; k < occ.length; k++) if (occ[k].repeat && !(k > 0 && occ[k - 1].repeat)) { let e = k; while (e + 1 < occ.length && occ[e + 1].repeat) e++; runs.push([k, e]); }
const speech = groups.flatMap((g) => g.words);
const asrOf = (o) => o.asr.map((i) => speech[i]);
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
const textOf = (o) => core.textWords[o.textIndex];
console.log(`${runs.length} repeat runs in ${name}.mp3 (${audio.length / SR | 0} s)\n`);
const rows = [];
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
for (const [n, [k, e]] of runs.entries()) {
  const rep = occ.slice(k, e + 1);
  // the first recitation of the same words: the latest earlier occurrences of the same entries
  const orig = rep.map((o) => { for (let q = k - 1; q >= 0; q--) if (occ[q].entry === o.entry && !occ[q].repeat) return occ[q]; return null; }).filter(Boolean);
  const g = groups.find((gg) => rep[0].start >= gg.start - 0.01 && rep[0].start < gg.end);
  const gi = groups.indexOf(g), prevG = groups[gi - 1];
  const lastWords = prevG.words.slice(-5);
  const rs = rep[0].start, re = rep.at(-1).end, os = orig[0].start, oe = orig.at(-1).end;
  const A = mfcc(os, oe), B = mfcc(rs, re);
  const d = dtw(A, B);
  // baseline: same-length random spans elsewhere in the speech (not overlapping the two spans)
  const len = oe - os, base = [];
  while (base.length < 150) { const t = 1 + rnd() * (audio.length / SR - len - 2); if (Math.abs(t - os) < len + 1 || Math.abs(t - rs) < len + 1) continue; if (energy(t, t + len) < energy(os, oe) * 0.4) continue; base.push(dtw(A, mfcc(t, t + len))); }
  base.sort((x, y) => x - y);
  const pct = base.filter((x) => x < d).length / base.length;
  const pause = rs - prevG.words.at(-1).end;
  rows.push({ n: n + 1, rs, re, os, oe, words: rep.map(textOf).join(" "), d, pct, pause, lastWords, base0: base[0], baseMed: base[75], gi });
  console.log(`#${n + 1}  repeat ${fmt(rs)} - ${fmt(re)}  (${(re - rs).toFixed(1)} s, group ${gi + 1} starts ${fmt(g.start)})`);
  console.log(`    repeated words (${rep.length}): ${rep.map((o) => `${textOf(o)} [${o.surah}:${o.ayah}:${o.word}]`).join("  ")}`);
  console.log(`    first recitation of them: ${fmt(os)} - ${fmt(oe)} (${(oe - os).toFixed(1)} s)  → repeat is ${(re - rs - (oe - os) >= 0 ? "+" : "") + (re - rs - (oe - os)).toFixed(1)} s vs the first time`);
  console.log(`    previous group ${gi} (${fmt(prevG.start)}-${fmt(prevG.end)}) last words: ${lastWords.map((w) => `${w.text} ${w.start.toFixed(1)}-${w.end.toFixed(1)}`).join(" | ")}`);
  console.log(`    gap between the previous group's last word and the repeat: ${pause.toFixed(2)} s; ASR word durations in the repeat: ${rep.map((o) => (o.end - o.start).toFixed(1)).join(" ")}`);
  console.log(`    acoustic DTW distance first-vs-repeat ${d.toFixed(2)}; random same-length spans: min ${base[0].toFixed(2)}, median ${base[75].toFixed(2)} → only ${(100 * pct).toFixed(0)} % of random spans are closer`);
  if (clipDir) { fs.mkdirSync(clipDir, { recursive: true }); const f = `${clipDir}/repeat-${n + 1}.wav`; execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, os - 1)), "-to", String(re + 1), "-i", audioFile, "-ac", "1", "-ar", "16000", f]); console.log(`    clip: ${f}  (starts at ${fmt(Math.max(0, os - 1))}; first recitation at +${(os - Math.max(0, os - 1)).toFixed(1)} s, repeat at +${(rs - Math.max(0, os - 1)).toFixed(1)} s)`); }
  console.log();
}
console.log("summary: DTW distance (lower = more alike) and percentile among random spans");
console.table(rows.map((r) => ({ "#": r.n, repeat: `${fmt(r.rs)}-${fmt(r.re)}`, gapSec: +r.pause.toFixed(2), dtw: +r.d.toFixed(2), "random min": +r.base0.toFixed(2), "random median": +r.baseMed.toFixed(2), "% random closer": +(100 * r.pct).toFixed(0) })));
