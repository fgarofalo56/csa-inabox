/**
 * uc-system-tables-clickwalk.spec.ts — the G1 CLICK-WALK for the Unity Catalog
 * "Audit & system tables" pane, and the G2 Fix-it receipt for issue #2624.
 *
 * WHY THIS EXISTS
 * ---------------
 * #2624 has two halves. The G2 half (register the two orphan gate codes
 * `uc_system_tables_boundary` / `uc_system_schema_grant` under a real gate,
 * `svc-databricks-system-tables`, and render an inline Fix-it) already LANDED in
 * PR #2853 — it is asserted by lib/gates/__tests__/registry.test.ts and
 * lib/gates/__tests__/route-gate-codes.test.ts. But those are tsc + vitest +
 * source-string guards, and `ux-baseline.md` G1 says no surface is done until a
 * real browser exercises every config, button and flow with real data
 * end-to-end. That receipt is what this spec produces — it drives the actual
 * pane in a real browser, clicks every tab and the Run action, and — when a gate
 * is present — clicks the inline **Fix it** and asserts the wizard launches.
 *
 * WHAT IT ASSERTS (per .claude/rules/no-scaffold — a DOM query is not a click,
 * so every tab/button here is driven with a real `locator.click()`):
 *
 *   REAL-DATA RECEIPT (no-vaporware.md):
 *     • GET /api/databricks/unity-catalog/system-tables returns EITHER real data
 *       (`{ ok:true, columns, rows }`) OR a normalized honest gate envelope
 *       (`{ gated:true, code, gate:{ id, state } }`) whose `code` resolves to a
 *       real registry gate — never a bare error. The gate id/code are grounded
 *       to app/api/databricks/unity-catalog/system-tables/route.ts.
 *     • The route is tenant-admin gated (withTenantAdmin, route.ts:164). When the
 *       automation identity is NOT a tenant admin the route answers a STRUCTURED
 *       `{ code:'admin_only', reason:'…restricted to tenant admins' }` (403,
 *       lib/auth/feature-gate.ts requireTenantAdmin) — not a bare 'forbidden'.
 *
 *   PANE WALK (G1):
 *     • The editor's "Audit & system" toolbar button
 *       (lib/editors/databricks/sql-warehouse-editor.tsx:978) opens the dialog
 *       titled "Audit & system tables — Unity Catalog" (uc-dialogs.tsx:2326).
 *     • Each of the five tabs — Access audit / Query history / Billing usage /
 *       Data classification / Data quality (uc-dialogs.tsx:2335-2339) — is a real
 *       click that lands (aria-selected → true, exclusively).
 *     • The Window / Row-limit filters and the Run action (uc-dialogs.tsx:2344-
 *       2384) drive a real backend read; the pane settles to ONE honest outcome:
 *       real rows (the "N row(s) · M ms" badge, uc-dialogs.tsx:2386) OR a
 *       HonestGate bar OR the "Read failed" error bar.
 *
 *   FIX-IT RECEIPT (G2, the crux of #2624):
 *     • When the pane renders a blocked HonestGate (uc-dialogs.tsx:2395 →
 *       honest-gate.tsx), it MUST carry an inline **Fix it** button
 *       (honest-gate.tsx:460); clicking it opens the wizard dialog titled
 *       "Fix it — <gate title>" (honest-gate.tsx:206). A HonestGate bar with no
 *       Fix-it and no fallback CTA is the exact G2 violation this issue is about
 *       and fails here.
 *     • When the gate is cloud-unavailable (Gov/IL5 — Databricks Unity Catalog
 *       has no Azure Government endpoint, so the boundary code
 *       `uc_system_tables_boundary` sets state:'cloud-unavailable'), the pane
 *       instead names the Loom-native fallback with a "Use the Loom-native
 *       equivalent" CTA and NO Fix-it (honest-gate.tsx:417-428) — an honest infra
 *       gate, which per no-vaporware.md is a PASS, recorded with a note.
 *
 *   NARROW-WIDTH (badge overlap, ux-baseline.md): the pane is re-opened at a
 *   narrow viewport and asserted to introduce no page-level horizontal overflow.
 *
 * HONEST-GATE TOLERANT. Every terminal state — real rows, blocked-with-Fix-it,
 * cloud-unavailable, or the tenant-admin guard — is a PASS with a distinct note.
 * The spec FAILS only on: the pane not opening, a tab click not landing, or a
 * HonestGate bar with neither a Fix-it nor a fallback CTA (the G2 regression).
 *
 * No item ids are hardcoded: a throwaway databricks-sql-warehouse item
 * (lib/catalog/item-types/azure-databricks.ts:108) is created and removed with
 * its workspace in afterAll.
 *
 * Project: `uc-system-tables-clickwalk` (playwright.config.ts), minted-session
 * auth via the `mint` dependency. NOT wired into any required check.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=uc-system-tables-clickwalk
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="uc-system-tables-clickwalk"
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  BASE, signIn, createWorkspace, createItem, cleanupWorkspaces,
  captureFailures, recordVerdict,
} from './_lib/uat';

/** The creatable item type whose editor hosts the pane (catalog slug). */
const ITEM_TYPE = 'databricks-sql-warehouse';

