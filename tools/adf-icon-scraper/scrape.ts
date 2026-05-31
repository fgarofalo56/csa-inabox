/**
 * ADF Studio icon scraper
 * =======================
 * Logs into Azure Data Factory Studio (interactive SSO, persistent profile)
 * and extracts every icon used on the visual authoring surfaces into clean,
 * named .svg / .png files for a draw.io / CSA Loom shape library.
 *
 * Surfaces captured:
 *   1. pipeline  — the left "Activities" palette (all groups expanded).
 *   2. dataflow  — Mapping Data Flow transformation icons (the "+" menu +
 *                  canvas/schema glyphs).
 *   3. wrangle   — Power Query / Data Wrangling step icons (if present).
 *
 * Extraction handles all four ways ADF ships icons (they coexist):
 *   a) inline <svg> nodes        → serialize outerHTML
 *   b) <img src=*.svg|*.png>     → fetch bytes via the page request context
 *   c) CSS background-image url  → resolve + fetch
 *   d) network image responses   → response listener pools every image/svg+xml
 *      or UI-asset png; catches sprite/atlas + lazy-loaded assets.
 *
 * Auth: NEVER hardcodes secrets. Uses chromium.launchPersistentContext against
 * ./.adf-profile so you sign in once by hand (SSO + MFA), pick the factory in
 * the UI, then press Enter in the terminal to resume. Reruns reuse the session.
 *
 * Usage:
 *   npm install
 *   npm run scrape                 # full extraction
 *   npm run scrape -- --dry-run    # log what WOULD be saved, write nothing
 *   npm run scrape -- --inspect    # after login, dump live DOM structure to
 *                                  #   ./icons/_inspect/*.json to refine selectors
 *   ADF_URL=https://adf.azure.com/en/authoring?factory=/subscriptions/.../myfactory npm run scrape
 *
 * Constraints: TypeScript + Playwright + node builtins only. Idempotent.
 */

import { chromium, type BrowserContext, type Page, type Response } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Config + CLI flags
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ADF_URL = process.env.ADF_URL || 'https://adf.azure.com';
const PROFILE_DIR = join(__dirname, '.adf-profile');
const OUT_DIR = join(__dirname, 'icons');

const DRY_RUN = process.argv.includes('--dry-run');
const INSPECT = process.argv.includes('--inspect');

type Surface = 'pipeline' | 'dataflow' | 'wrangle';
type IconSource = 'inline' | 'img' | 'background' | 'network';

interface ManifestEntry {
  surface: Surface;
  label: string;
  slug: string;
  file: string;
  sha256: string;
  source: IconSource;
  ext: 'svg' | 'png';
  aliases: string[];
}

// sha256 → entry, so duplicate bytes collapse to one file with aliases.
const byHash = new Map<string, ManifestEntry>();
// url → bytes, populated by the network response listener (strategy d).
const networkAssets = new Map<string, { bytes: Buffer; contentType: string }>();
const unmatchedNetwork = new Set<string>();
const failures: Array<{ surface: Surface; label: string; reason: string }> = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function log(...a: unknown[]) { console.log(...a); }

function slugify(s: string): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'icon';
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Normalize SVG markup before hashing so trivial whitespace differs don't split dupes. */
function normalizeSvg(svg: string): string {
  return svg.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans); }));
}

function ensureDirs() {
  if (DRY_RUN) return;
  for (const sfx of ['pipeline', 'dataflow', 'wrangle', '_unmatched', '_inspect']) {
    mkdirSync(join(OUT_DIR, sfx), { recursive: true });
  }
}

/**
 * Record an extracted icon. Dedups by content hash; if a new label hits an
 * existing hash, it's added as an alias rather than written twice.
 */
function record(surface: Surface, label: string, bytes: Buffer, ext: 'svg' | 'png', source: IconSource) {
  const hash = sha256(ext === 'svg' ? normalizeSvg(bytes.toString('utf8')) : bytes);
  const existing = byHash.get(hash);
  const slug = slugify(label);
  if (existing) {
    const alias = `${surface}__${slug}`;
    if (existing.file !== `${surface}/${slug}.${ext}` && !existing.aliases.includes(alias)) {
      existing.aliases.push(alias);
    }
    return;
  }
  const file = `${surface}/${slug}.${ext}`;
  const entry: ManifestEntry = { surface, label, slug, file, sha256: hash, source, ext, aliases: [] };
  byHash.set(hash, entry);
  if (!DRY_RUN) writeFileSync(join(OUT_DIR, file), bytes);
  log(`  ${DRY_RUN ? '[dry] ' : ''}+ ${file}  (${source}, ${bytes.length}b)`);
}

