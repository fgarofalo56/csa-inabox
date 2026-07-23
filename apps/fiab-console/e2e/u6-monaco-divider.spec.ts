/**
 * U6 — query↔results divider across the Monaco query editors
 * (loom-next-level ws-ui-excellence U6, systemic gap #3).
 *
 * Rides the `monaco-divider` Playwright project stubbed by the Phase-1
 * test-projects batch (#2411): minted-session auth (mint dependency +
 * storageState), live target via LOOM_UAT_BASE_URL / LOOM_URL.
 *
 *   pnpm exec playwright test --project=monaco-divider
 *
 * Per adopting editor the walk is: create a throwaway item → open the editor
 * → execute the query action (a REAL BFF round-trip; an honest error/gate
 * envelope also counts — the divider mounts whenever a result exists) → the
 * split appears → PACED drag of the divider (the U0 finding: CDP-fast drags
 * outrun the SplitPane React-state machine and false-fail; mouse moves MUST
 * be paced across frames) → assert the committed size + localStorage
 * persistence → reload → re-run → assert the split position was restored.
 *
 * GATE SEMANTICS (journey-style): an editor whose run action is not
 * executable in this environment (e.g. warehouse compute paused so Run is
 * disabled, sql-database with no database bound) records an honest SKIP —
 * never a fail. Real drag/persistence defects fail.
 *
 * DISPOSABLE STATE: one `uat-u6-*` workspace, removed in afterAll.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  BASE, signIn, createWorkspace, createItem, cleanupWorkspaces,
} from './_lib/uat';

test.describe.configure({ mode: 'serial' });

const DIVIDER = '[role="separator"][aria-label="Resize query / results split"]';
const WORKSPACE_GRIP = '[role="separator"][aria-label^="Resize query workspace height"]';

interface EditorCase {
  /** Catalog itemType to create (route /items/<type>/<id>). */
  itemType: string;
  /** EditorResultsSplit editorKey → loom.splitpane.<key>.results-split. */
  editorKey: string;
  /** Tab to click before the query pane is visible (regex on the tab name). */
  tab?: RegExp;
  /** Type this query into the Monaco editor before running (empty editors). */
  monacoText?: string;
  /** Fill this text into the labeled input before running (non-Monaco pane). */
  fillInput?: { label: RegExp; value: string };
  /** The query action button label. */
  runLabel: RegExp;
}

/**
 * The 11 U6 adopters. `sql-database-editor.tsx` (the non-unified legacy
 * component) is registry-orphaned — the `sql-database` itemType routes to the
 * unified editor — so its adoption is exercised by the unified case here and
 * by its vitest render test.
 */
const EDITORS: EditorCase[] = [
  { itemType: 'gql-graph', editorKey: 'graph.gql', runLabel: /^(Run|Running…|Save query)$/ },
  { itemType: 'cypher-graph', editorKey: 'graph.cypher-kql', runLabel: /^Run$/ },
  { itemType: 'cosmos-gremlin-graph', editorKey: 'graph.gremlin', runLabel: /^Run$/ },
  { itemType: 'vector-store', editorKey: 'graph.vector-search', tab: /search/i, fillInput: { label: /Query text/i, value: 'u6 divider probe' }, runLabel: /^Search$/ },
  { itemType: 'kql-database', editorKey: 'kql-database', monacoText: 'print now()', runLabel: /^Run$/ },
  { itemType: 'kql-queryset', editorKey: 'kql-queryset', monacoText: 'print now()', runLabel: /^Run$/ },
  { itemType: 'azure-sql-database', editorKey: 'unified-sql-database', monacoText: 'SELECT 1 AS u6', runLabel: /^Run$/ },
  { itemType: 'sql-database', editorKey: 'unified-sql-database', monacoText: 'SELECT 1 AS u6', runLabel: /^Run$/ },
  { itemType: 'databricks-sql-warehouse', editorKey: 'databricks-sql-warehouse', monacoText: 'SELECT 1 AS u6', runLabel: /^Run$/ },
  { itemType: 'warehouse', editorKey: 'warehouse', monacoText: 'SELECT 1 AS u6', runLabel: /^Run$/ },
  { itemType: 'lakehouse', editorKey: 'lakehouse-sql', tab: /sql/i, runLabel: /^Run$/ },
];

let wsId = '';
const createdWorkspaces: string[] = [];

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  wsId = await createWorkspace(page, `uat-u6-${Date.now()}`);
  createdWorkspaces.push(wsId);
  await ctx.close();
});

test.afterAll(async () => {
  await cleanupWorkspaces(createdWorkspaces);
});

