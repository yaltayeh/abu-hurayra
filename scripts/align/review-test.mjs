// Drives the review page (?view=review) in headless Chrome with the REAL pipeline (worker → aligner → glyphs):
// uploads an audio file, waits for the transcription, checks the DOM (fonts, glyphs, flags, click-to-seek, highlight while playing)
// and saves screenshots. Needs `pnpm build && pnpm preview`, public/fonts + public/data (scripts/data/copy-assets.mjs) and Chrome.
// With `inject:<groups.json>` instead of an audio file (see make-demo-groups.mjs) the transcript is loaded directly (no audio, no model),
// which shows every flag type; click-to-seek checks are skipped.
// Usage: node --no-warnings scripts/align/review-test.mjs <audio|inject:groups.json> <out-dir> [timeoutSec] [query]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [audio, outDir, timeoutSec = "900", query = ""] = process.argv.slice(2);
const BASE = process.env.BASE ?? "http://localhost:4173/";
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rv-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--headless=new", "--window-size=1500,1000", "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=metal", "--ignore-gpu-blocklist", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map(), logs = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const shot = async (name, clip) => { const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, "base64")); console.log("screenshot", path.join(outDir, name)); };
try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(200); }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    else if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    else if (m.method === "Network.loadingFailed") logs.push(`NETFAIL ${m.params.errorText} ${m.params.blockedReason ?? ""}`); };
  await send("Runtime.enable"); await send("Page.enable"); await send("DOM.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}?view=review&debug=1${query ? "&" + query : ""}` });
  await sleep(2000);
  console.log("data loaded:", await ev(`document.querySelector('.status')?.textContent`));
  const t0 = Date.now();
  const inject = audio.startsWith("inject:");
  if (inject) {
    await ev(`window.__loadGroups(${fs.readFileSync(audio.slice(7), "utf8")}); window.__done = true`);
  } else {
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]" });
    await send("DOM.setFileInputFiles", { nodeId, files: [path.resolve(audio)] });
  }
  let shotMid = false;
  while (Date.now() - t0 < +timeoutSec * 1000) {
    await sleep(1000);
    const st = await ev(`JSON.stringify({done: !!window.__done, groups: window.__review?.groups?.length ?? 0, words: document.querySelectorAll('.review .w').length, status: document.querySelector('.status')?.textContent})`);
    const s = JSON.parse(st);
    if (!shotMid && s.groups >= 3) { shotMid = true; console.log("progressive:", st); await shot("1-progressive.png"); }
    if (s.done) { console.log("done after", ((Date.now() - t0) / 1000).toFixed(0), "s", st); break; }
  }
  for (let i = 0; i < 40 && (await ev(`document.querySelectorAll('.w.loading, .marker.loading').length`)) > 0; i++) await sleep(250); // fonts
  const report = JSON.parse(await ev(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const fam = [...new Set([...document.querySelectorAll('.review .w, .review .marker')].map((e) => e.style.fontFamily.split(',')[0]))];
    const loaded = [...document.fonts].filter((f) => f.family.startsWith('qcf2-p') && f.status === 'loaded').length;
    return JSON.stringify({ words: q('.w'), markers: q('.marker'), partialMarkers: q('.marker.partial'), notes: q('.note'), flagsInPanel: q('.flags li'), substituted: q('.w.substituted'), inferred: q('.w.inferred'), repeat: q('.w.repeat'), basmala: q('.w.basmala'), extrasInDom: q('.extra'), fontFamilies: fam.length, fontsLoaded: loaded, stillLoading: q('.w.loading, .marker.loading'), noFont: q('.w.nofont, .marker.nofont'), firstGlyph: document.querySelector('.w')?.textContent.codePointAt(0).toString(16), stats: document.querySelector('.stats')?.textContent, repeatJumps: (window.__review?.result?.jumps ?? []).filter((j) => j.type === 'repeat').map((j) => j.time.toFixed(1) + ' ' + j.to), longFlags: [...document.querySelectorAll('.flags li')].filter((li) => li.querySelector('.type')?.textContent === 'long words').length });
  })()`));
  console.log("DOM:", JSON.stringify(report, null, 1));
  await shot("2-top.png");
  // click a word: seek + play
  const clickInfo = inject ? null : JSON.parse(await ev(`(async () => {
    const els = [...document.querySelectorAll('.review .w')]; const el = els[Math.floor(els.length * 0.4)];
    const k = +el.dataset.k; const o = window.__review.result.occurrences[k];
    el.scrollIntoView({ block: 'center' }); el.click();
    await new Promise((r) => setTimeout(r, 1500));
    const a = document.querySelector('audio');
    const cur = document.querySelector('.review .cur');
    return JSON.stringify({ k, label: o.surah + ':' + o.ayah + ':' + o.word, start: o.start, currentTime: a.currentTime, paused: a.paused, highlighted: cur?.dataset.k, highlightedLabel: cur ? (() => { const q = window.__review.result.occurrences[+cur.dataset.k]; return q.surah + ':' + q.ayah + ':' + q.word; })() : null });
  })()`));
  console.log("click-to-seek:", clickInfo);
  await sleep(1500);
  await shot("3-playing.png");
  const hover = await ev(`(() => { const el = document.querySelector('.review .w.substituted') ?? document.querySelector('.review .w'); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return document.querySelector('.hover').textContent + ' | title: ' + el.title; })()`);
  console.log("hover:", hover);
  // panel: click the first flag of each type
  const flagClicks = JSON.parse(await ev(`(async () => {
    const out = [];
    for (const li of [...document.querySelectorAll('.flags li')].slice(0, 400)) {
      const type = li.querySelector('.type').textContent; if (out.some((x) => x.type === type)) continue;
      const a = document.querySelector('audio') ?? { pause() {}, currentTime: -1 }; a.pause(); li.querySelector('button').click(); await new Promise((r) => setTimeout(r, 700));
      out.push({ type, text: li.querySelector('.text').textContent.slice(0, 90), t: li.querySelector('.t').textContent, currentTime: +a.currentTime.toFixed(2) });
    }
    return JSON.stringify(out);
  })()`));
  console.log("flag clicks:", JSON.stringify(flagClicks, null, 1));
  await ev(`document.querySelectorAll('.review header input[type=checkbox]')[0].click()`); // show extras
  await sleep(400);
  await shot("4-with-extras.png");
  const fullHeight = await ev(`document.documentElement.scrollHeight`);
  console.log("page height", fullHeight, "console problems:", logs.filter((l) => /EXCEPTION|NETFAIL|Failed|error/i.test(l)).slice(0, 8));
} finally { try { ws?.close(); } catch {} chrome.kill("SIGKILL"); await sleep(300); }