// ---------------------------------------------------------------------------
// Network listener (strategy d) — pool every image asset the page loads.
// ---------------------------------------------------------------------------
function attachNetwork(ctx: BrowserContext) {
  ctx.on('response', async (resp: Response) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const url = resp.url();
      const looksImg = ct.includes('image/svg+xml') || ct.includes('image/png')
        || /\.(svg|png)(\?|$)/i.test(url);
      if (!looksImg) return;
      // Skip giant raster assets (screenshots, photos) — UI glyphs are small.
      const buf = await resp.body().catch(() => null);
      if (!buf || buf.length > 256 * 1024) return;
      networkAssets.set(url, { bytes: buf, contentType: ct });
    } catch { /* ignore aborted/streamed responses */ }
  });
}

/** Resolve an asset URL to bytes — prefer the network pool, else fetch via page context. */
async function fetchAsset(page: Page, url: string): Promise<{ bytes: Buffer; ext: 'svg' | 'png' } | null> {
  const pooled = networkAssets.get(url);
  if (pooled) {
    const ext = pooled.contentType.includes('svg') || /\.svg(\?|$)/i.test(url) ? 'svg' : 'png';
    return { bytes: pooled.bytes, ext };
  }
  try {
    const resp = await page.request.get(url);
    if (!resp.ok()) return null;
    const buf = Buffer.from(await resp.body());
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const ext = ct.includes('svg') || /\.svg(\?|$)/i.test(url) ? 'svg' : 'png';
    return { bytes: buf, ext };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// DOM extraction — strategies a/b/c for one "icon item" element.
// Returns the inline svg string or an asset URL to fetch, plus a label.
// Runs in-page so it can read computed styles + serialize SVG.
// ---------------------------------------------------------------------------
interface RawItem {
  label: string;
  inlineSvg?: string;
  assetUrl?: string;
}

/**
 * Collect candidate icon items from a container. Heuristic, role/aria-first so
 * it survives ADF's hashed class names. We look for elements that:
 *   - carry a human label (aria-label | title | visible text), AND
 *   - contain an <svg> or <img>, OR have a background-image.
 * `rootSelector` scopes the search (e.g. the Activities pane); when omitted we
 * scan the whole document (used for menus that portal to the body root).
 */
async function collectItems(page: Page, rootSelector?: string): Promise<RawItem[]> {
  return page.evaluate((rootSel) => {
    const root: ParentNode = rootSel ? (document.querySelector(rootSel) || document) : document;
    const out: Array<{ label: string; inlineSvg?: string; assetUrl?: string }> = [];
    const seen = new Set<Element>();

    const labelOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title');
      if (aria) return aria.trim();
      // Nearest labelled ancestor (palette tiles wrap the glyph + a text span).
      let cur: Element | null = el;
      for (let i = 0; i < 4 && cur; i++) {
        const a = cur.getAttribute?.('aria-label') || cur.getAttribute?.('title');
        if (a) return a.trim();
        cur = cur.parentElement;
      }
      // Fall back to trimmed visible text of the tile.
      const txt = (el.closest('[role="treeitem"],[role="button"],li,div') as HTMLElement | null)?.innerText || '';
      return txt.split('\n').map((t) => t.trim()).find(Boolean) || '';
    };

    // Strategy a: inline svgs.
    root.querySelectorAll('svg').forEach((svg) => {
      // Skip tiny decorative chevrons / the big canvas grid.
      const r = (svg as SVGElement).getBoundingClientRect();
      if (r.width < 8 || r.width > 64 || r.height < 8 || r.height > 64) return;
      const host = svg.closest('[role="treeitem"],[role="button"],[draggable="true"],li') || svg;
      if (seen.has(host)) return;
      seen.add(host);
      out.push({ label: labelOf(svg), inlineSvg: (svg as SVGElement).outerHTML });
    });

    // Strategy b: <img> with svg/png src.
    root.querySelectorAll('img').forEach((img) => {
      const src = (img as HTMLImageElement).src;
      if (!src || !/\.(svg|png)(\?|$)/i.test(src)) return;
      const host = img.closest('[role="treeitem"],[role="button"],[draggable="true"],li') || img;
      if (seen.has(host)) return;
      seen.add(host);
      out.push({ label: labelOf(img), assetUrl: src });
    });

    // Strategy c: background-image url on palette tiles.
    root.querySelectorAll<HTMLElement>('[role="treeitem"],[role="button"],[draggable="true"],li,span,i,div').forEach((el) => {
      if (seen.has(el)) return;
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !/\.(svg|png)(\?|$)/i.test(m[1])) return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.width > 64) return;
      seen.add(el);
      out.push({ label: labelOf(el), assetUrl: new URL(m[1], location.href).href });
    });

    return out;
  }, rootSelector);
}

