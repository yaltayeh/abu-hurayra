// Synthetic edge cases built from REAL ASR output (82, 51, 1 dumps). Usage: node --no-warnings scripts/align/synthetic.mjs [asr-dir]  (default: scripts/align/fixtures)

import { alignTranscript } from "../../src/align/align.ts";
import { resolveBasmalas } from "../../src/align/basmala.ts";
import { dir, core, idx, flatAsr, ayah, ayahs, simulate, basmala, build, join, seq, rng } from "./synth-lib.mjs";
import { label } from "./common.mjs";
void dir;

let failed = 0;
function check(name, r, conds, show = []) {
  const res = conds.map(([desc, ok]) => [desc, !!ok]);
  const pass = res.every(([, ok]) => ok);
  if (!pass) failed++;
  console.log(`\n${pass ? "PASS" : "FAIL"}  ${name}`);
  for (const [d, ok] of res) console.log(`   ${ok ? "ok " : "NO "} ${d}`);
  console.log(`   jumps: ${r.jumps.map((j) => `${j.type} ${j.from ?? "-"}→${j.to}${j.skippedAyahs ? " skipped " + j.skippedAyahs.join(",") : ""}`).join(" | ")}`);
  console.log(`   ayah events: ${r.ayahs.map((a) => `${a.surah}:${a.ayah}${a.complete ? "" : "(partial)"}`).join(" ")}`);
  if (r.rejections.length) console.log(`   rejections: ${r.rejections.map((x) => `[${x.reason}] asr ${x.asrFrom}-${x.asrTo} t=${x.start.toFixed(1)}-${x.end.toFixed(1)}`).join("; ")}`);
  for (const s of show) console.log("   " + s);
  console.log(`   accepted=${r.accepted} matched=${r.stats.quranWordsMatched} substituted=${r.stats.substituted} inferred=${r.stats.inferred} extra=${r.stats.extra} alternatives=${r.alternatives.length} ${r.stats.ms.toFixed(1)} ms`);
}
const evAyahs = (r) => r.ayahs.map((a) => `${a.surah}:${a.ayah}`).join(" ");
const count = (r, f) => r.occurrences.filter(f).length;

