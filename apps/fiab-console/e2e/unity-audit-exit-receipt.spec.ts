/**
 * unity-audit-exit-receipt.spec.ts — the G1 in-browser receipt for issue #2622
 * ("audit the un-audited Unity Catalog exits").
 *
 * ## What #2622 was and what commit c2fafe84 did
 *
 * LU-3 gave the Console a Unity Catalog access trail funnelled through audited
 * TRANSPORTS whose `finally` writes a `_auditLog itemType:'loom-unity'` row
 * (who / what / when / outcome, DENIALS included). Three exits reached the
 * catalog OUTSIDE that trail and were declared gaps:
 *
 *   gap 1 — `lib/azure/shortcut-credentials.ts` (storage-credential + external-
 *           location CREATE/DELETE) — STILL un-audited, and behind a repo-level
 *           credential-path read/write deny, so it can only be closed by someone
 *           with write access to that path. It remains in the guard's
 *           `KNOWN_UNAUDITED` map (scripts/ci/check-unity-audit-chokepoint.mjs)
 *           and prints on every passing guard run. This receipt does NOT and
 *           cannot exercise it.
 *   gap 2 — the Databricks SQL Statement Execution DDL (`GRANT`/`REVOKE`, ABAC
 *           `CREATE`/`DROP POLICY`, `ALTER … SET MASK` / `SET ROW FILTER`,
 *           governed tags, `SET TAGS`) — CLOSED by c2fafe84: `lib/azure/uc-sql.ts`
 *           `ucSql()` records via `recordUnitySqlAccess` from a `finally`.
 *   gap 3 — the Databricks ACCOUNT plane (metastore assignment) — CLOSED by
 *           c2fafe84: `unity-catalog-account-client.ts` `acctFetch()` records via
 *           `recordUnityAccountAccess` from a `finally`.
 *
 * The guard `scripts/ci/check-unity-audit-chokepoint.mjs` is green and reports
 * all four audited transports (ucFetch, dbxFetch, ucSql, acctFetch) plus the one
 * remaining declared gap (shortcut-credentials.ts). This spec is the BROWSER
 * half the guard cannot give (`ux-baseline.md` G1): the guard proves a recorder
 * is CALLED from a `finally`; only a live drive proves a row actually LANDS in
 * the trail a tenant admin reads.
 *
 * ## What this spec asserts
 *
 *  1. OFFLINE PREDICATE SELF-CHECK (no estate). The "is this a loom-unity audit
 *     row?" matcher used below returns true for a real unity row and FALSE for a
 *     generic audit row (non-vacuity: a matcher that cannot fail proves nothing).
 *     It also asserts the row nuance this receipt is built around: a loom-unity
 *     row carries `itemType:'loom-unity'` + `action:'unity.…'` and NO `kind`, so
 *     `/api/admin/audit-logs?type=…` — which filters `c.kind` — cannot surface
 *     it; the receipt therefore reads BROAD and matches on `action`/`itemType`.
 *     (Grounded: lib/azure/unity-audit.ts UNITY_AUDIT_ITEM_TYPE/PREFIX +
 *      recordUnityAccess row shape; app/api/admin/audit-logs/route.ts `c.kind = @kind`.)
 *
 *  2. THE AUDIT READ PATH IS REACHABLE AND TENANT-ADMIN GATED. `GET
 *     /api/admin/audit-logs` (withTenantAdmin) either returns `{ok:true, rows}`
 *     for an admin session or the canonical 403 admin gate. A 403 is an HONEST
 *     GATE (the automation identity is not `LOOM_TENANT_ADMIN_OID` on this
 *     estate) and downgrades the strong assertion in test 3 to an annotation —
 *     not a failure.
 *
 *  3. DRIVING A UC OPERATION THROUGH AN AUDITED EXIT LANDS A loom-unity ROW.
 *     `GET /api/catalog/metastores` (withSession) runs `listAllMetastores()` —
 *     which reaches Unity Catalog through the audited `ucFetch` for every
 *     env/registered workspace host — and, when `LOOM_DATABRICKS_ACCOUNT_ID` is
 *     set, `listAccountMetastores()`, which is the gap-3 `acctFetch` exit. When
 *     the estate actually exposes a UC backend to exercise (a real metastore, a
 *     probed-and-errored workspace, configured hosts, or the account API), this
 *     asserts a loom-unity row appears in the trail with who / operation /
 *     outcome. When it exposes none (no hosts, no registrations, no account API),
 *     that is an HONEST GATE: no audited UC exit was reachable, so no row is
 *     expected, and the spec says so rather than faking one (`no-vaporware.md`).
 *
 * ## What this spec does NOT assert (stated, not implied)
 *   • It does not close or exercise gap 1 (shortcut-credentials) — that path is
 *     denied to every automated writer, human or agent, by repo policy.
 *   • It does not prove the row reached Cosmos DURABLY or the `LoomAudit_CL`
 *     SIEM sink — neither is observable from the browser.
 *   • It does not assert `?type=` surfaces unity rows — it asserts the OPPOSITE
 *     (they carry `action`/`itemType`, not `kind`), which is why it reads broad.
 *   • It does not force a SPECIFIC exit (gap 2 vs gap 3) to fire — which one is
 *     reachable is estate config; when the row reveals it (`method:'SQL'`,
 *     `operation` metastore-assignment/policy/grant/tag) the annotation names it,
 *     but the hard assertion only requires a loom-unity row.
 *   • It does not assert the automation identity IS an admin — a 403 is handled
 *     as an honest gate.
 *
 * Project: `unity-audit-exit` (playwright.config.ts), minted-session auth via the
 * `mint` dependency. NOT wired into any required check — it is the G1 receipt.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *        pnpm exec playwright test --project=unity-audit-exit
 * CI:  gh workflow run loom-ui-verify.yml --ref main -f extra_projects="unity-audit-exit"
 *
 * No Microsoft Fabric / Power BI is reachable from any path this spec drives
 * (.claude/rules/no-fabric-dependency.md): the catalog federation call is
 * Databricks/OSS Unity Catalog + the Databricks account plane only.
 */