/** Expand every collapsed group + scroll lazy lists so all items mount. */
async function expandAndScroll(page: Page) {
  // Expand collapsed groups (ADF palette groups use aria-expanded).
  for (let pass = 0; pass < 4; pass++) {
    const toggles = await page.locator('[aria-expanded="false"]').all().catch(() => []);
    if (!toggles.length) break;
    for (const t of toggles) { await t.click({ timeout: 1500 }).catch(() => {}); }
    await page.waitForTimeout(300);
  }
  // Scroll any scrollable panes to bottom to trigger virtualization.
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((el) => {
      const e = el as HTMLElement;
      if (e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 120) e.scrollTop = e.scrollHeight;
    });
  });
  await page.waitForTimeout(500);
}

async function processItems(page: Page, surface: Surface, items: RawItem[]) {
  let n = 0;
  for (const it of items) {
    const label = it.label || `${surface}-unnamed-${n++}`;
    try {
      if (it.inlineSvg) {
        record(surface, label, Buffer.from(it.inlineSvg, 'utf8'), 'svg', 'inline');
      } else if (it.assetUrl) {
        const asset = await fetchAsset(page, it.assetUrl);
        if (!asset) { failures.push({ surface, label, reason: `fetch failed: ${it.assetUrl}` }); continue; }
        record(surface, label, asset.bytes, asset.ext, networkAssets.has(it.assetUrl) ? 'network' : 'img');
      }
    } catch (e) {
      failures.push({ surface, label, reason: String(e) });
    }
  }
}