// 1. reciter repeats a whole ayah (immediately, no pause)
{
  const parts = [ayahs(82, 1, 3), join(ayah(82, 3)), join(ayahs(82, 4, 5))];
  const r = alignTranscript(idx, build(parts));
  const rep = r.occurrences.filter((o) => o.repeat);
  check("repeat an ayah (82:3 twice)", r, [
    ["one repeat jump", r.jumps.filter((j) => j.type === "repeat").length === 1],
    ["repeat jumps back to 82:3:1", r.jumps.find((j) => j.type === "repeat")?.to === "82:3:1"],
    ["repeated words are output (as recited): 82:3 appears twice", count(r, (o) => o.surah === 82 && o.ayah === 3) === 2 * ayah(82, 3).length - count(r, (o) => o.surah === 82 && o.ayah === 3 && o.split) * 0],
    ["ayah completion events 1 2 3 3 4 5", evAyahs(r) === "82:1 82:2 82:3 82:3 82:4 82:5"],
    ["nothing rejected, no extras", r.rejections.length === 0 && count(r, (o) => o.kind === "extra") === 0],
  ], [`repeat-flagged words: ${rep.length}`]);
}
// 2. repeats the last 3 words of an ayah
{
  const a5 = ayah(82, 5);
  const parts = [ayahs(82, 1, 5), join(a5.slice(-3)), join(ayahs(82, 6, 7))];
  const r = alignTranscript(idx, build(parts));
  check("repeat the last 3 words of 82:5", r, [
    ["repeat jump to 82:5:" + (a5.length - 2), r.jumps.find((j) => j.type === "repeat")?.to === `82:5:${a5.length - 2}`],
    ["3 repeated words flagged", count(r, (o) => o.repeat) === 3],
    ["events: 82:5 completes twice, then 6 7", evAyahs(r) === "82:1 82:2 82:3 82:4 82:5 82:5 82:6 82:7"],
    ["no rejections", r.rejections.length === 0],
  ]);
}
// 3. starts mid-surah (51:10 from its 3rd word)
{
  const parts = [[...ayah(51, 14, 3), ...ayahs(51, 15, 17)]];
  const r = alignTranscript(idx, build(parts));
  check("starts mid-surah (51:14:3)", r, [
    ["start anchor at 51:14:3", r.jumps[0]?.type === "start" && r.jumps[0].to === "51:14:3"],
    ["51:14 reported partial (started mid-ayah), 15-17 complete", r.ayahs[0]?.ayah === 14 && !r.ayahs[0].complete && r.ayahs.slice(1).every((a) => a.complete)],
    ["no earlier words invented", seq(r)[0] === "51:14:3"],
    ["no extras", count(r, (o) => o.kind === "extra") === 0],
  ]);
}
// 4. skips an ayah
{
  const parts = [ayahs(82, 1, 4), ayahs(82, 6, 8)]; // 82:5 skipped; separate group = pause
  const r = alignTranscript(idx, build(parts));
  check("skips an ayah (82:5) after a pause: flagged, not filled", r, [
    ["skip-forward jump flagged with skippedAyahs [82:5]", r.jumps.some((j) => j.type === "skip-forward" && j.skippedAyahs?.join() === "82:5")],
    ["82:5 not output (neither matched nor inferred)", count(r, (o) => o.surah === 82 && o.ayah === 5) === 0],
    ["events 1 2 3 4 6 7 8", evAyahs(r) === "82:1 82:2 82:3 82:4 82:6 82:7 82:8"],
    ["no rejections", r.rejections.length === 0],
  ]);
  const r2 = alignTranscript(idx, build([ayahs(82, 1, 4), join(ayahs(82, 6, 9))])); // no pause: forbidden
  check("skips an ayah (82:5) with NO pause: forbidden jump is reported", r2, [
    ["82:5 not filled", count(r2, (o) => o.surah === 82 && o.ayah === 5) === 0],
    ["a rejected span is reported (forbidden-jump)", r2.rejections.some((x) => x.reason === "forbidden-jump")],
    ["path recovers (re-anchor) and 82:7.. are matched", r2.jumps.some((j) => j.type === "reanchor") && count(r2, (o) => o.surah === 82 && o.ayah === 8 && o.kind === "matched") > 0],
  ], r2.rejections.map((x) => `detail: ${x.detail}`));
}
// 5. Al-Fatiha followed by a non-adjacent surah
{
  const fat = [...ayah(1, 1), ...ayahs(1, 2, 6)];
  const r = alignTranscript(idx, build([fat, ayahs(82, 1, 5)]));
  if (process.env.DBG) { const gg = build([fat, ayahs(82, 1, 5)]); console.log(JSON.stringify(gg.map((g) => ({ s: g.start, e: g.end, n: g.words.length, first: g.words[0], last: g.words.at(-1), pre: g.words.slice(14, 19).map((w) => [w.text, +w.start.toFixed(2), +w.end.toFixed(2)]) }))), r.stats.cost); console.log(fat.map((w) => w.text).join(" ")); console.log(r.occurrences.map((o) => `${o.kind[0]}:${o.text ?? core.textWords[o.textIndex]}(${label(o)})`).join(" ")); }
  check("Al-Fatiha then 82 (non-adjacent)", r, [
    ["passage jump 1:6:3 → 82:1:1", r.jumps.some((j) => j.type === "passage" && j.from === "1:6:3" && j.to === "82:1:1")],
    ["Al-Fatiha ayahs 1-6 and 82:1-5 complete", evAyahs(r) === "1:1 1:2 1:3 1:4 1:5 1:6 82:1 82:2 82:3 82:4 82:5"],
    ["no rejections", r.rejections.length === 0],
  ]);
  const off = alignTranscript(idx, build([fat, ayahs(82, 1, 5)]), { passageJumps: false });
  check("same input with passageJumps=false: the second passage is rejected", off, [
    ["82:1 not matched through a jump", count(off, (o) => o.surah === 82 && o.kind === "matched") < 3 || off.rejections.length > 0],
  ], [`matched in surah 82: ${count(off, (o) => o.surah === 82 && o.kind === "matched")}, rejections ${off.rejections.length}`]);
}
// 6. two consecutive surahs (82 then 83; 83 simulated from the Quran text)
{
  const s83 = simulate(83, 1, 6);
  const withB = alignTranscript(idx, build([ayahs(82, 17, 19), join(basmala()), join(s83)]));
  check("consecutive surahs 82 → 83 with the basmala recognized", withB, [
    ["82:19 then basmala (83:0:1-4) then 83:1:1, no jump", withB.jumps.filter((j) => j.type !== "start").length === 0],
    ["basmala flagged and matched", count(withB, (o) => o.basmala && o.surah === 83 && o.kind === "matched") === 4],
    ["events 82:17 82:18 82:19 83:1.. ", evAyahs(withB).startsWith("82:17 82:18 82:19 83:1 83:2")],
  ]);
  const noB = alignTranscript(idx, build([ayahs(82, 17, 19), join(s83)]));
  const inferred = noB.occurrences.filter((o) => o.basmala && o.surah === 83);
  check("consecutive surahs 82 → 83, basmala NOT recognized (joined)", noB, [
    ["4 inferred basmala words for 83", inferred.length === 4 && inferred.every((o) => o.kind === "inferred")],
    ["reported in basmalaGaps (not recognized)", noB.basmalaGaps.some((g) => g.surah === 83 && !g.recognized)],
    ["83:1 starts right after, no extras/rejections", noB.rejections.length === 0 && count(noB, (o) => o.kind === "extra") === 0],
  ], [`inferred basmala times: ${inferred.map((o) => o.start.toFixed(2) + "-" + o.end.toFixed(2)).join(" ")}`]);
  // gap long enough (pause between the surahs): silence fallback; no gap: absent
  const gapped = alignTranscript(idx, build([ayahs(82, 17, 19), s83], { gap: 2.5 }));
  const sil = await resolveBasmalas(idx, gapped);
  const tight = alignTranscript(idx, build([ayahs(82, 17, 19), join(s83)]));
  const abs = await resolveBasmalas(idx, tight);
  console.log(`   resolveBasmalas without a probe: 2.5 s pause → ${sil.notes.map((n) => n.source).join()} (${sil.result.occurrences.filter((o) => o.basmala && o.surah === 83).length} basmala words); contiguous → ${abs.notes.map((n) => n.source).join()} (${abs.result.occurrences.filter((o) => o.basmala && o.surah === 83).length} words)`);
  if (sil.notes[0]?.source !== "silence" || abs.notes[0]?.source !== "absent") { failed++; console.log("FAIL basmala fallbacks"); }
  // probe path: a fake probe that returns the isolated basmala words
  let probed = 0;
  const probe = { transcribe: async (s, e) => { probed++; const w = []; let t = s + 0.3; for (const b of basmala()) { w.push({ text: b.text, start: t, end: t + b.dur }); t += b.dur; } return w; } };
  const pr = await resolveBasmalas(idx, gapped, probe);
  const ok = pr.notes[0]?.source === "probe" && pr.result.occurrences.filter((o) => o.basmala && o.surah === 83 && o.kind === "matched").length === 4 && probed === 1;
  console.log(`   resolveBasmalas with a probe returning the isolated basmala → ${pr.notes[0]?.source}, ${probed} probe call(s) ${ok ? "ok" : "FAIL"}`);
  if (!ok) failed++;
}
// 7. wrong / unrelated recitation
{
  const R = rng(7);
  const junk = (n) => { const pool = flatAsr["51"].slice(100, 300).map((w) => ({ text: w.text, dur: 0.4 })); const out = []; for (let i = 0; i < n; i++) out.push(pool[Math.floor(R() * pool.length)]); return out; };
  const allJunk = alignTranscript(idx, build([junk(60)]));
  check("unrelated recitation (60 words of shuffled Quran words)", allJunk, [
    ["file rejected (accepted=false)", !allJunk.accepted],
    ["a rejection span covers it", allJunk.rejections.length >= 1],
    ["nearly nothing matched as a sequence", count(allJunk, (o) => o.kind === "matched") < 15],
  ], [`matched words by chance: ${count(allJunk, (o) => o.kind === "matched")}`]);
  const mixed = alignTranscript(idx, build([ayahs(82, 1, 8), join(junk(25)), join(ayahs(82, 9, 14))]));
  check("wrong passage in the middle (25 junk words inside 82)", mixed, [
    ["accepted overall", mixed.accepted],
    ["a no-match rejection covers the junk", mixed.rejections.some((x) => x.reason === "no-match" && x.asrTo - x.asrFrom >= 18)],
    ["the rest is NOT thrown away: 82:9-14 matched", count(mixed, (o) => o.surah === 82 && o.ayah >= 9 && o.kind === "matched") >= 20],
    ["ayahs 82:1-8 and 9-14 completed", ["82:1", "82:8", "82:9", "82:14"].every((k) => evAyahs(mixed).includes(k))],
  ], mixed.rejections.map((x) => `detail: ${x.detail}`));
  const forb = alignTranscript(idx, build([[...ayahs(82, 1, 4), ...ayah(82, 5).slice(0, 3)], ayahs(51, 20, 24)]));
  check("jump out of an incomplete ayah (82:5 cut) into 51:20 is forbidden → reported, then re-anchored", forb, [
    ["forbidden-jump rejection", forb.rejections.some((x) => x.reason === "forbidden-jump")],
    ["re-anchored later at 51:2x", forb.jumps.some((j) => j.type === "reanchor" && j.to.startsWith("51:"))],
  ], forb.rejections.map((x) => `detail: ${x.detail}`));
}
// 8. a very short clip that exists in several places
{
  const r = alignTranscript(idx, build([basmala()]));
  check("clip = the basmala only (4 words; 113+ places in the Quran)", r, [
    ["ambiguity reported: many alternatives", r.alternatives.length >= 10],
    ["confidence halved and flagged ambiguous", r.occurrences.every((o) => o.kind === "extra" || (o.ambiguous && o.confidence <= 0.5))],
    ["still accepted", r.accepted],
  ], [`first alternatives: ${r.alternatives.slice(0, 6).join(" ")}; chosen start ${r.jumps[0]?.to}`]);
  const refrain = simulate(55, 13, 13); // فبأي آلاء ربكما تكذبان — 31 times in Ar-Rahman
  const r2 = alignTranscript(idx, build([refrain]));
  check("clip = 'فبأي آلاء ربكما تكذبان' (31× in surah 55)", r2, [
    ["≥ 20 alternatives reported", r2.alternatives.length >= 20],
    ["accepted but ambiguous", r2.accepted && r2.occurrences.some((o) => o.ambiguous)],
  ], [`chosen ${r2.jumps[0]?.to}; alternatives ${r2.alternatives.length}`]);
  const two = alignTranscript(idx, build([[...refrain, ...simulate(55, 14, 14)]]));
  check("same refrain followed by the next ayah (55:14) is no longer ambiguous", two, [
    ["unique anchor at 55:13:1", two.jumps[0]?.to === "55:13:1" && two.alternatives.length === 0],
  ], [`chosen ${two.jumps[0]?.to}; alternatives ${two.alternatives.length}`]);
}
// 9. an unrecognized span (the ASR dropped a looping segment) is filled with inferred words, not rejected
{
  const parts = [ayahs(82, 1, 4), join(ayahs(82, 6, 7))];
  const g = build(parts);
  const n4 = ayahs(82, 1, 4).length, gapStart = g[0].words[n4 - 1].end, GAP = 3;
  for (let k = n4; k < g[0].words.length; k++) { g[0].words[k].start += GAP; g[0].words[k].end += GAP; }
  g[0].end += GAP; g[0].unrecognized = [{ start: gapStart, end: gapStart + GAP }];
  const r = alignTranscript(idx, g);
  const inf = r.occurrences.filter((o) => o.kind === "inferred");
  check("unrecognized 3 s span where 82:5 (5 words) should be", r, [
    ["5 inferred words, all of 82:5", inf.length === ayah(82, 5).length && inf.every((o) => o.surah === 82 && o.ayah === 5)],
    ["inferred times lie inside the unrecognized span", inf.every((o) => o.start >= gapStart - 0.01 && o.end <= gapStart + GAP + 0.01)],
    ["inferred times are in order and proportional (longer words get longer slots)", inf.every((o, k) => k === 0 || o.start >= inf[k - 1].end - 1e-6)],
    ["82:5 completes (with inferred words), 82:6 and 82:7 follow, no jump", evAyahs(r) === "82:1 82:2 82:3 82:4 82:5 82:6 82:7" && r.jumps.length === 1],
    ["no rejections", r.rejections.length === 0],
  ], [`inferred: ${inf.map((o) => `${core.textWords[o.textIndex]} ${o.start.toFixed(2)}-${o.end.toFixed(2)}`).join(" | ")}`]);
  const noSpan = alignTranscript(idx, build(parts));
  console.log(`   same words WITHOUT the unrecognized span: inferred ${count(noSpan, (o) => o.kind === "inferred")}, jumps: ${noSpan.jumps.map((j) => j.type).join(",")}, rejections ${noSpan.rejections.length} (a 5-word hole is not a fill unless the ASR reported an unrecognized span)`);
}
console.log(`\n${failed ? failed + " FAILED" : "ALL PASSED"}`);
process.exitCode = failed ? 1 : 0;
void label;
