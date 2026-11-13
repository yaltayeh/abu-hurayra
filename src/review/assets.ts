// Quran data served from the same origin (see scripts/data/copy-assets.mjs): public/data/quran-core.bin.
import { parseQuranCore } from "../quran-data.ts";
import { buildQuranIndex, type QuranIndex } from "../align/quran-index.ts";

let loading: Promise<QuranIndex> | null = null;

export function loadQuran(): Promise<QuranIndex> {
  return (loading ??= fetch(`${import.meta.env.BASE_URL}data/quran-core.bin`)
    .then((r) => {
      if (!r.ok) throw new Error(`data/quran-core.bin: HTTP ${r.status}. Run: node scripts/data/copy-assets.mjs (see scripts/data/README.md)`);
      return r.arrayBuffer();
    })
    .then((buf) => buildQuranIndex(parseQuranCore(buf)))
    .catch((e) => {
      loading = null;
      throw e;
    }));
}