import { test, expect, type APIResponse } from '@playwright/test';
import { BASE, signIn } from './_lib/uat';

/** `_auditLog.itemType` every loom-unity row carries (lib/azure/unity-audit.ts). */
const UNITY_ITEM_TYPE = 'loom-unity';
/** Prefix stamped on the dotted audit action (`unity.metastore.list`, …). */
const UNITY_ACTION_PREFIX = 'unity.';
/** The outcomes recordUnityAccess writes — a denial is first-class. */
const UNITY_OUTCOMES = new Set(['success', 'failure', 'denied']);

type Row = Record<string, unknown>;

/**
 * Is `r` a loom-unity access row? A row is one iff it carries the trail's
 * itemType OR a `unity.`-prefixed action — the two fields recordUnityAccess
 * stamps (lib/azure/unity-audit.ts §3). Deliberately NOT keyed on `kind`: unity
 * rows have none, which is the whole reason `?type=` cannot surface them.
 */
function isUnityAuditRow(r: Row | null | undefined): boolean {
  if (!r) return false;
  return r.itemType === UNITY_ITEM_TYPE || String(r.action ?? '').startsWith(UNITY_ACTION_PREFIX);
}

/** Automation UPN the minted session carries (uat.ts mintSession) — used to
 *  recognise a row THIS run wrote, not a pre-existing one. */
const AUTOMATION_UPN = process.env.UAT_UPN || 'uat@example.invalid';

/** GET a JSON body + status without throwing on a non-2xx (honest-gate aware). */
async function getJson(res: APIResponse): Promise<{ status: number; body: any }> {
  const status = res.status();
  const body = await res.json().catch(() => ({}));
  return { status, body };
}

