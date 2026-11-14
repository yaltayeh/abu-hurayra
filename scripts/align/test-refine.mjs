// Offline test of refineLongWords (no model): a fake transcriber stands in for Whisper. Usage: node --no-warnings scripts/align/test-refine.mjs
import { refineLongWords } from "../../src/transcribe.ts";
const W = (t, a, b) => ({ text: t, timestamp: [a, b] });
const seg = (start, end) => ({ start, end, speechStart: start, speechEnd: end });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) failed++; };
const logs = [];
const log = (l) => logs.push(l);

// the 18.mp3 case: 'لدنك' lasts 9 s because the repeat of "من لدنك رحمة" was dropped; the two segments (break at 109.1) transcribed alone have both
const group = { ...seg(101.2, 121.7), members: [seg(101.2, 109.1), seg(109.1, 121.7)] };
const original = [W("فقالوا", 101.6, 102.7), W("ربنا", 102.7, 105.4), W("آتنا", 105.4, 106.4), W("من", 106.4, 106.7), W("لدنك", 106.7, 115.8), W("رحمة", 115.8, 117.6), W("وهيئ", 117.6, 118.7)];
const perSeg = new Map([
  [101.2, [W("فقالوا", 101.6, 102.7), W("ربنا", 102.7, 105.4), W("آتنا", 105.4, 106.4), W("من", 106.4, 106.7), W("لدنك", 106.7, 108.4), W("رحمة", 108.4, 108.9)]],
  [109.1, [W("فقالوا", 109.5, 110.6), W("ربنا", 110.6, 112.9), W("آتنا", 112.9, 114), W("من", 114, 114.3), W("لدنك", 114.3, 115.9), W("رحمة", 115.9, 117.6), W("وهيئ", 117.6, 118.7)]],
]);
let calls = [];
const run = async (_i, start) => { calls.push(start); return { words: perSeg.get(start) ?? [] }; };
let out = await refineLongWords(original, group, run, log);
check("repeat recovered: 7 -> 13 words, in time order", out.length === 13 && out.every((w, i) => i === 0 || w.timestamp[0] >= out[i - 1].timestamp[0]), out.map((w) => w.text).join(" "));
check("only the two segments of the long word were re-run", calls.join() === "101.2,109.1");

// a long pause: the segment-by-segment result has the same words -> unchanged
const pauseWords = [W("الدين", 20, 28), W("مالك", 28.5, 29)];
const g2 = { ...seg(18, 30), members: [seg(18, 25), seg(25, 30)] };
out = await refineLongWords(pauseWords, g2, async (_i, s) => ({ words: s === 18 ? [W("الدين", 20, 21)] : [W("مالك", 28.5, 29)] }), log);
check("long pause (same words) is kept as it was", out === pauseWords || (out.length === 2 && out[0].timestamp[1] === 28));

// a single-segment group cannot be split: untouched, no calls
calls = [];
const g3 = { ...seg(0, 20), members: [seg(0, 20)] };
out = await refineLongWords([W("a", 0, 9)], g3, run, log);
check("single-segment group: nothing to split", out.length === 1 && calls.length === 0);

// no long word: no calls
out = await refineLongWords([W("a", 0, 1), W("b", 1, 2)], group, run, log);
check("no long word: no calls", out.length === 2 && calls.length === 0);

// a transcriber that returns nothing (looped / empty) keeps the original
out = await refineLongWords(original, group, async () => ({ words: null }), log);
check("failed re-transcription keeps the original", out.length === original.length);
// ---- acoustic refinement: a synthetic signal (tone = speech, zeros = pause) and a fake transcriber that answers per time range ----
const SR = 16000;
const tone = (n) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR));
const sig = (parts) => { const out = new Float32Array(parts.reduce((a, p) => a + p[1], 0) * SR); let o = 0; for (const [on, dur] of parts) { if (on) out.set(tone(dur * SR), o); o += dur * SR; } return out; };
const answers = (table) => async (_i, start, end) => { const hit = table.find(([a, b]) => Math.abs(a - start) < 0.1 && Math.abs(b - end) < 0.1); return { words: hit ? hit[2] : [] }; };
const ag = (a, b) => ({ ...seg(a, b), members: [seg(a, b)] });

// a word said twice with a 0.6 s breath: 1.5 s speech, 0.6 s pause, 1.5 s speech
let audio = sig([[1, 1.5], [0, 0.6], [1, 1.5]]);
let w = [W("فاختلط", 0, 3.6)];
out = await refineLongWords(w, ag(0, 3.6), answers([[0, 1.53, [W("فاختلط", 0, 1.4)]], [2.07, 3.6, [W("فاختلط", 2.1, 3.5)]]]), log, audio);
check("a long word with a pause inside, two similar halves -> said twice", out.length === 2 && out[1].timestamp[0] === 2.1, out.map((x) => x.text).join(" "));
out = await refineLongWords(w, ag(0, 3.6), answers([[0, 1.53, [W("الرحي", 0, 1.4)]], [2.07, 3.6, [W("ورحمن", 2.1, 3.5)]]]), log, audio);
check("halves that are different fragments (an elongated word) are NOT used", out.length === 1 && out[0] === w[0]);
audio = sig([[1, 3.6]]);
out = await refineLongWords(w, ag(0, 3.6), answers([]), log, audio);
check("a long word with no pause inside is left alone", out.length === 1);

// a hole of 6 s after the last word that is full of speech
audio = sig([[1, 2], [1, 6]]);
w = [W("نفس", 0.5, 2)];
out = await refineLongWords(w, ag(0, 8), answers([[2, 8, [W("قال", 2.1, 2.6), W("أقتلت", 2.6, 3.5), W("نفسا", 3.5, 5), W("زكية", 5, 7)]]]), log, audio);
check("a speech-filled hole after the last word is transcribed and inserted", out.length === 5, out.map((x) => x.text).join(" "));
audio = sig([[1, 2], [0, 6]]);
out = await refineLongWords(w, ag(0, 8), answers([[2, 8, [W("هلوسة", 3, 4), W("وهمية", 4, 5), W("كلمة", 5, 6)]]]), log, audio);
check("a silent hole is not transcribed", out.length === 1);
audio = sig([[1, 2], [1, 6]]);
out = await refineLongWords(w, ag(0, 8), answers([[2, 8, [W("الم", 3, 4), W("ما", 4, 5)]]]), log, audio);
check("a hole answered with 2 words (too few for 6 s) is not inserted", out.length === 1);

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exitCode = failed ? 1 : 0;
