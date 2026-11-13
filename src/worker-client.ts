// Owns the (replaceable) transcription worker. The results/progress live in React state on the main thread, so a
// worker can be terminated and recreated at any time (?recycle=worker) without losing anything.
type Handler = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const handlers = new Set<Handler>();
let worker: Worker | null = null;

const stamp = () => `[main ${(performance.now() / 1000).toFixed(1)}s]`;

function spawn(): Worker {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  // navigator.vendor does not exist inside workers, so browser detection data is passed from the main thread
  w.postMessage({ type: "init", search: window.location.search, vendor: navigator.vendor });
  w.addEventListener("error", (e) => console.error(`${stamp()} worker failed to load: ${e.message || "(blocked or script error)"}`));
  w.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (d.status === "recycle") {
      // The worker asks to be replaced (its audio comes back to us, transferred without a copy).
      console.log(`${stamp()} worker restart, resuming at segment ${d.nextIndex + 1}`);
      w.terminate();
      worker = spawn();
      worker.postMessage({ type: "transcribe", audio: d.audio, startIndex: d.nextIndex }, [d.audio.buffer]);
      return;
    }
    handlers.forEach((h) => h(d));
  });
  return w;
}

export function getWorker(): Worker {
  return (worker ??= spawn());
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  getWorker();
  return () => void handlers.delete(handler);
}

/** Transfers the audio to the worker (no copy); the caller must not use it afterwards. */
export function transcribe(audio: Float32Array) {
  getWorker().postMessage({ type: "transcribe", audio }, [audio.buffer]);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    worker?.terminate();
    worker = null;
    handlers.clear();
  });
}
