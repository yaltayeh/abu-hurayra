import { TextStreamer, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { analyzeSegments, type Segment } from "./segment.ts";
import { LONG_WORD_SEC } from "./long-word.ts";
import { findDip, voicedFraction } from "./audio-dips.ts";
import { normalize } from "./normalize.ts";

export const SAMPLE_RATE = 16000;
const HAS_ARABIC = /[ء-ي]/;
const TIMESTAMP_TOKEN = /<\|\d+(\.\d+)?\|>/g;

export type Word = { text: string; timestamp: [number, number | null] };
export type TimeSpan = { start: number; end: number };
export type SegmentResult = {
  index: number;
  start: number;
  end: number;
  words: Word[];
  /** Silence boundaries between the segments merged into this group (absolute seconds). The alignment treats them as pauses. */
  breaks?: number[];
  /** Spans of this group that produced no usable text (looping/empty output). The alignment may fill them with inferred words. */
  unrecognized?: TimeSpan[];
};

export type Callbacks = {
  /** Called once after segmentation. */
  onPlan?: (plan: { total: number; duration: number; segments: Segment[] }) => void;
  /** Draft text of the segment being transcribed (grows while tokens are generated). */
  onPartial?: (index: number, text: string) => void;
  /** A finished segment (absolute timestamps). Segments without Arabic text are not reported here. */
  onSegment?: (result: SegmentResult, progress: { done: number; total: number; processedSec: number }) => void;
  onLog?: (line: string) => void;
  /**
   * Returns the pipeline to use. Called once at the start, and again with `failed` set after a segment errored:
   * the caller should dispose the failed pipeline and return the next configuration's pipeline (null to give up).
   */
  getPipeline: (failed?: unknown) => Promise<AutomaticSpeechRecognitionPipeline | null>;
  /** Resume at this segment (segmentation is deterministic, so it is simply recomputed). The plan is not re-announced. */
  startIndex?: number;
  /**
   * Asked before every segment except the first of this call. Return true to stop here, so the caller can recycle
   * the pipeline (or the whole worker) and call again with `startIndex = nextIndex`.
   */
  shouldRecycle?: (since: { segments: number; seconds: number }) => boolean;
  /** Group options, or `false` for one call per silence-delimited segment (no merging). */
  grouping?: GroupOptions | false;
  /** Called after every finished segment (used for periodic debug logging). */
  onSegmentDone?: (index: number) => void;
  /** Re-transcribe the neighbourhood of abnormally long words (default on, `false` to disable). See `refineLongWords`. */
  refineLongWords?: boolean;
};

const REFINE_MAX_PER_GROUP = 8;

export type RunResult = { finished: boolean; nextIndex: number };

/**
 * Transformers.js 4.3.2 bug: the last word's end is wrong. The final EOS token never goes through the decoder, so
 * it has no cross-attention row and its timestamp is padded with 0; the end of the last word is read from it, giving
 * `0 + chunk time offset` (0 for one chunk, 20 s = 30 - 2 * 5 for the last of several).
 * Fix: a word whose end is missing or not after its start ends where the next word starts, and the last word of the
 * segment ends at `segmentEnd`.
 */
export function fixWordEnds(words: Word[], segmentEnd: number, hardEnd = segmentEnd): Word[] {
  return words.map((w, i) => {
    const [start, end] = w.timestamp;
    if (end != null && end > start) return w;
    const next = words[i + 1]?.timestamp[0];
    // last word: end of speech if it is after the start, else the end of the segment, else a minimal duration
    const last = segmentEnd > start ? segmentEnd : hardEnd > start ? hardEnd : start + 0.02;
    return { ...w, timestamp: [start, next != null && next > start ? next : last] };
  });
}

/** Whisper sometimes loops on a short segment ("د د د د …"). */
function isDegenerate(words: Word[]) {
  if (words.length < 8) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w.text.trim(), (counts.get(w.text.trim()) ?? 0) + 1);
  return Math.max(...counts.values()) / words.length >= 0.6;
}

export type Group = Segment & { members: Segment[] };

