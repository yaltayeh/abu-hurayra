// QA page for the whole chain: audio → worker (Whisper) → aligner → Quran glyphs. Open with ?view=review.
// Results update after every group: the aligner (≈90 ms for 28 min of audio) re-runs on all groups received so far.
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { decode } from "../audio.ts";
import { subscribe, transcribe } from "../worker-client.ts";
import { alignTranscript } from "../align/align.ts";
import { fromSegmentResult } from "../align/index.ts";
import type { AsrGroup } from "../align/types.ts";
import type { QuranIndex } from "../align/quran-index.ts";
import { loadQuran } from "./assets.ts";
import { buildModel, fmtTime, type Flag } from "./model.ts";
import { RecitationView } from "./RecitationView.tsx";
import { FlagPanel } from "./FlagPanel.tsx";
import "./review.css";

type Progress = { done: number; total: number; processedSec: number; duration: number };

export default function ReviewPage() {
  const [idx, setIdx] = useState<QuranIndex | null>(null);
  const [loadError, setLoadError] = useState("");
  const [groups, setGroups] = useState<AsrGroup[]>([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadQuran().then(setIdx, (e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    const debug = new URLSearchParams(window.location.search).get("debug") === "1";
    return subscribe((d) => {
      switch (d.status) {
        case "log": console.log(d.line); return;
        case "progress": setStatus(`loading ${d.file}: ${d.progress?.toFixed(0)}%`); return;
        case "ready": setStatus("model ready, transcribing…"); return;
        case "plan": setProgress({ done: 0, total: d.total, processedSec: 0, duration: d.duration }); setStatus("transcribing…"); return;
        case "segment":
          setGroups((prev) => [...prev, fromSegmentResult({ index: d.index, start: d.start, end: d.end, words: d.words, breaks: d.breaks, unrecognized: d.unrecognized })]);
          setProgress((p) => (p ? { ...p, done: d.done, processedSec: d.processedSec } : p));
          return;
        case "complete": setStatus("done"); setBusy(false); if (debug) (window as unknown as { __done: boolean }).__done = true; return;
        case "error": setStatus("error: " + d.message); setBusy(false); return;
      }
    });
  }, []);

  const result = useMemo(() => {
    if (!idx || groups.length === 0) return null;
    return alignTranscript(idx, groups);
  }, [idx, groups]);

  const asrWords = useMemo(() => groups.flatMap((g) => g.words.map((w) => w.text)), [groups]);
  const model = useMemo(() => (result && idx ? buildModel(result, idx, (i) => asrWords[i] ?? "?") : null), [result, idx, asrWords]);

  useEffect(() => {
    // test hooks (?debug=1): inspect the state, or load a transcript without audio (scripts/align/review-test.mjs)
    if (new URLSearchParams(window.location.search).get("debug") !== "1") return;
    const w = window as unknown as { __review: unknown; __loadGroups: (g: AsrGroup[]) => void };
    w.__review = { groups, result };
    w.__loadGroups = setGroups;
  }, [groups, result]);

  // ---- audio sync: highlight the word being played, click to seek ----
  useEffect(() => {
    const audio = audioRef.current;
    const root = rootRef.current;
    if (!audio || !root || !result) return;
    const timed = result.occurrences.map((o, k) => ({ k, s: o.start, e: o.end })).filter((x, i) => result.occurrences[i].kind !== "extra" && Number.isFinite(x.s));
    let cur = -1;
    let raf = 0;
    const el = (k: number) => root.querySelector<HTMLElement>(`[data-k="${k}"]`);
    const update = () => {
      const t = audio.currentTime;
      let lo = 0, hi = timed.length - 1, found = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (timed[m].s <= t) { found = m; lo = m + 1; } else hi = m - 1;
      }
      const k = found >= 0 && t <= timed[found].e + 1.5 ? timed[found].k : -1;
      if (k === cur) return;
      el(cur)?.classList.remove("cur");
      cur = k;
      const e = k >= 0 ? el(k) : null;
      if (e) {
        e.classList.add("cur");
        if (autoScroll) {
          const r = e.getBoundingClientRect();
          if (r.top < 180 || r.bottom > window.innerHeight - 60) e.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    };
    const loop = () => { update(); raf = requestAnimationFrame(loop); };
    const onPlay = () => { cancelAnimationFrame(raf); loop(); };
    const onPause = () => { cancelAnimationFrame(raf); update(); };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("seeked", update);
    audio.addEventListener("timeupdate", update);
    if (!audio.paused) onPlay();
    return () => {
      cancelAnimationFrame(raf);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", update);
      audio.removeEventListener("timeupdate", update);
      el(cur)?.classList.remove("cur");
    };
  }, [result, autoScroll]);

  const seek = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, t);
    void a.play().catch(() => {});
  }, []);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const k = target.closest<HTMLElement>("[data-k]")?.dataset.k;
    if (k !== undefined && result) return seek(result.occurrences[+k].start - 0.05);
    const t = target.closest<HTMLElement>("[data-t]")?.dataset.t;
    if (t !== undefined) seek(+t - 0.3);
  };
  const onOver = (e: MouseEvent) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-k]")?.dataset.k;
    const o = k !== undefined && result ? result.occurrences[+k] : null;
    if (hoverRef.current) hoverRef.current.textContent = o ? `${o.surah === null ? "extra ASR word" : `${o.surah}:${o.ayah}:${o.word}`} · ${o.kind}${o.repeat ? " · repeated" : ""} · conf ${o.confidence.toFixed(2)} · ${fmtTime(o.start)}–${fmtTime(o.end)}${o.text ? ` · "${o.text}"` : ""}` : "";
  };

  const onFlag = (f: Flag) => {
    seek(f.time - 0.3);
    if (f.k === null) return;
    const wasExtra = result?.occurrences[f.k]?.kind === "extra";
    if (wasExtra && !showExtras) setShowExtras(true);
    setTimeout(() => {
      const e = rootRef.current?.querySelector<HTMLElement>(`[data-k="${f.k}"]`);
      e?.scrollIntoView({ block: "center", behavior: "smooth" });
      e?.classList.add("flash");
      setTimeout(() => e?.classList.remove("flash"), 1500);
    }, 60);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setGroups([]);
    setProgress(null);
    setStatus("reading the file…");
    setAudioUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    transcribe(await decode(file));
  };

  const stats = result?.stats;
  return (
    <div className="review">
      <header>
        <div className="bar">
          <input type="file" accept="audio/*,video/*" onChange={onFile} disabled={busy || !idx} />
          <span className="status">{loadError ? <b className="err">{loadError}</b> : !idx ? "loading the Quran data…" : status}</span>
          <label><input type="checkbox" checked={showExtras} onChange={(e) => setShowExtras(e.target.checked)} /> show extra ASR words</label>
          <label><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> follow playback</label>
        </div>
        {audioUrl && <audio ref={audioRef} src={audioUrl} controls />}
        {progress && <progress value={progress.processedSec} max={progress.duration} />}
        <div className="legend" dir="ltr">
          <span className="sw matched">matched</span><span className="sw substituted">substituted</span><span className="sw inferred">inferred (missing)</span>
          <span className="sw repeat">repeated</span><span className="sw extra">extra ASR word</span><span className="sw rejected">rejected span</span>
          <span className="sw basmala">basmala</span><span className="sw marker">ayah end</span>
        </div>
        <div className="hover" dir="ltr" ref={hoverRef} />
        {stats && result && (
          <div className="stats" dir="ltr">
            groups {groups.length}{progress ? `/${progress.total}` : ""} · {stats.quranWordsMatched} matched · {stats.substituted} substituted · {stats.inferred} inferred · {stats.extra} extra ·{" "}
            {stats.ayahsCompleted} ayahs completed · {result.rejections.length} rejected spans · {result.jumps.filter((j) => j.type !== "start" && j.type !== "repeat").length} jumps ·{" "}
            {result.jumps.filter((j) => j.type === "repeat").length} repeats · aligner {stats.ms.toFixed(0)} ms{result.accepted ? "" : " · NOT ACCEPTED"}
          </div>
        )}
      </header>
      <main>
        <div ref={rootRef} onClick={onClick} onMouseOver={onOver}>
          {model ? <RecitationView blocks={model.blocks} showExtras={showExtras} /> : <p className="empty">Choose an audio file. The words appear here group by group.</p>}
        </div>
        <FlagPanel flags={model?.flags ?? []} onSeek={onFlag} />
      </main>
    </div>
  );
}
