"""mkdocs hook: rewrite relative links in any docs page that escape the
docs tree (e.g. `../../examples/foo/README.md` or `../../deploy/...`) into
absolute GitHub source-tree URLs.

Why:
- `docs/examples/<name>.md` are include-markdown shims pulling
  `examples/<name>/README.md` which contain repo-relative links.
- `docs/use-cases/*.md` and `docs/tutorials/**/README.md` were already
  authored with relative links pointing OUTSIDE `docs/` (into `examples/`,
  `deploy/`, `.github/`, etc.).

Rather than duplicating those source files into `docs/`, this hook detects
any leftover relative link that mkdocs cannot resolve as a doc file and
rewrites it to point at the GitHub source tree on `main`.

============================================================================
SHIM vs STANDALONE — the rule that decides where links are resolved from
============================================================================

A page under `docs/examples/` can be one of two shapes:

  (A) An **include-markdown SHIM**: the source under `docs/examples/foo.md`
      is a thin frontmatter + `{% include-markdown "../../examples/foo/README.md" %}`
      wrapper. The actual content lives in `examples/foo/README.md` and uses
      relative links from THAT location (e.g. `../../README.md` means the
      repo root). When mkdocs renders the shim, those links are evaluated
      against the README's location, not the shim's.

  (B) A **standalone doc**: the source under `docs/examples/foo.md` is the
      real content, with no include-markdown directive. Its relative links
      should be resolved against `docs/examples/foo.md` itself (so
      `../use-cases/bar.md` means `docs/use-cases/bar.md`).

This hook MUST distinguish the two, otherwise standalone docs under
`docs/examples/` get their `../use-cases/...` links rewritten to point at
the non-existent `examples/use-cases/...` path in the GitHub blob tree
(broken). See PR #243 for the bug that prompted this distinction and the
fix.

The detection rule: a page is a SHIM if and only if its markdown source
contains the literal token `{% include-markdown` (or its whitespace
variant). The `on_page_markdown` callback inspects the markdown directly
and passes `is_include_shim` to `_resolve_against_source`.

If you add a new page under `docs/examples/`:
- If it's an include-markdown shim, the existing 22 sibling files are
  the template — drop in a 9-line wrapper and you're done.
- If it's a standalone doc, just write the doc normally. The hook will
  detect the absence of `{% include-markdown` and resolve links from the
  doc's own `docs/examples/` location.
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

# Repo-root files that source READMEs / docs commonly link back to.
# These resolve to root-level paths with NO directory prefix, so the
# tree-prefix check above misses them.
_REPO_ROOT_FILES = (
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "LICENSE",
    "LICENSE.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    ".env.example",
    "CODEBASE_INVENTORY.txt",
    "VISION.md",
    "COMPLIANCE.md",
    "HIPAA_COMPLIANCE.md",
    "pyproject.toml",
    "mkdocs.yml",
)


def _resolve_against_source(
    href: str, page_src_path: str, is_include_shim: bool = True
) -> str | None:
    """Resolve `href` against the page's *source* repo location.

    For include-markdown shims like `docs/examples/<name>.md` that pull
    `examples/<name>/README.md`, the source is the README's location.
    For standalone docs (including standalone docs that happen to live under
    `docs/examples/`), resolve from the doc's own location under `docs/`.

    Returns the resolved repo-rooted POSIX path, or None if it cannot be
    resolved (e.g. went above repo root).
    """
    p = Path(page_src_path)
    if is_include_shim and p.parts[:1] == ("examples",) and p.name != "index.md":
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
    """Rewrite paths into known repo trees outside `docs/` OR repo-root files."""
    if any(resolved.startswith(tree) for tree in _REPO_TREES):
        return True
    if resolved in _REPO_ROOT_FILES:
        return True
    return False


def on_page_markdown(markdown: str, page, config, files):  # noqa: ANN001 (mkdocs API)
    src_path = page.file.src_path.replace("\\", "/")

    # A page under docs/examples/ is only an include-markdown shim when it
    # actually pulls a sibling README via the include-markdown plugin.
    # Standalone docs that live there (e.g. NASA API-first end-to-end) must
    # resolve relative links from their own docs/ location instead.
    is_include_shim = "{% include-markdown" in markdown or "{%- include-markdown" in markdown

    def _sub(match: re.Match[str]) -> str:
        text, target, anchor = match.group(1), match.group(2), match.group(3) or ""
        resolved = _resolve_against_source(target, src_path, is_include_shim)
        if not resolved or not _should_rewrite(resolved):
            return match.group(0)
        return f"{text}({REPO_BLOB}/{resolved}{anchor})"

    return _LINK_RE.sub(_sub, markdown)
