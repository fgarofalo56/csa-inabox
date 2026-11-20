/**
 * health-tenant-g1.spec.ts - the G1 (browser E2E, real data) receipt producer for
 * the LHDS W01b health-tenant lifecycle: create -> bind -> read back -> destroy.
 *
 * Run in-VNet against the LIVE console (ux-baseline G1; deploy-integrity R2):
 *   gh workflow run loom-ui-verify.yml --ref main -f extra_projects="health-tenant-g1"
 *
 * It CREATES a real synthetic tenant on the stamp the console is wired to and
 * DESTROYS it again. Operator pre-authorized this on the Commercial dev01 stamp.
 * Config comes only from what loom-ui-verify forwards (SESSION_SECRET, LOOM_URL,
 * LOOM_AUTOMATION_*) plus the fixed constants below.
 *
 * Reads: the console had no route to read a control-plane job by id, and the
 * `tenant.destroy` job outlives the item, so /api/health/tenants/{itemId} cannot
 * reach it. The destroy job is read through GET /api/health/jobs/{id}
 * (app/api/health/jobs/[id]/route.ts, added alongside this spec).
 * Depends on PR #5321 (DELETE of a health-tenant item submits tenant.destroy and
 * answers { ok, destroyJobId }). Without it step 5 fails on "destroyJobId present".
 *
 * NOT MEASURED: the stamp-paused banner (no stamp pause is in scope), and the
 * dark/light/narrow screenshots are attachments for a human to read, not
 * assertions of visual correctness.
 *
 * Every assertion names, in a comment, the value that would break it
 * (.claude/rules/assertion-design.md). No token or secret is ever printed.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { BASE, signIn, createWorkspace, cleanupWorkspaces } from './_lib/uat';

const ITEM_TYPE = 'health-tenant';
const CREATE_TIMEOUT_MS = 12 * 60_000;
const DESTROY_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 10_000;
const ARM_ID_RE = /^\/subscriptions\/[0-9a-f-]{36}\/resourcegroups\/[^/\s]+\/providers\/[^\s]+$/i;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

interface Receipt { at: string; step: string; detail: string }

/** Parse `"<kind> exists=<bool> id=<armId>"` lines out of a job's `readback` receipts. */
function parseReadbacks(receipts: Receipt[]): { kind: string; exists: boolean; id: string }[] {
  const out: { kind: string; exists: boolean; id: string }[] = [];
  for (const r of receipts) {
    if (r.step !== 'readback') continue;
    const m = /^(\S+) exists=(true|false) id=(\S+)$/.exec(r.detail.trim());
    if (m) out.push({ kind: m[1]!, exists: m[2] === 'true', id: m[3]! });
  }
  return out;
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

/**
 * A 403 whose body names `health.tenant-admin` is the strict, non-inherited gate
 * (D12), not a product defect. It must FAIL LOUDLY with that cause - never skip,
 * never pass. Breaks (throws) on any 403 carrying `capability: health.tenant-admin`.
 */
function failIfTenantAdminGate(status: number, body: any, what: string) {
  if (status === 403 && body?.capability === 'health.tenant-admin') {
    throw new Error(
      `${what}: automation identity lacks health.tenant-admin ${body.requiredRole ?? '(role)'} ` +
      `- grant it at /admin/permissions (Health Tenant Admin); Loom admin does not inherit it (D12). reason=${String(body.reason ?? '').slice(0, 200)}`,
    );
  }
}

async function getJson(page: Page, path: string): Promise<{ status: number; body: any }> {
  const r = await page.request.get(`${BASE}${path}`, { timeout: 60_000 });
  const body = await r.json().catch(() => ({}));
  failIfTenantAdminGate(r.status(), body, `GET ${path}`);
  return { status: r.status(), body };
}

test.describe.serial('health-tenant lifecycle (LHDS W01b G1)', () => {
  const displayName = `g1-${stamp()}`;
  const createdWorkspaces: string[] = [];
  let wsId = '';
  let itemId = '';
  let itemDeleted = false;
  let armIds: string[] = [];
  let tenantId = '';

  test.beforeEach(async ({ context }) => {
    await signIn(context).catch(() => { /* storageState may already carry the session */ });
  });

  test.afterAll(async ({ browser }) => {
    // Never leave a live tenant behind: delete the item first (submits tenant.destroy),
    // THEN drop the workspace (a cascade workspace delete would not run the destroy).
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(context).catch(() => {});
      // The create POST may have timed out AFTER the server made the item (itemId never recorded):
      // find it by the run's generated name, so a billable tenant is not orphaned.
      const victims = new Set<string>();
      if (itemId && !itemDeleted) victims.add(itemId);
      if (wsId && !itemId) {
        const l = await page.request.get(`${BASE}/api/workspaces/${wsId}/items`, { timeout: 60_000 }).catch(() => null);
        const rows = l && l.ok() ? await l.json().catch(() => []) : [];
        for (const it of Array.isArray(rows) ? rows : []) {
          if (it?.displayName === displayName && typeof it?.id === 'string') victims.add(it.id);
        }
      }
      for (const id of victims) {
        const r = await page.request.delete(`${BASE}/api/workspaces/${wsId}/items/${id}`, { timeout: 60_000 }).catch(() => null);
        console.log(`[health-tenant-g1] cleanup DELETE item ${id} -> ${r ? r.status() : 'no response'}` +
          (r && r.ok() ? ' (tenant.destroy submitted; NOT polled by cleanup)'
            : ` (TENANT MAY STILL BE LIVE: item=${id} tenant=${tenantId || displayName.toLowerCase()})`));
      }
    } finally {
      await page.close();
      await context.close();
    }
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  });

  test('1. BFF -> control plane auth path answers (GET /api/health/tenants)', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const { status, body } = await getJson(page, '/api/health/tenants');
    await testInfo.attach('tenants-list-first-300', { body: JSON.stringify(body).slice(0, 300), contentType: 'text/plain' });
    // Breaks on 503 (authServerMissing / health-control-plane gate), 502 (CP unreachable) or 403 (no health.tenant-admin grant).
    expect(status, `GET /api/health/tenants -> ${status}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    // Breaks if the route answers 200 with ok:false (a gate envelope is not a success).
    expect(body.ok, 'body.ok must be exactly true').toBe(true);
    // Paired positive: a list was returned, not just an ok flag.
    expect(Array.isArray(body.tenants), 'body.tenants must be an array (an ok with no list proves no CP read)').toBe(true);
  });

  test('2. create the item; the editor opens clean on the real surface', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    wsId = await createWorkspace(page, 'g1-health-tenant');
    createdWorkspaces.push(wsId);
    const r = await page.request.post(`${BASE}/api/workspaces/${wsId}/items`, {
      data: { itemType: ITEM_TYPE, displayName }, timeout: 90_000,
    });
    const created = await r.json().catch(() => ({}));
    // Breaks if item creation (autoBindOnCreate) 4xx/5xx's.
    expect(r.ok(), `create health-tenant -> ${r.status()}: ${JSON.stringify(created).slice(0, 300)}`).toBe(true);
    itemId = String(created.id || '');
    // Breaks if the response carries no id (nothing to open, poll or delete).
    expect(itemId, 'created item must carry an id').not.toEqual('');

    await page.goto(`${BASE}/items/${ITEM_TYPE}/${itemId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => { /* best-effort */ });

    // The editor's real surface carries the item's own display name; a bind form would not.
    // Breaks if the editor fails to load (name never appears).
    await expect(page.getByText(displayName, { exact: false }).first(), 'editor must render the item surface carrying its own display name').toBeVisible({ timeout: 60_000 });
    // Breaks if the editor opens on a bind-me-first form (auto-bind-by-default 4).
    await expect(page.getByText(/Bind to an existing|isn't bound to a real/i), 'a bind-me-first form is the auto-bind-by-default violation').toHaveCount(0);

    // ux-baseline 6: no error/warning banner on first open. Fluent MessageBar root class is fui-MessageBar.
    // Breaks on any bar whose text reads as a failure (e.g. "Provisioning failed", "Stamp .. is paused", "last recorded state").
    const bars = await page.locator('.fui-MessageBar').allInnerTexts();
    await testInfo.attach('first-open-messagebars', { body: JSON.stringify(bars), contentType: 'application/json' });
    const bad = bars.filter((t) => /fail|error|unavailable|cannot|could not|paused|last recorded|try again/i.test(t));
    expect(bad, `error-like MessageBars on first open: ${JSON.stringify(bad)}`).toEqual([]);
  });

  test('3. tenant reaches active; binding maps the display name; readback is all exists=true', async ({ page }, testInfo) => {
    test.setTimeout(CREATE_TIMEOUT_MS + 60_000);
    expect(itemId, 'step 2 must have created the item').not.toEqual('');
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    let last: any = null;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      let r = await getJson(page, `/api/health/tenants/${itemId}`);
      // GET is read-only and never provisions. While the item is unbound, ask the BFF to ensure it (idempotent
      // POST, the same call the editor makes on open) and FAIL FAST on a stop the provisioner reports (#5377):
      // a gated phase ('no-stamp', 'unconfigured') or a control-plane error will not clear by waiting 12 minutes.
      if (r.status === 200 && r.body?.phase === 'unbound') {
        const p = await page.request.post(`${BASE}/api/health/tenants/${itemId}`, { data: { retry: false }, timeout: 90_000 });
        const pb = await p.json().catch(() => ({}));
        failIfTenantAdminGate(p.status(), pb, `POST /api/health/tenants/${itemId}`);
        // Breaks on a 503 gate (phase 'no-stamp' / 'unconfigured') or a 502 control-plane error: throws with the
        // provisioner's own phase and message, not a timeout with `phase` undefined.
        if (p.status() === 503 || p.status() === 502 || pb?.gated === true) {
          throw new Error(
            `tenant create stopped before any ARM resource: HTTP ${p.status()} phase=${pb?.phase ?? '(none)'} ` +
            `gate=${pb?.gate?.id ?? '(none)'} message=${JSON.stringify(String(pb?.error ?? pb?.message ?? '').slice(0, 300))}`,
          );
        }
        r = await getJson(page, `/api/health/tenants/${itemId}`);
      }
      last = r.body; lastStatus = r.status;
      // FAIL FAST on the live create job, not only on the recorded phase (#5388): a console older than the
      // GET's livePhase() still reports `provisioning` after the job has failed, and run 44661794270 then
      // waited the full 12 min with the job's code and message unread. Breaks on job.state 'failed' or
      // 'cancelled' while phase is still 'provisioning': throws naming the job's own code and message.
      const jobState = last?.job?.state;
      if (r.status === 200 && (last?.phase === 'failed' || jobState === 'failed' || jobState === 'cancelled')) {
        await attachJson(testInfo, 'create-job-failed', { phase: last?.phase, job: last?.job, binding: last?.binding, liveError: last?.liveError });
        throw new Error(
          `tenant create failed: phase=${last?.phase} job=${last?.job?.id ?? '(none)'} state=${jobState ?? '(none)'} ` +
          `code=${last?.job?.error?.code ?? '(none)'} message=${JSON.stringify(last?.job?.error?.message ?? null)} ` +
          `binding.lastError=${JSON.stringify(last?.binding?.lastError)} liveError=${JSON.stringify(last?.liveError)}`,
        );
      }
      // FINALISE like the editor does (tenant-editor.tsx, the provisioning poll): when the live create job has
      // SUCCEEDED, ensure once more so the provisioner records the readback receipts and the binding goes
      // 'bound'. The GET is read-only and never finalises, so without this the spec waits 12 min on a tenant
      // that is already active (run 44700233998: tenant.status 'active', binding 'provisioning', resources []).
      // Breaks if the provisioner refuses to bind a succeeded job (e.g. 'readback_missing'): throws its phase.
      if (r.status === 200 && last?.phase === 'provisioning' && jobState === 'succeeded') {
        const f = await page.request.post(`${BASE}/api/health/tenants/${itemId}`, { data: { retry: false }, timeout: 90_000 });
        const fb = await f.json().catch(() => ({}));
        failIfTenantAdminGate(f.status(), fb, `POST /api/health/tenants/${itemId} (finalise)`);
        if (fb?.phase !== 'bound') {
          await attachJson(testInfo, 'finalise-not-bound', { status: f.status(), phase: fb?.phase, error: fb?.error, binding: fb?.binding, steps: fb?.steps });
          throw new Error(
            `create job succeeded but finalise did not bind: HTTP ${f.status()} phase=${fb?.phase ?? '(none)'} ` +
            `code=${fb?.error?.code ?? '(none)'} message=${JSON.stringify(String(fb?.error?.message ?? fb?.error ?? '').slice(0, 300))}`,
          );
        }
        r = await getJson(page, `/api/health/tenants/${itemId}`);
        last = r.body; lastStatus = r.status;
      }
      if (r.status === 200 && last?.phase === 'bound' && last?.tenant?.status === 'active') break;
      await page.waitForTimeout(POLL_MS);
    }
    await attachJson(testInfo, 'tenant-final', { status: lastStatus, phase: last?.phase, tenant: last?.tenant, binding: last?.binding, liveError: last?.liveError });
    // Breaks if the tenant never goes bound+active within 12 min (stuck job, stamp paused, CP down).
    expect(last?.phase, `phase after ${CREATE_TIMEOUT_MS / 60_000} min (liveError=${JSON.stringify(last?.liveError)})`).toBe('bound');
    expect(last?.tenant?.status, 'control-plane tenant status').toBe('active');
    // Breaks if the live CP read failed: the binding would then be only a record, not the CP truth.
    expect(last?.liveError, 'liveError must be null').toBeNull();

    // auto-bind-by-default 2: the backing tenant carries the SAME name as the item; sanitization is recorded.
    const b = last.binding;
    tenantId = String(b?.tenantId || '');
    // Breaks if sourceName/displayName are rewritten (name mapping drift).
    expect(b.sourceName, 'binding.sourceName must equal the item display name').toBe(displayName);
    expect(last.tenant.displayName, 'CP tenant displayName must equal the item display name').toBe(displayName);
    // Breaks if the slug is not the deterministic lowercase of the name; this name needs no sanitizing, so the flag must be false.
    expect(b.tenantId, 'binding.tenantId = deterministic slug of the display name').toBe(displayName.toLowerCase());
    expect(b.tenantIdSanitized, 'no sanitizing is needed for a [a-z0-9-] name of <=20 chars (g1- + 12 digits = 15)').toBe(false);
    expect(last.tenant.id, 'CP tenant id must be the bound slug').toBe(b.tenantId);

    const receipts: Receipt[] = last?.job?.receipts ?? [];
    await attachJson(testInfo, 'create-job-receipts', receipts);
    const readbacks = parseReadbacks(receipts);
    await attachJson(testInfo, 'readback-list', readbacks);
    // Breaks if the job wrote no readback receipts (the create verified nothing) or the line shape changed.
    expect(readbacks.length, 'create job must carry >=1 readback receipt').toBeGreaterThanOrEqual(1);
    // Breaks on any readback that says a resource is missing.
    expect(readbacks.filter((x) => !x.exists), 'readbacks with exists=false').toEqual([]);
    // Breaks if an id is not a full ARM id (e.g. a bare name).
    expect(readbacks.filter((x) => !ARM_ID_RE.test(x.id)), 'every readback id must be a /subscriptions/... ARM id').toEqual([]);
    // Breaks if the job never reached tenant.active.
    expect(receipts.some((x) => x.step === 'tenant.active'), 'create job must record tenant.active').toBe(true);
    armIds = Array.from(new Set(readbacks.map((x) => x.id)));
  });

  test('4. editor screenshots: light, dark, narrow', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    expect(itemId, 'step 2 must have created the item').not.toEqual('');
    await page.goto(`${BASE}/items/${ITEM_TYPE}/${itemId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await expect(page.getByText(displayName, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
    const shots: [string, () => Promise<void>][] = [
      ['editor-light', async () => { await page.emulateMedia({ colorScheme: 'light' }); }],
      ['editor-dark', async () => { await page.emulateMedia({ colorScheme: 'dark' }); }],
      ['editor-narrow-420', async () => { await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 420, height: 900 }); }],
    ];
    for (const [name, setup] of shots) {
      await setup();
      await page.waitForTimeout(800);
      const body = await page.screenshot({ fullPage: true });
      // Breaks if a screenshot comes back (near) empty.
      expect(body.length, `${name} screenshot size`).toBeGreaterThan(5_000);
      await testInfo.attach(name, { body, contentType: 'image/png' });
    }
    // Narrow pass: no horizontal page overflow. Breaks if scrollWidth exceeds the 420px viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await testInfo.attach('narrow-horizontal-overflow-px', { body: String(overflow), contentType: 'text/plain' });
    expect(overflow, 'horizontal overflow in px at 420px wide').toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1600, height: 1000 });
  });

  test('5. DELETE destroys the tenant; every ARM id is deleted and the key is shredded', async ({ page }, testInfo) => {
    test.setTimeout(DESTROY_TIMEOUT_MS + 3 * 60_000);
    expect(armIds.length, 'step 3 must have recorded ARM ids to look for').toBeGreaterThanOrEqual(1);
    const r = await page.request.delete(`${BASE}/api/workspaces/${wsId}/items/${itemId}`, { timeout: 120_000 });
    const body = await r.json().catch(() => ({}));
    if (!r.ok()) console.log(`[health-tenant-g1] DELETE refused (${r.status()}): TENANT MAY STILL BE LIVE: item=${itemId} tenant=${tenantId || displayName.toLowerCase()}`);
    failIfTenantAdminGate(r.status(), body, 'DELETE item');
    // Breaks if the delete is refused (502/503 fail-closed: the CP would not accept the destroy).
    expect(r.ok(), `DELETE item -> ${r.status()}: ${JSON.stringify(body).slice(0, 300)}`).toBe(true);
    expect(body.ok, 'DELETE body.ok').toBe(true);
    // Breaks without PR #5321 (the route answers { ok:true } with no destroy job).
    expect(typeof body.destroyJobId, 'DELETE must return destroyJobId').toBe('string');
    expect(body.destroyJobId, 'destroyJobId must be non-empty').not.toEqual('');
    itemDeleted = true; // the item is gone from here; the destroy job is what remains to verify

    const deadline = Date.now() + DESTROY_TIMEOUT_MS;
    let job: any = null;
    while (Date.now() < deadline) {
      const j = await getJson(page, `/api/health/jobs/${encodeURIComponent(body.destroyJobId)}`);
      job = j.status === 200 ? j.body?.job : null;
      if (job && (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled')) break;
      await page.waitForTimeout(POLL_MS);
    }
    const receipts: Receipt[] = job?.receipts ?? [];
    await attachJson(testInfo, 'destroy-job', { id: body.destroyJobId, kind: job?.kind, state: job?.state, error: job?.error, receipts });
    // Breaks if the job fails, is cancelled, or does not finish within 12 min.
    expect(job?.state, `destroy job state (error=${JSON.stringify(job?.error)})`).toBe('succeeded');
    // Breaks if the job read back is not the destroy kind (wrong job id).
    expect(job?.kind, 'job kind').toBe('tenant.destroy');

    const deleted = receipts.filter((x) => x.step === 'resource.deleted').map((x) => x.detail.toLowerCase());
    // Breaks for any ARM id from the create readback with no resource.deleted line (a leaked resource).
    // Case-insensitive: ARM echoes casing differently between read and delete paths.
    const missing = armIds.filter((id) => !deleted.some((d) => d.includes(`id=${id.toLowerCase()}`)));
    expect(missing, `ARM ids created but with no resource.deleted receipt (${deleted.length} deleted lines)`).toEqual([]);

    const shredded = receipts.filter((x) => x.step === 'key.shredded');
    await attachJson(testInfo, 'key-shredded', shredded);
    // Breaks if no key was shredded (crypto-shred step absent).
    expect(shredded.length, 'destroy must record >=1 key.shredded receipt').toBeGreaterThanOrEqual(1);
    // Breaks if any shredded key is still live.
    expect(shredded.filter((x) => !/\blive=false\b/.test(x.detail)), 'key.shredded lines that are not live=false').toEqual([]);
  });
});