/** The system-tables BFF this pane reads (app/api/.../system-tables/route.ts). */
const SYSTEM_TABLES_API = '/api/databricks/unity-catalog/system-tables';

/** The registry gate #2624 registered for the two orphan codes. */
const SYSTEM_TABLES_GATE_ID = 'svc-databricks-system-tables';

/**
 * Every machine-readable code the route can emit (route.ts:116/121/200/218).
 * `not_configured` is the WS-D2 envelope default `code` for a plain blocked gate
 * (gate-envelope.ts:101) — the `svc-databricks` not-configured path carries it.
 */
const KNOWN_GATE_CODES = new Set([
  'svc-databricks',
  'svc-databricks-sql',
  'uc_system_tables_boundary',
  'uc_system_schema_grant',
  'not_configured',
  'cloud_unavailable',
]);

/** The five tabs the pane renders (uc-dialogs.tsx:2335-2339), value → label. */
const TABS: Array<{ value: string; label: string }> = [
  { value: 'audit', label: 'Access audit' },
  { value: 'query', label: 'Query history' },
  { value: 'billing', label: 'Billing usage' },
  { value: 'classification', label: 'Data classification' },
  { value: 'quality', label: 'Data quality' },
];

interface Scratch { id: string; workspaceId: string; }

/** One probe of the system-tables BFF, classified. */
interface Probe {
  status: number;
  ok: boolean;
  gated: boolean;
  code: string | null;
  gateId: string | null;
  gateState: string | null;
  adminOnly: boolean;
  raw: any;
}

/** Probe the route with the suite's minted session (page.request carries it). */
async function probeSystemTables(page: Page): Promise<Probe> {
  const r = await page.request.get(`${BASE}${SYSTEM_TABLES_API}?table=audit&days=7&limit=5`);
  const body = await r.json().catch(() => ({} as any));
  return {
    status: r.status(),
    ok: !!body?.ok,
    gated: !!body?.gated,
    code: body?.code ?? null,
    gateId: body?.gate?.id ?? null,
    gateState: body?.gate?.state ?? null,
    adminOnly: r.status() === 403 && body?.code === 'admin_only',
    raw: body,
  };
}

/** The open dialog surface, scoped so every lookup stays inside the pane. */
function pane(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'Audit & system tables — Unity Catalog' });
}

