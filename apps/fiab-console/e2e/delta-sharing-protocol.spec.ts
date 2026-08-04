/**
 * delta-sharing-protocol.spec.ts — the G1 receipt for #2619 (LU-9).
 *
 * #2613 shipped the recipient-facing Delta Sharing endpoint with UNIT + ROUTE
 * coverage only (app/api/delta-sharing/__tests__/protocol.test.ts). Per
 * ux-baseline.md G1 and no-vaporware.md that is not a completion receipt: a
 * vitest that imports the route handler and calls it with a NextRequest never
 * proves the route is deployed, reachable over the wire, and answering in the
 * Delta Sharing PROTOCOL shape rather than a Loom envelope. This spec closes
 * that gap with real HTTP against the live console, plus a real browser walk of
 * the Marketplace → Data shares publish surface.
 *
 * ── What this spec proves, grounded to source ──────────────────────────────
 *
 * TEST 1 — the protocol endpoint is LIVE and FAILS CLOSED in the wire shape.
 *   A truly anonymous HTTP client (its own cookie-less request context — not the
 *   minted session) hits the three verbs a `delta_sharing` client would call:
 *     GET  /api/delta-sharing/shares
 *     GET  /api/delta-sharing/shares/<s>/schemas/<sc>/tables/<t>/metadata
 *     POST /api/delta-sharing/shares/<s>/schemas/<sc>/tables/<t>/query
 *   and asserts each returns 401 in the PROTOCOL error body {errorCode,message}
 *   — NOT the Loom {ok:false} envelope. This is exactly the contract the route
 *   documents (app/api/delta-sharing/[...path]/route.ts:59-64 + :105-107): a
 *   conforming client (delta-sharing-python, the Spark connector, Power BI's
 *   connector) parses {errorCode,message}, and a Loom envelope here would break
 *   every one of them. The no-bearer 401 lands BEFORE any configuration is read
 *   (lib/sharing/recipient-auth.ts:102-104), so this receipt is valid on EVERY
 *   estate — deployed or not — and additionally asserts no configuration text
 *   leaks to an unauthenticated caller (the live twin of protocol.test.ts's
 *   "no infrastructure disclosure" block).
 *
 *   NON-VACUITY: the assertion checks `errorCode === 'UNAUTHENTICATED'` AND
 *   `ok === undefined`. A 401 wrapped in the Loom `{ok:false,error}` envelope
 *   would carry no errorCode and an `ok` key, and would fail here — which is the
 *   whole point (the route must speak the protocol, not the envelope).
 *
 * TEST 2 — the Data shares UI surface renders + its BFF answers (browser walk).
 *   Navigates to /marketplace?tab=shares (loom-marketplace.tsx reflects the tab
 *   in ?tab= and renders <DataShares/> for value 'shares'), asserts the surface
 *   heading, probes the management BFF for the active backend, and — when the
 *   surface is functional — real-clicks the "Shared by me" tab to reach the
 *   publish panel. Honest-gate tolerant: a 501 {gated:true} estate renders the
 *   documented "Delta Sharing not available" MessageBar and is recorded gated,
 *   not failed (no-vaporware.md).
 *
 * TEST 3 — the loom-backend PUBLISH walk, end to end, real backend + real click.
 *   The LU-9 protocol path: create a share → add an ADLS Delta table → register
 *   an Entra recipient → grant → render the reference-server manifest, each via
 *   the real management BFF (Cosmos-backed, backend:'loom'), each cross-checked
 *   on the response. Then the specific affordance #2619 names — "suspend via the
 *   new Access toggle" — is driven with a REAL UI click on the recipient row's
 *   Access Switch (aria-label "Access for <name>", data-shares.tsx:788-793) and
 *   confirmed on the BFF (recipient.disabled === true). Tenant-admin/gate
 *   tolerant: publishing outside the boundary is withTenantAdmin (a 403
 *   admin_only from a non-admin automation identity, or a 501 gate, is recorded
 *   as an honest precondition, not a failure).
 *
 * ── What this spec does NOT prove (honest, documented gaps) ────────────────
 *   • A real `delta_sharing` PYTHON client running list_shares → list_all_tables
 *     → load_as_pandas, and a live A-vs-B cross-recipient refusal, both require
 *     a genuine Microsoft Entra ACCESS token scoped `DeltaSharing.Read` for a
 *     REGISTERED recipient (two of them, for the cross-recipient case). The UAT
 *     harness mints a Loom SESSION COOKIE (uat.ts mintSession), which the
 *     protocol route deliberately ignores — it reads the Authorization header
 *     and verifies an Entra JWT via JWKS (recipient-auth.ts:144-160). We cannot
 *     forge that token here, so the AUTHENTICATED data-plane read and the live
 *     cross-recipient/traversal refusals remain covered by the unit suite
 *     (protocol.test.ts) and are called out here rather than faked. The live
 *     receipt this spec adds is the anonymous fail-closed protocol shape + the
 *     full publish/authorization control plane.
 *   • Applying the manifest is an infra redeploy of the loom-sharing Container
 *     App (loomManifest.apply). This spec asserts the manifest RENDERS the
 *     just-published table + the exact apply command; the redeploy itself is out
 *     of a spec's reach and is the honest seam _loom-backend.ts documents.
 *
 * Project: `delta-sharing` (playwright.config.ts), minted-session auth via the
 * `mint` dependency. NOT wired into any required check — it is the G1 receipt.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=delta-sharing
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="delta-sharing"
 */
