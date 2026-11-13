// Copies what the review page serves from the same origin into public/ (both git-ignored):
//   data/QPC-V2/woff2/p<N>.woff2  ->  public/fonts/v2/p<NNN>.woff2   (zero-padded, 604 files, ~94 MB)
//   scripts/data/out/quran-core.bin -> public/data/quran-core.bin
// Usage: python3 scripts/data/build.py && node scripts/data/copy-assets.mjs [path/to/QPC-V2]
import fs from "node:fs";
import path from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const src = path.resolve(process.argv[2] ?? path.join(root, "data/QPC-V2"));
const fonts = path.join(root, "public/fonts/v2");
fs.mkdirSync(fonts, { recursive: true });
let bytes = 0;
for (let p = 1; p <= 604; p++) {
  const from = path.join(src, "woff2", `p${p}.woff2`);
  if (!fs.existsSync(from)) throw new Error(`missing ${from}`);
  const to = path.join(fonts, `p${String(p).padStart(3, "0")}.woff2`);
  fs.copyFileSync(from, to);
  bytes += fs.statSync(to).size;
}
console.log(`fonts: 604 files, ${(bytes / 1048576).toFixed(1)} MB -> public/fonts/v2/`);
const bin = path.join(root, "scripts/data/out/quran-core.bin");
if (!fs.existsSync(bin)) throw new Error("scripts/data/out/quran-core.bin is missing: run python3 scripts/data/build.py");
fs.mkdirSync(path.join(root, "public/data"), { recursive: true });
fs.copyFileSync(bin, path.join(root, "public/data/quran-core.bin"));
console.log(`data: ${fs.statSync(bin).size} bytes -> public/data/quran-core.bin`);
