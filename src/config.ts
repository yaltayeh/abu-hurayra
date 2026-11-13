export type Device = "webgpu" | "wasm";
/**
 * q4  : 4-bit weights incl. a 4-bit token embedding (GatherBlockQuantized)  -> WebGPU only
 * q4w : 4-bit weights + int8 token embedding, standard ops only             -> runs on WASM (and WebGPU)
 * q8  : int8 dynamic quantization                                           -> WASM / WebGPU
 */
export type Dtype = "q4" | "q4w" | "q8";
export type Config = { device: Device; dtype: Dtype };

export type RuntimeOptions = {
  /** Configs to try in order. A single entry means "no fallback" (used when device/dtype are set in the URL). */
  attempts: Config[];
  /** WASM threads (ignored unless the page is cross-origin isolated). */
  threads: number;
  /** Periodic recycling of the pipeline (or the whole worker) as a safety net against leaks; only applied on WebGPU. */
  recycle: { mode: "off" | "pipeline" | "worker"; segments: number; seconds: number };
  /** Log GPU-cleanup statistics every 10 segments. */
  debug: boolean;
};

/**
 * dtype used on WASM unless overridden. Measured in Chrome (82.mp3, 4 threads): q8 RTF 0.14 vs q4w 0.23, q8 is 3 MB
 * smaller and matched fp32 on 100% of words on a 9 min file (q4w: 99.4%). q4w stays available as ?dtype=q4w and as fallback.
 */
export const WASM_DEFAULT: Dtype = "q8";

export const isFirefox = (ua: string) => /firefox|fxios/i.test(ua);

/**
 * Safari and every other WebKit browser (all browsers on iOS/iPadOS use WebKit). `navigator.vendor` is
 * "Apple Computer, Inc." for WebKit; the UA check is the fallback (Safari has "Safari" but not Chrome/Chromium/Edge/…).
 */
export function isSafari(ua: string, vendor = ""): boolean {
  if (/apple/i.test(vendor)) return true;
  return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|opr|android|firefox/i.test(ua);
}

/**
 * URL params (for testing each config separately):
 *   ?device=wasm|webgpu   ?dtype=q4|q4w|q8   ?threads=1..8   ?fallback=1 (keep the default fallback chain after the chosen config)
 *   ?recycle=off|pipeline|worker (default off)  ?recycleSegments=20  ?recycleSeconds=300   ?debug=1
 *
 * Defaults:
 *   Chrome / Edge (WebGPU available): WebGPU q4, then WASM.
 *   Safari (WebKit leaks GPU memory with WebGPU) and Firefox (WebGPU hangs / slow): WASM only.
 */
export function resolveOptions(search: string, ua: string, hasWebGPU: boolean, hardwareConcurrency: number, vendor = ""): RuntimeOptions {
  const p = new URLSearchParams(search);
  const safari = isSafari(ua, vendor);
  const defaultWebGPU = hasWebGPU && !safari && !isFirefox(ua);
  const device = p.get("device") as Device | null;
  const dtype = p.get("dtype") as Dtype | null;

  const wasmChain: Config[] = [WASM_DEFAULT, WASM_DEFAULT === "q8" ? "q4w" : "q8"].map((d) => ({ device: "wasm", dtype: d as Dtype }));
  const defaultChain: Config[] = [...(defaultWebGPU ? [{ device: "webgpu", dtype: "q4" } as Config] : []), ...wasmChain];

  let attempts = defaultChain;
  if (device === "wasm" || device === "webgpu" || dtype === "q4" || dtype === "q4w" || dtype === "q8") {
    const chosenDevice: Device = device ?? (defaultWebGPU ? "webgpu" : "wasm");
    const chosen: Config = { device: chosenDevice, dtype: dtype ?? (chosenDevice === "wasm" ? WASM_DEFAULT : "q4") };
    attempts = p.get("fallback") === "1" ? [chosen, ...defaultChain.filter((c) => c.device !== chosen.device || c.dtype !== chosen.dtype)] : [chosen];
  }

  const requested = Number(p.get("threads"));
  const cores = hardwareConcurrency || 1;
  const threads = Math.max(1, Math.min(requested >= 1 ? requested : Math.min(cores, 4), 8, cores));
  const mode = p.get("recycle");
  const num = (k: string, d: number) => (Number(p.get(k)) > 0 ? Number(p.get(k)) : d);
  const recycle = {
    mode: (mode === "pipeline" || mode === "worker" ? mode : "off") as "off" | "pipeline" | "worker",
    segments: num("recycleSegments", 20),
    seconds: num("recycleSeconds", 300),
  };
  return { attempts, threads, recycle, debug: p.get("debug") === "1" };
}
