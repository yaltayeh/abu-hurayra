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
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exitCode = failed ? 1 : 0;
