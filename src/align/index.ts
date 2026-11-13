export { alignTranscript, ayahEvents, findBasmalaGaps } from "./align.ts";
export { buildQuranIndex, type QuranIndex } from "./quran-index.ts";
export { resolveBasmalas, type BasmalaNote, type BasmalaOptions, type BasmalaProbe } from "./basmala.ts";
export * from "./types.ts";

import type { SegmentResult } from "../transcribe.ts";
import type { AsrGroup } from "./types.ts";

/** Convert a transcribeSegments result (timestamps as tuples) to the aligner's input. */
export function fromSegmentResult(r: SegmentResult): AsrGroup {
  return {
    start: r.start,
    end: r.end,
    words: r.words.map((w) => ({ text: w.text.trim(), start: w.timestamp[0], end: w.timestamp[1] ?? w.timestamp[0] + 0.1 })),
    breaks: r.breaks,
    unrecognized: r.unrecognized,
  };
}
