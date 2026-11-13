// Basmala resolution (rule 7). The ASR usually skips a basmala that is joined to the following speech, so the aligner
// reports where each surah's basmala should be (AlignResult.basmalaGaps). Here:
//   1. re-transcribe the audio of that gap on its own (an isolated basmala IS transcribed) via `probe`;
//   2. if that does not recognize it, split by silence: the gap between the previous recited word and the surah's
//      first word is bounded by silence, so the basmala is placed in it (inferred, low confidence) when it is long
//      enough to hold one;
//   3. if the gap is too short for a basmala, none was recited: the inferred basmala is removed.
import { normalize } from "../normalize.ts";
import { ayahEvents, findBasmalaGaps } from "./align.ts";
import type { QuranIndex } from "./quran-index.ts";
import type { AlignResult, AsrWord, Occurrence } from "./types.ts";

export type BasmalaProbe = {
  /** Transcribe [start, end) of the audio on its own; absolute timestamps. null when nothing usable. */
  transcribe: (start: number, end: number) => Promise<AsrWord[] | null>;
};
export type BasmalaOptions = {
  /** Gap shorter than this cannot hold a basmala (seconds). */
  minGap?: number;
  /** Basmala words (of 4) the isolated transcription must contain. */
  minMatch?: number;
};
export type BasmalaNote = { surah: number; source: "recognized" | "probe" | "silence" | "absent"; start: number; end: number };

const sim = (a: string, b: string) => {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n, 1);
};

function occurrenceFor(idx: QuranIndex, q: number, p: Pick<Occurrence, "kind" | "start" | "end" | "confidence" | "asr" | "group">): Occurrence {
  return { wordId: idx.coreId[q], textIndex: idx.textIndex[q], surah: idx.surah[q], ayah: idx.ayah[q], word: idx.pos[q], entry: q, basmala: true, ...p };
}

export async function resolveBasmalas(
  idx: QuranIndex,
  result: AlignResult,
  probe?: BasmalaProbe,
  { minGap = 1.2, minMatch = 3 }: BasmalaOptions = {},
): Promise<{ result: AlignResult; notes: BasmalaNote[] }> {
  const occ = result.occurrences.slice();
  const notes: BasmalaNote[] = [];
  const gaps = findBasmalaGaps(idx, occ);
  for (const gap of gaps.reverse()) {
    if (gap.recognized) {
      notes.push({ surah: gap.surah, source: "recognized", start: gap.start, end: gap.end });
      continue;
    }
    const at = gap.basmala.length ? gap.basmala[0] : gap.first;
    const firstEntry = occ[gap.first].entry!;
    const entries = [firstEntry - 4, firstEntry - 3, firstEntry - 2, firstEntry - 1]; // the surah's basmala block
    const group = occ[gap.first].group;
    const remove = () => occ.splice(at, gap.basmala.length);
    const len = gap.end - gap.start;
    if (len < minGap) {
      remove();
      notes.push({ surah: gap.surah, source: "absent", start: gap.start, end: gap.end });
      continue;
    }
    let placed: Occurrence[] | null = null;
    if (probe) {
      const words = (await probe.transcribe(gap.start, gap.end)) ?? [];
      const norm = words.map((w) => normalize(w.text));
      const hit: (AsrWord | null)[] = entries.map(() => null);
      let from = 0;
      entries.forEach((q, k) => {
        for (let t = from; t < norm.length; t++) {
          if (sim(norm[t], idx.strictStr[idx.strict[q]]) >= 0.6) { hit[k] = words[t]; from = t + 1; break; }
        }
      });
      if (hit.filter(Boolean).length >= minMatch) {
        placed = entries.map((q, k) => occurrenceFor(idx, q, hit[k]
          ? { kind: "matched", start: hit[k]!.start, end: hit[k]!.end, confidence: 1, asr: [], group }
          : { kind: "inferred", start: NaN, end: NaN, confidence: 0.3, asr: [], group }));
        // fill the missing ones between their neighbours, proportional to letters
        for (let k = 0; k < placed.length; k++) {
          if (!Number.isNaN(placed[k].start)) continue;
          let b = k;
          while (b < placed.length && Number.isNaN(placed[b].start)) b++;
          const from = k > 0 ? placed[k - 1].end : gap.start, to = b < placed.length ? placed[b].start : gap.end;
          const w = entries.slice(k, b).map((q) => Math.max(1, idx.letters[q]));
          const total = w.reduce((x, y) => x + y, 0);
          let t = from;
          for (let r = k; r < b; r++) { const d = ((to - from) * w[r - k]) / total; placed[r].start = t; placed[r].end = t + d; t += d; }
        }
        notes.push({ surah: gap.surah, source: "probe", start: gap.start, end: gap.end });
      }
    }
    if (!placed) {
      const w = entries.map((q) => Math.max(1, idx.letters[q]));
      const total = w.reduce((x, y) => x + y, 0);
      let t = gap.start;
      placed = entries.map((q, k) => {
        const d = (len * w[k]) / total;
        const o = occurrenceFor(idx, q, { kind: "inferred", start: t, end: t + d, confidence: 0.3, asr: [], group });
        t += d;
        return o;
      });
      notes.push({ surah: gap.surah, source: "silence", start: gap.start, end: gap.end });
    }
    occ.splice(at, gap.basmala.length, ...placed);
  }
  const count = (kd: Occurrence["kind"]) => occ.filter((o) => o.kind === kd).length;
  const out: AlignResult = {
    ...result,
    occurrences: occ,
    ayahs: ayahEvents(idx, occ),
    basmalaGaps: findBasmalaGaps(idx, occ),
    stats: { ...result.stats, quranWordsMatched: count("matched"), substituted: count("substituted"), inferred: count("inferred"), extra: count("extra"), ayahsCompleted: ayahEvents(idx, occ).length },
  };
  return { result: out, notes: notes.reverse() };
}
