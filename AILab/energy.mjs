import { execFileSync } from "node:child_process";
const raw = execFileSync("ffmpeg", ["-v","error","-i",process.argv[2],"-ac","1","-ar","16000","-f","f32le","-"], { maxBuffer: 1<<30 });
const a = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength));
const fr=320, n=Math.floor(a.length/fr), rms=new Float32Array(n);
for(let f=0;f<n;f++){let s=0;for(let i=f*fr;i<f*fr+fr;i++)s+=a[i]*a[i];rms[f]=Math.sqrt(s/fr)}
const sorted=Float32Array.from(rms).sort(); const p95=sorted[Math.floor(n*.95)];
console.log("p95",p95.toFixed(4),"p50",sorted[n>>1].toFixed(4),"p10",sorted[Math.floor(n*.1)].toFixed(4),"p1",sorted[Math.floor(n*.01)].toFixed(5));
for (const rel of [0.02,0.06,0.1,0.15,0.2]) {
  const th=p95*rel, runs=[]; for(let f=0;f<n;){ if(rms[f]>=th){f++;continue} let g=f; while(g<n&&rms[g]<th)g++; if(g-f>=15) runs.push(`${(f*.02).toFixed(1)}-${(g*.02).toFixed(1)}`); f=g }
  console.log("rel",rel,"silences>=300ms:",runs.join(" "));
}
// coarse profile: dB relative to p95 per 0.5 s (min over the 25 frames)
let line=""; for(let t=0;t<n;t+=25){let m=1e9;for(let f=t;f<Math.min(n,t+25);f++)m=Math.min(m,rms[f]); line+=(20*Math.log10(m/p95+1e-9)).toFixed(0)+" "}
console.log("min dB per 0.5s:",line);
