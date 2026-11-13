// Decoder for quran-core.bin (built by scripts/data/build.py, see scripts/data/README.md).
// Word ids are 0-based indexes over ALL 83,668 words in canonical mushaf order, including the 6,236 ayah-end markers
// (the last "word" of every ayah, rendered with its own glyph). Matching must use `textWordIds` (markers skipped).

const GLYPH_BASE = 0xfc41; // first glyph code on every page
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const SEP = "|";

export type QuranWord = {
  id: number; // 0-based index over all words
  surah: number;
  ayah: number;
  word: number; // 1-based position in the ayah (the marker is the last one)
  page: number; // 1..604
  glyph: string; // QCF v2 glyph string (1-3 code points), render with the font of `page`
  text: string; // Uthmani text; for a marker the ayah number in Arabic-Indic digits
  isMarker: boolean;
};

export type AyahInfo = {
  surah: number;
  ayah: number;
  firstId: number; // first word id of the ayah
  markerId: number; // the ayah-end marker (last id of the ayah)
};

export type QuranData = {
  readonly wordCount: number; // 83,668
  readonly textWordIds: Uint32Array; // word ids of the 77,432 real words, in order (what matching runs over)
  /** Uthmani text of the real words, aligned with `textWordIds` (index = matching index). */
  readonly textWords: readonly string[];
  wordAt(id: number): QuranWord;
  isMarker(id: number): boolean;
  /** Ayah by 1-based surah/ayah. Returns the marker so rendering can draw the ayah number glyph. */
  ayah(surah: number, ayah: number): AyahInfo;
  ayahOfWord(id: number): AyahInfo;
  ayahMarker(surah: number, ayah: number): QuranWord;
  /** All ayah markers of a page, in order. */
  pageMarkers(page: number): QuranWord[];
  pageRange(page: number): { first: number; end: number }; // [first, end) word ids
  surahAyahCount(surah: number): number;
};

function readVarints(u8: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < u8.length; ) {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = u8[i++];
      v |= (b & 127) << shift;
      shift += 7;
    } while (b & 128);
    out.push(v);
  }
  return out;
}

export function parseQuranCore(input: ArrayBuffer | Uint8Array): QuranData {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "QCR1") throw new Error("quran-core: bad magic");
  let o = 4;
  const sec: Uint8Array[] = [];
  for (let i = 0; i < 6; i++) {
    const n = dv.getUint32(o, true);
    o += 4;
    sec.push(u8.subarray(o, o + n));
    o += n;
  }
  const sv = new DataView(sec[0].buffer, sec[0].byteOffset, sec[0].byteLength);
  const surahAyahs = Array.from({ length: 114 }, (_, i) => sv.getUint16(i * 2, true));
  const ayahWords = sec[1];
  const pageDelta = sec[2];
  const multiDelta = readVarints(sec[3]);
  const multi3 = readVarints(sec[4]);
  const words = new TextDecoder().decode(sec[5]).split(SEP);

  const ayahCount = ayahWords.length;
  const ayahStart = new Uint32Array(ayahCount + 1);
  for (let i = 0; i < ayahCount; i++) ayahStart[i + 1] = ayahStart[i] + ayahWords[i];
  const n = ayahStart[ayahCount];

  const surahFirstAyah = new Uint32Array(115); // global ayah index of each surah's first ayah
  for (let s = 0; s < 114; s++) surahFirstAyah[s + 1] = surahFirstAyah[s] + surahAyahs[s];

  const ayahIndexOfWord = new Uint16Array(n); // 6,236 < 65,536
  for (let a = 0; a < ayahCount; a++) ayahIndexOfWord.fill(a, ayahStart[a], ayahStart[a + 1]);

  const pageFirst = new Uint32Array(605);
  for (let p = 0; p < 604; p++) pageFirst[p + 1] = pageFirst[p] + pageDelta[p];
  const page = new Uint16Array(n);
  for (let p = 0; p < 604; p++) page.fill(p + 1, pageFirst[p], pageFirst[p + 1]);

  const glyphLen = new Uint8Array(n).fill(1);
  let idx = 0;
  for (const d of multiDelta) {
    idx += d;
    glyphLen[idx] = 2;
  }
  for (const i of multi3) glyphLen[i] = 3;
  const glyphStart = new Uint16Array(n);
  for (let p = 0; p < 604; p++) {
    let code = GLYPH_BASE;
    for (let w = pageFirst[p]; w < pageFirst[p + 1]; w++) {
      glyphStart[w] = code;
      code += glyphLen[w];
    }
  }

  // index into `words` for real words; -1 for markers
  const textIndex = new Int32Array(n).fill(-1);
  const textWordIds = new Uint32Array(words.length);
  let t = 0;
  for (let a = 0; a < ayahCount; a++) {
    for (let w = ayahStart[a]; w < ayahStart[a + 1] - 1; w++) {
      textIndex[w] = t;
      textWordIds[t++] = w;
    }
  }
  if (t !== words.length) throw new Error(`quran-core: ${t} real words but ${words.length} texts`);

  const surahOf = (a: number) => {
    let lo = 0;
    let hi = 113;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (surahFirstAyah[m] <= a) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  const ayahInfo = (a: number): AyahInfo => {
    const s = surahOf(a);
    return { surah: s + 1, ayah: a - surahFirstAyah[s] + 1, firstId: ayahStart[a], markerId: ayahStart[a + 1] - 1 };
  };
  const ayahIndex = (surah: number, ayah: number) => {
    if (surah < 1 || surah > 114 || ayah < 1 || ayah > surahAyahs[surah - 1]) throw new RangeError(`no ayah ${surah}:${ayah}`);
    return surahFirstAyah[surah - 1] + ayah - 1;
  };
  const toDigits = (x: number) => String(x).replace(/\d/g, (d) => ARABIC_DIGITS[+d]);

  const wordAt = (id: number): QuranWord => {
    if (id < 0 || id >= n) throw new RangeError(`no word ${id}`);
    const a = ayahIndexOfWord[id];
    const info = ayahInfo(a);
    const marker = textIndex[id] < 0;
    let glyph = "";
    for (let k = 0; k < glyphLen[id]; k++) glyph += String.fromCharCode(glyphStart[id] + k);
    return {
      id,
      surah: info.surah,
      ayah: info.ayah,
      word: id - info.firstId + 1,
      page: page[id],
      glyph,
      text: marker ? toDigits(info.ayah) : words[textIndex[id]],
      isMarker: marker,
    };
  };

  return {
    wordCount: n,
    textWordIds,
    textWords: words,
    wordAt,
    isMarker: (id) => textIndex[id] < 0,
    ayah: (s, a) => ayahInfo(ayahIndex(s, a)),
    ayahOfWord: (id) => ayahInfo(ayahIndexOfWord[id]),
    ayahMarker: (s, a) => wordAt(ayahStart[ayahIndex(s, a) + 1] - 1),
    pageMarkers: (p) => {
      const out: QuranWord[] = [];
      for (let w = pageFirst[p - 1]; w < pageFirst[p]; w++) if (textIndex[w] < 0) out.push(wordAt(w));
      return out;
    },
    pageRange: (p) => ({ first: pageFirst[p - 1], end: pageFirst[p] }),
    surahAyahCount: (s) => surahAyahs[s - 1],
  };
}
