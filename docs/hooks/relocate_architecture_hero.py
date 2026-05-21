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

    # Stash on page.meta so the Material override template can find it.
    # `page.meta` is a regular dict on mkdocs Page objects; create the
    # key if absent rather than replacing the whole dict.
    if page.meta is None:  # pragma: no cover - defensive
        page.meta = {}
    page.meta["page_hero"] = {"src": src, "alt": alt, "link": link}

    # Excise the inline hero from the article body so it does not
    # render below the H1 — the override template now renders it.
    start, end = hero_line_match.span()
    rest = markdown[:start] + markdown[end:]

    # Collapse the blank-line gap left behind so the article body is
    # tight. Two consecutive newlines remain (paragraph break).
    rest = re.sub(r"\n{3,}", "\n\n", rest, count=1)
    return rest
