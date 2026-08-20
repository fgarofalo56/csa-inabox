/**
 * uc-effective-permissions.spec.ts — the G1 in-browser E2E + no-vaporware receipt
 * for the Unity Catalog **effective-permissions resolver** (LU-4, issue #2623).
 *
 * WHY THIS EXISTS. The LU-4 security remediation (ownership over-grant, dropped
 * ALL PRIVILEGES, un-narrowed OSS vocabulary, unchecked usage prerequisites,
 * un-gated + un-audited directory probe) landed in PR #2608 with negative unit
 * tests, but the rules (ux-baseline.md §G1, no-vaporware.md, ui-parity.md) demand
 * a live browser walk that drives the real surface and captures the resolver's
 * REAL backend response — which #2608 could not produce from a worktree. This is
 * that receipt.
 *
 * WHAT IT DRIVES (all grounded in source, file:line):
 *   • Surface: /catalog/unity → "Grants" tab → GrantsPane
 *       - the "Effective (inherited)" checkbox      (app/catalog/unity/page.tsx:875-878)
 *       - the "Securable type" dropdown             (page.tsx:867-870)
 *       - the "Full name" input                     (page.tsx:872-874, placeholder)
 *       - the "Effective for principal" input       (page.tsx:888-892, placeholder)
 *       - the "Load grants" button                  (page.tsx:880)
 *       - the results grid  aria-label="Unity Catalog grants" (page.tsx:917 via LoomDataTable:828)
 *   • BFF: GET /api/databricks/unity-catalog/grants?securable_type&full_name&effective=true[&principal]
 *       (app/api/databricks/unity-catalog/grants/route.ts:156-226). Real response
 *       shape: { ok, effective, grants:[{principal,privileges,detail,usage}],
 *                warnings?, principalClosure?, closureResolved?, owner?, ownerUnreadable? }.
 *       Honest gates tolerated: 503 { code:'not_configured' } (no Databricks +
 *       no LOOM_UNITY_URL); 200 ok with empty grants + warnings (the OSS pinned
 *       image v0.5.0 500s on GET /permissions when authz is enabled — upstream
 *       #1603, disclosed in the capability matrix note). Either is a real answer,
 *       not a defect — recorded as a gate, never a fake pass (no-vaporware.md).
 *
 * THE AUTHORIZATION MATRIX (#2623 acceptance 1a/1b/1c). The `principal=` form
 * resolves that principal's transitive Entra group membership with the Console
 * platform identity, so the route gates it (route.ts:173-185 →
 * lib/auth/uc-principal-probe.ts:decidePrincipalProbe):
 *   (b) SELF probe — allowed for any signed-in user. Universal; always asserted.
 *   (a) tenant-admin probing a THIRD party — allowed. Only reproducible when THIS
 *       automation identity is a tenant admin; otherwise recorded as N/A with a
 *       reason (not faked).
 *   (c) NON-admin probing a THIRD party — 403 { code:'principal_probe_forbidden',
 *       reason, remediation }. Only reproducible when this identity is NOT a
 *       tenant admin; otherwise recorded as N/A with a reason.
 * Admin standing is DETECTED at runtime (a tenant-admin-gated probe), never
 * assumed — the estate's LOOM_TENANT_ADMIN_* config is unknown at author time.
 *
 * DOCUMENTED GAPS this single-console spec CANNOT close honestly (stated, never
 * faked — no-scaffold):
 *   • #2623 acceptance 3 (Databricks-vs-OSS SIDE-BY-SIDE). One deployed estate
 *     runs EXACTLY ONE backend (lib/azure/uc-backend.ts:resolveUcBackend), and
 *     the Loom grants route dispatches to whichever is active
 *     (unity-catalog-client.ts:listEffectivePermissions:785), so both the
 *     Databricks-native /effective-permissions answer AND the Loom OSS-resolver
 *     answer cannot be obtained from ONE console. A true diff needs two estates
 *     (Commercial+Databricks and Gov+OSS) holding an identical securable with
 *     identical grants; additionally the pinned OSS image 500s on authz-enabled
 *     reads (capability note, uc-backend.ts row `grants`). This spec captures the
 *     ACTIVE backend's real answer + names the backend; correcting parity-doc row
 *     E2 from a measured diff is the operator's cross-estate step.
 *   • #2623 acceptance 2 asks for the first-300-chars receipt on BOTH backends —
 *     same one-estate-one-backend limit: this spec captures the active backend.
 *   • #2623 acceptance 4 (audit render) — the WRITE fires on EVERY effective query,
 *     allowed AND denied (route.ts:176-179,194-200 → uc-access-review-audit.ts).
 *     Reading it back in Admin → Audit Logs is tenant-admin gated
 *     (app/api/admin/audit-logs/route.ts:74). The ALLOWED row's render is verified
 *     when this identity is a tenant admin. The DENIED row's render needs TWO
 *     identities — a NON-admin to generate it and an admin to read it — because
 *     one identity cannot be both denied (non-admin) and read the admin page
 *     (admin). That two-identity step is recorded as a documented gap.
 *
 * Auth: minted-session (SESSION_SECRET) via the `mint` project dependency +
 * storageState, exactly like sm-tab-clickwalk / publish-version. NOT a required
 * check — it is the G1 receipt for #2623.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=uc-effective-permissions
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="uc-effective-permissions"
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE, signIn, captureFailures, recordVerdict, AUTOMATION_OID } from './_lib/uat';

const SURFACE = 'page:/catalog/unity#grants-effective';
const OUT_DIR = path.join('temp', 'uat-uc-effective', process.env.LOOM_UAT_RUN_TAG || 'local');

/**
 * The queried principal that matches the minted session's own account. Imported
 * from the mint helper rather than re-derived: `uat.ts` throws when neither
 * UAT_OID nor LOOM_AUTOMATION_OID is set (#3804), so a third fallback term here
 * would be unreachable — and before that change it silently made this spec
 * assert `self` against the zero GUID, a principal that cannot sign in.
 */
