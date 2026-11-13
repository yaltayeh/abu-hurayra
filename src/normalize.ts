// Arabic normalization for matching ASR output (imla'i-like spelling) against the Quran text (Uthmani rasm).
// Applied to BOTH sides. The pipeline is a list of named steps so the quality script can measure each one
// (scripts/data/norm-eval.mjs). Order matters: the dagger-alef steps must run before marks are stripped.
// Code points are written as hex numbers on purpose: invisible combining marks inside regex literals are unreadable.

export type NormStep = { name: string; apply: (s: string) => string };

const ch = (code: number) => String.fromCharCode(code);
const span = (a: number, b: number) => `${ch(a)}-${ch(b)}`;

const DAGGER = ch(0x670); // superscript (dagger) alef
const TASHKEEL = `[${span(0x64b, 0x65f)}${span(0x6d6, 0x6ed)}]*`; // harakat, shadda, sukun, maddah, small hamza + Quranic signs (U+06E1 sukun, …)
const MARKS = new RegExp(`[${span(0x610, 0x61a)}${span(0x64b, 0x65f)}${DAGGER}${span(0x6d6, 0x6ed)}]`, "g"); // tashkeel, dagger alef, small signs
const NOISE = new RegExp(`[${ch(0x640)}${ch(0x61c)}${ch(0x200c)}${ch(0x200d)}${ch(0x6de)}${ch(0x6e9)}${ch(0x621)} ]`, "g"); // tatweel, bidi/joiners, ۞ ۩, standalone hamza, space
// Hamza written on a tatweel: after a ya it is the hamza-on-ya seat (شَيۡـٔٗا ~ شيئا: ئ); elsewhere (بِـَٔايَٰتِنَا ~ بآياتنا) it is a plain
// hamza that the base step drops, so only the after-ya case becomes a letter.
const KASHIDA_HAMZA = new RegExp(`(?<=${ch(0x64a)}${TASHKEEL})${ch(0x640)}[${ch(0x654)}${ch(0x655)}]`, "g");
// Only a waw/alef-maqsura DIRECTLY followed by the dagger alef is a silent letter that stands for an alef
// (ٱلصَّلَوٰةَ, عَلَىٰ). A waw or ya that carries its own vowel before the dagger (سَمَٰوَٰتِ, يَٰقَوۡمِ) is a real letter.
const WAW_DAGGER = new RegExp(`${ch(0x648)}${DAGGER}`, "g");
const YA_DAGGER_FINAL = new RegExp(`(${ch(0x649)})${DAGGER}${TASHKEEL}$`);
const YA_DAGGER_MEDIAL = new RegExp(`${ch(0x649)}${DAGGER}`, "g");
const DAGGER_ANY = new RegExp(DAGGER, "g");
// Closed list of words whose dagger alef is NOT written as an alef in imla'i spelling (هَٰذَا ~ هذا, ذَٰلِكَ ~ ذلك,
// ٱلرَّحۡمَٰنِ ~ الرحمن, إِلَٰه ~ اله, لَٰكِن ~ لكن, أُوْلَٰٓئِكَ ~ أولئك, هَٰٓؤُلَآءِ ~ هؤلاء). Matched on the letter skeleton,
// with optional prefix letters (أ و ف ب ك ل) and/or ال. Anything else with a dagger gets the alef back.
const ALEFLESS = /^(?:[واوفبكل]{1,2}|ال|[وفبك]ال|لل)?(?:ه(?:ذا|ذه|ذان|ذين)|ذلك(?:م|ما)?|رحمن|اله[اهكمنو]?|لكن[اه]?|اولئك|هؤلاء|هكذا)$/;
const SKELETON_MARKS = new RegExp(`[${span(0x610, 0x61a)}${span(0x64b, 0x65f)}${DAGGER}${span(0x6d6, 0x6ed)}${ch(0x640)}${ch(0x621)}]`, "g");
const skeleton = (s: string) => s.replace(SKELETON_MARKS, "").replace(/[ٱأإآ]/g, "ا");

export const STEPS: Record<string, NormStep> = {
  // --- Uthmani-vs-imla'i rules (run on the vocalised text, before marks are removed) ---
  kashidaHamza: { name: "kashidaHamza", apply: (s) => s.replace(KASHIDA_HAMZA, "ي") }, // شَيۡـٔٗا ~ شيئا
  wawDagger: { name: "wawDagger", apply: (s) => s.replace(WAW_DAGGER, "ا") }, // ٱلصَّلَوٰةَ ~ الصلاة
  yaDaggerFinal: { name: "yaDaggerFinal", apply: (s) => s.replace(YA_DAGGER_FINAL, "$1") }, // مُوسَىٰ ~ موسى
  yaDaggerMedial: { name: "yaDaggerMedial", apply: (s) => s.replace(YA_DAGGER_MEDIAL, "ا") }, // أَدۡرَىٰكَ ~ أدراك
  alefless: { name: "alefless", apply: (s) => (ALEFLESS.test(skeleton(s)) ? s.replace(DAGGER_ANY, "") : s) }, // must run before daggerAlef
  daggerAlef: { name: "daggerAlef", apply: (s) => s.replace(DAGGER_ANY, "ا") }, // ٱلۡكِتَٰبُ ~ الكتاب
  // --- base cleanup ---
  base: {
    name: "base",
    apply: (s) =>
      s
        .normalize("NFC")
        .replace(MARKS, "")
        .replace(NOISE, "")
        .replace(/[ٱأإآ]/g, "ا")
        .replace(/ؤ/g, "و")
        .replace(/[ئىی]/g, "ي")
        .replace(/ة/g, "ه"),
  },
  // --- spelling-variation rules that run after base ---
  dropMedialAlef: { name: "dropMedialAlef", apply: (s) => s.replace(/(?<=.)ا(?=.)/g, "") }, // الرحمٰن ~ الرحمن, هَٰذَا ~ هذا
  dropNonInitialAlef: { name: "dropNonInitialAlef", apply: (s) => s.replace(/(?<=.)ا/g, "") },
};

// Two tiers (evidence: scripts/data/README.md):
//  - normalize():      strict. Undoes Uthmani-only spelling (dagger alef, silent waw/ya) but keeps every real letter.
//                      Use it for word comparison / alignment scoring.
//  - normalizeLoose(): strict + drops alefs inside a word. Higher recall on imla'i-vs-Uthmani, but merges distinct
//                      words (قال/قل, كان/كن). Use it only as a fallback for the trigram anchor lookup, never to decide a word is right.
export const STRICT_STEPS: readonly string[] = ["kashidaHamza", "wawDagger", "yaDaggerFinal", "yaDaggerMedial", "alefless", "daggerAlef", "base"];
export const LOOSE_STEPS: readonly string[] = [...STRICT_STEPS, "dropMedialAlef"];

export function normalize(text: string, steps: readonly string[] = STRICT_STEPS): string {
  let s = text;
  for (const k of steps) s = STEPS[k].apply(s);
  return s;
}

export const normalizeLoose = (text: string): string => normalize(text, LOOSE_STEPS);
