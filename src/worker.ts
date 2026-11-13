/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { resolveOptions, type Config, type Dtype, type RuntimeOptions } from "./config";
import { freeGenerateOutputs, gpuStats } from "./gpu-cleanup.ts";
import { SAMPLE_RATE, transcribeSegments } from "./transcribe.ts";

declare const self: DedicatedWorkerGlobalScope;

const MODEL_ID = "yaltaieh/whisper-base-ar-quran-onnx";

// q4w = the q4 encoder + a decoder whose token embedding is int8 (file suffix "_bnb4"), because WASM has no GatherBlockQuantized
const dtypeFor = (d: Dtype) => (d === "q4w" ? { encoder_model: "q4", decoder_model_merged: "bnb4" } : d) as never;

// ---------- logging (with memory where the browser exposes it) ----------
const t0 = performance.now();
function mem() {
  // performance.memory is Chromium-only; Safari/Firefox expose nothing, so there only the timeline is useful.
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return m ? `jsHeap=${(m.usedJSHeapSize / 1048576).toFixed(0)}/${(m.totalJSHeapSize / 1048576).toFixed(0)}MB` : "mem=n/a";
}
function log(stage: string, extra = "") {
  const line = `[worker +${((performance.now() - t0) / 1000).toFixed(1)}s] ${stage} ${extra} ${mem()}`.replace(/\s+/g, " ");
  console.log(line);
  self.postMessage({ status: "log", line });
}

// ---------- config ----------
let options: RuntimeOptions | null = null;
type Loaded = { config: Config; asr: AutomaticSpeechRecognitionPipeline };
let current: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

function init(search: string, vendor = "") {
  if (options) return;
  options = resolveOptions(search, navigator.userAgent, "gpu" in navigator, navigator.hardwareConcurrency, vendor);
  // Threads need SharedArrayBuffer (cross-origin isolation); without it ORT runs single-threaded anyway, and
  // setting numThreads would only print warnings.
  if (self.crossOriginIsolated) env.backends.onnx.wasm!.numThreads = options.threads;
  log(
    "config",
    `attempts=${options.attempts.map((c) => `${c.device}/${c.dtype}`).join(" > ")} requestedThreads=${options.threads} ` +
      `crossOriginIsolated=${self.crossOriginIsolated} sharedArrayBuffer=${typeof SharedArrayBuffer !== "undefined"} ` +
      `hardwareConcurrency=${navigator.hardwareConcurrency} recycle=${options.recycle.mode} vendor="${vendor}"`,
  );
}

async function disposeCurrent() {
  if (!current) return;
  const { config, asr } = current;
  current = null;
  try {
    await asr.dispose();
    log("disposed", `${config.device}/${config.dtype}`);
  } catch (err) {
    console.warn("dispose failed", err);
  }
}

async function load(): Promise<Loaded> {
  try {
    return await loadChain();
  } catch (err) {
    // Safety net: multithreaded WASM needs onnxruntime to spawn its own nested workers, which a browser can refuse
    // (e.g. Safari + COEP). Retry the whole chain once with a single thread, which spawns none.
    const threads = env.backends.onnx.wasm?.numThreads ?? 1;
    if (threads <= 1) throw err;
    log("falling back to single-threaded WASM", `after: ${err}`);
    env.backends.onnx.wasm!.numThreads = 1;
    return await loadChain();
  }
}

async function loadChain(): Promise<Loaded> {
  let lastError: unknown;
  for (const config of options!.attempts) {
    await disposeCurrent(); // never keep two models in memory
    try {
      self.postMessage({ status: "device", ...config });
      log("model load start", `${config.device}/${config.dtype}`);
      const asr = (await pipeline("automatic-speech-recognition", MODEL_ID, {
        device: config.device,
        dtype: dtypeFor(config.dtype),
        progress_callback: (x: unknown) => self.postMessage(x),
      })) as AutomaticSpeechRecognitionPipeline;
      freeGenerateOutputs(asr); // dispose the GPU KV cache that Transformers.js leaves behind after every generate()
      current = { config, asr };
      // ORT lowers env.wasm.numThreads to 1 itself when SharedArrayBuffer / isolation is missing, so this is the real value
      log("model load end", `${config.device}/${config.dtype} wasmThreads=${env.backends.onnx.wasm?.numThreads}`);
      return current;
    } catch (err) {
      // A failed pipeline() call returns nothing to dispose; whatever it partially created is released by the GC / ORT.
      log("model load FAILED", `${config.device}/${config.dtype}: ${err}`);
      lastError = err;
    }
  }
  throw lastError;
}