import { test, expect, request as playwrightRequest, type APIResponse, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { BASE, signIn, mintSession, recordVerdict } from './_lib/uat';

/** Protocol + management base paths, grounded to the route trees. */
const DS = `${BASE}/api/delta-sharing`;      // recipient-facing protocol (route.ts)
const MP = `${BASE}/api/marketplace/sharing`; // management BFF (data-shares.tsx uses these)

/** Config strings that must NEVER reach an unauthenticated protocol caller
 *  (mirrors protocol.test.ts:553 LEAKS, asserted LIVE here). */
const LEAKS = ['bicep', 'loom-sharing-app', 'LOOM_SHARING_URL', 'LOOM_ENTRA_TENANT_ID',
  'Key Vault', 'docs/fiab', 'LOOM_SHARING_ENABLED'];

/** A valid ADLS Gen2 Delta root — the only location the Loom backend accepts
 *  (lib/sharing/model.ts isValidShareLocation: abfss://<c>@<acct>/<path>). */
const SHARE_LOCATION = 'abfss://lake@uatloomshare.dfs.core.windows.net/gold/revenue';

interface JsonResponse { status: number; body: any; contentType: string | null; }

/** GET the protocol route with NO credential, retrying only the rate-limit
 *  ceiling (429 RESOURCE_EXHAUSTED — route.ts:223-229, keyed on source IP). */
async function anonGet(
  ctx: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  url: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<JsonResponse> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res: APIResponse = method === 'POST'
      ? await ctx.post(url, { data: {} })
      : await ctx.get(url);
    const contentType = res.headers()['content-type'] ?? null;
    const body = await res.json().catch(() => ({}));
    if (res.status() !== 429) return { status: res.status(), body, contentType };
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`${method} ${url} stayed 429 across retries (rate limiter never opened)`);
}

/** POST/PATCH/GET/DELETE the management BFF through the page's (authenticated)
 *  request context. Returns status + parsed body. */