export type GroupOptions = {
  /** Consecutive segments are merged while the group stays within this many seconds. */
  targetSec?: number;
  /** The first group stays small so the first result appears quickly: at most 2 segments and this many seconds. */
  firstMaxSec?: number;
};

/**
 * Whisper pads every input to 30 s, so each call has a large fixed cost. Merge consecutive silence-delimited segments
 * into groups of up to `targetSec` (never over 30 s). Cuts stay on silences only; a segment longer than the target is
 * never merged and stays alone (it is chunked later).
 */
export function groupSegments(segments: Segment[], { targetSec = 25, firstMaxSec = 8 }: GroupOptions = {}): Group[] {
  const groups: Group[] = [];
  for (const seg of segments) {
    const g = groups.at(-1);
    const limit = groups.length === 1 ? firstMaxSec : targetSec;
    const fits = g && seg.end - g.start <= limit && (groups.length > 1 || g.members.length < 2);
    if (g && fits) {
      g.members.push(seg);
      g.end = seg.end;
      g.speechEnd = seg.speechEnd;
    } else {
      groups.push({ ...seg, members: [seg] });
    }
  }
  return groups;
}

export async function transcribeSegments(audio: Float32Array, cb: Callbacks): Promise<RunResult> {
  const log = cb.onLog ?? (() => {});
  const duration = audio.length / SAMPLE_RATE;

  const tSeg = performance.now();
  const { segments, info } = analyzeSegments(audio, SAMPLE_RATE);
  const groups: Group[] = cb.grouping === false ? segments.map((seg) => ({ ...seg, members: [seg] })) : groupSegments(segments, cb.grouping);
  log(
    `segmentation: ${segments.length} segments -> ${groups.length} groups in ${(performance.now() - tSeg).toFixed(0)}ms (audio ${duration.toFixed(1)}s), ` +
      `threshold ${info.thresholdDb.toFixed(1)} dB (floor ${info.floorDb.toFixed(1)}, speech ${info.speechDb.toFixed(1)}), ` +
      `longest segment ${info.longestSec.toFixed(1)}s, longest group ${Math.max(0, ...groups.map((g) => g.end - g.start)).toFixed(1)}s, retries ${info.retries}`,
  );
  const startIndex = cb.startIndex ?? 0;
  if (startIndex === 0) cb.onPlan?.({ total: groups.length, duration, segments: groups });

  let asr = await cb.getPipeline();
  if (!asr) throw new Error("no usable model configuration");

  let done = startIndex;
  let processedSec = groups.slice(0, startIndex).reduce((a, g) => a + (g.end - g.start), 0);
  const startSec = processedSec;
  let totalProc = 0;
  let totalAudio = 0;

  /** One Whisper call on [start, end). Returns the absolute-time words, or null when the output is unusable. */
  async function transcribeRange(index: number, start: number, end: number, speechEnd: number, label: string, partial: boolean) {
    const sub = audio.subarray(Math.round(start * SAMPLE_RATE), Math.round(end * SAMPLE_RATE));
    const dur = sub.length / SAMPLE_RATE;
    // Whisper only looks at 30 s: longer inputs must be chunked or the rest is silently dropped.
    const chunking = dur > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {};
    for (let attempt = 0; ; attempt++) {
      let draft = "";
      const streamer = new TextStreamer(asr!.tokenizer, {
        skip_prompt: true,
        callback_function: (piece: string) => {
          draft += piece;
          if (partial) cb.onPartial?.(index, draft.replace(TIMESTAMP_TOKEN, "").trim());
        },
      });
      const t0 = performance.now();
      try {
        const out = (await asr!(sub, {
          language: "arabic",
          task: "transcribe",
          return_timestamps: "word",
          ...chunking,
          // a loop would otherwise run to 448 tokens; recitation is ~4 tokens/s, so 12/s per 30 s window is generous
          max_new_tokens: Math.ceil(Math.min(dur, 30) * 12) + 20,
          streamer,
        } as never)) as { text: string; chunks?: Word[] };
        const ms = performance.now() - t0;
        totalProc += ms / 1000;
        totalAudio += dur;
        log(
          `${label}: audio ${dur.toFixed(1)}s${chunking.chunk_length_s ? " (chunked)" : ""}, ` +
            `processing ${(ms / 1000).toFixed(2)}s, RTF ${(ms / 1000 / dur).toFixed(2)}`,
        );
        const looped = isDegenerate(out.chunks ?? []);
        if (looped) log(`${label}: repetition loop ("${out.text.trim().slice(0, 30)}…")`);
        if (looped) return { words: null, looped: true };
        if (!HAS_ARABIC.test(out.text)) {
          log(`${label}: no Arabic letters, dropped ("${out.text.trim()}")`);
          return { words: null, looped: false };
        }
        const shifted = (out.chunks ?? []).map((w) => ({
          text: w.text,
          timestamp: [w.timestamp[0] + start, w.timestamp[1] == null ? null : w.timestamp[1] + start] as [number, number | null],
        }));
        return { words: fixWordEnds(shifted, speechEnd, end), looped: false };
      } catch (err) {
        log(`${label} FAILED: ${err}`);
        if (attempt >= 1) throw err;
        // ask the caller to dispose the failed pipeline and load the next configuration, then retry this call only
        const next = await cb.getPipeline(err);
        if (!next) throw err;
        asr = next;
      }
    }
  }

  for (let index = startIndex; index < groups.length; index++) {
    if (index > startIndex && cb.shouldRecycle?.({ segments: index - startIndex, seconds: processedSec - startSec })) {
      log(`recycle requested before group ${index + 1}`);
      return { finished: false, nextIndex: index };
    }
    const g = groups[index];
    const label = `group ${index + 1}/${groups.length}`;
    let { words } = await transcribeRange(index, g.start, g.end, g.speechEnd, label, true).then((r) => (r.looped && g.members.length > 1 ? { words: undefined, looped: true } : r));

    const unrecognized: TimeSpan[] = [];
    if (words === undefined) {
      // a merged group looped: redo it segment by segment, so only the looping segment is lost
      log(`${label}: retrying its ${g.members.length} segments one by one`);
      words = [];
      for (const [i, m] of g.members.entries()) {
        const r = await transcribeRange(index, m.start, m.end, m.speechEnd, `${label}.${i + 1}`, false);
        if (r.words) words.push(...r.words);
        else unrecognized.push({ start: m.start, end: m.end });
      }
    } else if (words === null) {
      unrecognized.push({ start: g.start, end: g.end });
    }
    if (words && cb.refineLongWords !== false) words = await refineLongWords(words, g, transcribeRange, log, audio);
    done++;
    processedSec += g.end - g.start;
    cb.onSegment?.({ index, start: g.start, end: g.end, words: words ?? [], breaks: g.members.slice(1).map((m) => m.start), unrecognized }, { done, total: groups.length, processedSec });
    cb.onSegmentDone?.(index);
  }
  log(`total: audio ${totalAudio.toFixed(1)}s, processing ${totalProc.toFixed(1)}s, RTF ${(totalProc / Math.max(totalAudio, 1e-9)).toFixed(2)}`);
  return { finished: true, nextIndex: groups.length };
}

