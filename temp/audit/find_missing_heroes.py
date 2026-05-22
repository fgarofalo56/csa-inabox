"""Crawl the live site's sitemap and find every page that doesn't have a
hero. Group by top-level directory so we can decide which directories
deserve a new section default.

Output (printed):
  - Total pages
  - Pages missing hero by top-level directory (path -> count)
  - Sample of missing pages per directory (first 3 each)
  - Directories not currently in the _SECTION_DEFAULTS map
"""
from __future__ import annotations

import re
import sys
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SITE = "https://fgarofalo56.github.io/csa-inabox"
SITEMAP = f"{SITE}/sitemap.xml"

# Read the current section defaults from the hook so we know which
# directories are already covered.
HOOK = Path(__file__).resolve().parents[2] / "docs/hooks/relocate_architecture_hero.py"
hook_src = HOOK.read_text(encoding="utf-8")
covered_dirs = set(re.findall(r'"([a-z\-_]+)": \(\s*\n\s*"assets/images/hero/', hook_src))
print(f"Hook already covers these top-level dirs: {sorted(covered_dirs)}")


def fetch(url: str) -> tuple[str, bool]:
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        has_hero = 'class="page-hero-region"' in html or 'class="page-hero-image"' in html
        return url, has_hero
    except Exception:
        return url, False


def main() -> None:
    print("Fetching sitemap...")
    with urllib.request.urlopen(SITEMAP) as r:
        sitemap = r.read().decode("utf-8", errors="ignore")
    urls = re.findall(r"<loc>([^<]+)</loc>", sitemap)
    print(f"Sitemap has {len(urls)} URLs")

    # Filter to just the docs site (drop any external)
    urls = [u for u in urls if u.startswith(SITE)]

    # Limit to a sampling for speed if --full not passed
    if "--full" not in sys.argv:
        # We need this to be exhaustive — fetch all
        pass

    print(f"Fetching {len(urls)} pages with 16 parallel workers...")
    no_hero: list[str] = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch, u): u for u in urls}
        for i, fut in enumerate(as_completed(futures), 1):
            url, has_hero = fut.result()
            if not has_hero:
                no_hero.append(url)
            if i % 100 == 0:
                print(f"  ... {i}/{len(urls)}")

    print(f"\n=== {len(no_hero)} pages missing hero (of {len(urls)} total) ===")

    # Group by top-level path
    by_dir: dict[str, list[str]] = defaultdict(list)
    for url in no_hero:
        path = url.removeprefix(SITE + "/").rstrip("/")
        top = path.split("/", 1)[0] if "/" in path else (path or "<root>")
        by_dir[top].append(path)

    # Print summary
    print("\n--- by top-level directory (sorted by count, desc) ---")
    for top, paths in sorted(by_dir.items(), key=lambda x: -len(x[1])):
        marker = " (already in hook)" if top in covered_dirs else ""
        print(f"\n  {top}: {len(paths)} pages{marker}")
        for p in paths[:3]:
            print(f"    - {p}")
        if len(paths) > 3:
            print(f"    ... and {len(paths) - 3} more")

    # Directories that DON'T have a section default and have ≥ 1 hero-less page
    gaps = sorted({top for top in by_dir if top not in covered_dirs and top != "<root>"})
    print(f"\n=== {len(gaps)} top-level dirs NOT covered by the hook ===")
    for g in gaps:
        print(f"  - {g} ({len(by_dir[g])} pages)")


if __name__ == "__main__":
    main()
