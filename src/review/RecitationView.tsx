import { memo, useEffect, useSyncExternalStore } from "react";
import type { Block, Item } from "./model.ts";
import { fmtTime, wordLabel } from "./model.ts";
import { ensureFont, fontFamily, getFontStates, subscribeFonts, type FontStates } from "./fonts.ts";

// Font state comes in as a prop (an immutable snapshot) so memoized renders cannot show a stale "loading" glyph.
function Glyph({ page, glyph, className, title, k, fonts }: { page: number; glyph: string; className: string; title: string; k?: number; fonts: FontStates }) {
  const st = fonts.get(page);
  return (
    <span className={`${className}${st === "ready" ? "" : st === "failed" ? " nofont" : " loading"}`} style={{ fontFamily: `${fontFamily(page)}, serif` }} title={title} data-k={k}>
      {glyph}
    </span>
  );
}

function tip(it: Item) {
  const o = it.o;
  return `${wordLabel(o)} · ${o.kind}${o.repeat ? " · repeated" : ""}${o.basmala ? " · basmala" : ""} · conf ${o.confidence.toFixed(2)} · ${fmtTime(o.start)}–${fmtTime(o.end)}${o.text ? ` · ASR "${o.text}"` : ""}${o.ambiguous ? " · ambiguous start" : ""}`;
}

function Row({ it, showExtras, fonts }: { it: Item; showExtras: boolean; fonts: FontStates }) {
  const o = it.o;
  if (o.kind === "extra") {
    if (!showExtras) return null;
    return (
      <span className={`extra${it.rejected ? " rejected" : ""}`} data-k={it.k} title={tip(it)}>
        {o.text}
      </span>
    );
  }
  const cls = ["w", o.kind, o.repeat ? "repeat" : "", o.basmala ? "basmala" : "", it.rejected ? "rejected" : "", o.ambiguous ? "ambiguous" : ""].filter(Boolean).join(" ");
  return (
    <>
      <Glyph page={it.page!} glyph={it.glyph!} className={cls} title={tip(it)} k={it.k} fonts={fonts} />
      {it.marker && <Glyph page={it.marker.page} glyph={it.marker.glyph} className={`marker${it.marker.complete ? "" : " partial"}`} title={it.marker.label} fonts={fonts} />}
    </>
  );
}

function RecitationViewImpl({ blocks, showExtras }: { blocks: Block[]; showExtras: boolean }) {
  const fonts = useSyncExternalStore(subscribeFonts, getFontStates); // re-render when a page font arrives
  useEffect(() => {
    const pages = new Set<number>();
    for (const b of blocks) for (const it of b.items) {
      if (it.page !== null) pages.add(it.page);
      if (it.marker) pages.add(it.marker.page);
    }
    pages.forEach(ensureFont); // only the pages that have a recited word
  }, [blocks]);
  return (
    <div className="recitation" dir="rtl" lang="ar">
      {blocks.map((b) => {
        const visible = b.items.some((it) => it.o.kind !== "extra" || showExtras);
        if (!visible && b.notes.length === 0) return null;
        return (
          <section key={b.key} className="block">
            {b.heading && b.surah !== null && <h3 className="surah" dir="ltr">Surah {b.surah}</h3>}
            {b.notes.map((n, i) => (
              <div key={i} className={`note ${n.kind}`} dir="ltr" data-t={n.time}>
                <span className="t">{fmtTime(n.time)}</span> {n.text}
              </div>
            ))}
            <div className="line">
              {b.items.map((it) => (
                <Row key={it.k} it={it} showExtras={showExtras} fonts={fonts} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
export const RecitationView = memo(RecitationViewImpl);
