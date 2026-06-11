#!/usr/bin/env python3
"""Build slide decks (PPTX + PDF) from CSA Loom marketing / workshop markdown.

This is the real generator behind the "slide deck generated from markdown"
claim in PRP-21 (marketing kit) and PRP-22 (5-day workshops). It performs a
deterministic markdown -> Marp transform, then shells out to the Marp CLI
(`@marp-team/marp-cli`, fetched on demand via `npx`) to render PPTX and PDF.

Why a preprocessor: the Loom marketing decks are authored as MkDocs-friendly
reference pages (`### Slide N — ...` headings, speaker-note bullets) so they
render cleanly in the docs site. Marp wants `---` slide separators and treats
HTML comments as presenter notes. This script bridges the two representations
without forcing slide syntax into the published docs.

Usage:
    python scripts/csa-loom/build-decks.py            # build all known decks
    python scripts/csa-loom/build-decks.py docs/fiab/marketing/pitch-deck.md
    python scripts/csa-loom/build-decks.py --format pdf <file> [<file> ...]

Requirements:
    - Node.js + npx on PATH (the Marp CLI is fetched on first run; needs
      network access once, then npx caches it). If npx/marp is unavailable
      the script still emits the intermediate `.marp.md` so the transform is
      verifiable offline.

Outputs go to build/decks/ (gitignored) — slide artifacts are never committed.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "build" / "decks"

# Decks we know how to build. Each is a published markdown page that doubles
# as a slide source. Add new workshop day files here as they ship.
DEFAULT_DECKS = [
    "docs/fiab/marketing/pitch-deck.md",
    "docs/fiab/marketing/federal-pitch.md",
    "docs/fiab/workshops/5-day-federal-coe/day-1-foundation.md",
    "docs/fiab/workshops/5-day-federal-coe/day-2-ingest.md",
    "docs/fiab/workshops/5-day-federal-coe/day-3-transform.md",
    "docs/fiab/workshops/5-day-federal-coe/day-4-bi-ai.md",
    "docs/fiab/workshops/5-day-federal-coe/day-5-operate.md",
    "docs/fiab/workshops/5-day-commercial-coe/day-1-foundation.md",
    "docs/fiab/workshops/5-day-commercial-coe/day-2-ingest.md",
    "docs/fiab/workshops/5-day-commercial-coe/day-3-transform.md",
    "docs/fiab/workshops/5-day-commercial-coe/day-4-bi-ai.md",
    "docs/fiab/workshops/5-day-commercial-coe/day-5-operate.md",
]

MARP_FRONT_MATTER = """---
marp: true
theme: default
paginate: true
backgroundColor: #0b1020
color: #e8eefc
style: |
  section { font-family: 'Segoe UI', sans-serif; font-size: 26px; }
  h1, h2, h3 { color: #7fc8ff; }
  code { background: #16203a; }
  blockquote { border-left: 4px solid #3fd6a8; }
---
"""

# A "new slide" begins at any of these heading patterns.
SLIDE_HEADING = re.compile(r"^(#{1,3})\s+(Slide\s+\d+|Day\s+\d+|.+)$")
SPEAKER_NOTE = re.compile(r"^\s*[-*]\s*(?:\*\*)?Speaker note(?:\*\*)?\s*:\s*(.*)$", re.IGNORECASE)


def transform(md: str) -> str:
    """Convert a published Loom markdown page into a Marp slide deck source."""
    lines = md.splitlines()

    # Strip an existing YAML/MkDocs front-matter block if present.
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                lines = lines[i + 1 :]
                break

    out: list[str] = [MARP_FRONT_MATTER.rstrip(), ""]
    first_heading_seen = False
    notes: list[str] = []

    def flush_notes() -> None:
        if notes:
            out.append("")
            out.append("<!--")
            out.extend(notes)
            out.append("-->")
            notes.clear()

    for raw in lines:
        m = SLIDE_HEADING.match(raw.strip())
        note = SPEAKER_NOTE.match(raw)
        if note:
            notes.append(f"Presenter: {note.group(1).strip()}")
            continue
        if m and raw.startswith(("#", "##", "###")):
            flush_notes()
            if first_heading_seen:
                out.append("")
                out.append("---")
                out.append("")
            first_heading_seen = True
            # Promote every slide heading to an H2 for consistent Marp sizing.
            out.append(f"## {m.group(2).strip()}")
            continue
        out.append(raw)

    flush_notes()
    return "\n".join(out) + "\n"


def render(src: Path, fmt: str) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{src.parent.name}_{src.stem}" if src.parent.name not in ("marketing",) else src.stem
    marp_md = OUT_DIR / f"{stem}.marp.md"
    marp_md.write_text(transform(src.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"  transform -> {marp_md.relative_to(REPO_ROOT)}")

    npx = shutil.which("npx")
    if not npx:
        print("  [skip] npx not found; intermediate .marp.md emitted for offline review.")
        return 0

    targets = ["--pptx", "--pdf"] if fmt == "all" else [f"--{fmt}"]
    rc = 0
    for t in targets:
        ext = t.lstrip("-")
        out_file = OUT_DIR / f"{stem}.{ext}"
        cmd = [npx, "-y", "@marp-team/marp-cli@latest", str(marp_md), t,
               "--allow-local-files", "-o", str(out_file)]
        print(f"  marp {t} -> {out_file.relative_to(REPO_ROOT)}")
        proc = subprocess.run(cmd, cwd=REPO_ROOT)
        rc = rc or proc.returncode
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="Markdown deck sources (default: the known Loom decks).")
    ap.add_argument("--format", choices=["pptx", "pdf", "all"], default="all")
    args = ap.parse_args()

    files = args.files or DEFAULT_DECKS
    overall = 0
    for f in files:
        src = (REPO_ROOT / f) if not Path(f).is_absolute() else Path(f)
        if not src.exists():
            print(f"[warn] missing deck source: {f}")
            continue
        print(f"Building deck: {f}")
        overall = render(src, args.format) or overall
    return overall


if __name__ == "__main__":
    sys.exit(main())
