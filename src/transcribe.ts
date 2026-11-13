import { TextStreamer, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { analyzeSegments, type Segment } from "./segment.ts";

export const SAMPLE_RATE = 16000;
const HAS_ARABIC = /[ء-ي]/;
const TIMESTAMP_TOKEN = /<\|\d+(\.\d+)?\|>/g;

export type Word = { text: string; timestamp: [number, number | null] };
export type SegmentResult = { index: number; start: number; end: number; words: Word[] };

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
};

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

    if (words === undefined) {
      // a merged group looped: redo it segment by segment, so only the looping segment is lost
      log(`${label}: retrying its ${g.members.length} segments one by one`);
      words = [];
      for (const [i, m] of g.members.entries()) {
        const r = await transcribeRange(index, m.start, m.end, m.speechEnd, `${label}.${i + 1}`, false);
        if (r.words) words.push(...r.words);
      }
    }
    done++;
    processedSec += g.end - g.start;
    cb.onSegment?.({ index, start: g.start, end: g.end, words: words ?? [] }, { done, total: groups.length, processedSec });
    cb.onSegmentDone?.(index);
  }
  log(`total: audio ${totalAudio.toFixed(1)}s, processing ${totalProc.toFixed(1)}s, RTF ${(totalProc / Math.max(totalAudio, 1e-9)).toFixed(2)}`);
  return { finished: true, nextIndex: groups.length };
}
