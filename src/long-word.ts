/** A word lasting at least this many seconds is suspicious: Whisper sometimes drops a repeated phrase or a stretch of speech
 *  and the word before it is stretched over the lost audio (18.mp3: `لَدُنْكَ` 9.1 s, `كَنْزٌ` 6.3 s). Real elongations (madd)
 *  and the pause after an ayah also produce long words. Used by `refineLongWords` (transcribe.ts) and flagged in the review page. */
export const LONG_WORD_SEC = 4;
