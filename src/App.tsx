import { useEffect, useState, type ChangeEvent } from "react";
import { decode } from "./audio.ts";
import { subscribe, transcribe } from "./worker-client.ts";

function mem() {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? `jsHeap=${(m.usedJSHeapSize / 1048576).toFixed(0)}MB` : "mem=n/a";
}
const log = (s: string) => console.log(`[main ${(performance.now() / 1000).toFixed(1)}s] ${s} ${mem()}`);

type Word = { text: string; timestamp: [number, number | null] };
type Seg = { index: number; start: number; end: number; words: Word[] };
type Progress = { done: number; total: number; processedSec: number; duration: number };

const fmt = (t: number | null) => (t == null ? "?" : t.toFixed(2));

export default function App() {
  const [status, setStatus] = useState("");
  const [segments, setSegments] = useState<Seg[]>([]);
  const [partial, setPartial] = useState<{ index: number; text: string } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // test hook: with ?debug=1 every segment/complete message is also collected on window.__events (used by AILab/browser_test.mjs)
    const collect = new URLSearchParams(window.location.search).get("debug") === "1";
    const events: unknown[] = [];
    if (collect) (window as unknown as { __events: unknown[] }).__events = events;
    return subscribe((d) => {
      if (collect && (d.status === "segment" || d.status === "complete" || d.status === "error")) events.push({ t: performance.now(), ...d });
      switch (d.status) {
        case "log": console.log(d.line); return; // surface the worker log in the page console
        case "device": console.log("device:", d.device, d.dtype); return;
        case "progress": setStatus(`تحميل ${d.file}: ${d.progress?.toFixed(0)}%`); return;
        case "ready": setStatus("النموذج جاهز، جارِ التفريغ..."); return;
        case "plan": setProgress({ done: 0, total: d.total, processedSec: 0, duration: d.duration }); setStatus("جارِ التفريغ..."); return;
        case "partial": setPartial({ index: d.index, text: d.text }); return;
        case "segment":
          setSegments((prev) => (d.words.length ? [...prev, { index: d.index, start: d.start, end: d.end, words: d.words }] : prev));
          setPartial(null);
          setProgress((p) => (p ? { ...p, done: d.done, processedSec: d.processedSec } : p));
          return;
        case "complete": setStatus("تم"); setPartial(null); setBusy(false); log("all segments received"); return;
        case "error": setStatus("خطأ: " + d.message); setBusy(false); return;
      }
    });
  }, []);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // don't keep the File selected
    if (!file) return;
    setBusy(true);
    setStatus("جارِ قراءة الملف...");
    setSegments([]);
    setPartial(null);
    setProgress(null);
    log(`audio decode start (${(file.size / 1048576).toFixed(1)}MB)`);
    const audio = await decode(file);
    log(`audio decode end (${(audio.length / 16000).toFixed(1)}s)`);
    transcribe(audio);
  };

  return (
    <div dir="rtl" style={{ padding: 20 }}>
      <input type="file" accept="audio/*,video/*" onChange={onFile} disabled={busy} />
      <p>{status}</p>
      {progress && (
        <div style={{ margin: "8px 0" }}>
          <progress value={progress.processedSec} max={progress.duration} style={{ width: "100%" }} />
          <small>
            المقاطع: {progress.done} / {progress.total} — الصوت المعالج: {progress.processedSec.toFixed(0)} / {progress.duration.toFixed(0)} ثانية
          </small>
        </div>
      )}
      {segments.map((s) => (
        <section key={s.index} style={{ margin: "12px 0", textAlign: "right" }}>
          <small style={{ color: "#888" }} dir="ltr">
            #{s.index + 1} [{fmt(s.start)} – {fmt(s.end)}]
          </small>
          <div style={{ fontSize: "1.3em", lineHeight: 2 }}>
            {s.words.map((w, i) => (
              <span key={i} style={{ display: "inline-block", margin: "0 4px", textAlign: "center" }}>
                {w.text.trim()}
                <small dir="ltr" style={{ display: "block", fontSize: "0.5em", color: "#888" }}>
                  {fmt(w.timestamp[0])}–{fmt(w.timestamp[1])}
                </small>
              </span>
            ))}
          </div>
        </section>
      ))}
      {partial && (
        <section style={{ margin: "12px 0", textAlign: "right", color: "#aaa" }}>
          <small dir="ltr">#{partial.index + 1} …</small>
          <div style={{ fontSize: "1.3em", lineHeight: 2 }}>{partial.text}</div>
        </section>
      )}
    </div>
  );
}