// ---------------------------------------------------------------------------
// Inspect mode — dump live DOM structure so selectors can be refined by hand.
// ---------------------------------------------------------------------------
async function dumpInspection(page: Page, name: string) {
  const data = await page.evaluate(() => {
    const sample = (sel: string) => Array.from(document.querySelectorAll(sel)).slice(0, 30).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      cls: (el.getAttribute('class') || '').slice(0, 80),
      hasSvg: !!el.querySelector('svg'),
      hasImg: !!el.querySelector('img'),
      text: (el as HTMLElement).innerText?.split('\n')[0]?.slice(0, 40),
    }));
    return {
      treeitems: sample('[role="treeitem"]'),
      buttons: sample('[role="button"]'),
      draggables: sample('[draggable="true"]'),
      listitems: sample('li'),
      svgCount: document.querySelectorAll('svg').length,
      imgCount: document.querySelectorAll('img').length,
    };
  });
  if (!DRY_RUN) writeFileSync(join(OUT_DIR, '_inspect', `${name}.json`), JSON.stringify(data, null, 2));
  log(`[inspect] ${name}: ${data.svgCount} svg, ${data.imgCount} img, ${data.treeitems.length} treeitems, ${data.draggables.length} draggables`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  ensureDirs();
  log(`ADF icon scraper — ${DRY_RUN ? 'DRY RUN' : 'writing to ' + OUT_DIR}${INSPECT ? ' [INSPECT]' : ''}`);
  log(`Profile: ${PROFILE_DIR}`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args: ['--start-maximized'],
  });
  attachNetwork(ctx);
  const page = ctx.pages()[0] || await ctx.newPage();

  log(`\nOpening ${ADF_URL} …`);
  await page.goto(ADF_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // ---- interactive login pause (do NOT automate SSO/MFA) ----
  log('\n┌─────────────────────────────────────────────────────────────┐');
  log('│ Sign in to ADF Studio (SSO + MFA) in the opened browser,     │');
  log('│ then open a data factory and navigate to the AUTHORING view  │');
  log('│ (the pencil "Author" tab on the left rail).                  │');
  log('└─────────────────────────────────────────────────────────────┘');
  await prompt('\nPress Enter here once you are in the Author view of a factory… ');

  // ===================== 1) Pipeline Activities palette =====================
  log('\n[1/3] Pipeline Activities palette');
  try {
    // Create / open a pipeline so the Activities pane renders. Prefer the "+"
    // factory-resources menu → Pipeline; tolerant of label variants.
    await openNewResource(page, ['Pipeline', 'New pipeline']);
    await page.waitForTimeout(1500);
    // The Activities pane is the labelled region on the left of the canvas.
    const paneSel = '[aria-label*="Activities" i], [aria-label*="activity" i]';
    await page.locator(paneSel).first().waitFor({ timeout: 8000 }).catch(() => {});
    await expandAndScroll(page);
    if (INSPECT) await dumpInspection(page, 'pipeline-activities');
    const root = (await page.locator(paneSel).count()) ? paneSel : undefined;
    const items = await collectItems(page, root);
    log(`  found ${items.length} candidate activity icons`);
    await processItems(page, 'pipeline', items);
  } catch (e) {
    log('  ! pipeline capture failed:', String(e));
  }

  // ===================== 2) Mapping Data Flow transforms =====================
  log('\n[2/3] Mapping Data Flow transformations');
  try {
    await openNewResource(page, ['Data flow', 'Dataflow', 'Mapping data flow']);
    await page.waitForTimeout(2000);
    // Add a Source, then open the "+" transform menu it exposes.
    await page.getByText(/add source/i).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    // Click any "+" affordance to reveal the transformation list.
    await page.locator('[aria-label*="add" i], [title*="add" i]').first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (INSPECT) await dumpInspection(page, 'dataflow-transforms');
    // The transform menu portals to the body — scan whole doc.
    const items = await collectItems(page);
    log(`  found ${items.length} candidate transform icons`);
    await processItems(page, 'dataflow', items);
  } catch (e) {
    log('  ! dataflow capture failed:', String(e));
  }

  // ===================== 3) Power Query / Data Wrangling =====================
  log('\n[3/3] Power Query / Data Wrangling');
  try {
    await openNewResource(page, ['Data wrangling', 'Power Query', 'Wrangling data flow']);
    await page.waitForTimeout(2000);
    if (INSPECT) await dumpInspection(page, 'wrangle-steps');
    const items = await collectItems(page);
    log(`  found ${items.length} candidate wrangle icons`);
    await processItems(page, 'wrangle', items);
  } catch (e) {
    log('  ! wrangle capture failed (surface may be unavailable):', String(e));
  }

  // ---- unmatched network assets (no label) ----
  for (const [url, asset] of networkAssets) {
    const hash = sha256(asset.contentType.includes('svg') ? normalizeSvg(asset.bytes.toString('utf8')) : asset.bytes);
    if (byHash.has(hash)) continue; // already captured with a label
    const ext = asset.contentType.includes('svg') || /\.svg(\?|$)/i.test(url) ? 'svg' : 'png';
    const base = slugify((url.split('/').pop() || 'asset').replace(/\.(svg|png).*$/i, ''));
    unmatchedNetwork.add(url);
    if (!DRY_RUN) writeFileSync(join(OUT_DIR, '_unmatched', `${base}.${ext}`), asset.bytes);
  }

  await writeManifest();
  await summary();

  log('\nLeaving the browser open so you can re-navigate. Press Enter to close…');
  await prompt('');
  await ctx.close();
}

/** Open a factory resource via the "+" (Add resource) menu, trying labels. */
async function openNewResource(page: Page, labels: string[]) {
  // The "+" button on the Factory Resources pane.
  const plus = page.locator('[aria-label*="add" i][role="button"], button[aria-label*="add" i]').first();
  await plus.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  for (const label of labels) {
    const item = page.getByText(new RegExp(`^${label}$`, 'i')).first();
    if (await item.count()) { await item.click({ timeout: 3000 }).catch(() => {}); return; }
  }
  // Fallback: loosely match any menu item containing the first label word.
  await page.getByText(new RegExp(labels[0].split(' ')[0], 'i')).first().click({ timeout: 3000 }).catch(() => {});
}

async function writeManifest() {
  const manifest = [...byHash.values()].sort((a, b) => a.file.localeCompare(b.file));
  if (!DRY_RUN) {
    writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(OUT_DIR, 'unmatched.json'), JSON.stringify([...unmatchedNetwork], null, 2));
  }
}

async function summary() {
  const bySurface: Record<string, number> = {};
  for (const e of byHash.values()) bySurface[e.surface] = (bySurface[e.surface] || 0) + 1;
  log('\n──────── summary ────────');
  for (const s of ['pipeline', 'dataflow', 'wrangle']) log(`  ${s.padEnd(10)} ${bySurface[s] || 0} icons`);
  log(`  unmatched  ${unmatchedNetwork.size} network assets (see icons/_unmatched + unmatched.json)`);
  if (failures.length) {
    log(`\n  ${failures.length} failures:`);
    for (const f of failures.slice(0, 20)) log(`   - [${f.surface}] ${f.label}: ${f.reason}`);
  }
  log(`\n  manifest: icons/manifest.json (${byHash.size} unique icons)`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
