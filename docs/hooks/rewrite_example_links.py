"""mkdocs hook: rewrite relative links in any docs page that escape the\ndocs tree (e.g. `../../examples/foo/README.md` or `../../deploy/...`) into\nabsolute GitHub source-tree URLs.

Why:
- `docs/examples/<name>.md` are include-markdown shims pulling
  `examples/<name>/README.md` which contain repo-relative links.
- `docs/use-cases/*.md` and `docs/tutorials/**/README.md` were already
  authored with relative links pointing OUTSIDE `docs/` (into `examples/`,
  `deploy/`, `.github/`, etc.).

Rather than duplicating those source files into `docs/`, this hook detects
any leftover relative link that mkdocs cannot resolve as a doc file and
rewrites it to point at the GitHub source tree on `main`.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_BLOB = "https://github.com/fgarofalo56/csa-inabox/blob/main"

# Match Markdown links: [text](target) where target is a relative path
# (starts with ../ or ./).  Anchors and absolute URLs are left alone.
_LINK_RE = re.compile(r"(\[[^\]]+\])\((\.\.?/[^)#]+)(#[^)]*)?\)")

# Trees we know exist at the repo root but NOT under docs/ — these are the
# common targets that produce "not found among documentation files" warnings.
_REPO_TREES = (
    "examples/",
    "deploy/",
    ".github/",
    "scripts/",
    "csa_platform/",
    "apps/",
    "azure-functions/",
    "domains/",
    "portal/",
    "tests/",
    "tools/",
)


def _resolve_against_source(href: str, page_src_path: str) -> str | None:
    """Resolve `href` against the page's *source* repo location.

    For `docs/examples/<name>.md` the source is `examples/<name>/README.md`
    (the include-markdown source).  For other pages it's the page itself
    rooted at `docs/<page_src_path>`.

    Returns the resolved repo-rooted POSIX path, or None if it cannot be
    resolved (e.g. went above repo root).
    """
    p = Path(page_src_path)
    if p.parts[:1] == ("examples",) and p.name != "index.md":
        # Include-markdown shim — resolve from the README's location
        base_dir = Path("examples") / p.stem
    else:
        # Real doc file under docs/ — resolve from its actual location
        base_dir = Path("docs") / p.parent

    parts = href.split("/")
    rel = base_dir
    for part in parts:
        if part == "..":
            rel = rel.parent
        elif part and part != ".":
            rel = rel / part

    # Must stay at or below repo root
    try:
        rel.relative_to(Path("."))
    except ValueError:
        return None
    posix = rel.as_posix()
    if posix.startswith("./"):
        posix = posix[2:]
    return posix or None


def _should_rewrite(resolved: str) -> bool:
    """Only rewrite paths into known repo trees outside `docs/`."""
    return any(resolved.startswith(tree) for tree in _REPO_TREES)


def on_page_markdown(markdown: str, page, config, files):  # noqa: ANN001 (mkdocs API)
    src_path = page.file.src_path.replace("\\", "/")

    def _sub(match: re.Match[str]) -> str:
        text, target, anchor = match.group(1), match.group(2), match.group(3) or ""
        resolved = _resolve_against_source(target, src_path)
        if not resolved or not _should_rewrite(resolved):
            return match.group(0)
        return f"{text}({REPO_BLOB}/{resolved}{anchor})"

    return _LINK_RE.sub(_sub, markdown)