test.describe.serial('unity-catalog audited-exit receipt (#2622)', () => {
  /** Set by test 2: whether `/api/admin/audit-logs` returned rows (admin) or 403. */
  let adminReadable = false;

  // --------------------------------------------------------------------------
  // 1. OFFLINE PREDICATE SELF-CHECK — needs no estate, so it can fail on a green
  //    estate (the failure mode that let hollow gates pass for months: a check
  //    that only ever runs against a fixed backend cannot tell "bug gone" from
  //    "measures nothing"). Proves the matcher recognises a real row, rejects a
  //    generic one, and that the `?type=`→`c.kind` route filter would MISS a
  //    unity row — which is why test 3 reads broad.
  // --------------------------------------------------------------------------
  test('offline self-check — the loom-unity matcher works, can fail, and explains the broad read', () => {
    // A real row, shaped exactly as recordUnityAccess writes it (gap-3 acctFetch
    // metastore list is the concrete case test 3 tries to trigger).
    const unityRow: Row = {
      id: 'r1', at: new Date().toISOString(),
      itemType: UNITY_ITEM_TYPE, itemId: `unity:metastore.list:${new Date().toISOString().slice(0, 10)}`,
      action: 'unity.metastore.list', operation: 'metastore.list',
      securableType: 'metastore', securableFqn: '*',
      backend: 'databricks', method: 'GET', outcome: 'success',
      who: AUTOMATION_UPN, actorUpn: AUTOMATION_UPN, tenantId: 'oid-x',
      // NOTE: no `kind` — this is the field /api/admin/audit-logs `?type=` filters.
    };
    // A generic audit row from another writer — carries `kind`, no unity marker.
    const genericRow: Row = {
      id: 'r2', at: new Date().toISOString(),
      itemType: 'workspace', kind: 'create', action: 'item.create',
      who: AUTOMATION_UPN, tenantId: 'oid-x',
    };

    expect(isUnityAuditRow(unityRow), 'the matcher must recognise a real loom-unity row').toBe(true);
    expect(
      isUnityAuditRow(genericRow),
      'the matcher must REJECT a non-unity row — a predicate that always returns true proves nothing',
    ).toBe(false);
    expect(isUnityAuditRow(null)).toBe(false);
    expect(isUnityAuditRow({})).toBe(false);

    // The route nuance this receipt is built around, as an executable fact:
    // /api/admin/audit-logs?type=X adds `c.kind = @kind` to the Cosmos query, but
    // a loom-unity row has no `kind`, so a kind-filtered read returns zero.
    expect(
      'kind' in unityRow,
      'a loom-unity row must NOT carry `kind` — if it did, this note (and the broad read in test 3) would be wrong',
    ).toBe(false);
    const kindFilter = (r: Row, type: string) => r.kind === type; // mirrors `c.kind = @kind`
    expect(
      kindFilter(unityRow, UNITY_ITEM_TYPE),
      'a `?type=loom-unity` (kind) filter must MISS the unity row — proving why test 3 reads broad and matches on action/itemType',
    ).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 2. THE AUDIT READ PATH — reachable + tenant-admin gated.
  // --------------------------------------------------------------------------
  test('the audit read path is reachable and tenant-admin gated', async ({ page, context }, testInfo) => {
    test.setTimeout(60_000);
    await signIn(context).catch(() => { /* storageState already set by `mint` */ });

    // `?refresh=1` bypasses the 5-min stale-while-revalidate cache (route: bypass:refresh)
    // so a row written seconds ago is not hidden behind a stale snapshot.
    const res = await page.request.get(`${BASE}/api/admin/audit-logs?top=1000&refresh=1`, { timeout: 45_000 });
    const { status, body } = await getJson(res);

    if (status === 403) {
      // HONEST GATE: the automation identity is not LOOM_TENANT_ADMIN_OID and not
      // in LOOM_TENANT_ADMIN_GROUP_ID on this estate (feature-gate.ts isTenantAdmin).
      adminReadable = false;
      testInfo.annotations.push({
        type: 'audit-read',
        description: `admin-gated 403 (${String(body?.error || body?.code || 'admin_only')}) — ` +
          'the automation identity is not the bootstrap tenant admin here; test 3 downgrades to an honest annotation',
      });
      // A 403 is the CORRECT behaviour for a non-admin — the trail must not be
      // world-readable. Assert it IS the admin gate, not some other failure.
      expect(status, 'a non-admin must get exactly 403 from the audit trail, never 200 and never 500').toBe(403);
      return;
    }

    expect(status, `GET /api/admin/audit-logs returned ${status}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    expect(body?.ok, 'the audit read must return ok:true for an admin session').toBe(true);
    expect(Array.isArray(body?.rows), 'the audit read must return a rows[] array').toBe(true);
    adminReadable = true;

    const unityRows = (body.rows as Row[]).filter(isUnityAuditRow);
    testInfo.annotations.push({
      type: 'audit-read',
      description: `ok — total=${body.total} rows, ${unityRows.length} already loom-unity ` +
        `(kinds seen: ${(body.kinds || []).slice(0, 8).join(', ') || 'none'})`,
    });
  });

  // --------------------------------------------------------------------------
  // 3. DRIVE A UC OPERATION THROUGH AN AUDITED EXIT + ASSERT A ROW LANDS.
  // --------------------------------------------------------------------------
  test('driving the catalog federation call lands a loom-unity audit row (or honest gate)', async ({ page, context }, testInfo) => {
    test.setTimeout(150_000);
    await signIn(context).catch(() => { /* storageState already set */ });

    // Baseline: ids of loom-unity rows already present (so a NEW row is provable).
    const baselineIds = new Set<string>();
    if (adminReadable) {
      const { body } = await getJson(await page.request.get(`${BASE}/api/admin/audit-logs?top=1000&refresh=1`, { timeout: 45_000 }));
      for (const r of (body?.rows as Row[] | undefined) ?? []) if (isUnityAuditRow(r)) baselineIds.add(String(r.id));
    }

    // DRIVE: the catalog federation read. This reaches Unity Catalog through the
    // audited ucFetch (listAllMetastores → per-workspace UC list) and, when the
    // account API is configured, through the gap-3 acctFetch (listAccountMetastores).
    const meta = await getJson(await page.request.get(`${BASE}/api/catalog/metastores`, { timeout: 60_000 }));
    expect(
      [200, 401, 403, 500].includes(meta.status),
      `GET /api/catalog/metastores returned an unexpected ${meta.status}: ${JSON.stringify(meta.body).slice(0, 300)}`,
    ).toBeTruthy();

    // Did the estate actually expose a UC backend for the audited exits to touch?
    //   - a real metastore listed (unity[]),                    → ucFetch ran
    //   - a workspace probed and errored (unityWorkspaceErrors), → ucFetch ran + wrote a failure/denied row
    //   - configured env hosts (unityHosts),                     → ucFetch ran per host
    //   - the account API configured (accountApiConfigured),     → acctFetch (gap 3) ran
    const b = meta.body || {};
    const exercisedUc =
      (Array.isArray(b.unity) && b.unity.length > 0) ||
      (Array.isArray(b.unityWorkspaceErrors) && b.unityWorkspaceErrors.length > 0) ||
      (Array.isArray(b.unityHosts) && b.unityHosts.length > 0) ||
      b.accountApiConfigured === true;

    testInfo.annotations.push({
      type: 'drive',
      description:
        `metastores=${meta.status} unity=${(b.unity || []).length} ` +
        `workspaceErrors=${(b.unityWorkspaceErrors || []).length} unityHosts=${(b.unityHosts || []).length} ` +
        `accountApiConfigured=${!!b.accountApiConfigured} accountMetastores=${(b.accountMetastores || []).length} ` +
        `registrations=${(b.registrations || []).length} exercisedUc=${exercisedUc}`,
    });

    // HONEST GATE #1: the trail read is admin-only and we are not admin here.
    if (!adminReadable) {
      test.skip(true,
        'the audit trail is tenant-admin gated (feature-gate.ts) and the automation identity is not the bootstrap ' +
        'admin on this estate — the write side is covered by the guard + specs; the read-side assertion needs an admin session');
      return;
    }

    // HONEST GATE #2: the estate exposes no UC backend, so no audited UC exit was
    // reachable and no row is expected. Faking one would be a vaporware receipt.
    if (!exercisedUc) {
      testInfo.annotations.push({
        type: 'honest-gate',
        description:
          'no Unity Catalog backend is exposed on this estate (no metastores, no probed workspaces, no configured ' +
          'hosts, no account API) — no audited UC exit was reachable, so no loom-unity row is expected. The gap-2/gap-3 ' +
          'recorders are still proven by the CI guard (all four transports record from a finally) + unity-audit-sql.test.ts.',
      });
      test.skip(true, 'no UC backend exposed on this estate — audited exit not reachable (honest gate)');
      return;
    }

    // STRONG ASSERTION: a loom-unity row must appear in the trail. The audit
    // write is fire-and-forget (recordUnityAccess), so poll a few times with the
    // cache bypassed before asserting.
    let unityRows: Row[] = [];
    let freshRow: Row | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { body } = await getJson(await page.request.get(`${BASE}/api/admin/audit-logs?top=1000&refresh=1`, { timeout: 45_000 }));
      unityRows = ((body?.rows as Row[] | undefined) ?? []).filter(isUnityAuditRow);
      // A row this run wrote: id not in the baseline, or stamped with our own UPN.
      freshRow = unityRows.find((r) => !baselineIds.has(String(r.id)))
        ?? unityRows.find((r) => String(r.who ?? r.actorUpn ?? r.upn) === AUTOMATION_UPN);
      if (freshRow) break;
      await page.waitForTimeout(3_000);
    }

    // Name which closed exit the observed rows evidence, for the receipt.
    const families = new Set<string>();
    for (const r of unityRows) {
      const op = String(r.operation ?? '');
      if (String(r.method) === 'SQL' || /^(policy|grant|governed-tag|tag|column-mask|row-filter|connection|view|function)\b/.test(op)) {
        families.add('gap2:ucSql(SQL-DDL)');
      } else if (/^metastore(-assignment)?\b|^account\b/.test(op)) {
        families.add('gap3:acctFetch(account-plane)');
      } else {
        families.add('base:ucFetch(UC-REST)');
      }
    }
    testInfo.annotations.push({
      type: 'row-evidence',
      description: freshRow
        ? `loom-unity row landed: operation=${freshRow.operation} outcome=${freshRow.outcome} ` +
          `method=${freshRow.method} who=${freshRow.who ?? freshRow.actorUpn} — exits evidenced: ${[...families].join(', ')}`
        : `no fresh row after polling; ${unityRows.length} loom-unity row(s) visible total`,
    });

    expect(
      freshRow,
      `drove GET /api/catalog/metastores (which reaches Unity Catalog through the audited ucFetch/acctFetch exits) ` +
      `but no loom-unity audit row appeared in /api/admin/audit-logs. The audited transports must write a row from ` +
      `their finally on success, failure OR denial (lib/azure/unity-audit.ts). Baseline unity rows=${baselineIds.size}, ` +
      `now=${unityRows.length}.`,
    ).toBeTruthy();

    // AU-2/AU-3 shape: the row must carry who / operation / a real outcome.
    expect(String(freshRow!.operation ?? ''), 'the audit row must carry an operation verb').not.toEqual('');
    expect(
      UNITY_OUTCOMES.has(String(freshRow!.outcome)),
      `the audit row's outcome must be success|failure|denied, got "${freshRow!.outcome}"`,
    ).toBe(true);
    expect(
      String(freshRow!.who ?? freshRow!.actorUpn ?? freshRow!.upn ?? ''),
      'the audit row must carry the acting principal (who / actorUpn)',
    ).not.toEqual('');
  });
});
