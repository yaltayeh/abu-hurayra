// One QCF v2 font per mushaf page, served from public/fonts/v2/pNNN.woff2 and loaded with FontFace only when a word
// of that page is about to be shown.
type State = "loading" | "ready" | "failed";
// `states` is replaced (never mutated) on every change, so components can read it as an immutable snapshot (useSyncExternalStore).
let states: ReadonlyMap<number, State> = new Map();
const listeners = new Set<() => void>();

export const fontFamily = (page: number) => `qcf2-p${page}`;

function set(page: number, s: State) {
  states = new Map(states).set(page, s);
  listeners.forEach((l) => l());
}

export function ensureFont(page: number) {
  if (states.has(page)) return;
  set(page, "loading");
  const url = `${import.meta.env.BASE_URL}fonts/v2/p${String(page).padStart(3, "0")}.woff2`;
  const face = new FontFace(fontFamily(page), `url(${url})`);
  face
    .load()
    .then((f) => {
      document.fonts.add(f);
      set(page, "ready");
    })
    .catch(() => set(page, "failed"));
}

export type FontStates = ReadonlyMap<number, State>;
export const getFontStates = (): FontStates => states;
export const subscribeFonts = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
