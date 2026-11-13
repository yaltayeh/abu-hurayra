# Transcript → Quran alignment (`src/align/`)

Phase B of `next-phase.md`. Input: the transcription groups (ASR words with times, plus silence boundaries and spans the
ASR could not read). Output: the list of **recited occurrences** — each a Quran word id (quran-core) with start/end,
confidence and a kind (`matched` / `substituted` / `inferred` / `extra`) — plus ayah-completion events, jumps, rejected
spans and basmala gaps. Nothing here touches the UI or the worker yet.

```ts
import { buildQuranIndex, alignTranscript, resolveBasmalas, fromSegmentResult } from "./align/index.ts";
const idx = buildQuranIndex(parseQuranCore(bin));            // once: ~150 ms in Chrome
const result = alignTranscript(idx, groups.map(fromSegmentResult));   // batch over all groups: 94 ms for a 28-min file
const { result: final, notes } = await resolveBasmalas(idx, result, probe /* optional */);
```

## Files

| File | Role |
|---|---|
| `quran-index.ts` | The Quran as one matching sequence of 77,880 entries: the 77,432 words plus a 4-word basmala in front of every surah except Al-Fatiha (where it is ayah 1) and At-Tawbah. Strict and loose normalized forms interned to ints; strict/loose trigram indexes (65,016 strict trigrams). |
| `align.ts` | The beam search, backtrace, times for inferred words, ayah events, jump events, rejection. |
| `basmala.ts` | Rule 7: re-transcribe the gap before a surah's first word, else split by silence, else absent. |
| `types.ts` | Input/output types and `DEFAULT_CONFIG` (all costs and thresholds). |
| `index.ts` | Exports and `fromSegmentResult` (adapter from `transcribeSegments` output). |

`src/transcribe.ts` got two optional fields on `SegmentResult`: `breaks` (silence boundaries between the segments merged
into a group) and `unrecognized` (members dropped for looping/empty output). Words inside a group are contiguous in time,
so without `breaks` the aligner could not see a pause inside a 25 s group.

## Model

A beam search (Viterbi, at most 64 hypotheses per ASR word, hypotheses more than 10 worse than the best are dropped) over
states `(j, e)`: `j` = entry of the last Quran word consumed (−1 before the first anchor), `e` = recent unmatched ASR words
(capped at 4 = "lost"). One pass over the whole transcript, group boundaries only matter as pauses, so every group
continues where the previous one ended (rule 2). Costs (lower is better; `DEFAULT_CONFIG`):

| Move | Cost | Notes |
|---|---|---|
| next word, exact strict form | −0.02 | tiny bonus: of two explanations with equal cost the one matching more words wins |
| next word, equal loose form | 0.13 | |
| next word, similar (sim ≥ 0.6) | 0.2 + 1.2·(1 − sim) | `substituted` |
| next word, different | 1.4 | `substituted` (an ASR error is cheaper than extra + skip) |
| skip 1–3 Quran words (ASR missed them) | 0.8 each | `inferred`; a skipped surah basmala costs 0.1 per word |
| skip inside an unrecognized span | 0.25 each, up to 3.5 words/s of the span | the span is evidence the words were recited |
| extra ASR word | 0.9 | `extra`; the state does not move |
| split (يا + أيها → one word) / merge | 0.25–0.3 + similarity | join is normalized as a whole (alef rules see the join) |
| backward jump inside the current or previous ayah of the same surah | 1.0 (+0.1 if not to an ayah start) | `repeat`; the repeated words are output as recited |
| passage jump anywhere | 2.0 + seed penalty | only (a) at the start, (b) after a completed ayah (≤ 1 word short) **and** a pause **and** at most one trailing unmatched word, (c) when lost (4 unmatched words). `passageJumps: false` disables (b) and (c): only the start anchor remains |

**Anchor (rule 1).** A passage jump needs candidate targets ("seeds"). For the word `i` where a jump is allowed: strict
3-grams of words `i+o … i+o+2` for `o = 0, 1, 2` (the other windows in the first 5 words; word `i` is then aligned to the
position `o` words before the hit), then the same with loose forms (+0.3), plus a window whose first token is the join
of words `i, i+1` (split at the start). **All** candidates are kept (up to 96, ranked by how many of the next 6 words
agree); the hypotheses then compete word by word, nothing is picked on the first hit. The file start is a forced jump.
A search happens only at the start or when a jump is allowed/lost.

