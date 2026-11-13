// Drives Chrome (headless) through the DevTools protocol: opens the built app (vite preview), uploads an audio file through
// the page's <input type=file>, collects console output + window.__events, samples process memory.
// Usage: node --no-warnings browser_test.mjs "<query string>" <audio file> [timeoutSec] [--headed]
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [query = "", audio, timeoutSec = "600"] = process.argv.slice(2);
const BASE = process.env.BASE ?? "http://localhost:4173/";
const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(path.join(tmpdir(), "cdp-"));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chromeBin, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  ...(process.argv.includes("--headed") ? [] : ["--headless=new"]), "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=metal", "--ignore-gpu-blocklist", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rssMB = () => { try { return Math.round(execSync(`ps -axo rss,command | grep -- "${profile}" | grep -v grep | awk '{s+=$1} END {print s}'`).toString().trim() / 1024); } catch { return 0; } };

let ws, id = 0; const pending = new Map(); const logs = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some(t => t.type === "page")) break; } catch {} await sleep(200); }
  ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === "Runtime.consoleAPICalled") { const text = m.params.args.map(a => a.value ?? a.description ?? "").join(" "); logs.push({ t: Date.now(), text }); if (process.env.VERBOSE) console.log("  >", text.slice(0, 200)); }
    else if (m.method === "Runtime.exceptionThrown") logs.push({ t: Date.now(), text: "EXCEPTION " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text) });
    else if (m.method === "Network.loadingFailed") logs.push({ t: Date.now(), text: `NETFAIL ${m.params.errorText} ${m.params.blockedReason ?? ""} ${m.params.requestId}` });
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("DOM.enable"); await send("Network.enable");
  const url = BASE + (query ? "?" + query : "");
  await send("Page.navigate", { url });
  await sleep(1500);
  const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const env = await ev(`JSON.stringify({crossOriginIsolated, sab: typeof SharedArrayBuffer, webgpu: 'gpu' in navigator, cores: navigator.hardwareConcurrency, vendor: navigator.vendor, ua: navigator.userAgent})`);
  console.log("page env:", env);
  const { root } = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" });
  const t0 = Date.now(); const mem = [{ t: 0, mb: rssMB() }];
  await send("DOM.setFileInputFiles", { nodeId, files: [path.resolve(audio)] });
  let events = []; const deadline = t0 + +timeoutSec * 1000; let lastMem = 0;
  while (Date.now() < deadline) {
    await sleep(500);
    if (Date.now() - lastMem > 10000) { lastMem = Date.now(); mem.push({ t: Math.round((Date.now() - t0) / 1000), mb: rssMB(), segs: (await ev(`window.__events?.filter(e=>e.status==='segment').length ?? -1`)) }); }
    events = JSON.parse((await ev(`JSON.stringify((window.__events ?? []).map(e => ({status: e.status, t: e.t, index: e.index, start: e.start, end: e.end, done: e.done, total: e.total, message: e.message, words: e.words})))`)) ?? "[]");
    if (events.some(e => e.status === "complete" || e.status === "error")) break;
  }
  mem.push({ t: Math.round((Date.now() - t0) / 1000), mb: rssMB(), segs: events.filter(e => e.status === "segment").length });
  const segs = events.filter(e => e.status === "segment");
  const fin = events.find(e => e.status === "complete" || e.status === "error");
  const L = (re) => logs.filter(l => re.test(l.text)).map(l => l.text);
  const pageT0 = await ev(`performance.now()`);
  const first = segs[0], last = events.at(-1);
  const out = {
    query, audio: path.basename(audio), finished: fin?.status ?? "TIMEOUT", error: fin?.message,
    groups: segs.length, firstResultSec: first ? +((Date.now() - t0 - (pageT0 - first.t)) / 1000).toFixed(1) : null,
    totalSec: fin ? +((Date.now() - t0 - (pageT0 - last.t)) / 1000).toFixed(1) : null,
    config: L(/\] config /)[0], loaded: L(/model load end/), failed: L(/FAILED|NETFAIL|EXCEPTION/).slice(0, 5), summary: L(/\] total:/)[0], segmentation: L(/segmentation:/)[0],
    memoryMB: mem,
  };
  console.log(JSON.stringify(out, null, 1));
  if (process.env.SAVE) writeFileSync(process.env.SAVE, JSON.stringify({ events, logs: logs.map(l => l.text) }));
} finally { try { ws?.close(); } catch {} proc.kill("SIGKILL"); await sleep(300); try { execSync(`pkill -f -- "${profile}"`); } catch {} }
