import { resolveOptions } from "../src/config.ts";
const UA = {
  "Chrome mac": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Google Inc."],
  "Edge": ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Google Inc."],
  "Safari mac": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", "Apple Computer, Inc."],
  "Safari iPad (desktop UA)": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Apple Computer, Inc."],
  "Chrome on iOS (WebKit)": ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", "Apple Computer, Inc."],
  "Firefox mac": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0", ""],
  "Safari, vendor missing": ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", ""],
};
for (const [name, [ua, vendor]] of Object.entries(UA)) {
  const o = resolveOptions("", ua, true, 8, vendor);
  console.log(name.padEnd(26), o.attempts.map(c => `${c.device}/${c.dtype}`).join(" > ").padEnd(34), `threads=${o.threads} recycle=${o.recycle.mode}`);
}
console.log("override ?device=webgpu on Safari ->", resolveOptions("device=webgpu", UA["Safari mac"][0], true, 8, "Apple Computer, Inc.").attempts.map(c => `${c.device}/${c.dtype}`).join(" > "));
console.log("override ?device=wasm&dtype=q4w&threads=2 ->", JSON.stringify(resolveOptions("device=wasm&dtype=q4w&threads=2", UA["Chrome mac"][0], true, 8, "Google Inc.")));
