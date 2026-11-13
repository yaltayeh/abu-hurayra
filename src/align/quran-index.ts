// The Quran as one matching sequence: real words in mushaf order, plus the basmala (4 words) in front of every surah
// except Al-Fatiha (where it is ayah 1) and At-Tawbah (none). Strict and loose normalized forms are interned to ints,
// and trigram indexes (strict and loose) give the anchor candidates.
import type { QuranData } from "../quran-data.ts";
import { normalize, normalizeLoose } from "../normalize.ts";

export type QuranIndex = {
  core: QuranData;
  /** Entries in the matching sequence (77,432 words + 112 basmalas × 4). */
  n: number;
  strict: Int32Array; // interned strict form
  loose: Int32Array;
  strictStr: string[]; // by interned id
  strictId: Map<string, number>;
  looseId: Map<string, number>;
  ayahId: Int32Array; // a basmala block is its own pseudo-ayah (ayah number 0)
  surah: Uint8Array;
  ayah: Uint16Array;
  pos: Uint8Array; // 1-based position in the ayah (basmala: 1-4)
  isLast: Uint8Array; // last word of its (pseudo-)ayah
  isBasmala: Uint8Array;
  skippableBasmala: Uint8Array; // basmala of a surah other than Al-Fatiha: may be absent from a recitation
  textIndex: Int32Array; // index into core.textWords
  coreId: Uint32Array; // word id in quran-core
  ayahFirst: Int32Array;
  ayahLast: Int32Array;
  letters: Uint8Array;
  triStrict: Map<number, number[]>;
  triLoose: Map<number, number[]>;
  /** "surah:ayah:word" label of an entry (basmala: "surah:0:word"). */
  label(j: number): string;
};

export const triKey = (a: number, b: number, c: number) => (a * 16384 + b) * 16384 + c; // ids < 16384

export function buildQuranIndex(core: QuranData): QuranIndex {
  const words = core.textWords;
  const total = words.length;
  // build entry list
  const ent: { text: number; surah: number; ayah: number; pos: number; bas: 0 | 1 | 2 }[] = [];
  let lastSurah = 0;
  for (let t = 0; t < total; t++) {
    const w = core.wordAt(core.textWordIds[t]);
    if (w.surah !== lastSurah) {
      lastSurah = w.surah;
      if (w.surah !== 1 && w.surah !== 9) for (let b = 0; b < 4; b++) ent.push({ text: b, surah: w.surah, ayah: 0, pos: b + 1, bas: 2 });
    }
    ent.push({ text: t, surah: w.surah, ayah: w.ayah, pos: w.word, bas: w.surah === 1 && w.ayah === 1 && w.word <= 4 ? 1 : 0 });
  }
  const n = ent.length;
  const strictStrs: string[] = [];
  const strictId = new Map<string, number>();
  const looseId = new Map<string, number>();
  const intern = (m: Map<string, number>, s: string, arr?: string[]) => {
    let id = m.get(s);
    if (id === undefined) {
      id = m.size;
      m.set(s, id);
      arr?.push(s);
    }
    return id;
  };
  // normalize each distinct Uthmani word once
  const cacheS = new Map<string, string>();
  const strict = new Int32Array(n), loose = new Int32Array(n);
  const ayahId = new Int32Array(n), surah = new Uint8Array(n), ayah = new Uint16Array(n), pos = new Uint8Array(n);
  const isLast = new Uint8Array(n), isBasmala = new Uint8Array(n), skippableBasmala = new Uint8Array(n);
  const textIndex = new Int32Array(n), coreId = new Uint32Array(n), letters = new Uint8Array(n);
  const ayahFirst: number[] = [], ayahLast: number[] = [];
  let curKey = -1, curAyah = -1;
  for (let j = 0; j < n; j++) {
    const e = ent[j];
    const text = words[e.text];
    let s = cacheS.get(text);
    if (s === undefined) cacheS.set(text, (s = normalize(text)));
    strict[j] = intern(strictId, s, strictStrs);
    loose[j] = intern(looseId, normalizeLoose(text));
    const key = e.surah * 1000 + e.ayah;
    if (key !== curKey) {
      curKey = key;
      curAyah = ayahFirst.length;
      ayahFirst.push(j);
      ayahLast.push(j);
    }
    ayahLast[curAyah] = j;
    ayahId[j] = curAyah;
    surah[j] = e.surah;
    ayah[j] = e.ayah;
    pos[j] = e.pos;
    isBasmala[j] = e.bas ? 1 : 0;
    skippableBasmala[j] = e.bas === 2 ? 1 : 0;
    textIndex[j] = e.text;
    coreId[j] = core.textWordIds[e.text];
    letters[j] = Math.min(255, s.length);
  }
  for (let j = 0; j < n; j++) isLast[j] = ayahLast[ayahId[j]] === j ? 1 : 0;
  if (strictId.size >= 16384 || looseId.size >= 16384) throw new Error("vocabulary too large for trigram keys");

  const triStrict = new Map<number, number[]>(), triLoose = new Map<number, number[]>();
  const add = (m: Map<number, number[]>, k: number, p: number) => {
    const a = m.get(k);
    if (a) a.push(p);
    else m.set(k, [p]);
  };
  for (let j = 0; j + 2 < n; j++) {
    add(triStrict, triKey(strict[j], strict[j + 1], strict[j + 2]), j);
    add(triLoose, triKey(loose[j], loose[j + 1], loose[j + 2]), j);
  }
  return {
    core, n, strict, loose, strictStr: strictStrs, strictId, looseId, ayahId, surah, ayah, pos, isLast, isBasmala, skippableBasmala,
    textIndex, coreId, ayahFirst: Int32Array.from(ayahFirst), ayahLast: Int32Array.from(ayahLast), letters, triStrict, triLoose,
    label: (j) => `${surah[j]}:${ayah[j]}:${pos[j]}`,
  };
}
