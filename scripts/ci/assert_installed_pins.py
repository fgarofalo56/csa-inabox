#!/usr/bin/env python3
"""Assert that the INSTALLED distributions match a requirements file's `==` pins.

Why this exists (#2615)
-----------------------
The Python Test Suite installs every ``requirements.txt`` in the repo into ONE
shared environment. Six of them pin ``fastapi==0.115.x`` while
``apps/loom-duckdb/requirements.txt`` — the file that describes the image that
actually SHIPS — pins ``fastapi==0.140.13``. Those two are mutually exclusive
(0.115.x requires ``starlette<0.42``, 0.140.13 requires ``starlette>=0.46``), so
whichever install runs LAST silently decides the stack under test.

``tests/loom_duckdb`` passes on BOTH stacks, so the skew produced no signal at
all: a green suite that had measured a FastAPI the container never runs. This
script turns that silence into a hard failure — it prints the resolved version
of every pinned distribution and exits non-zero if any of them differs from the
pin, so a future reordering (or a new ``requirements.txt`` landing later in
``find`` order) breaks the build instead of quietly changing what is tested.

Usage::

    python scripts/ci/assert_installed_pins.py apps/loom-duckdb/requirements.txt

Only ``name==version`` lines are checked. Ranges (``>=``, ``<``, ``~=``),
markers, ``-r`` includes, URLs and comments are reported as "not a pin" and
skipped — this asserts EXACT pins, which is what a shipped image has.
"""

from __future__ import annotations

import argparse
import re
import sys
from importlib import metadata
from pathlib import Path

#: ``name[extra1,extra2]==1.2.3`` -> ("name", "1.2.3"). Environment markers
#: (``; python_version < "3.11"``) and trailing comments are tolerated and
#: stripped by the caller before this is applied.
_PIN = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?:\[(?P<extras>[^\]]*)\])?"
    r"==(?P<version>[A-Za-z0-9][A-Za-z0-9.*+!-]*)$"
)


def parse_pins(text: str) -> dict[str, str]:
    """Return ``{distribution_name: exact_version}`` for every ``==`` pin.

    Lines that are blank, comments, pip options (``-r``, ``--hash``), URLs or
    non-exact constraints are skipped: this function answers "what does this
    file pin EXACTLY", not "what does it allow".
    """
    pins: dict[str, str] = {}
    for raw in text.splitlines():
        # Strip inline comments, then environment markers, then whitespace.
        line = raw.split("#", 1)[0].split(";", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        match = _PIN.match(line)
        if match is None:
            continue
        pins[match.group("name")] = match.group("version")
    return pins


def _installed(name: str) -> str | None:
    """Resolved version of *name*, or None when it is not installed."""
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def check(pins: dict[str, str]) -> list[tuple[str, str, str | None]]:
    """Return ``[(name, expected, actual_or_None)]`` for every MISMATCH."""
    mismatches: list[tuple[str, str, str | None]] = []
    for name, expected in sorted(pins.items()):
        actual = _installed(name)
        if actual != expected:
            mismatches.append((name, expected, actual))
    return mismatches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requirements", type=Path, help="path to a requirements.txt")
    parser.add_argument(
        "--label",
        default=None,
        help="human name for the stack, used in the printed banner",
    )
    args = parser.parse_args(argv)

    path: Path = args.requirements
    if not path.is_file():
        print(f"::error::{path} does not exist", file=sys.stderr)
        return 2

    pins = parse_pins(path.read_text(encoding="utf-8"))
    if not pins:
        # An empty pin set would make this check vacuously green — the exact
        # "gate measures nothing" failure mode this script exists to prevent.
        print(f"::error::{path} contains no `name==version` pins to assert", file=sys.stderr)
        return 2

    label = args.label or str(path)
    print(f"Resolved stack under test vs {label}:")
    for name, expected in sorted(pins.items()):
        actual = _installed(name)
        flag = "ok " if actual == expected else "SKEW"
        print(f"  [{flag}] {name}: pinned {expected}, installed {actual or '<missing>'}")

    mismatches = check(pins)
    if not mismatches:
        print(f"All {len(pins)} pins in {path} match the installed environment.")
        return 0

    for name, expected, actual in mismatches:
        got = actual or "NOT INSTALLED"
        print(
            f"::error file={path.as_posix()}::{name} is {got} but {path.as_posix()} "
            f"pins {expected} — the tests are measuring a different stack than the "
            f"one that ships (#2615).",
            file=sys.stderr,
        )
    print(
        f"::error::{len(mismatches)} of {len(pins)} pinned distributions do not match "
        f"{path.as_posix()}. Install that file LAST, or drop the conflicting pin.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