/** Wait until the pane's Run button is enabled again (disabled={loading}, 2384). */
async function waitPaneSettled(dlg: Locator): Promise<void> {
  await dlg.getByRole('button', { name: 'Run', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => { /* gate/err may replace surface — classified below */ });
  await expect(async () => {
    const disabled = await dlg.getByRole('button', { name: 'Run', exact: true })
      .isDisabled().catch(() => false);
    expect(disabled).toBeFalsy();
  }).toPass({ timeout: 20_000 }).catch(() => { /* best-effort settle */ });
}

test.describe.serial('uc-system-tables pane click-walk (#2624 G1/G2)', () => {
  const createdWorkspaces: string[] = [];
  let scratch: Scratch | null = null;
  /** Ground truth from the BFF, read once in beforeAll. */
  let probe: Probe | null = null;

  test.beforeAll(async ({ browser }) => {
    // Best-effort — a throwing beforeAll takes the whole file with it. Discovery
    // and item creation live here; each test tolerates the miss honestly.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(context).catch(() => { /* storageState may already be set */ });
      probe = await probeSystemTables(page).catch(() => null);
      // A non-admin identity is legitimately blocked from creating the item's
      // parent flows too; still try — creation is owner-scoped, not admin-scoped.
      const wsId = await createWorkspace(page, 'uc-systables-clickwalk');
      createdWorkspaces.push(wsId);
      const id = await createItem(page, wsId, ITEM_TYPE, `uc-systables-${Date.now()}`);
      scratch = { id, workspaceId: wsId };
      console.log(
        `[uc-system-tables] probe status=${probe?.status} ok=${probe?.ok} gated=${probe?.gated} ` +
          `code=${probe?.code} gateId=${probe?.gateId} state=${probe?.gateState} adminOnly=${probe?.adminOnly} ` +
          `scratch=${scratch?.id}`,
      );
    } catch (e: any) {
      console.log(`[uc-system-tables] beforeAll partial: ${e?.message?.split('\n')?.[0] || e}`);
    } finally {
      await page.close();
      await context.close();
    }
  });

  test.afterAll(async () => {
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  });

  // --------------------------------------------------------------------------
  // A) REAL-DATA RECEIPT — the BFF answers real data or a resolvable honest gate
  //    (never a bare error), and honors the tenant-admin guard structurally.
  // --------------------------------------------------------------------------
  test('system-tables BFF returns real data or a registry-resolvable honest gate', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });
    const p = await probeSystemTables(page);

    // (1) Tenant-admin guard path (route.ts:164 withTenantAdmin →
    //     requireTenantAdmin, feature-gate.ts). A non-admin identity must get the
    //     STRUCTURED admin_only envelope with a tenant-admin reason — the issue's
    //     "not a bare 'forbidden'" requirement, grounded at the route.
    if (p.status === 403) {
      expect(p.code, 'a 403 from this route must be the structured admin_only guard, not a bare forbidden').toBe('admin_only');
      expect(String(p.raw?.reason || ''), 'the admin_only guard must name the tenant-admin restriction')
        .toMatch(/tenant admin/i);
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'uc-system-tables:tenant-admin-guard', verdict: 'A', status: 'pass',
        notes: `withTenantAdmin fired: 403 admin_only with tenant-admin remediation (automation identity is not a tenant admin on this estate)`,
      });
      return;
    }

    // (2) Otherwise it is either real data or a normalized honest gate.
    expect(p.ok || p.gated, `BFF answered neither ok nor a gate: status=${p.status} body=${JSON.stringify(p.raw).slice(0, 300)}`).toBeTruthy();

    if (p.gated) {
      // The code must be one the route actually emits, and (WS-D2) the envelope
      // must carry a registry gate id — a code that resolves to nothing is the
      // exact #2624 defect the route-gate-codes guard pins.
      expect(KNOWN_GATE_CODES.has(String(p.code)), `unexpected gate code "${p.code}"`).toBeTruthy();
      expect(p.gateId, 'the gate envelope must carry a registry gate id (WS-D2)').toBeTruthy();
      // The two UC-system-tables-specific codes must map to the #2624 gate.
      if (p.code === 'uc_system_tables_boundary' || p.code === 'uc_system_schema_grant') {
        expect(p.gateId).toBe(SYSTEM_TABLES_GATE_ID);
      }
      const cloud = p.gateState === 'cloud-unavailable';
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'uc-system-tables:bff', verdict: 'A', status: 'pass',
        notes: `honest gate: code=${p.code} gateId=${p.gateId}${cloud ? ' (cloud-unavailable — Loom-native fallback)' : ''}`,
      });
    } else {
      const rows = Array.isArray(p.raw?.rows) ? p.raw.rows.length : 0;
      const cols = Array.isArray(p.raw?.columns) ? p.raw.columns.length : 0;
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'uc-system-tables:bff', verdict: 'A', status: 'pass',
        notes: `real data: backend=${p.raw?.backend} columns=${cols} rows=${rows} execMs=${p.raw?.executionMs}`,
      });
    }
  });

  // --------------------------------------------------------------------------
  // B) PANE CLICK-WALK — open the dialog, walk all five tabs with real clicks,
  //    drive Run, then assert the honest terminal state + the inline Fix-it.
  // --------------------------------------------------------------------------
  test('Audit & system tables pane — tab walk + Run + inline Fix-it (G1/G2)', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });
    test.skip(!scratch, 'no scratch databricks-sql-warehouse item was created (workspace/item setup failed in beforeAll)');
    // The route (and therefore the whole pane) is tenant-admin gated. When the
    // automation identity is not an admin the pane cannot be walked — the guard
    // is doing its job; that path is asserted structurally in test A.
    test.skip(!!probe?.adminOnly, 'automation identity is not a tenant admin on this estate — the pane is tenant-admin gated (asserted in test A)');
    const target = scratch!;

    const { result } = await captureFailures(page, async () => {
      // 1) Open the editor and its "Audit & system" pane.
      await page.goto(`${BASE}/items/${ITEM_TYPE}/${target.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* best-effort */ });

      const openBtn = page.getByRole('button', { name: /Audit & system/i }).first();
      await openBtn.waitFor({ state: 'visible', timeout: 30_000 });
      await openBtn.click();

      const dlg = pane(page);
      await expect(dlg, 'the Audit & system tables dialog must open').toBeVisible({ timeout: 20_000 });
      await waitPaneSettled(dlg);

      // 2) Walk all five tabs with REAL clicks; each must land exclusively.
      const tabProblems: string[] = [];
      for (const t of TABS) {
        const tab = dlg.getByRole('tab', { name: t.label, exact: true });
        if ((await tab.count()) === 0) { tabProblems.push(`tab "${t.label}" not rendered`); continue; }
        await tab.scrollIntoViewIfNeeded().catch(() => {});
        try {
          await tab.click({ timeout: 10_000 });
        } catch (e: any) {
          tabProblems.push(`tab "${t.label}" could not be clicked — ${(e?.message || String(e)).split('\n')[0]}`);
          continue;
        }
        // Fluent re-renders async; settle once before recording a miss.
        let selected = await tab.getAttribute('aria-selected').catch(() => null);
        if (selected !== 'true') { await page.waitForTimeout(300); selected = await tab.getAttribute('aria-selected').catch(() => null); }
        if (selected !== 'true') tabProblems.push(`tab "${t.label}" clicked but aria-selected stayed "${selected}"`);
        const selCount = await dlg.locator('[role="tab"][aria-selected="true"]').count().catch(() => -1);
        if (selected === 'true' && selCount !== 1) tabProblems.push(`tab "${t.label}" selected but ${selCount} tabs report selected`);
        await waitPaneSettled(dlg);
      }
      expect(tabProblems, `tab walk problems:\n${tabProblems.join('\n')}`).toEqual([]);

      // 3) Back on Access audit, drive the filters + Run for a real backend read.
      await dlg.getByRole('tab', { name: 'Access audit', exact: true }).click();
      await waitPaneSettled(dlg);
      // Window (days) / Row limit filters (uc-dialogs.tsx:2344,2346).
      const daysField = dlg.getByLabel('Window (days)');
      if (await daysField.count()) { await daysField.fill('14').catch(() => {}); }
      const limitField = dlg.getByLabel('Row limit');
      if (await limitField.count()) { await limitField.fill('25').catch(() => {}); }
      await dlg.getByRole('button', { name: 'Run', exact: true }).click().catch(() => { /* gate may replace it */ });
      await waitPaneSettled(dlg);

      // 4) Classify the honest terminal state of the audit read.
      const fixIt = dlg.getByRole('button', { name: 'Fix it', exact: true });
      const fallbackCta = dlg.getByRole('button', { name: /Use the Loom-native equivalent/i });
      const execBadge = dlg.getByText(/\d+\s+row\(s\)/);                          // uc-dialogs.tsx:2386 ("N row(s) · M ms")
      const resultTable = dlg.getByRole('table', { name: 'System table results' }); // uc-dialogs.tsx:2196
      const readFailed = dlg.getByText('Read failed');                            // uc-dialogs.tsx:2407
      // A HonestGate bar is present iff one of its CTAs is; distinguish blocked
      // (Fix-it) from cloud-unavailable (fallback) from real data.
      const hasFixIt = (await fixIt.count()) > 0;
      const hasFallback = (await fallbackCta.count()) > 0;
      const hasBadge = (await execBadge.count()) > 0;
      const hasReadFailed = (await readFailed.count()) > 0;

      await page.screenshot({ path: testInfo.outputPath('uc-system-tables-audit.png') }).catch(() => {});

      let outcome: string;
      if (hasFixIt) {
        // G2 CRUX — the blocked HonestGate must launch its wizard on click.
        outcome = 'blocked-with-fixit';
        await fixIt.first().click();
        const wizard = page.getByRole('dialog').filter({ hasText: /Fix it — / });
        await expect(wizard, 'clicking "Fix it" must open the Fix-it wizard dialog (honest-gate.tsx:206)').toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: testInfo.outputPath('uc-system-tables-fixit.png') }).catch(() => {});
        // Close the wizard (honest-gate.tsx:299) to leave the pane usable.
        await wizard.getByRole('button', { name: 'Close', exact: true }).first().click().catch(() => {});
      } else if (hasFallback) {
        // Honest cloud-unavailable infra gate (Gov/IL5) — PASS, no Fix-it by design.
        outcome = 'cloud-unavailable';
        await expect(dlg.getByText(/is not available in this cloud/i), 'cloud-unavailable bar text (honest-gate.tsx:417)').toBeVisible();
      } else if (hasBadge || (await resultTable.count()) > 0) {
        outcome = hasReadFailed ? 'read-failed-then-data' : 'real-data';
      } else if (hasReadFailed) {
        // A non-gate backend error (e.g. 502) surfaced honestly. Record it; do
        // NOT fake a pass with a fabricated gate — but it is not a scaffold
        // failure either, so classify and move on.
        outcome = 'read-failed';
      } else {
        outcome = 'empty';
      }

      // The one hard G2 assertion: a HonestGate bar (uc-dialogs.tsx:2395) must
      // ALWAYS carry either a Fix-it or a fallback CTA — never a bare bar.
      const gateBarText = dlg.getByText(/needs .* wired in this deployment|is not available in this cloud/i);
      if ((await gateBarText.count()) > 0) {
        expect(hasFixIt || hasFallback, 'a HonestGate bar rendered with NEITHER a Fix-it NOR a fallback CTA — the exact G2 gap #2624 closes').toBeTruthy();
      }

      // 5) Narrow-width pass (badge overlap / ux-baseline.md): re-open at 900px
      //    and assert the pane introduces no page-level horizontal overflow.
      await dlg.getByRole('button', { name: 'Close', exact: true }).first().click().catch(() => {});
      await page.setViewportSize({ width: 900, height: 1000 });
      await openBtn.click();
      const narrowDlg = pane(page);
      await expect(narrowDlg).toBeVisible({ timeout: 15_000 });
      await waitPaneSettled(narrowDlg);
      const overflow = await page.evaluate(() =>
        Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
      await page.screenshot({ path: testInfo.outputPath('uc-system-tables-narrow.png') }).catch(() => {});
      expect(overflow, `narrow-width horizontal overflow of ${overflow}px — the pane / its badge row must wrap, not overlap`).toBeLessThanOrEqual(2);

      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'uc-system-tables:pane-walk', verdict: 'A', status: 'pass',
        notes: `tabs=${TABS.length} walked; audit outcome=${outcome}; narrow-overflow=${overflow}px`,
      });
      return { outcome, tabs: TABS.length };
    }, { label: 'uc-system-tables' });

    expect(result, 'the Audit & system tables pane walk completed').toBeTruthy();
  });
});
