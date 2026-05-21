"""mkdocs hook: relocate `.architecture-hero` images to the top of each
page so the hero renders ABOVE the H1 title instead of below it.

Why:
- Heroes were authored inline below the H1 across ~70 pages. Below-title
  placement reads like an in-article illustration, not a page hero.
- Users want heroes to read like a banner: above the H1, content-column
  wide, with the title sitting underneath.

Rather than mass-editing 70 files, this hook moves the FIRST line that
contains `.architecture-hero` to immediately above the FIRST H1 (or to
the very top of the page if no H1 exists). The CSS treatment in
`docs/stylesheets/docs.css` styles `.architecture-hero` as a wide,
top-of-page banner.

Behavior:
- If the hero already appears before the H1 in the source, do nothing.
- Skip pages without a `.architecture-hero` image.
- Skip frontmatter blocks (handled before `on_page_markdown` is called).

This complements `rewrite_example_links.py` — both hooks run on the
merged markdown after include-markdown has expanded shims.
"""

from __future__ import annotations

import re

_H1_RE = re.compile(r"^(#\s+\S.*)$", re.MULTILINE)
_HERO_LINE_RE = re.compile(
    r"^.*!\[[^\]]*\]\([^)]+\)\{[^}]*\barchitecture-hero\b[^}]*\}.*$",
    re.MULTILINE,
)


def on_page_markdown(markdown: str, page, config, files):  # noqa: ANN001 (mkdocs API)
    hero_match = _HERO_LINE_RE.search(markdown)
    if not hero_match:
        return markdown

    h1_match = _H1_RE.search(markdown)
    if not h1_match:
        # No H1 anywhere — hero stays where it is (already at top in
        # include-markdown shim pages, or the page genuinely has no
        # title and we shouldn't speculate).
        return markdown

    # Hero already above H1 — nothing to do.
    if hero_match.start() < h1_match.start():
        return markdown

    hero_line = hero_match.group(0)
    # Remove the hero from its original location, leaving a blank line
    # so paragraph reflow stays clean.
    rest = markdown[: hero_match.start()] + markdown[hero_match.end() :]

    # Re-find the H1 in the modified text (offset may have shifted).
    h1_in_rest = _H1_RE.search(rest)
    if not h1_in_rest:
        # Defensive: H1 was somehow consumed; fall back to leaving hero
        # at the top of the page.
        return f"{hero_line}\n\n{markdown}"

    insert_at = h1_in_rest.start()
    return (
        rest[:insert_at]
        + hero_line
        + "\n\n"
        + rest[insert_at:]
    )