**Rejection (rule 5).** After the backtrace, an ASR word is "ok" if it matched (strict/loose/split/repeat) or was a
substitution with similarity ≥ 0.8. A span is rejected when a window of 8 words has < 50 % ok words, or when ≥ 4 words in a
row are not ok. Each span gets a reason: `no-match` (no 3-gram of it exists anywhere consistent) or `forbidden-jump` (its
words do match somewhere else, but reaching it needs a jump that is not allowed here; the detail says why: previous word
mid-ayah, or no pause). The rest of the file is kept and the path re-anchors. `accepted = false` when < 40 % of all words are ok.

**Missing words (rule 6).** Skipped Quran words get times inside the gap between their neighbours, proportional to letter
count; if the neighbours are contiguous the inferred words borrow at most 35 % of the neighbours' duration (≥ 0.12 s each).

**Ayah ends (rule 8).** `ayahs[]` lists every time the path passes an ayah's last word: `{surah, ayah, markerId, time,
complete, occurrence}`. `markerId` is the quran-core word id of the ayah-end glyph; `complete` is false if the recitation
started mid-ayah or words are missing. A repeated ayah produces a second event.

**Ambiguity.** Final hypotheses with a different anchor within 1.5 cost of the best are returned in `alternatives`
(e.g. 20 for the basmala alone) and all confidences are halved with `ambiguous: true`.

**Basmala (rule 7).** The basmala is in the matching sequence as ayah 0 of each surah, so it matches when recited
(`basmala: true`, ids point at 1:1:1-4) and is a cheap skip when not. `result.basmalaGaps` lists, for each surah start, whether it
was recognized and the audio interval where it would be. `resolveBasmalas(idx, result, probe)`:
1. gap shorter than 1.2 s → none was recited (inferred ones are removed, note `absent`);
2. else `probe.transcribe(start, end)` re-transcribes just that interval; ≥ 3 of the 4 basmala words found in order → matched (note `probe`);
3. else the gap itself (bounded by silence) is split proportionally among the 4 words, `inferred`, confidence 0.3 (note `silence`).
Without audio access (no probe) steps 1 and 3 still work.

## Results

All numbers: Node 22 (and headless Chrome 157 for times), `scripts/align/*` with the committed ASR fixtures
(`scripts/align/fixtures/`: q8 transcripts of `test-tarteel-ai/{1,82,51,27}.mp3` and their segments).

### Real files (`node --no-warnings scripts/align/real.mjs`)

| file | ASR words | Quran words in surah | matched (equal) | substituted | inferred | not covered | extra ASR | repeated words | ayahs completed | rejections | jumps | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.mp3 | 20 | 29 (file ends at 1:6:3) | 20 | 0 | 0 | 9 (never recited) | 0 | 0 | 6 of 7 | 0 | start | 12 |
| 82.mp3 | 81 | 80 | 80 | 0 | 0 | 0 | 0 | 0 | 19 / 19 | 0 | start | 6 |
| 51.mp3 | 360 | 360 | 358 | 2 | 0 | 0 | 0 | 0 | 60 / 60 | 0 | start | 32 |
| 27.mp3 | 1,194 | 1,151 | 1,115 (96.9 %) | 31 | 5 | 0 | 12 | 28 | 93 / 93 | 0 | start + 7 repeat | 144 |

27.mp3: 99.6 % of its words are matched or substituted, 100 % covered with the 5 inferred. The 7 `repeat` jumps (3–6 words
restarted inside the same ayah) all happen exactly at a group start. Checked in `scripts/align/check-repeats.mjs` (next section):
they are the reciter restarting after a pause, not ASR artifacts (by ear: still to be confirmed by the owner). 82.mp3's 81 ASR words are 80 Quran words
(`يا` + `أيها` is one word, handled as a split). 1.mp3's matched words include its basmala (Al-Fatiha ayah 1).

### Are the 7 repeats in 27.mp3 real? (`scripts/align/check-repeats.mjs`)

Two independent arguments, no artifact found:
1. **Structure.** Each group is a separate Whisper call on audio that does not overlap the previous group's (cut points are in the
   middle of silences) and no text is passed as a prompt, so Whisper cannot re-emit words "from the previous context": the repeated
   words must come from the audio of the new group.
2. **Acoustics.** For every repeat, DTW distance (MFCC) between the first recitation of those words and the repeat, against 150 random
   same-length spans of the file: 12.1–18.3 for the 7 pairs vs a random minimum of 15.9–19.9 and median 20–24; **0 % of the random spans were closer
   in all 7 cases**. The repeats are 3–6 words long, start 0.5–0.8 s after the previous group's last word, and last 4.5–11 s.

| # | repeat | words | first time | gap before | DTW (random min / median) |
|---|---|---|---|---|---|
| 1 | 5:14.2–5:19.0 | وقال رب أوزعني (27:19:5-7) | 5:10.9–5:13.6 | 0.60 s | 18.3 (19.1 / 23.5) |
| 2 | 6:59.0–7:03.9 | وزين لهم الشيطان أعمالهم (27:24:8-11) | 6:53.9–6:58.4 | 0.64 s | 12.9 (19.9 / 23.1) |
| 3 | 10:07.3–10:18.6 | فما آتان الله خير مما آتاكم (27:36:7-12) | 9:56.8–10:06.8 | 0.50 s | 14.0 (18.5 / 21.7) |
| 4 | 11:48.1–11:52.6 | قال هذا من فضل ربي (27:40:19-23) | 11:43.3–11:47.4 | 0.68 s | 12.1 (18.5 / 22.5) |
| 5 | 14:51.9–14:56.7 | ثم لنقولن لوليه (27:49:6-8) | 14:47.1–14:51.3 | 0.58 s | 13.3 (16.7 / 20.5) |
| 6 | 16:32.5–16:37.8 | إلا أن قالوا (27:56:5-7) | 16:27.6–16:31.7 | 0.78 s | 14.2 (15.9 / 20.2) |
| 7 | 19:23.9–19:29.1 | ومن يرسل الرياح بشرا (27:63:7-10) | 19:19.2–19:23.1 | 0.76 s | 17.7 (19.9 / 24.4) |

This cannot prove the *words* are the same (same reciter, similar prosody) but it does show the audio is a re-recitation of the earlier
span rather than new speech. If a future file shows repeats that are not acoustically close to the first recitation, the guard to add would be:
reject a `repeat` whose DTW distance is above the random median, or whose audio span is shorter than the words need (≈ 0.25 s per word); not needed here.

### Synthetic edge cases from real ASR output (`scripts/align/synthetic.mjs`, 16 cases, all pass)

Built by concatenating the real ASR words of 82 / 51 / 1 per ayah (each part its own group = pause, unless noted).
Only surah 83 and the refrain of surah 55 are *simulated* (strict-normalized Quran text, no real ASR exists for them).

| case | result |
|---|---|
| repeat a whole ayah (82:3 twice, no pause) | one `repeat` jump 82:3:3 → 82:3:1; 82:3 output twice; events 1 2 3 3 4 5 |
| repeat the last 3 words of 82:5 | repeat jump to 82:5:3, 3 words flagged `repeat`, 82:5 completes twice |
| start mid-surah (51:14 from word 3) | anchor 51:14:3, 51:14 reported partial, 51:15-17 complete, no earlier words invented |
| skip an ayah (82:5) after a pause | `skip-forward` 82:4:3 → 82:6:1, `skippedAyahs: [82:5]`, nothing output for 82:5 |
| skip an ayah with NO pause | forbidden: 4-word `forbidden-jump` rejection ("previous ayah is complete but there is no pause"), re-anchor, 82:5 not filled |
| Al-Fatiha then 82 | `passage` jump 1:6:3 → 82:1:1; with `passageJumps: false` the second passage is rejected (17 extras, 1 rejection) |
| 82 → 83 with basmala recited | no jump; basmala matched (4 words, `basmala`) then 83:1.. |
| 82 → 83, basmala joined/unrecognized | 4 inferred basmala words + `basmalaGaps`; no extras |
| …`resolveBasmalas` | 2.5 s pause: `silence` (4 inferred); contiguous: `absent`; with a probe returning the isolated basmala: `probe`, 4 matched, 1 probe call |
| unrelated recitation (60 shuffled Quran words) | `accepted = false`, one `no-match` span covering all 60, 0 words matched |
| 25 junk words inside 82 | `no-match` span, 82:9-14 afterwards matched, all of 82:1-14 completed |
| leaving an incomplete ayah (82:5 cut) for 51:20 | `forbidden-jump` rejection: "previous recited word 82:5:3 is mid-ayah (3 of 5)", then re-anchor at 51:21 |
| clip = the basmala only | 20+ alternatives, confidences halved, `ambiguous` |
| clip = refrain 55:13 (31× in surah 55) | 20 alternatives listed; with 55:14 after it, unique anchor |
| unrecognized 3 s span where 82:5 is missing | 5 inferred words with times inside the span, 82:5 completes, no jump (without the span the same input is a flagged skip/reanchor) |

### Real basmala re-transcription (`scripts/align/basmala-real.mjs`, real model)

One 168 s file: 82.mp3, 1.5 s silence, the basmala of 1.mp3 (5.9 s), 0.5 s, the first 30 s of 51.mp3. Transcription: 9
groups in 14.5 s. The basmala is joined to 51's first words, so the ASR skips it (`passage 82:19:9 → 51:1:1`, basmala
reported as not recognized). `resolveBasmalas` called the real pipeline on the gap [127.04, 137.98] once, got
"بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ" and placed the 4 words at 131.5-135.9 s (the basmala was at 131.3-137.2): `probe`, 4 matched.

### Speed (`scripts/align/perf.mjs`; Chrome via a throwaway page)

| | words | Node 22 (median of 5) | headless Chrome 157 (first run / median) |
|---|---|---|---|
| 28-min file (27.mp3) | 1,194 | 144 ms | 94 / 89 ms |
| 84 min (3 × 27.mp3) | 3,582 | 241 ms | 189 / 189 ms |
| 167 min (6 ×) | 7,164 | 452 ms | – |

~60–120 µs per ASR word, linear. One-time cost: parse quran-core 17 ms (Node; 69 ms in Chrome including the fetch from localhost) and
build the matching index 150-175 ms. The Chrome harness is not in the repo.

## Limitations and open points

- **Batch, not incremental.** `alignTranscript` runs over all groups at once (fast enough to re-run on every new group, 94 ms for 28 minutes).
  A session API that keeps the beam between groups is straightforward but not written.
- **Costs are hand-tuned** on 4 real files and the synthetic cases above; no held-out set exists. The three that mattered:
  jump 2.0 (3.0 made 3-word passages cheaper as extras), extra 0.9 vs substitution, the 0.02 match bonus.
- **A passage shorter than ~3 words** after a jump is not worth the jump cost and stays `extra`. A split at the very start of a
  window is handled; splits elsewhere are handled by the DP moves.
- **Pause detection** comes from group boundaries, `breaks` and gaps ≥ 0.3 s. Words inside a Whisper call are contiguous, so a pause inside one
  segment is invisible.
- The ASR repeats words at **group seams** only if the reciter does; the 7 repeats in 27.mp3 are all at group starts. Not checked by ear.
- Surah 9 has no basmala by construction; reciters who read one anyway are matched as extras or inferred.
- `resolveBasmalas` "split by silence" places the basmala in the whole gap; the gap may include a breath or other speech. Confidence 0.3 says so.
- Not integrated in the worker/UI; `transcribe.ts` only gained the optional `breaks`/`unrecognized` fields.
- Not tested: Safari/Firefox timing, files with several surah changes in one recording (only the synthetic ones), real recordings with unrecited ayahs.

## Reproduce

```bash
python3 scripts/data/build.py                       # quran-core.bin (needs data/QPC-V2, see scripts/data/README.md)
node --no-warnings scripts/align/real.mjs           # fixtures in scripts/align/fixtures
node --no-warnings scripts/align/synthetic.mjs      # 16 cases, exit code 1 on failure
node --no-warnings scripts/align/perf.mjs
node --no-warnings scripts/align/basmala-real.mjs test-tarteel-ai   # real model + ffmpeg; the audio is not in the repo
```
Fixtures are regenerated with `AILab/dump_transcript.mjs` and `AILab/dump_segments.mjs` (see `scripts/data/README.md`).
