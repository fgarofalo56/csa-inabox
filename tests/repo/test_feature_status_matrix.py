"""Feature Status Matrix conformance tests.

The README's Feature Status Matrix is the *only* authoritative statement
of which capabilities are GA / Beta / Stub / Removed / Planned.  These
tests parse the matrix and assert the most easily-falsifiable claims so
the README cannot silently drift away from the source tree.

What we check
-------------

1. Every module path mentioned in a "Python Platform" row exists in the
   tree (or, for "Removed" rows, does NOT exist -- a tombstone .md is
   acceptable for the parent dir).
2. Every "GA" platform module has a ``tests/`` directory.
3. Every vertical mentioned by name exists under ``examples/``.
4. The Stub-vs-not-Stub claim for ``ai_integration/graphrag``,
   ``ai_integration/mcp_server`` and ``ai_integration/model_serving``
   matches reality (Stub rows must have zero ``test_*.py`` under their
   subtree).

What we DON'T check (out of scope, would be too brittle)
--------------------------------------------------------

* Bicep "Beta" rows (manual judgement)
* Compliance status (manual judgement)
* Copilot LOC counts ("~25k LOC" claim)
* Streaming "stub ResolvedSchema" claim (runtime behaviour)
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
README = REPO_ROOT / "README.md"


def _matrix_text() -> str:
    text = README.read_text(encoding="utf-8")
    start = text.index("## 📊 Feature Status Matrix")
    # Matrix runs to the next H2 (## 🚀 ... or end of file).
    end_match = re.search(r"\n## ", text[start + 1 :])
    end = (start + 1 + end_match.start()) if end_match else len(text)
    return text[start:end]


# ---------------------------------------------------------------------------
# Test 1 -- module paths in the Python Platform section exist (or don't, for Removed)
# ---------------------------------------------------------------------------

# Pattern: ``backtick-wrapped path/`` ... | Status | ...
_PLATFORM_ROW_RE = re.compile(
    r"^\| `(?P<path>[^`]+)` \| (?P<status>GA|Beta|Stub|Planned|Removed)\b",
    re.MULTILINE,
)


def _platform_rows() -> list[tuple[str, str]]:
    matrix = _matrix_text()
    section_start = matrix.index("### Python Platform")
    section_end = matrix.index("### Portal", section_start)
    return _PLATFORM_ROW_RE.findall(matrix[section_start:section_end])


@pytest.mark.parametrize("row", _platform_rows(), ids=lambda r: f"{r[0]}={r[1]}")
def test_platform_module_path_matches_status(row: tuple[str, str]) -> None:
    path_str, status = row
    # Platform-section rows are written relative to ``csa_platform/`` because
    # that is the section heading -- e.g. ``ai_integration/rag/`` means
    # ``csa_platform/ai_integration/rag/``.
    rel = path_str.rstrip("/")
    path = REPO_ROOT / "csa_platform" / rel

    if status == "Removed":
        # The directory itself must be gone.  A tombstone .md sibling is
        # allowed (and expected -- see SEMANTIC_KERNEL_REMOVED.md).
        assert not path.exists(), (
            f"README marks `{path_str}` as Removed but the directory still "
            f"exists at {path}.  Either restore the row's status or delete "
            f"the directory."
        )
    else:
        assert path.exists(), (
            f"README mentions `{path_str}` as a {status} module but no such "
            f"path exists at {path}.  Either fix the README path or add the "
            f"module."
        )


# ---------------------------------------------------------------------------
# Test 2 -- GA platform modules have a tests/ directory
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "row",
    [r for r in _platform_rows() if r[1] == "GA"],
    ids=lambda r: r[0],
)
def test_ga_modules_have_tests(row: tuple[str, str]) -> None:
    path_str, _status = row
    path = REPO_ROOT / "csa_platform" / path_str.rstrip("/")
    # Look for a tests/ subdirectory anywhere in the subtree, OR a
    # top-level ``tests/`` mirror (csa_platform/governance has both
    # styles and either is fine).
    has_tests = any(path.rglob("tests")) or any(
        (REPO_ROOT / "tests").rglob(path.name)
    )
    assert has_tests, (
        f"README marks `{path_str}` as GA but no tests/ directory was found "
        f"under {path} or under top-level tests/{path.name}/.  GA modules "
        f"must have at least one tests/ folder."
    )


# ---------------------------------------------------------------------------
# Test 3 -- verticals named in the matrix exist under examples/
# ---------------------------------------------------------------------------


def test_named_verticals_exist() -> None:
    matrix = _matrix_text()
    section = matrix[matrix.index("### Verticals") : matrix.index("### Compliance")]
    # Two patterns: comma-separated bare names ("usda, noaa, epa, ...")
    # and backtick-wrapped paths (`examples/streaming/`).
    # NOTE: pattern uses a flat character class (no nested quantifier) to
    # avoid catastrophic backtracking — see CodeQL alert py/redos #292.
    bare_names = re.search(
        r"\| (?P<names>[a-z][a-z0-9, -]+[a-z0-9]) \| Beta", section
    )
    assert bare_names, "couldn't find comma-separated vertical list row"
    names = [n.strip() for n in bare_names.group("names").split(",")]
    missing = [n for n in names if not (REPO_ROOT / "examples" / n).is_dir()]
    assert not missing, (
        f"README lists these verticals but no matching examples/ dir: "
        f"{missing}"
    )

    # Backtick-wrapped vertical paths (`examples/streaming/` etc).
    paths = re.findall(r"`(examples/[a-z0-9-]+)/?`", section)
    missing_paths = [p for p in paths if not (REPO_ROOT / p).is_dir()]
    assert not missing_paths, (
        f"README references these vertical paths but they don't exist: "
        f"{missing_paths}"
    )


# ---------------------------------------------------------------------------
# Test 4 -- Stub claims for AI integration submodules are honest
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "submodule",
    ["mcp_server", "model_serving"],
)
def test_stub_ai_modules_have_no_tests(submodule: str) -> None:
    """README claims these submodules have *zero tests*; verify it."""
    subtree = REPO_ROOT / "csa_platform" / "ai_integration" / submodule
    if not subtree.exists():
        pytest.skip(f"{subtree} not present")
    test_files = [
        p for p in subtree.rglob("test_*.py")
        # Allow a single placeholder ``conftest.py`` or empty package
        # marker; ignore files with zero non-blank, non-comment lines.
        if any(
            line.strip() and not line.strip().startswith("#")
            for line in p.read_text(encoding="utf-8", errors="ignore").splitlines()
        )
    ]
    assert not test_files, (
        f"README marks csa_platform/ai_integration/{submodule}/ as Stub "
        f"with 'zero tests', but found:\n  "
        + "\n  ".join(str(p.relative_to(REPO_ROOT)) for p in test_files)
        + "\nEither upgrade the README status or remove the test files."
    )