type RangeFn = (index: number, start: number, end: number, speechEnd: number, label: string, partial: boolean) => Promise<{ words: Word[] | null | undefined }>;

/**
 * Whisper drops a repeated phrase when both occurrences are inside one call (18.mp3: "من لدنك رحمة" said twice in one 20 s group came back
 * once, and `لَدُنْكَ` was stretched over 9 s; the same audio transcribed segment by segment gives both). A group is several
 * silence-delimited segments merged to save calls, so when a word of the group lasts at least LONG_WORD_SEC the segments it spans are
 * transcribed one by one. Their words replace the group's words of that time range only if there are more of them; a long pause or a
 * real elongation gives the same words and the original is kept.
 */
export async function refineLongWords(words: Word[], g: Group, run: RangeFn, log: (line: string) => void, audio?: Float32Array): Promise<Word[]> {
  const bySegment = await refineSegmentBySegment(words, g, run, log);
  return audio ? refineByAcoustics(bySegment, g, run, log, audio) : bySegment;
}

async function refineSegmentBySegment(words: Word[], g: Group, run: RangeFn, log: (line: string) => void): Promise<Word[]> {
  if (g.members.length < 2) return words;
  const ranges: [number, number][] = []; // member index ranges to redo, merged
  for (const w of words) {
    const [start, end] = w.timestamp;
    if (end == null) continue;
    // suspicious: a long word, or a word of 1.8 s or more with a silence boundary of the group inside it (two segments, one word)
    const crossesBoundary = end - start >= 1.8 && g.members.some((m, k) => k > 0 && m.start > start + 0.2 && m.start < end - 0.2);
    if (end - start < LONG_WORD_SEC && !crossesBoundary) continue;
    const first = g.members.findIndex((m) => start < m.end);
    let last = first;
    while (last + 1 < g.members.length && g.members[last + 1].start < end) last++;
    if (first < 0) continue;
    const prev = ranges.at(-1);
    if (prev && first <= prev[1] + 1) prev[1] = Math.max(prev[1], last);
    else ranges.push([first, last]);
  }
  let out = words;
  for (const [a, b] of ranges.slice(0, REFINE_MAX_PER_GROUP)) {
    const from = g.members[a].start, to = g.members[b].end;
    const fresh: Word[] = [];
    for (let m = a; m <= b; m++) {
      const mem = g.members[m];
      const r = await run(-1, mem.start, mem.end, mem.speechEnd, `refine segment ${m + 1}/${g.members.length}`, false);
      if (r.words) fresh.push(...r.words);
    }
    const old = out.filter((w) => w.timestamp[0] >= from && w.timestamp[0] < to);
    // a stretched word of 4 s or more may hide new speech; a shorter one crossing a segment boundary is only trusted when it was simply said again
    const hasLong = old.some((w) => (w.timestamp[1] ?? 0) - w.timestamp[0] >= LONG_WORD_SEC);
    const used = fresh.length > old.length && keepsOld(old, fresh) && (hasLong || onlyRepeats(old, fresh));
    log(`long word(s) in ${from.toFixed(1)}-${to.toFixed(1)}s: segment by segment ${old.length} -> ${fresh.length} words${used ? ": " + fresh.map((x) => x.text.trim()).join(" ") : " (not used)"}`);
    if (used) out = [...out.filter((w) => w.timestamp[0] < from), ...fresh, ...out.filter((w) => w.timestamp[0] >= to)];
  }
  return out;
}

