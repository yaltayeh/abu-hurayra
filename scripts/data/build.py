#!/usr/bin/env python3
"""Build src-ready Quran data from data/QPC-V2 (QUL exports). See scripts/data/README.md.

Output (scripts/data/out/, git-ignored):
  quran-core.bin     the file the app downloads (decoded by src/quran-data.ts)

With --candidates it also writes the two formats compared before choosing the binary one:
  quran.sqlite       candidate A: SQLite, minimal columns
  quran-core.json    candidate B as compact JSON arrays

Usage: python3 scripts/data/build.py [--candidates]   (stdlib only)
"""
import json, os, sqlite3, struct, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "data", "QPC-V2")
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

GLYPH_BASE = 0xFC41  # first glyph code on every page
DIGITS = "٠١٢٣٤٥٦٧٨٩"
SEP = "|"


def load():
    g = json.load(open(os.path.join(SRC, "qpc-v2.json")))
    h = json.load(open(os.path.join(SRC, "qpc-hafs-word-by-word.json")))
    # The JSON key order is NOT canonical; the `id` field is.
    G = sorted(g.values(), key=lambda x: x["id"])
    H = sorted(h.values(), key=lambda x: x["id"])
    assert [x["id"] for x in G] == list(range(1, len(G) + 1))
    assert [(x["id"], x["location"]) for x in G] == [(x["id"], x["location"]) for x in H]
    db = sqlite3.connect(os.path.join(SRC, "layout", "qpc-v2-15-lines.db"))
    rows = db.execute(
        "select page_number,line_number,first_word_id,last_word_id from pages "
        "where line_type='ayah' order by page_number,line_number"
    ).fetchall()
    return G, H, rows


def page_of_words(n, rows):
    page = [0] * n
    line = [0] * n
    for p, l, a, b in rows:
        for i in range(int(a), int(b) + 1):
            page[i - 1] = p
            line[i - 1] = l
    assert all(page), "every word must belong to a page"
    return page, line


def main():
    G, H, rows = load()
    n = len(G)
    page, line = page_of_words(n, rows)
    is_marker = [h["text"].strip(DIGITS) == "" for h in H]

    CAND = "--candidates" in sys.argv
    if CAND:
        # ---------------- A. SQLite ----------------
        p = os.path.join(OUT, "quran.sqlite")
        if os.path.exists(p):
            os.remove(p)
        db = sqlite3.connect(p)
        db.execute("PRAGMA page_size=1024")
        db.execute(
            "CREATE TABLE words (id INTEGER PRIMARY KEY, surah INTEGER, ayah INTEGER, word INTEGER, "
            "text TEXT, glyph TEXT, page INTEGER)"
        )
        db.executemany(
            "INSERT INTO words VALUES (?,?,?,?,?,?,?)",
            [(g["id"], int(g["surah"]), int(g["ayah"]), int(g["word"]), h["text"], g["text"], page[g["id"] - 1])
             for g, h in zip(G, H)],
        )
        db.commit()
        db.execute("VACUUM")
        db.close()

    # ---------------- B. compact derived ----------------
    # words-per-ayah (incl. the end marker, which is the last word of each ayah), surah -> ayah count
    ay_words = []
    surah_ayahs = []
    cur = None
    for g in G:
        k = (int(g["surah"]), int(g["ayah"]))
        if k != cur:
            if cur is None or k[0] != cur[0]:
                surah_ayahs.append(0)
            surah_ayahs[-1] += 1
            ay_words.append(0)
            cur = k
        ay_words[-1] += 1
    assert len(surah_ayahs) == 114 and sum(surah_ayahs) == 6236 and sum(ay_words) == n
    assert max(ay_words) < 256

    # first word index (0-based) of each page, plus the end
    page_first = [0] * 605
    for i in range(n - 1, -1, -1):
        page_first[page[i] - 1] = i
    page_first[604] = n
    assert page_first[0] == 0 and page_first == sorted(page_first)
    page_delta = [page_first[i + 1] - page_first[i] for i in range(604)]
    assert max(page_delta) < 256

    # text of the non-marker words
    words = [h["text"] for h, m in zip(H, is_marker) if not m]
    assert all(SEP not in w for w in words)
    text = SEP.join(words)
    assert len(words) + 6236 == n

    # glyph codes: sequential per page from GLYPH_BASE; a word occupies `len(glyph)` codes.
    glyph_len = [len(g["text"]) for g in G]
    multi = [i for i, c in enumerate(glyph_len) if c != 1]          # word indexes with != 1 code
    multi_len = [glyph_len[i] for i in multi]
    assert set(multi_len) <= {2, 3}
    multi_delta = [multi[0]] + [multi[i] - multi[i - 1] for i in range(1, len(multi))]
    multi_is3 = [i for i, c in zip(multi, multi_len) if c == 3]

    core = {
        "v": 1,
        "surahAyahs": surah_ayahs,
        "ayahWords": ay_words,
        "pageDelta": page_delta,
        "multiDelta": multi_delta,
        "multi3": multi_is3,
        "text": text,
    }
    if CAND:
        open(os.path.join(OUT, "quran-core.json"), "w").write(json.dumps(core, ensure_ascii=False, separators=(",", ":")))

    # binary: header "QCR1", then sections [len u32][bytes]
    def varint(vals):
        out = bytearray()
        for v in vals:
            while v >= 128:
                out.append((v & 127) | 128)
                v >>= 7
            out.append(v)
        return bytes(out)

    text_b = text.encode("utf-8")
    sections = [
        struct.pack("<114H", *surah_ayahs),
        bytes(ay_words),
        bytes(page_delta),
        varint(multi_delta),
        varint(multi_is3),
        text_b,
    ]
    blob = b"QCR1" + b"".join(struct.pack("<I", len(s)) + s for s in sections)
    open(os.path.join(OUT, "quran-core.bin"), "wb").write(blob)

    print("words incl. markers:", n, "| text words:", len(words))
    print("multi-glyph words:", len(multi), "(3 codes:", len(multi_is3), ")")
    for f in sorted(os.listdir(OUT)):
        print(f"{f:22s}{os.path.getsize(os.path.join(OUT, f)):>10,d} B")


if __name__ == "__main__":
    main()
