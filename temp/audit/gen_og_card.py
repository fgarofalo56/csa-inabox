"""Generate docs/assets/images/og-card.png from the homepage hero SVG.

The OG card needs the Twitter / LinkedIn "large image summary" aspect
of 1200×630. Our homepage hero SVG is 1600×420 (3.8:1 wide). We
rasterize the hero at 1200 wide → ~315 tall, then composite it on a
1200×630 navy canvas so the social-share preview reads as a banner
with brand backdrop above + below.

Uses headless Playwright to rasterize the SVG (no cairo binary
dependency) plus Pillow for the canvas composition.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HERO_SVG = ROOT / "docs" / "assets" / "images" / "architecture-hero.svg"
OUT_PNG = ROOT / "docs" / "assets" / "images" / "og-card.png"

# Twitter large-image-summary card aspect
W, H = 1200, 630
HERO_W, HERO_H = 1200, 315  # 1200 * 420/1600


def rasterize_svg(svg_path: Path, width: int, height: int) -> Image.Image:
    """Render an SVG to a Pillow image via headless Chromium."""
    svg = svg_path.read_text(encoding="utf-8")
    html = (
        "<!doctype html><html><head><style>"
        f"html,body{{margin:0;padding:0;width:{width}px;height:{height}px;background:transparent;}}"
        "svg{display:block;width:100%;height:100%;}"
        "</style></head><body>" + svg + "</body></html>"
    )
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": width, "height": height})
        page = ctx.new_page()
        page.set_content(html)
        page.wait_for_load_state("networkidle")
        png_bytes = page.screenshot(omit_background=True, full_page=False)
        browser.close()
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def main() -> None:
    hero = rasterize_svg(HERO_SVG, HERO_W, HERO_H)
    canvas = Image.new("RGB", (W, H), color=(10, 17, 38))  # CSA navy #0A1126
    y_offset = (H - HERO_H) // 2
    canvas.paste(hero, (0, y_offset), hero)
    canvas.save(OUT_PNG, "PNG", optimize=True)
    print(f"Wrote {OUT_PNG} ({OUT_PNG.stat().st_size:,} bytes, {canvas.size})")


if __name__ == "__main__":
    main()
