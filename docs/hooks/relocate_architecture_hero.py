"""mkdocs hook: promote `.architecture-hero` images to a full-grid page hero.

Pages across the site embed a hero image inline:

    ![alt](path/to/hero.svg){ .architecture-hero loading="eager" }

…optionally wrapped in a link::

    [![alt](path/to/hero.svg){ .architecture-hero }](TARGET.md "title")

Users want that hero to render as a banner that spans the FULL grid
width (left sidebar edge to right TOC edge) sitting between the top
navigation tabs and the main grid. The article's own content column is
too narrow for a banner role.

Implementation
--------------

This hook runs on the merged markdown (after include-markdown shims
expand). For the first `.architecture-hero` image found it:

1. Parses ``src``, ``alt``, and the optional surrounding link.
2. Stashes a dict on ``page.meta["page_hero"]``::

       {"src": "path/to/hero.svg", "alt": "...", "link": "TARGET.md" | None}

3. Removes the inline image line from the markdown so the article body
   does not double-render the hero.

The companion Material theme override at ``overrides/main.html`` reads
``page.meta.page_hero`` and renders the banner in the Material ``hero``
template block — which lives inside ``.md-container`` but outside
``.md-main__inner``, giving the banner full grid width.

Pages without a hero are returned unchanged.
"""

from __future__ import annotations

import posixpath
import re

# A markdown line containing an architecture-hero image. We accept the
# image either bare or wrapped in a link, with anchor text matching:
#
#   ![alt](src){ ... .architecture-hero ... }
#   [![alt](src){ ... .architecture-hero ... }](LINK "title")
#
# The regex captures the full line so callers can excise it cleanly.
_HERO_LINE_RE = re.compile(
    r"^.*!\[[^\]]*\]\([^)]+\)\{[^}]*\barchitecture-hero\b[^}]*\}.*$",
    re.MULTILINE,
)

# Inner extraction of src + alt from the image. Run on the captured
# line so we don't have to worry about line boundaries.
_HERO_IMG_RE = re.compile(
    r"!\[(?P<alt>[^\]]*)\]\((?P<src>[^)]+)\)\{[^}]*\barchitecture-hero\b[^}]*\}",
)

# Detect the link wrapper that puts the hero inside `[ ... ](TARGET)`.
# We tolerate an optional `"title"` after the target. The link target
# itself stops at whitespace or `)` so titles do not bleed in.
_HERO_LINK_RE = re.compile(
    r"\[!\[[^\]]*\]\([^)]+\)\{[^}]*\barchitecture-hero\b[^}]*\}\]"
    r"\((?P<link>[^\s)]+)(?:\s+\"[^\"]*\")?\)",
)


def _resolve_to_docs_root(src: str, page_src_path: str) -> str:
    """Convert a markdown image ``src`` to a docs-root-relative path.

    Markdown image paths are written relative to the source ``.md``
    file's directory. mkdocs's body-renderer rewrites them to be valid
    against the rendered page URL, but our hook bypasses that — we
    extract the raw src and hand it to the Material override template.
    The template will prepend ``base_url`` (which is relative to the
    rendered page's URL), so the path we hand it must be relative to
    the docs root.

    Examples (with ``page_src_path`` shown after each src):

    * ``assets/x.svg`` from ``index.md``                      -> ``assets/x.svg``
    * ``assets/x.svg`` from ``GETTING_STARTED.md``            -> ``assets/x.svg``
    * ``../../assets/x.png`` from ``tutorials/01-foo/README.md`` -> ``assets/x.png``

    Absolute paths and absolute URLs pass through unchanged.
    """
    if not src:
        return src
    # Absolute (web) URL — let it through.
    if src.startswith(("http://", "https://", "data:")):
        return src
    # Already root-relative (single leading slash). Strip the leading
    # slash so the template's ``base_url + "/" + src`` doesn't double-up.
    if src.startswith("/"):
        return src.lstrip("/")
    # page_src_path is repo-relative under docs/ — already without the
    # ``docs/`` prefix. e.g. ``tutorials/01-foundation-platform/README.md``.
    # Use posixpath.normpath so back-references resolve uniformly across
    # platforms (mkdocs always emits forward slashes for src_path).
    page_dir = posixpath.dirname(page_src_path.replace("\\", "/"))
    if page_dir:
        joined = posixpath.normpath(posixpath.join(page_dir, src))
    else:
        joined = posixpath.normpath(src)
    # If the resolved path tries to escape above docs root, fall back
    # to the original src and let mkdocs's link-checker complain.
    if joined.startswith("..") or joined == ".":
        return src
    return joined


def on_page_markdown(markdown: str, page, config, files):  # noqa: ANN001 (mkdocs API)
    hero_line_match = _HERO_LINE_RE.search(markdown)
    if not hero_line_match:
        return markdown

    line = hero_line_match.group(0)

    img_match = _HERO_IMG_RE.search(line)
    if not img_match:
        return markdown

    alt = img_match.group("alt")
    src = img_match.group("src")

    link_match = _HERO_LINK_RE.search(line)
    link = link_match.group("link") if link_match else None

    # Resolve the markdown-relative src to a docs-root-relative path
    # so the template can prepend `base_url` and produce a working
    # link from any page URL depth.
    page_src_path = getattr(getattr(page, "file", None), "src_path", "") or ""
    resolved_src = _resolve_to_docs_root(src, page_src_path)

    # Stash on page.meta so the Material override template can find it.
    if page.meta is None:  # pragma: no cover - defensive
        page.meta = {}
    page.meta["page_hero"] = {"src": resolved_src, "alt": alt, "link": link}

    # Excise the inline hero from the article body so it does not
    # render below the H1 — the override template now renders it.
    start, end = hero_line_match.span()
    rest = markdown[:start] + markdown[end:]

    # Collapse the blank-line gap left behind so the article body is
    # tight. Two consecutive newlines remain (paragraph break).
    rest = re.sub(r"\n{3,}", "\n\n", rest, count=1)
    return rest