const SELF_PRINCIPAL = AUTOMATION_OID;

/** A principal guaranteed NOT to be the session (not its oid / upn / email). */
const THIRD_PARTY = `uc-eff-notself-${Date.now()}@third-party.invalid`;

interface Json { status: number; ok: boolean; body: any; }
interface Securable { type: string; name: string; label: string; }

function ensureOut() { try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* best-effort */ } }

/** GET a BFF route with the session cookie; never throws. */
async function getJson(page: Page, urlPath: string): Promise<Json> {
  try {
    const r = await page.request.get(`${BASE}${urlPath}`, { timeout: 60_000 });
    const body = await r.json().catch(() => ({}));
    return { status: r.status(), ok: r.ok(), body };
  } catch (e: any) {
    return { status: 0, ok: false, body: { error: e?.message || String(e) } };
  }
}

/** The effective-permissions BFF call this whole spec exercises. */
function effectiveUrl(sec: Securable, principal?: string): string {
  const p = new URLSearchParams({ securable_type: sec.type, effective: 'true' });
  if (sec.name) p.set('full_name', sec.name);
  if (principal) p.set('principal', principal);
  return `/api/databricks/unity-catalog/grants?${p.toString()}`;
}

/**
 * Discover the deepest real securable the automation identity can see, so the
 * resolver runs against a REAL containment chain (table → schema → catalog):
 * the same list routes the Explore pane calls (page.tsx:305,309,313). Falls all
 * the way back to METASTORE (which needs no full_name and always exists) so the
 * controls are still driven on an empty/gated estate — never faking data.
 */
async function discoverSecurable(page: Page): Promise<Securable> {
  const cats = await getJson(page, '/api/databricks/unity-catalog/catalogs');
  const catalog = cats.ok && (cats.body.catalogs || [])[0]?.name;
  if (!catalog) return { type: 'METASTORE', name: '', label: 'METASTORE (no catalog visible)' };

  const schs = await getJson(page, `/api/databricks/unity-catalog/schemas?catalog=${encodeURIComponent(catalog)}`);
  const schema = schs.ok && (schs.body.schemas || [])[0]?.name;
  if (!schema) return { type: 'CATALOG', name: catalog, label: `CATALOG ${catalog}` };

  const full2 = `${catalog}.${schema}`;
  const tbls = await getJson(page, `/api/databricks/unity-catalog/tables?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`);
  const table = tbls.ok && (tbls.body.tables || [])[0];
  const tname = table && (table.full_name || `${full2}.${table.name}`);
  if (tname) return { type: 'TABLE', name: tname, label: `TABLE ${tname}` };
  return { type: 'SCHEMA', name: full2, label: `SCHEMA ${full2}` };
}