async function bff(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await page.request.fetch(`${BASE}${path}`, {
    method,
    ...(data !== undefined ? { data } : {}),
    timeout: 60_000,
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/** Delete a share / recipient best-effort with a minted-session request context
 *  (mirrors uat.cleanupWorkspaces — the test may throw before inline cleanup). */
async function cleanup(shares: string[], recipients: string[]): Promise<void> {
  if (!shares.length && !recipients.length) return;
  let ctx: Awaited<ReturnType<typeof playwrightRequest.newContext>> | undefined;
  try {
    ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: { cookie: `loom_session=${mintSession()}` },
    });
    for (const s of new Set(shares)) {
      await ctx.delete(`${MP}/shares/${encodeURIComponent(s)}`).catch(() => { /* best-effort */ });
    }
    for (const r of new Set(recipients)) {
      await ctx.delete(`${MP}/recipients/${encodeURIComponent(r)}`).catch(() => { /* best-effort */ });
    }
  } catch { /* teardown must never fail the run */ } finally {
    await ctx?.dispose().catch(() => {});
  }
}

test.describe('delta-sharing LU-9 (#2619) — live protocol + publish walk', () => {
  const createdShares: string[] = [];
  const createdRecipients: string[] = [];

  test.afterAll(async () => {
    await cleanup(createdShares, createdRecipients);
  });

  // --------------------------------------------------------------------------
  // TEST 1 — the protocol endpoint is LIVE and fails closed in the WIRE shape.
  //
  // Uses a cookie-less request context so the receipt is a true "curl with no
  // credential": it proves the route refuses anonymous access on its own, not
  // because the ambient minted session did or did not carry the right header
  // (the route reads Authorization, never the cookie — route.ts:323).
  // --------------------------------------------------------------------------
  test('the protocol endpoint is reachable and fails closed in the delta-sharing error shape', async ({}, testInfo) => {
    const anon = await playwrightRequest.newContext(); // NO storageState → no cookies
    try {
      // The three protocol calls a recipient client actually makes, each with no
      // bearer. seg-length 1 (discovery), 7 (data-plane GET), and the POST query.
      const cases: Array<{ label: string; url: string; method: 'GET' | 'POST' }> = [
        { label: 'GET /shares (discovery)', url: `${DS}/shares`, method: 'GET' },
        {
          label: 'GET table metadata (data plane)',
          url: `${DS}/shares/share-x/schemas/gold/tables/t1/metadata`, method: 'GET',
        },
        {
          label: 'POST table query (data plane)',
          url: `${DS}/shares/share-x/schemas/gold/tables/t1/query`, method: 'POST',
        },
      ];

      const problems: string[] = [];
      for (const c of cases) {
        const { status, body, contentType } = await anonGet(anon, c.url, c.method);

        // (a) 401 UNAUTHENTICATED — the no-credential refusal (recipient-auth.ts:102).
        if (status !== 401) {
          problems.push(`${c.label}: expected 401, got ${status} (body ${JSON.stringify(body).slice(0, 200)})`);
          continue;
        }
        // (b) PROTOCOL shape, NOT the Loom envelope. A Loom 401 would be
        //     {ok:false,error} with no errorCode; the route must speak the wire
        //     protocol so delta-sharing-python / the Spark connector can parse it.
        if (body?.errorCode !== 'UNAUTHENTICATED') {
          problems.push(`${c.label}: errorCode was ${JSON.stringify(body?.errorCode)} not 'UNAUTHENTICATED' — is this the Loom envelope, not the protocol shape?`);
        }
        if (body?.ok !== undefined) {
          problems.push(`${c.label}: body carries an 'ok' key (${JSON.stringify(body.ok)}) — that is the Loom envelope; the protocol clients parse {errorCode,message}`);
        }
        if (typeof body?.message !== 'string' || !body.message) {
          problems.push(`${c.label}: protocol error has no 'message' string`);
        }
        if (!String(contentType || '').includes('application/json')) {
          problems.push(`${c.label}: content-type was ${JSON.stringify(contentType)} not application/json`);
        }
        // (c) no configuration disclosure to an anonymous caller (LIVE twin of
        //     protocol.test.ts "no infrastructure disclosure").
        const text = JSON.stringify(body);
        for (const leak of LEAKS) {
          if (text.includes(leak)) problems.push(`${c.label}: leaked config token "${leak}" to an unauthenticated caller`);
        }
      }

      testInfo.annotations.push({
        type: 'protocol',
        description: `anonymous protocol probes: ${cases.length} verbs, problems=${problems.length}`,
      });
      recordVerdict({
        surface: 'api:/api/delta-sharing', feature: 'protocol-fail-closed',
        verdict: problems.length ? 'F' : 'A', status: problems.length ? 'fail' : 'pass',
        notes: problems.length ? problems.join(' | ') : 'anonymous GET/POST across discovery + data-plane return 401 UNAUTHENTICATED in the protocol {errorCode,message} shape, no config leak',
      });
      expect(problems, `delta-sharing protocol fail-closed problems:\n${problems.join('\n')}`).toEqual([]);
    } finally {
      await anon.dispose().catch(() => {});
    }
  });

  // --------------------------------------------------------------------------
  // TEST 2 — the Data shares UI renders + its management BFF answers.
  // --------------------------------------------------------------------------
  test('Marketplace → Data shares renders and its BFF answers (browser walk)', async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    await page.goto(`${BASE}/marketplace?tab=shares`, { waitUntil: 'domcontentloaded' });
    // The Data shares surface header (data-shares.tsx:159).
    await expect(page.getByText('Data shares — Delta Sharing').first())
      .toBeVisible({ timeout: 20_000 });

    // Ground truth for the backend / gate — the same GET the surface makes.
    const shares = await bff(page, 'GET', '/api/marketplace/sharing/shares');
    await page.screenshot({ path: testInfo.outputPath('data-shares-surface.png') }).catch(() => {});

    if (shares.status === 501 && shares.body?.gated) {
      // Honest gate (no backend deployed) — the documented MessageBar must render.
      await expect(page.getByText('Delta Sharing not available').first())
        .toBeVisible({ timeout: 15_000 });
      recordVerdict({
        surface: 'page:/marketplace?tab=shares', feature: 'data-shares-render',
        verdict: 'B', status: 'pass',
        notes: `honest-gate: sharing backend not configured (${shares.body?.missing || 'no backend'}) — surface renders the documented MessageBar`,
      });
      testInfo.annotations.push({ type: 'gate', description: `501 gated: ${shares.body?.error || ''}` });
      return;
    }
    expect(shares.body?.ok, `GET /shares returned ${shares.status} ${JSON.stringify(shares.body).slice(0, 200)}`).toBeTruthy();
    const backend = String(shares.body?.backend || '');

    // Real click-walk to the publish panel: the "Shared by me" tab (data-shares.tsx:185).
    await page.getByRole('tab', { name: 'Shared by me' }).click();
    await expect(page.getByText('Shares I publish').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'New share' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'New recipient' }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('data-shares-outbound.png') }).catch(() => {});

    testInfo.annotations.push({ type: 'backend', description: `active sharing backend=${backend}` });
    recordVerdict({
      surface: 'page:/marketplace?tab=shares', feature: 'data-shares-render',
      verdict: 'A', status: 'pass',
      notes: `Data shares surface renders; "Shared by me" publish panel reached by real click (backend=${backend})`,
    });
  });

  // --------------------------------------------------------------------------
  // TEST 3 — the loom-backend publish walk + Access-toggle suspend (real click).
  // --------------------------------------------------------------------------
  test('loom-backend publish walk: create → add table → recipient → grant → manifest → suspend', async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    // Backend probe. The LU-9 protocol path is the LOOM backend; if this estate
    // runs Databricks/UC sharing (LOOM_SHARING_URL unset) or is gated, that is an
    // honest estate state — record it plainly, do not launder it into a pass of a
    // path that is not the one under test.
    const probe = await bff(page, 'GET', '/api/marketplace/sharing/shares');
    if (probe.status === 501 && probe.body?.gated) {
      recordVerdict({
        surface: 'api:/api/marketplace/sharing', feature: 'publish-walk',
        verdict: 'B', status: 'pass',
        notes: `honest-gate: no sharing backend configured — publish walk not applicable (${probe.body?.missing || ''})`,
      });
      test.skip(true, 'sharing backend not configured on this estate (honest 501 gate)');
      return;
    }
    const backend = String(probe.body?.backend || '');
    test.skip(
      backend !== 'loom',
      `active sharing backend is "${backend}", not "loom" — LU-9 is the loom-sharing (Azure-native) path. ` +
        'On this estate loom-sharing is not deployed (LOOM_SHARING_URL unset), so the Databricks UC path answers instead.',
    );

    const stamp = Date.now().toString(36);
    const shareName = `uat-lu9-s-${stamp}`;      // NAME_RE + canonical (lowercase) — model.ts
    const recipientName = `uat-lu9-r-${stamp}`;
    const principalId = crypto.randomUUID();     // a valid Entra GUID (model.isValidPrincipalId)

    // 1) CREATE SHARE (withTenantAdmin). A 403 admin_only is an honest precondition
    //    — publishing outside the boundary requires tenant admin, and the
    //    automation identity may not hold it on this estate.
    const create = await bff(page, 'POST', '/api/marketplace/sharing/shares', { name: shareName, comment: 'LU-9 G1 receipt' });
    if (create.status === 403) {
      recordVerdict({
        surface: 'api:/api/marketplace/sharing', feature: 'publish-walk',
        verdict: 'B', status: 'pass',
        notes: 'honest-precondition: the automation identity is not a tenant admin (POST /shares → 403 admin_only). Publishing is tenant-admin gated by design.',
      });
      test.skip(true, 'automation identity is not a tenant admin — publish mutations are admin-gated (honest precondition)');
      return;
    }
    expect(create.body?.ok, `POST /shares → ${create.status} ${JSON.stringify(create.body).slice(0, 200)}`).toBeTruthy();
    expect(create.body?.backend, 'create ran on the loom backend').toBe('loom');
    createdShares.push(shareName);

    // 2) ADD TABLE — an ADLS Gen2 Delta root (loom backend: _loom-backend.toSharedTable).
    const addTable = await bff(page, 'PATCH', `/api/marketplace/sharing/shares/${encodeURIComponent(shareName)}`, {
      addObjects: [{ schema: 'gold', name: 'revenue', location: SHARE_LOCATION, historyShared: true }],
    });
    expect(addTable.body?.ok, `PATCH addObjects → ${addTable.status} ${JSON.stringify(addTable.body).slice(0, 200)}`).toBeTruthy();
    const objNames = (addTable.body?.share?.objects || []).map((o: { name: string }) => o.name);
    expect(objNames, 'the published table is on the share').toContain('gold.revenue');
    // The manifest-pending seam is disclosed on the response (_loom-backend:262).
    expect(addTable.body?.manifestPending, 'manifest-pending disclosed').toBe(true);

    // 3) REGISTER RECIPIENT — an Entra principal (loomCreateRecipient).
    const recip = await bff(page, 'POST', '/api/marketplace/sharing/recipients', { name: recipientName, principalIds: [principalId] });
    expect(recip.body?.ok, `POST /recipients → ${recip.status} ${JSON.stringify(recip.body).slice(0, 200)}`).toBeTruthy();
    createdRecipients.push(recipientName);
    // A loom recipient is Entra-identified, created with NO shares (grant is separate).
    expect(recip.body?.recipient?.authentication_type, 'loom recipient is Entra-identified').toBe('ENTRA');
    expect(recip.body?.recipient?.shares || [], 'a fresh recipient holds no grants').toEqual([]);

    // 4) GRANT the recipient the share. Grants live on the recipient (the one
    //    place the reference server cannot see) — _loom-backend:229-238.
    const grant = await bff(page, 'PATCH', `/api/marketplace/sharing/shares/${encodeURIComponent(shareName)}`, { grant: [recipientName] });
    expect(grant.body?.ok, `PATCH grant → ${grant.status}`).toBeTruthy();
    const grantedPrincipals = (grant.body?.permissions?.privilege_assignments || []).map((p: { principal: string }) => p.principal);
    expect(grantedPrincipals, 'the recipient now holds a SELECT grant').toContain(recipientName);

    // 5) MANIFEST — the reference-server config seam. Asserts the just-published
    //    table RENDERS into the shares: block + the exact apply command
    //    (loomManifest). The redeploy that applies it is infra, out of a spec's
    //    reach — see the header's documented gap.
    const manifest = await bff(page, 'GET', '/api/marketplace/sharing/manifest');
    expect(manifest.body?.ok, `GET /manifest → ${manifest.status}`).toBeTruthy();
    expect(String(manifest.body?.yaml || ''), 'manifest names the share').toContain(shareName);
    expect(String(manifest.body?.yaml || ''), 'manifest names the published table').toContain('revenue');
    expect(String(manifest.body?.apply || ''), 'manifest carries the apply command').toContain('loom-sharing-app.bicep');
    expect(typeof manifest.body?.base64, 'manifest carries the base64 payload').toBe('string');

    // 6) SUSPEND via the Access toggle — the #2619-named affordance, a REAL click.
    //    Reload the publish panel, real-click the recipient's Access Switch
    //    (aria-label "Access for <name>", data-shares.tsx:788-793), then confirm
    //    disabled flipped on the BFF (no DOM-only claim — no-scaffold.md).
    await page.goto(`${BASE}/marketplace?tab=shares`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Data shares — Delta Sharing').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Shared by me' }).click();
    await expect(page.getByText('Recipients').first()).toBeVisible({ timeout: 15_000 });

    const toggle = page.getByRole('switch', { name: `Access for ${recipientName}` });
    await expect(toggle, `the Access toggle for "${recipientName}" is present (loom backend Access column)`)
      .toBeVisible({ timeout: 15_000 });
    // Starts Active (checked = !disabled, and the recipient is not disabled).
    await expect(toggle).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('recipient-active.png') }).catch(() => {});
    await toggle.click(); // suspend
    // The onChange PATCHes {disabled:true}; confirm the write landed on the BFF.
    let suspended = false;
    await expect(async () => {
      const after = await bff(page, 'GET', `/api/marketplace/sharing/recipients/${encodeURIComponent(recipientName)}`);
      suspended = after.body?.recipient?.disabled === true;
      expect(suspended, `recipient.disabled after toggle (got ${JSON.stringify(after.body?.recipient?.disabled)})`).toBe(true);
    }).toPass({ timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath('recipient-suspended.png') }).catch(() => {});

    testInfo.annotations.push({
      type: 'publish-walk',
      description: `share=${shareName} table=gold.revenue recipient=${recipientName} granted+suspended=${suspended}`,
    });
    recordVerdict({
      surface: 'page:/marketplace?tab=shares', feature: 'publish-walk',
      verdict: 'A', status: 'pass',
      notes: `loom publish walk: create+addTable+recipient+grant+manifest via real BFF; Access-toggle suspend via real click, confirmed disabled=${suspended}`,
    });

    // Inline cleanup (afterAll is the safety net if an assertion above threw).
    await bff(page, 'DELETE', `/api/marketplace/sharing/shares/${encodeURIComponent(shareName)}`).catch(() => {});
    await bff(page, 'DELETE', `/api/marketplace/sharing/recipients/${encodeURIComponent(recipientName)}`).catch(() => {});
  });
});
