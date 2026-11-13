/** Decode a file to 16 kHz mono. Owns its own Float32Array so it can be transferred to the worker without copies. */
export async function decode(file: File): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    // The file's ArrayBuffer only lives inside this call: decodeAudioData consumes it and nothing else keeps a reference.
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    return decoded.getChannelData(0).slice(); // copy out, so the AudioBuffer (all channels) can be freed
  } finally {
    await ctx.close();
  }
}