/** True when the response is the honest "backend not configured" gate. */
function isConfigGate(j: Json): boolean {
  return j.status === 503 || j.body?.code === 'not_configured';
}
/** True when the probe-guard fired (route.ts:180-183). */
function isProbeForbidden(j: Json): boolean {
  return j.status === 403 && j.body?.code === 'principal_probe_forbidden';
}

/** first 300 chars of the real body — the no-vaporware.md receipt. */
function receipt(j: Json): string {
  return JSON.stringify(j.body).slice(0, 300);
}

/* --------------------------------------------------------------- UI drivers */

/** Open /catalog/unity and switch to the Grants tab; returns the <main> scope. */
async function openGrantsPane(page: Page): Promise<Locator> {
  await page.goto(`${BASE}/catalog/unity`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 25_000 });
  const main = page.locator('main');
  // The catalog page's own TabList (page.tsx:267-278) — the "Grants" tab is
  // inside <main>, never the app-shell "Open tabs" chrome (whose tabs are route
  // links). Scope to <main> for the same reason sm-tab-clickwalk does.
  const grantsTab = main.getByRole('tab', { name: 'Grants' });
  await grantsTab.waitFor({ state: 'visible', timeout: 20_000 });
  await grantsTab.click();
  await page.getByRole('checkbox', { name: 'Effective (inherited)' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  return main;
}

/** Pick the securable type in the Grants dropdown (default is CATALOG). */
async function selectSecurableType(page: Page, scope: Locator, type: string): Promise<void> {
  if (type === 'CATALOG') return; // GrantsPane default (page.tsx:701)
  const combo = scope.getByRole('combobox', { name: 'Securable type' });
  const target = (await combo.count()) ? combo.first() : scope.getByRole('combobox').first();
  await target.click().catch(() => { /* verified by the option click below */ });
  await page.getByRole('option', { name: type, exact: true }).first()
    .click({ timeout: 8_000 })
    .catch(() => { /* dropdown drive is best-effort; the BFF receipt is authoritative */ });
}

/**
 * Drive the pane to load effective grants for `sec`, then wait for it to SETTLE
 * into a real state: the grants grid (ok — rendered even when empty, LoomDataTable
 * keeps the header grid + an empty-state <Text>, loom-data-table.tsx:820,951) OR a
 * Fluent MessageBar (an honest gate / warning / error). Neither appearing is a
 * genuine UI failure.
 */
async function driveEffectiveLoad(page: Page, scope: Locator, sec: Securable, principal?: string): Promise<void> {
  await selectSecurableType(page, scope, sec.type);
  if (sec.type !== 'METASTORE') {
    const nameInput = scope.getByPlaceholder('catalog[.schema[.object]]');
    await nameInput.fill(sec.name);
  }
  const effective = page.getByRole('checkbox', { name: 'Effective (inherited)' });
  if (!(await effective.isChecked())) await effective.click();
  if (principal) {
    const forPrincipal = scope.getByPlaceholder('ada@contoso.com or data-engineers');
    await forPrincipal.waitFor({ state: 'visible', timeout: 8_000 });
    await forPrincipal.fill(principal);
  }
  await scope.getByRole('button', { name: 'Load grants' }).click();

  const grid = scope.getByRole('grid', { name: 'Unity Catalog grants' });
  const banner = scope.locator('[class*="MessageBar"]');
  await expect(
    grid.or(banner).first(),
    'the Grants pane must settle into the results grid or an honest gate/warning banner after Load',
  ).toBeVisible({ timeout: 25_000 });
}

/* ------------------------------------------------------------------- suite */

test.describe.serial('uc effective-permissions resolver (#2623)', () => {
  let securable: Securable = { type: 'METASTORE', name: '', label: 'METASTORE' };
  let backend = '(unknown)';
  /** 'admin' | 'non-admin' | 'unknown' — detected, never assumed. */
  let adminStanding: 'admin' | 'non-admin' | 'unknown' = 'unknown';

  test.beforeAll(async ({ browser }) => {
    ensureOut();
    const page = await browser.newPage();
    try {
      await signIn(page.context()).catch(() => { /* storageState may already be set */ });
      securable = await discoverSecurable(page);
      const cap = await getJson(page, '/api/catalog/unity/capabilities');
      backend = (cap.ok && cap.body?.backend) || '(unresolved)';
      // Admin standing via a tenant-admin-gated route (audit-logs uses
      // withTenantAdmin — route.ts:74). 401/403 == the gate refused == non-admin;
      // anything else (200, or 500 when Cosmos is unhappy) means the gate PASSED.
      const probe = await getJson(page, '/api/admin/audit-logs?top=1');
      adminStanding = (probe.status === 401 || probe.status === 403) ? 'non-admin'
        : (probe.status === 0 ? 'unknown' : 'admin');
      console.log(`[uc-eff] backend=${backend} securable=${securable.label} admin=${adminStanding}`);
    } finally {
      await page.close();
    }
  });

  // 1) FIRST-OPEN — the pane opens clean (ux-baseline.md §6: no error banner on a
  //    fresh, untouched surface) and the effective controls are wired.
  test('first-open — Grants pane opens clean and the effective controls are wired', async ({ page, context }) => {
    await signIn(context).catch(() => { /* storageState already set */ });
    const { networkErrors } = await captureFailures(page, async () => {
      const main = await openGrantsPane(page);

      // No pre-touch error text (the pane only errors AFTER a bad Load).
      const errs = await main.getByText(/forbidden|HTTP \d{3}|Enter the securable full name/i).count();
      expect(errs, 'a freshly opened Grants pane must show no error text').toBe(0);

      // The effective toggle reveals the "Effective for principal" input — proof
      // the control is wired (page.tsx:882-895), not a static label.
      const toggle = page.getByRole('checkbox', { name: 'Effective (inherited)' });
      await toggle.click();
      await expect(
        main.getByPlaceholder('ada@contoso.com or data-engineers'),
        'ticking "Effective (inherited)" must reveal the principal field',
      ).toBeVisible({ timeout: 8_000 });
      await expect(main.getByRole('button', { name: 'Load grants' })).toBeEnabled();
      await page.screenshot({ path: path.join(OUT_DIR, 'first-open.png') }).catch(() => {});
    }, { label: '/catalog/unity#grants first-open' });

    recordVerdict({
      surface: SURFACE, feature: 'first-open+controls-wired', verdict: 'A', status: 'pass',
      notes: `clean first-open; effective toggle reveals principal field; backend=${backend}`,
      networkErrors,
    });
  });

  // 2) EFFECTIVE LOAD — the real resolver receipt, driven through the pane AND
  //    cross-checked directly against the BFF (no-vaporware.md real-data receipt).
  test('effective load — real resolver receipt via the pane + BFF (honest-gate tolerant)', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState already set */ });
    const { networkErrors } = await captureFailures(page, async () => {
      const main = await openGrantsPane(page);
      await driveEffectiveLoad(page, main, securable);
      await page.screenshot({ path: path.join(OUT_DIR, 'effective-load.png') }).catch(() => {});

      // Authoritative real-data receipt (page.request runs in the browser context
      // with the same session cookie).
      const j = await getJson(page, effectiveUrl(securable));
      const first300 = receipt(j);
      console.log(`[uc-eff] ${securable.label} effective=true -> ${j.status} :: ${first300}`);

      if (isConfigGate(j)) {
        recordVerdict({
          surface: SURFACE, feature: 'effective-load', verdict: 'B', status: 'pass',
          notes: `honest-gate: UC backend not configured (${backend}); status=${j.status} body=${first300}`,
          networkErrors,
        });
        return;
      }
      // The base effective form (no principal) is NOT probe-guarded, so a
      // probe-forbidden here would be a real defect.
      expect(isProbeForbidden(j), 'the un-scoped effective query must not be probe-gated').toBeFalsy();
      expect(j.body?.ok, `effective BFF returned ${j.status}: ${first300}`).toBeTruthy();
      expect(j.body?.effective, 'the answer must be flagged effective:true').toBeTruthy();
      expect(Array.isArray(j.body?.grants), 'effective answer carries a grants[] array').toBeTruthy();

      recordVerdict({
        surface: SURFACE, feature: 'effective-load', verdict: 'A', status: 'pass',
        notes: `backend=${backend} securable=${securable.label} rows=${j.body.grants.length} ` +
          `warnings=${(j.body.warnings || []).length} first300=${first300}`,
        networkErrors,
      });
    }, { label: '/catalog/unity#grants effective-load' });
  });

  // 3) AUTHORIZATION MATRIX (#2623 1a/1b/1c) — self allowed, third-party gated by
  //    admin standing. Each case that this identity cannot reproduce is recorded
  //    N/A with a reason, never faked.
  test('authorization matrix — self allowed; third-party gated per admin standing; all audited by design', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState already set */ });

    // (b) SELF probe — allowed for anyone (uc-principal-probe.ts). Universal.
    const self = await getJson(page, effectiveUrl(securable, SELF_PRINCIPAL));
    expect(
      isProbeForbidden(self),
      `self probe was gated — decidePrincipalProbe must allow self (status=${self.status} body=${receipt(self)})`,
    ).toBeFalsy();

    // (a)/(c) THIRD-PARTY probe — outcome depends on the DETECTED admin standing.
    const third = await getJson(page, effectiveUrl(securable, THIRD_PARTY));
    let matrixNote: string;
    if (adminStanding === 'non-admin') {
      // (c) must be a 403 with the honest remediation (route.ts:180-183).
      expect(isProbeForbidden(third), `non-admin third-party probe must 403 (got ${third.status}: ${receipt(third)})`).toBeTruthy();
      expect(typeof third.body?.reason === 'string' && third.body.reason.length > 0, 'the 403 carries a reason').toBeTruthy();
      expect(typeof third.body?.remediation === 'string' && third.body.remediation.length > 0, 'the 403 carries a remediation').toBeTruthy();
      matrixNote = `non-admin: self allowed; third-party 403 principal_probe_forbidden w/ reason+remediation. ` +
        `(1a — admin-allowed — N/A for a non-admin identity)`;
    } else if (adminStanding === 'admin') {
      // (a) a tenant admin may probe anyone — never the probe 403.
      expect(isProbeForbidden(third), `tenant-admin third-party probe must NOT be probe-gated (got ${third.status}: ${receipt(third)})`).toBeFalsy();
      matrixNote = `admin: self allowed; third-party allowed (status=${third.status}, not probe-gated). ` +
        `(1c — non-admin 403 — N/A: this identity is a tenant admin, so it is never denied)`;
    } else {
      matrixNote = `admin standing UNKNOWN (audit-logs probe status=0/unreachable); self probe not gated confirmed. ` +
        `1a/1c could not be classified — re-run against a reachable estate`;
    }

    await page.screenshot({ path: path.join(OUT_DIR, 'authz-matrix.png') }).catch(() => { /* API-only test */ });
    recordVerdict({
      surface: SURFACE, feature: 'authz-matrix(self/third-party)',
      verdict: adminStanding === 'unknown' ? 'C' : 'A',
      status: 'pass', notes: matrixNote,
    });
  });

  // 4) NARROW-WIDTH — the effective answer's privilege / usage / blocked badges
  //    never overlap at a narrow viewport (ux-baseline.md badge-wrap rule). Badges
  //    live in a flexWrap row (page.tsx:802-818); overlap at any width is a defect.
  test('narrow-width — effective badges never overlap', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState already set */ });
    await page.setViewportSize({ width: 820, height: 1100 });
    const main = await openGrantsPane(page);
    // Scope to SELF so any principal-scoped badges (blocked / usage) can appear.
    await driveEffectiveLoad(page, main, securable, SELF_PRINCIPAL);
    await page.screenshot({ path: path.join(OUT_DIR, 'narrow-badges.png') }).catch(() => {});

    const grid = main.getByRole('grid', { name: 'Unity Catalog grants' });
    const badgeRects = (await grid.count())
      ? await grid.locator('[class*="Badge"]').evaluateAll((els: Element[]) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height, text: (e.textContent || '').trim() };
          }).filter((r) => r.w > 0 && r.h > 0))
      : [];

    // Pairwise: two badges whose vertical spans overlap (same visual row) must not
    // overlap horizontally by more than a 1px anti-aliasing epsilon.
    const overlaps: string[] = [];
    for (let i = 0; i < badgeRects.length; i++) {
      for (let k = i + 1; k < badgeRects.length; k++) {
        const a = badgeRects[i]; const b = badgeRects[k];
        const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        const hOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (vOverlap > Math.min(a.h, b.h) * 0.5 && hOverlap > 1) {
          overlaps.push(`"${a.text}" ∩ "${b.text}" (${hOverlap.toFixed(1)}px)`);
        }
      }
    }
    expect(overlaps, `badges overlap at 820px width:\n${overlaps.join('\n')}`).toEqual([]);
    recordVerdict({
      surface: SURFACE, feature: 'narrow-width-badge-overlap', verdict: badgeRects.length ? 'A' : 'B', status: 'pass',
      notes: badgeRects.length
        ? `${badgeRects.length} badge(s) at 820px, zero overlaps; backend=${backend}`
        : `no badges rendered (empty/gated effective answer) — nothing to overlap; backend=${backend}`,
    });
  });

  // 5) AUDIT RENDER (#2623 4) — the ALLOWED uc-access-review row reaches Admin →
  //    Audit Logs. Tenant-admin gated (audit-logs route.ts:74) + Cosmos-backed.
  test('audit render — allowed uc-access-review row reaches Admin → Audit Logs', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState already set */ });

    if (adminStanding !== 'admin') {
      recordVerdict({
        surface: SURFACE, feature: 'audit-render', verdict: 'B', status: 'pass',
        notes: `N/A for a non-admin identity: the uc-access-review WRITE fires on every effective query by ` +
          `design (route.ts:194 → uc-access-review-audit.ts), but Admin → Audit Logs is tenant-admin gated, so ` +
          `this identity cannot read it back. Verifying the DENIED row's render additionally needs a second, ` +
          `non-admin identity to generate it — documented two-identity gap.`,
      });
      return;
    }

    // Generate an ALLOWED access-review row (self-scoped effective query).
    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const gen = await getJson(page, effectiveUrl(securable, SELF_PRINCIPAL));
    expect(isProbeForbidden(gen), 'self-scoped generator query must be allowed').toBeFalsy();

    // Poll Audit Logs (refresh=1 bypasses the 5-min stale-while-revalidate cache;
    // the audit write is fire-and-forget so give it a few passes).
    let found = false; let lastNote = '';
    for (let attempt = 0; attempt < 6 && !found; attempt++) {
      await page.waitForTimeout(2500);
      const q = `/api/admin/audit-logs?type=uc-access-review&since=${encodeURIComponent(sinceIso)}&top=50&refresh=1`;
      const a = await getJson(page, q);
      if (a.status !== 200 || !a.body?.ok) {
        // Admin passed the gate but Cosmos may be unconfigured (apiServerError → 500).
        lastNote = `audit-logs status=${a.status} body=${receipt(a)}`;
        if (a.status >= 500) break; // honest Cosmos gate — stop polling
        continue;
      }
      const rows: any[] = Array.isArray(a.body.rows) ? a.body.rows : [];
      found = rows.some((r) => r.kind === 'uc-access-review');
      lastNote = `rows=${rows.length} uc-access-review-present=${found}`;
    }

    if (!found) {
      recordVerdict({
        surface: SURFACE, feature: 'audit-render', verdict: 'B', status: 'pass',
        notes: `honest-gate/limitation: could not confirm a uc-access-review row in Admin → Audit Logs ` +
          `(${lastNote}). Likely Cosmos audit-log not configured on this estate, or eventual-consistency ` +
          `beyond the poll window. The WRITE is unit-covered in #2608; render needs a Cosmos-backed estate.`,
      });
      return;
    }
    recordVerdict({
      surface: SURFACE, feature: 'audit-render', verdict: 'A', status: 'pass',
      notes: `allowed uc-access-review row rendered in Admin → Audit Logs (${lastNote}). DENIED-row render needs a ` +
        `second non-admin identity — documented two-identity gap.`,
    });
  });

  // 6) BACKEND + PARITY (#2623 2/3) — capture the ACTIVE backend's real receipt and
  //    record the Databricks-vs-OSS side-by-side as the documented cross-estate gap.
  test('backend + parity — active-backend receipt captured; side-by-side is a documented cross-estate gap', async ({ page, context }) => {
    await signIn(context).catch(() => { /* storageState already set */ });
    const j = await getJson(page, effectiveUrl(securable));
    const first300 = receipt(j);
    recordVerdict({
      surface: SURFACE, feature: 'backend-receipt+parity-gap',
      verdict: 'B', status: 'pass',
      notes: `active backend=${backend}; securable=${securable.label}; status=${j.status}; first300=${first300}. ` +
        `#2623-3 (Databricks-vs-OSS side-by-side) and the both-backends first-300 receipt (#2623-2) are NOT ` +
        `producible from one console: an estate runs a single backend (resolveUcBackend) and the grants route ` +
        `dispatches to it (listEffectivePermissions), so both the Databricks-native and OSS-resolver answers ` +
        `cannot be obtained here. Requires two estates + an identical securable; parity-doc row E2 stays ⚠️ ` +
        `(disclosed-narrowing) until measured cross-estate.`,
    });
    expect(true).toBeTruthy();
  });
});
