// Small energy-envelope helpers used to look inside a long word or a gap between words (see refineLongWords in transcribe.ts).
const HOP = 0.01; // s
const WIN = 0.02; // s

/** Frame energies in dB (20 ms window, 10 ms hop) of audio[from, to). */
export function envelopeDb(audio: Float32Array, sampleRate: number, from: number, to: number): number[] {
  const a = Math.max(0, Math.round(from * sampleRate)), b = Math.min(audio.length, Math.round(to * sampleRate));
  const hop = Math.round(HOP * sampleRate), win = Math.round(WIN * sampleRate);
  const out: number[] = [];
  for (let i = a; i + win <= b; i += hop) {
    let e = 0;
    for (let k = 0; k < win; k++) e += audio[i + k] * audio[i + k];
    out.push(10 * Math.log10(e / win + 1e-12));
  }
  return out;
}

const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

/**
 * The longest low-energy stretch (>= minDip s, more than 12 dB under the span's loud level) strictly inside [start, end], with at least
 * `minSide` s of audio on both sides. A word said twice in a row with a short breath between the two is a long "word" with such a dip.
 */
export function findDip(audio: Float32Array, sampleRate: number, start: number, end: number, minDip = 0.28, minSide = 0.5): { start: number; end: number } | null {
  const env = envelopeDb(audio, sampleRate, start, end);
  if (env.length < 20) return null;
  const level = percentile(env, 0.9) - 12;
  let best: { start: number; end: number } | null = null;
  let run = -1;
  for (let i = 0; i <= env.length; i++) {
    const low = i < env.length && env[i] < level;
    if (low && run < 0) run = i;
    if (!low && run >= 0) {
      const s = start + run * HOP, e = start + i * HOP;
      if (e - s >= minDip && s - start >= minSide && end - e >= minSide && (!best || e - s > best.end - best.start)) best = { start: s, end: e };
      run = -1;
    }
  }
  return best;
}

/** Fraction of frames of [from, to) that are loud (within 14 dB of the loud level of `ref` = [refFrom, refTo)). 0 = silence, 1 = speech throughout. */
export function voicedFraction(audio: Float32Array, sampleRate: number, from: number, to: number, refFrom: number, refTo: number): number {
  const ref = envelopeDb(audio, sampleRate, refFrom, refTo);
  if (ref.length === 0) return 0;
  const level = percentile(ref, 0.9) - 14;
  const env = envelopeDb(audio, sampleRate, from, to);
  return env.length ? env.filter((v) => v > level).length / env.length : 0;
}
