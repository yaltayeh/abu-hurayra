import { useState } from "react";
import { FLAG_COLORS, fmtTime, type Flag, type FlagType } from "./model.ts";

const ORDER: FlagType[] = ["rejected", "jump", "repeat", "substituted", "inferred", "extra", "incomplete", "basmala", "ambiguous"];
const NAMES: Record<FlagType, string> = {
  rejected: "rejected", jump: "jumps", repeat: "repeats", substituted: "substituted", inferred: "inferred (missing)", extra: "extra ASR words",
  incomplete: "incomplete ayah", basmala: "basmala", ambiguous: "ambiguous",
};

export function FlagPanel({ flags, onSeek }: { flags: Flag[]; onSeek: (f: Flag) => void }) {
  const [off, setOff] = useState<Set<FlagType>>(new Set());
  const counts = new Map<FlagType, number>();
  for (const f of flags) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  const shown = flags.filter((f) => !off.has(f.type));
  return (
    <aside className="panel">
      <h2>Flags ({flags.length})</h2>
      <div className="filters">
        {ORDER.filter((t) => counts.has(t)).map((t) => (
          <label key={t} style={{ borderColor: FLAG_COLORS[t] }}>
            <input
              type="checkbox"
              checked={!off.has(t)}
              onChange={() =>
                setOff((prev) => {
                  const n = new Set(prev);
                  if (n.has(t)) n.delete(t);
                  else n.add(t);
                  return n;
                })
              }
            />{" "}
            {NAMES[t]} <b>{counts.get(t)}</b>
          </label>
        ))}
        {flags.length === 0 && <small>no flags yet</small>}
      </div>
      <ol className="flags">
        {shown.map((f) => (
          <li key={f.id}>
            <button onClick={() => onSeek(f)} style={{ borderInlineStartColor: FLAG_COLORS[f.type] }}>
              <span className="t">{fmtTime(f.time)}</span> <span className="type">{NAMES[f.type]}</span> <span className="text">{f.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