// ---------- pipeline access for the segment loop ----------
async function getPipeline(failed?: unknown): Promise<AutomaticSpeechRecognitionPipeline | null> {
  if (failed) {
    // Runtime failure (e.g. a WebGPU error): dispose the failed pipeline and move on to the remaining configs.
    log("transcription FAILED", String(failed));
    const f = current?.config;
    await disposeCurrent();
    loading = null;
    const idx = options!.attempts.findIndex((c) => c.device === f?.device && c.dtype === f?.dtype);
    const rest = idx >= 0 ? options!.attempts.slice(idx + 1) : [];
    if (rest.length === 0) return null;
    options = { ...options!, attempts: rest };
  }
  return (await (loading ??= load())).asr;
}

let busy = false;

function logGpuStats(index: number) {
  log("gpu-cleanup", `after segment ${index + 1}: generate calls ${gpuStats.generateCalls}, GPU tensors disposed ${gpuStats.tensorsDisposed} (${gpuStats.mbDisposed.toFixed(0)} MB), failed disposals ${gpuStats.failedDisposals}`);
}

/** Returns true when the whole file is done, false when the audio was handed back to the main thread for a worker restart. */
async function transcribe(audio: Float32Array, startIndex: number): Promise<boolean> {
  if (busy) throw new Error("already transcribing");
  busy = true;
  try {
    const rc = options!.recycle;
    log("transcription start", `audio=${(audio.length / SAMPLE_RATE).toFixed(1)}s from segment ${startIndex + 1} recycle=${rc.mode}/${rc.segments}seg/${rc.seconds}s`);
    for (;;) {
      const run = await transcribeSegments(audio, {
        getPipeline,
        startIndex,
        refineLongWords: options!.refine,
        onLog: log,
        onPlan: ({ total, duration, segments }) => self.postMessage({ status: "plan", total, duration, segments }),
        onPartial: (index, text) => self.postMessage({ status: "partial", index, text }),
        onSegment: (r, progress) => self.postMessage({ status: "segment", ...r, ...progress }),
        onSegmentDone: (index) => options!.debug && (index + 1) % 10 === 0 && logGpuStats(index),
        // Safety net against GPU leaks: only on WebGPU (WASM memory was measured flat)
        shouldRecycle: (since) =>
          rc.mode !== "off" && current?.config.device === "webgpu" && (since.segments >= rc.segments || since.seconds >= rc.seconds),
      });
      if (run.finished) break;

      const tRecycle = performance.now();
      if (rc.mode === "worker") {
        // Terminating the worker destroys its GPUDevice and frees everything. The main thread keeps the results and
        // starts a fresh worker; the audio travels back to it without a copy.
        await disposeCurrent();
        log("handing over for worker restart", `next segment ${run.nextIndex + 1}`);
        self.postMessage({ status: "recycle", nextIndex: run.nextIndex, audio }, [audio.buffer]);
        return false;
      }
      await disposeCurrent();
      loading = null;
      await (loading = load()); // model files come from the browser cache
      log("pipeline recycled", `in ${((performance.now() - tRecycle) / 1000).toFixed(1)}s`);
      startIndex = run.nextIndex;
    }
    if (options!.debug) logGpuStats(-1);
    log("transcription end");
    return true;
  } finally {
    busy = false;
  }
}

// ---------- messages ----------
type Msg = { type: "init"; search: string; vendor?: string } | { type: "transcribe"; audio: Float32Array; startIndex?: number };

self.addEventListener("message", async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") return init(msg.search, msg.vendor);
    if (!options) init("");
    if (await transcribe(msg.audio, msg.startIndex ?? 0)) self.postMessage({ status: "complete" });
  } catch (err) {
    loading = null;
    await disposeCurrent();
    log("error", String(err));
    self.postMessage({ status: "error", message: String(err) });
  }
});
