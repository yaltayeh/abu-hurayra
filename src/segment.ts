export type Segment = {
  /** Cut points in seconds, in the middle of the surrounding silences (or the file edges). */
  start: number;
  end: number;
  /** First/last non-silent frame inside the segment, in seconds. */
  speechStart: number;
  speechEnd: number;
};

export type SegmentInfo = {
  floorDb: number;
  speechDb: number;
  /** Silence threshold (dB) used for the first pass. */
  thresholdDb: number;
  segments: number;
  longestSec: number;
  /** Number of times a >30 s region had to be retried with a higher threshold. */
  retries: number;
};

export type SegmentOptions = {
  frameMs?: number;
  /** Threshold = floor + this fraction of the (speech - floor) dB range. */
  thresholdFraction?: number;
  /** A silence must last at least this long (ms) to be a cut point. */
  minSilenceMs?: number;
  /** Segments with less speech than this (ms) are dropped as noise. */
  minSpeechMs?: number;
  /** Regions longer than this (s) are retried with a higher threshold. */
  maxSegmentSec?: number;
};

const percentile = (sorted: Float32Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Split audio at silences only. Cuts go in the middle of silences of at least `minSilenceMs`, so a cut never falls
 * inside speech; segments may therefore be longer than 30 s.
 *
 * The silence threshold is adaptive: frame RMS is measured in dB, the noise floor (10th percentile) and the speech
 * level (90th percentile) are estimated, and the threshold sits `thresholdFraction` of the way from floor to speech.
 * A region that is still longer than `maxSegmentSec` is retried with progressively higher thresholds; if even the
 * highest threshold finds no pause of `minSilenceMs`, the longest pause in that region is used.
 */
export function analyzeSegments(
  audio: Float32Array,
  sampleRate = 16000,
  { frameMs = 20, thresholdFraction = 0.3, minSilenceMs = 300, minSpeechMs = 200, maxSegmentSec = 30 }: SegmentOptions = {},
): { segments: Segment[]; info: SegmentInfo } {
  const frame = Math.round((sampleRate * frameMs) / 1000);
  const n = Math.floor(audio.length / frame);
  const emptyInfo: SegmentInfo = { floorDb: 0, speechDb: 0, thresholdDb: 0, segments: 0, longestSec: 0, retries: 0 };
  if (n === 0) return { segments: [], info: emptyInfo };

  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * frame, e = i + frame; i < e; i++) sum += audio[i] * audio[i];
    db[f] = 20 * Math.log10(Math.sqrt(sum / frame) + 1e-9);
  }

  const sorted = Float32Array.from(db).sort();
  const speechDb = percentile(sorted, 0.9);
  // digital silence (e.g. padding) would drag the 10th percentile far down; keep the floor within 45 dB of speech
  const floorDb = Math.max(percentile(sorted, 0.1), speechDb - 45);
  const thresholdAt = (fraction: number) => floorDb + fraction * (speechDb - floorDb);
  const baseThreshold = thresholdAt(thresholdFraction);

  const minFrames = Math.ceil(minSilenceMs / frameMs);
  const maxFrames = Math.round((maxSegmentSec * 1000) / frameMs);
  let retries = 0;

  /** Silence runs [from, to) fully inside (a, b), at least `min` frames long. */
  const runs = (a: number, b: number, threshold: number, min: number) => {
    const out: [number, number][] = [];
    for (let f = a; f < b; ) {
      if (db[f] >= threshold) { f++; continue; }
      let g = f;
      while (g < b && db[g] < threshold) g++;
      if (g - f >= min && f > a && g < b) out.push([f, g]);
      f = g;
    }
    return out;
  };

  /** Cut frames for the region [a, b), refining with higher thresholds while it is longer than maxSegmentSec. */
  const split = (a: number, b: number, fraction: number): number[] => {
    if (b - a <= maxFrames) return [a, b];
    retries++;
    for (let fr = fraction + 0.1; fr <= 0.95; fr += 0.1) {
      const found = runs(a, b, thresholdAt(fr), minFrames);
      if (found.length) return cutAt(a, b, found.map(([s, e]) => Math.floor((s + e) / 2)), fr);
    }
    // no pause of minSilenceMs even at the highest threshold: accept the longest pause there is (>= 100 ms)
    const any = runs(a, b, thresholdAt(0.95), Math.ceil(100 / frameMs));
    if (!any.length) return [a, b];
    const [s, e] = any.reduce((best, r) => (r[1] - r[0] > best[1] - best[0] ? r : best));
    return cutAt(a, b, [Math.floor((s + e) / 2)], 0.95);
  };
  const cutAt = (a: number, b: number, mids: number[], fraction: number): number[] => {
    const pts = [a, ...mids, b];
    const out: number[] = [a];
    for (let i = 0; i + 1 < pts.length; i++) out.push(...split(pts[i], pts[i + 1], fraction).slice(1));
    return out;
  };

  // first pass at the base threshold
  const first = [0, ...runs(0, n, baseThreshold, minFrames).map(([s, e]) => Math.floor((s + e) / 2)), n];
  const cuts: number[] = [0];
  for (let i = 0; i + 1 < first.length; i++) cuts.push(...split(first[i], first[i + 1], thresholdFraction).slice(1));

  const minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
  const t = (f: number) => (f * frame) / sampleRate;
  const segments: Segment[] = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c], b = cuts[c + 1];
    let firstF = -1, lastF = -1, count = 0;
    for (let f = a; f < b; f++) if (db[f] >= baseThreshold) { if (firstF < 0) firstF = f; lastF = f; count++; }
    if (count < minSpeechFrames) continue; // pure silence / noise blip
    segments.push({ start: t(a), end: c + 2 === cuts.length ? audio.length / sampleRate : t(b), speechStart: t(firstF), speechEnd: t(lastF + 1) });
  }
  const longestSec = segments.reduce((m, s) => Math.max(m, s.end - s.start), 0);
  return { segments, info: { floorDb, speechDb, thresholdDb: baseThreshold, segments: segments.length, longestSec, retries } };
}

export const segmentAtSilences = (audio: Float32Array, sampleRate = 16000, options?: SegmentOptions): Segment[] =>
  analyzeSegments(audio, sampleRate, options).segments;