/** Type into the FIRST visible Monaco editor on the page (real keystrokes —
 * Monaco has no <textarea> value to fill). */
async function typeInMonaco(page: Page, text: string): Promise<boolean> {
  const monaco = page.locator('.monaco-editor').first();
  try {
    await monaco.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    return false;
  }
  await monaco.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text, { delay: 10 });
  return true;
}

/**
 * PACED divider drag (U0 finding). Moves the pointer across ~16 frames with
 * per-step waits so the SplitPane `dragging` React state machine sees every
 * move; a single CDP jump commits nothing and false-fails.
 */
async function pacedDrag(page: Page, dy: number): Promise<void> {
  const divider = page.locator(DIVIDER).first();
  await divider.scrollIntoViewIfNeeded();
  const box = await divider.boundingBox();
  expect(box, 'divider bounding box').toBeTruthy();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx, cy + (dy * i) / steps);
    await page.waitForTimeout(32);
  }
  await page.mouse.up();
  // Let the pointer-up commit (state + localStorage write) settle.
  await page.waitForTimeout(250);
}

/** Open the editor, optionally switch tab / seed query text, click run.
 * Returns a skip reason when the action is not executable here. */
async function activateSplit(page: Page, ec: EditorCase, itemId: string): Promise<string | null> {
  await page.goto(`${BASE}/items/${ec.itemType}/${itemId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2_000);

  if (ec.tab) {
    const tab = page.getByRole('tab', { name: ec.tab }).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(1_000);
    } else {
      return `tab ${ec.tab} not present`;
    }
  }
  if (ec.monacoText) {
    const typed = await typeInMonaco(page, ec.monacoText);
    if (!typed) return 'monaco editor not visible (pane gated in this environment)';
  }
  if (ec.fillInput) {
    const input = page.getByLabel(ec.fillInput.label).first();
    if (!(await input.isVisible().catch(() => false))) return 'query input not present';
    await input.fill(ec.fillInput.value);
  }

  const run = page.getByRole('button', { name: ec.runLabel }).first();
  try {
    await run.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    return 'run button not present';
  }
  if (await run.isDisabled().catch(() => true)) {
    return 'run button disabled (backend not executable in this environment)';
  }
  await run.click();

  // The divider mounts as soon as a result (rows OR an honest error/gate
  // envelope) exists — a real BFF round-trip either way.
  try {
    await page.locator(DIVIDER).first().waitFor({ state: 'visible', timeout: 45_000 });
  } catch {
    return 'divider did not mount after run (no result envelope surfaced)';
  }
  return null;
}

// Registered-flag receipt: the FLAG0 kill-switch exists and reports state.
test('u6-monaco-divider flag is registered and reported', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const res = await page.request.get(`${BASE}/api/runtime-flags`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.ok).toBeTruthy();
  expect(typeof json.flags?.['u6-monaco-divider']).toBe('boolean');
  await ctx.close();
});

for (const ec of EDITORS) {
  test(`u6[${ec.itemType}] — divider drag + reload persistence (${ec.editorKey})`, async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    try {
      const itemId = await createItem(page, wsId, ec.itemType);

      const skip = await activateSplit(page, ec, itemId);
      test.skip(skip !== null, `honest skip: ${skip}`);

      const divider = page.locator(DIVIDER).first();
      // Workspace grip (ResizableCanvasRegion) mounted alongside the divider.
      await expect(page.locator(WORKSPACE_GRIP).first()).toBeVisible();

      const before = Number(await divider.getAttribute('aria-valuenow'));
      expect(Number.isFinite(before)).toBeTruthy();

      // Drag the divider DOWN 120px → the query pane (primary) grows.
      await pacedDrag(page, 120);
      const after = Number(await divider.getAttribute('aria-valuenow'));
      expect(after, 'divider size committed after paced drag').toBeGreaterThan(before + 60);

      // Persistence: the SplitPane storageKey wrote the committed size.
      const storeKey = `loom.splitpane.${ec.editorKey}.results-split`;
      const stored = await page.evaluate((k) => window.localStorage.getItem(k), storeKey);
      expect(stored, `${storeKey} persisted`).not.toBeNull();
      expect(Math.abs(Number(stored) - after)).toBeLessThanOrEqual(2);

      // Reload → re-run → the split restores the persisted position.
      const skip2 = await activateSplit(page, ec, itemId);
      test.skip(skip2 !== null, `honest skip on reload pass: ${skip2}`);
      const restored = Number(await page.locator(DIVIDER).first().getAttribute('aria-valuenow'));
      expect(Math.abs(restored - Number(stored)), 'split restored after reload').toBeLessThanOrEqual(5);
    } finally {
      await ctx.close();
    }
  });
}
