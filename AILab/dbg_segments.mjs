import { pipeline, env } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { transcribeSegments } from "../src/transcribe.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = here; env.allowRemoteModels = false;
const raw = execFileSync("ffmpeg", ["-v","error","-i",path.resolve(process.argv[2]),"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
const asr = await pipeline("automatic-speech-recognition","whisper-quran-onnx",{dtype:process.argv[3]||"q4"});
await transcribeSegments(audio,{ getPipeline: async()=>asr,
  onSegment:(r)=>{ const w=r.words; const bad=w.filter(x=>!(x.timestamp[1]>x.timestamp[0])).length;
    console.log(`#${r.index} ${r.start.toFixed(1)}-${r.end.toFixed(1)} (${(r.end-r.start).toFixed(1)}s) words=${w.length} badEnds=${bad} :`, w.slice(0,12).map(x=>x.text.trim()).join(" ")); } });
