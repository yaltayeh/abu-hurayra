// Types of the transcript -> Quran alignment (see docs/alignment.md).

export type AsrWord = { text: string; start: number; end: number };

/** One transcription group as produced by transcribeSegments (use `fromSegmentResult` to convert). */
export type AsrGroup = {
  start: number;
  end: number;
  words: AsrWord[];
  /** Silence boundaries inside the group (seconds). Together with group boundaries and long gaps they count as pauses. */
  breaks?: number[];
  /** Spans that produced no usable text (looping / empty output). */
  unrecognized?: { start: number; end: number }[];
};

export type OccurrenceKind =
  | "matched" // ASR word equals the Quran word after normalization (strict or loose)
  | "substituted" // aligned to a Quran word but spelled differently (ASR error)
  | "inferred" // Quran word the ASR did not produce; time is interpolated inside the gap
  | "extra"; // ASR word with no Quran counterpart (wordId is null)

export type Occurrence = {
  kind: OccurrenceKind;
  /** Word id in quran-core (index over all words, markers included); null for `extra`. */
  wordId: number | null;
  /** Index into core.textWords (markers skipped); null for `extra`. */
  textIndex: number | null;
  surah: number | null;
  ayah: number | null; // basmala of a surah (not Al-Fatiha) is reported as ayah 0 of that surah
  word: number | null; // 1-based position in the ayah
  start: number;
  end: number;
  /** Index in the matching sequence (QuranIndex), null for `extra`. Basmala words point at the basmala entries of their surah. */
  entry: number | null;
  /** 0..1. strict match 1, loose 0.9, substituted 0.3-0.7, inferred 0.3, extra 0; halved while the start is ambiguous. */
  confidence: number;
  /** ASR word indexes (flat, over all groups) behind this occurrence; empty for `inferred`. */
  asr: number[];
  group: number;
  /** Part of a basmala (the ids point at 1:1:1-4). `inferred` + basmala may be refined by resolveBasmalas. */
  basmala?: boolean;
  /** Recited again after a backward jump (a repetition, output as recited). */
  repeat?: boolean;
  /** The ASR merged this word with its neighbour or split it (يا + أيها). */
  split?: boolean;
  merged?: boolean;
  /** For `extra`: the ASR text. */
  text?: string;
  /** First word after a passage jump. */
  jump?: "passage" | "skip-forward" | "reanchor";
  ambiguous?: boolean;
};

export type AyahEvent = {
  surah: number;
  ayah: number;
  /** quran-core word id of the ayah-end marker the renderer should draw. */
  markerId: number;
  /** End time of the ayah's last word. */
  time: number;
  /** Every word of the ayah was matched/inferred in this pass (false when the recitation started mid-ayah or words are missing). */
  complete: boolean;
  /** Index into `occurrences` of the ayah's last word. */
  occurrence: number;
};

export type JumpEvent = {
  type: "repeat" | "passage" | "skip-forward" | "reanchor" | "start";
  time: number;
  asrIndex: number;
  from: string | null; // "surah:ayah:word" of the previous word
  to: string;
  /** For skip-forward: ayahs that were not recited. */
  skippedAyahs?: string[];
  reason: string;
};

export type Rejection = {
  asrFrom: number;
  asrTo: number;
  start: number;
  end: number;
  ratio: number;
  reason: "no-match" | "forbidden-jump";
  detail: string;
};

/** The stretch of time before the first word of a surah (other than Al-Fatiha / At-Tawbah) where its basmala belongs. */
export type BasmalaGap = {
  surah: number;
  /** Index (in `occurrences`) of the surah's first word. */
  first: number;
  /** Indexes of basmala occurrences already present: matched ones, or inferred ones (skipped by the ASR). */
  basmala: number[];
  recognized: boolean;
  /** Audio before the first word, after the previous recited word: where an isolated basmala would be. */
  start: number;
  end: number;
};

export type AlignResult = {
  occurrences: Occurrence[];
  ayahs: AyahEvent[];
  jumps: JumpEvent[];
  rejections: Rejection[];
  /** False when the whole input is rejected (matched ratio too low). */
  accepted: boolean;
  /** Other starting positions whose total cost is within `ambiguityMargin` of the best (e.g. an ayah repeated in several surahs). */
  alternatives: string[];
  /** Surahs whose basmala was not recognized (inferred): candidates for resolveBasmalas. */
  basmalaGaps: BasmalaGap[];
  stats: {
    asrWords: number;
    quranWordsMatched: number;
    substituted: number;
    inferred: number;
    extra: number;
    ayahsCompleted: number;
    cost: number;
    ms: number;
    cells: number;
  };
};

export type AlignConfig = {
  beam: number;
  /** Seeds (jump targets) kept per jump point. */
  seeds: number;
  /** Jumps to any position at an ayah boundary after a pause (prayer recordings, compilations). */
  passageJumps: boolean;
  pauseGap: number;
  maxSkip: number;
  wordsPerSecond: number;
  /** Consecutive unmatched words after which the path counts as lost and may re-anchor anywhere. */
  lostAfter: number;
  cost: { extra: number; skip: number; skipBasmala: number; skipInGap: number; back: number; jump: number; substituted: number; loose: number };
  /** Rejection: window size (ASR words), minimum matched ratio, minimum span length. */
  window: number;
  minRatio: number;
  minSpan: number;
  ambiguityMargin: number;
};

export const DEFAULT_CONFIG: AlignConfig = {
  beam: 64,
  seeds: 96,
  passageJumps: true,
  pauseGap: 0.3,
  maxSkip: 3,
  wordsPerSecond: 3.5,
  lostAfter: 4,
  cost: { extra: 0.9, skip: 0.8, skipBasmala: 0.1, skipInGap: 0.25, back: 1.0, jump: 2.0, substituted: 1.4, loose: 0.15 },
  window: 8,
  minRatio: 0.5,
  minSpan: 4,
  ambiguityMargin: 1.5,
};