const DIP_WORD_SEC = 2.4; // a word at least this long is searched for an internal pause
const GAP_SEC = 1.5; // a hole between two words at least this long that contains speech is re-transcribed
const strip = (t: string) => normalize(t);
const similar = (a: string, b: string) => {
  const x = strip(a), y = strip(b);
  const m = x.length, n = y.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
};

/**
 * A real recovery keeps what was already there (the first pass of a repeated phrase, the word that was stretched) and adds to it; a
 * garbled re-transcription (halves of an elongated word) throws it away. The old words must all be found, in order, among the fresh ones.
 */
function keepsOld(old: Word[], fresh: Word[]): boolean {
  let at = 0;
  for (const o of old) {
    let found = false;
    for (let k = at; k < fresh.length; k++) {
      if (similar(o.text, fresh[k].text) >= 0.6) { at = k + 1; found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

/** Every fresh word is a (re)spelling of one of the old words: the old words were said again, nothing new was invented. */
function onlyRepeats(old: Word[], fresh: Word[]): boolean {
  return fresh.every((f) => old.some((o) => similar(o.text, f.text) >= 0.65));
}

/**
 * Two things Whisper does inside one call that the silence segmentation cannot see (18.mp3, checked by ear):
 *  1. A word said twice in a row with only a breath between ("فاختلط به" ×2) comes back once, as one 3-4 s word. If a word lasts
 *     >= DIP_WORD_SEC and its audio has a clear pause inside, each side is transcribed on its own; the two replace the word when they
 *     are two similar words (a repetition) or more words than before.
 *  2. A stretch of speech is left out altogether (7 s hole between two words). A hole >= GAP_SEC whose audio is mostly voiced is
 *     transcribed on its own and the words it gives are inserted.
 */
async function refineByAcoustics(words: Word[], g: Group, run: RangeFn, log: (line: string) => void, audio: Float32Array): Promise<Word[]> {
  const out: Word[] = [];
  const sr = SAMPLE_RATE;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const [start, end] = w.timestamp;
    // 2. a hole before this word
    const prevEnd = out.length ? (out[out.length - 1].timestamp[1] ?? g.start) : g.start;
    if (start - prevEnd >= GAP_SEC && voicedFraction(audio, sr, prevEnd, start, g.start, g.end) >= 0.5) {
      const r = await run(-1, prevEnd, start, start, `refine gap ${prevEnd.toFixed(1)}s`, false);
      const fresh = (r.words ?? []).filter((x) => x.timestamp[0] >= prevEnd - 0.05 && x.timestamp[0] < start);
      log(`gap ${prevEnd.toFixed(1)}-${start.toFixed(1)}s with speech: ${fresh.length} word(s)${fresh.length ? ": " + fresh.map((x) => x.text.trim()).join(" ") : ""}`);
      if (fresh.length >= 3 && fresh.length >= 0.4 * (start - prevEnd)) out.push(...fresh);
    }
    // 1. a long word with a pause inside
    if (end != null && end - start >= DIP_WORD_SEC) {
      const dip = findDip(audio, sr, start, end);
      if (dip) {
        const a = await run(-1, start, dip.start + 0.03, dip.start + 0.03, `refine dip ${start.toFixed(1)}s (1/2)`, false);
        const b = await run(-1, dip.end - 0.03, end, end, `refine dip ${start.toFixed(1)}s (2/2)`, false);
        const fa = a.words ?? [], fb = b.words ?? [];
        const fresh = [...fa, ...fb];
        const repetition = fa.length > 0 && fb.length > 0 && similar(fa.map((x) => x.text).join(" "), fb.map((x) => x.text).join(" ")) >= 0.6;
        const isLong = end - start >= LONG_WORD_SEC;
        if (fa.length && fb.length && fresh.length >= 2 && (repetition || (isLong && fresh.length > 2)) && keepsOld([w], fresh) && (isLong || onlyRepeats([w], fresh))) {
          log(`long word "${w.text.trim()}" ${(end - start).toFixed(1)}s has a pause at ${dip.start.toFixed(2)}-${dip.end.toFixed(2)}s: ${fresh.map((x) => x.text.trim()).join(" | ")}`);
          out.push(...fresh);
          continue;
        }
        log(`long word "${w.text.trim()}" ${(end - start).toFixed(1)}s has a pause at ${dip.start.toFixed(2)}s but its halves are "${fa.map((x) => x.text.trim()).join(" ")}" / "${fb.map((x) => x.text.trim()).join(" ")}": kept`);
      }
    }
    out.push(w);
  }
  // 2'. a hole after the last word of the group (the group's speech continues but no words came out)
  const lastEnd = out.length ? (out[out.length - 1].timestamp[1] ?? g.start) : g.start;
  if (out.length && g.end - lastEnd >= GAP_SEC && voicedFraction(audio, sr, lastEnd, g.end, g.start, g.end) >= 0.5) {
    const r = await run(-1, lastEnd, g.end, g.end, `refine tail gap ${lastEnd.toFixed(1)}s`, false);
    const fresh = (r.words ?? []).filter((x) => x.timestamp[0] >= lastEnd - 0.05);
    log(`gap ${lastEnd.toFixed(1)}-${g.end.toFixed(1)}s with speech: ${fresh.length} word(s)${fresh.length ? ": " + fresh.map((x) => x.text.trim()).join(" ") : ""}`);
    if (fresh.length >= 3 && fresh.length >= 0.4 * (g.end - lastEnd)) out.push(...fresh);
  }
  return out;
}
