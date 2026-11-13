# Review page (`?view=review`)

QA tool for the whole chain: audio → worker (Whisper) → `src/align` → Quran glyphs. It is not the product UI; it exists to make
alignment problems easy to see and to listen to.

## Setup (assets are not in git)

```bash
python3 scripts/data/build.py                 # scripts/data/out/quran-core.bin (needs data/QPC-V2, see scripts/data/README.md)
node scripts/data/copy-assets.mjs             # public/fonts/v2/p001.woff2 … p604.woff2 (93 MB) + public/data/quran-core.bin
pnpm dev                                      # or: pnpm build && pnpm preview;  open /?view=review
```
`public/fonts/` and `public/data/` are git-ignored. Everything is served from the same origin, so COOP/COEP/CORP stay valid. Without the
assets the page shows the command to run. The font license is still unchecked: do not publish the fonts.

## What it shows

- **Words as glyphs**: the QCF v2 glyph of every recited word in the font of its mushaf page (`FontFace`, loaded when a word of that
  page is rendered; until it arrives the glyph is faded), flowing like a mushaf (RTL), with the ayah-end marker (gold) after every ayah
  the path completed. A marker outlined in dotted amber = completed but not every word was recited/recognized. A new block starts at a
  surah change, jump, repeat or rejected span, so a repeated passage is shown again, as recited.
- **Audio player** (the uploaded file): the current word is highlighted (yellow box) while playing; click a word, a jump label or a flag to seek
  to it and play. "follow playback" scrolls the current word into view.
- **Colours** (legend at the top): *substituted* orange underline, *inferred (missing)* blue dashed + faded, *repeated* purple, *extra ASR
  word* red chip (hidden unless "show extra ASR words" is on), *rejected span* red outline on the words of the span + a red banner above it with the
  reason, *new passage / skip / re-anchor* labels above the block (green, amber, red), basmala grey. Hover a word (or look at the line under the
  legend): `surah:ayah:word · kind · confidence · time · ASR text`.
- **Flags panel**: every flag with its time, filterable by type with counts; click = seek and scroll to it (extra words are shown automatically).
  Flags: rejected spans, jumps/skips/re-anchors, repeats, substituted words (with the ASR word), inferred runs, extra ASR words, incomplete
  ayahs, unrecognized basmalas (only when the gap could hold one), ambiguous start, whole-input rejection.
- **Progressive**: the worker posts each group; the aligner re-runs on all groups received (6–12 ms for 82.mp3, ~90 ms for 28 min) and the page updates.
  The stats line shows counts, groups and the aligner time.

## Test run (headless Chrome, real model, `scripts/align/review-test.mjs`)

`pnpm build && pnpm preview`, then `node --no-warnings scripts/align/review-test.mjs <audio> <out-dir>` uploads the file, waits for the
transcription, checks the DOM (fonts, glyph counts, flags), clicks a word and checks `audio.currentTime` and the highlight, clicks flags, and saves
screenshots.

### Results (Chrome 157 headless on macOS, WebGPU q4, the real model)

| | 82.mp3 | 27.mp3 (28 min) |
|---|---|---|
| transcription (page open → last group) | 26 s | 288 s |
| groups / glyph words / ayah markers | 7 / 80 / 19 | 85 / 1,175 / 93 |
| page fonts requested and loaded | 1 | 9 (of 604) |
| glyphs still faded / failed after loading | 0 / 0 | 0 / 0 |
| flags in the panel | 1 | 56 (34 substituted, 11 extra, 6 repeats, 5 inferred) |
| aligner time at the end | 6-12 ms | 96-115 ms |
| click a word (82:8:6 / 27:39:16) | audio seeks there, plays, the same word is highlighted 1.5 s later | same |
| flag clicks (substituted / extra / inferred / repeat) | – | each seeks to its time |

The browser transcript differs from the Node one (1,175 vs 1,194 words, 6 vs 7 repeats): Chrome's decoder gives a different segmentation.
A synthetic transcript (`make-demo-groups.mjs`, injected with `window.__loadGroups`, no audio) renders every other flag: skip-forward label,
repeat label with the repeated words in purple, new-passage labels, a rejected span banner with its reason (extras hidden or shown),
inferred words from an unrecognized span, the basmala of Al-Fatiha greyed, an unrecognized-basmala flag.

A bug found by these runs: with the React compiler, a glyph that read the module-level font state during render stayed faded forever
(98 glyphs on 27.mp3). The font state is now an immutable snapshot passed as a prop.

### Not verified

- **By ear.** Headless Chrome plays the audio but nobody listened: click-to-seek and the highlight were checked through `audio.currentTime` and the
  highlighted element, not that the highlighted word is what is being recited. That needs a person (the 7 repeats in 27.mp3 too).
- Safari and Firefox (the page was only run in Chrome; WASM q8 there, `FontFace` with woff2 should be fine but is untested).
- Narrow / mobile layout (CSS written, not looked at) and light colour scheme (only the dark scheme was captured).
- Fonts over a real network (served from localhost: all 9 loaded within a second); font license.
- Keyboard navigation and accessibility of the word spans.
- Rejected spans and jumps on a real recording: 27.mp3 and 82.mp3 have none, so those labels are only seen on the synthetic transcript.
