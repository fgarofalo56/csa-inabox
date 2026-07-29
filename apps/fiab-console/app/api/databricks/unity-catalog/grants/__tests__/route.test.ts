/**
 * BFF tests for the backend-aware UC grants route — the same pane serves
 * Databricks UC (Commercial) and OSS UC (loom-unity, Gov). Covers auth (401),
 * the Databricks config gate (503, skipped on OSS), validation (400), privilege
 * spelling normalization per backend (underscores ↔ spaces), the
 * REGISTERED_MODEL securable, and the LU-4 effective-permissions path (which now
 * works on BOTH backends — the client resolves the inheritance walk itself on
 * OSS — including the `principal=` scope and the honest `warnings[]` passthrough).
 *
 * The LU-4 REMEDIATION half is a security surface, and it is tested as an
 * ATTACK rather than as a happy path: `?effective=true&principal=<someone else>`
 * resolves that principal's transitive Entra group membership with the Console
 * platform identity, so a non-admin aiming it at a THIRD party must 403, must
 * not reach the directory at all, and must leave an audit row. "A can read A's
 * own answer" proves nothing about whether A can read B's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ databricksConfigGate: vi.fn() }));
vi.mock('@/lib/azure/uc-backend', () => ({ isOssUc: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/azure/uc-access-review-audit', () => ({ auditUcAccessReview: vi.fn(async () => {}) }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  primaryWorkspaceHost: vi.fn(async () => 'adb-1.7.azuredatabricks.net'),
  listPermissions: vi.fn(),
  listEffectivePermissions: vi.fn(),
  updatePermissions: vi.fn(),
}));

import { GET, PATCH } from '../route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { auditUcAccessReview } from '@/lib/azure/uc-access-review-audit';
import { listPermissions, listEffectivePermissions, updatePermissions, primaryWorkspaceHost } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'ada@contoso.com', email: 'ada@contoso.com', oid: 'oid-1', name: 'Ada Lovelace' }, exp: 9_999_999_999 };
function getReq(qs = '') { return { nextUrl: new URL(`http://x/api/databricks/unity-catalog/grants${qs}`) } as any; }
function patchReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (databricksConfigGate as any).mockReturnValue(null);
  (isOssUc as any).mockReturnValue(false);
  (isTenantAdmin as any).mockReturnValue(false);
  (auditUcAccessReview as any).mockResolvedValue(undefined);
  (primaryWorkspaceHost as any).mockResolvedValue('adb-1.7.azuredatabricks.net');
});

describe('GET /grants', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq('?securable_type=CATALOG&full_name=sales'));
    expect(res.status).toBe(401);
  });

  it('503 config gate on databricks when the workspace is unset', async () => {
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await GET(getReq('?securable_type=CATALOG&full_name=sales'));
    expect(res.status).toBe(503);
  });

  it('SKIPS the databricks config gate on the OSS backend', async () => {
    (isOssUc as any).mockReturnValue(true);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    (listPermissions as any).mockResolvedValue({ privilege_assignments: [{ principal: 'g', privileges: ['USE CATALOG'] }] });
    const res = await GET(getReq('?securable_type=CATALOG&full_name=sales'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    // OSS space-spelled privileges are normalized to the UI's underscore form,
    // and every row carries an index-aligned `detail[]` — a plain string grant
    // becomes a minimal structured entry so `detail[i]` always describes
    // `privileges[i]` (see the index-alignment specs below).
    expect(j.grants).toEqual([{
      principal: 'g',
      privileges: ['USE_CATALOG'],
      detail: [{ privilege: 'USE_CATALOG', display: 'USE_CATALOG', revocableHere: true, blocked: false }],
    }]);
  });

  it('400 on an unknown securable', async () => {
    const res = await GET(getReq('?securable_type=PIPELINE&full_name=x'));
    expect(res.status).toBe(400);
  });

  it('accepts the REGISTERED_MODEL securable', async () => {
    (listPermissions as any).mockResolvedValue({ privilege_assignments: [] });
    const res = await GET(getReq('?securable_type=REGISTERED_MODEL&full_name=main.sales.churn'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(listPermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'REGISTERED_MODEL', 'main.sales.churn');
  });

  it('effective=true uses the effective-permissions path and renders provenance', async () => {
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [{ principal: 'g', privileges: [{ privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'main' }] }],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    const j = await res.json();
    expect(j.effective).toBe(true);
    // The securable the grant actually lives on must reach the UI — "(inherited)"
    // alone does not tell the operator WHERE to go to revoke it.
    expect(j.grants[0].privileges).toEqual(['SELECT (inherited from CATALOG main)']);
  });

  it('LU-4: effective=true is served on the OSS backend too (no Databricks-only fallback)', async () => {
    (isOssUc as any).mockReturnValue(true);
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [{ principal: 'dana@contoso.com', privileges: [{ privilege: 'MANAGE', source: 'OWNERSHIP', inherited_from_type: 'CATALOG', inherited_from_name: 'main' }] }],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.effective).toBe(true);
    expect(j.note).toBeUndefined();
    expect(listEffectivePermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'TABLE', 'main.sales.orders', undefined);
    expect(listPermissions).not.toHaveBeenCalled();
    expect(j.grants[0].privileges).toEqual(['MANAGE (inherited: owner of CATALOG main)']);
  });

  it('passes principal= through and returns the group closure + warnings (SELF query)', async () => {
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [{ principal: 'ada@contoso.com', privileges: [{ privilege: 'SELECT', via_principal: 'analysts' }] }],
      warnings: ['Could not read grants on CATALOG main: PERMISSION_DENIED.'],
      principal_closure: ['ada@contoso.com', 'analysts'],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true&principal=ada%40contoso.com'));
    const j = await res.json();
    expect(listEffectivePermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'TABLE', 'main.sales.orders', { principal: 'ada@contoso.com' });
    expect(j.principalClosure).toEqual(['ada@contoso.com', 'analysts']);
    expect(j.warnings).toHaveLength(1);
    expect(j.grants[0].privileges).toEqual(['SELECT (via analysts)']);
  });

  it('does NOT ask for effective permissions unless effective=true', async () => {
    (listPermissions as any).mockResolvedValue({ privilege_assignments: [{ principal: 'g', privileges: ['SELECT'] }] });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&principal=ada%40contoso.com'));
    const j = await res.json();
    expect(j.effective).toBe(false);
    expect(listEffectivePermissions).not.toHaveBeenCalled();
  });
});

describe('PATCH /grants', () => {
  it('normalizes privileges to underscores for databricks', async () => {
    (updatePermissions as any).mockResolvedValue({ privilege_assignments: [] });
    const res = await PATCH(patchReq({
      securable_type: 'CATALOG', full_name: 'sales',
      changes: [{ principal: 'g', add: ['use catalog', 'CREATE_SCHEMA'] }],
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(updatePermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'CATALOG', 'sales', {
      add: [{ principal: 'g', privileges: ['USE_CATALOG', 'CREATE_SCHEMA'] }],
      remove: [],
    });
  });

  it('normalizes privileges to spaces for the OSS server', async () => {
    (isOssUc as any).mockReturnValue(true);
    (updatePermissions as any).mockResolvedValue({ privilege_assignments: [] });
    await PATCH(patchReq({
      securable_type: 'SCHEMA', full_name: 'main.sales',
      changes: [{ principal: 'g', add: ['USE_SCHEMA'], remove: ['SELECT'] }],
    }));
    expect(updatePermissions).toHaveBeenCalledWith(expect.any(String), 'SCHEMA', 'main.sales', {
      add: [{ principal: 'g', privileges: ['USE SCHEMA'] }],
      remove: [{ principal: 'g', privileges: ['SELECT'] }],
    });
  });

  it('400 when no valid changes', async () => {
    const res = await PATCH(patchReq({ securable_type: 'CATALOG', full_name: 'sales', changes: [{ principal: '' }] }));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// LU-4 remediation — the directory-enumeration guard, tested as an ATTACK
// ============================================================

describe('GET /grants?effective&principal — principal-probe authorization', () => {
  const EFFECTIVE = { privilege_assignments: [{ principal: 'x', privileges: [{ privilege: 'SELECT' }] }] };

  function probe(principal: string) {
    return GET(getReq(`?securable_type=TABLE&full_name=main.sales.orders&effective=true&principal=${encodeURIComponent(principal)}`));
  }

  it('ATTACK: a non-admin probing a THIRD PARTY is refused 403 and never reaches the directory', async () => {
    (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
    const res = await probe('ceo@contoso.com');
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('principal_probe_forbidden');
    expect(j.remediation).toBeTruthy();
    // The whole point: the Graph-backed closure walk must NOT run. Reaching
    // listEffectivePermissions at all would resolve the CEO's group membership
    // with the Console platform identity.
    expect(listEffectivePermissions).not.toHaveBeenCalled();
    expect(listPermissions).not.toHaveBeenCalled();
    // …and the response must not leak any part of the answer.
    expect(j.grants).toBeUndefined();
    expect(j.principalClosure).toBeUndefined();
  });

  it('ATTACK: probing a GROUP name is refused the same way (group != self)', async () => {
    (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
    const res = await probe('platform-admins');
    expect(res.status).toBe(403);
    expect(listEffectivePermissions).not.toHaveBeenCalled();
  });

  it('ATTACK: the caller\'s DISPLAY NAME is not an identity — probing it is refused', async () => {
    // A display name is neither unique nor directory-controlled; matching on it
    // would let "Ada Lovelace" probe a group called "Ada Lovelace".
    (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
    const res = await probe('Ada Lovelace');
    expect(res.status).toBe(403);
    expect(listEffectivePermissions).not.toHaveBeenCalled();
  });

  it('every DENIAL is audited (a silent 403 tells nobody an enumeration sweep is running)', async () => {
    await probe('ceo@contoso.com');
    expect(auditUcAccessReview).toHaveBeenCalledTimes(1);
    expect((auditUcAccessReview as any).mock.calls[0][1]).toMatchObject({
      decision: 'denied-principal-probe',
      probedPrincipal: 'ceo@contoso.com',
      securableType: 'TABLE',
      securableName: 'main.sales.orders',
      effective: true,
    });
  });

  it('ALLOWS the caller to ask about ITSELF, by upn / email / oid', async () => {
    for (const me of ['ada@contoso.com', 'ADA@CONTOSO.COM', 'oid-1']) {
      vi.clearAllMocks();
      (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
      const res = await probe(me);
      expect(res.status).toBe(200);
      expect(listEffectivePermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'TABLE', 'main.sales.orders', { principal: me });
    }
  });

  it('ALLOWS a tenant admin to probe anyone (that is the access-review audience)', async () => {
    (isTenantAdmin as any).mockReturnValue(true);
    (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
    const res = await probe('ceo@contoso.com');
    expect(res.status).toBe(200);
    expect(listEffectivePermissions).toHaveBeenCalled();
  });

  it('audits every ALLOWED effective query too, with blast-radius counters', async () => {
    (isTenantAdmin as any).mockReturnValue(true);
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [
        { principal: 'a', privileges: [{ privilege: 'SELECT' }] },
        { principal: 'b', privileges: [{ privilege: 'MODIFY' }] },
      ],
      principal_closure: ['ceo@contoso.com', 'execs'],
    });
    await probe('ceo@contoso.com');
    expect((auditUcAccessReview as any).mock.calls[0][1]).toMatchObject({
      decision: 'allowed', probedPrincipal: 'ceo@contoso.com', resultPrincipals: 2, closureSize: 2,
    });
  });

  it('audits the UNFILTERED effective enumeration as well', async () => {
    (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    expect(res.status).toBe(200);
    expect((auditUcAccessReview as any).mock.calls[0][1]).toMatchObject({ decision: 'allowed', effective: true });
    expect((auditUcAccessReview as any).mock.calls[0][1].probedPrincipal).toBeUndefined();
  });

  it('an audit-sink failure never breaks (or blocks) the guarded read', async () => {
    (auditUcAccessReview as any).mockRejectedValue(new Error('cosmos down'));
    (listEffectivePermissions as any).mockResolvedValue(EFFECTIVE);
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('GET /grants — structured provenance reaches the client', () => {
  it('returns detail[] with revocability + blocked flags, not just display text', async () => {
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [{
        principal: 'ada@contoso.com',
        privileges: [
          { privilege: 'SELECT', inherited_from_type: 'CATALOG', inherited_from_name: 'owner', via_principal: 'analysts' },
          { privilege: 'MODIFY', blocked_by: ['USE_CATALOG on CATALOG main'] },
        ],
        usage: [{ privilege: 'USE_CATALOG', securable_type: 'CATALOG', securable_name: 'main', status: 'missing' }],
      }],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    const j = await res.json();
    // A securable literally named `owner` used to mis-tint, and a via-group row
    // used to look locally revocable, because the pane re-parsed this string.
    expect(j.grants[0].detail).toEqual([
      expect.objectContaining({ privilege: 'SELECT', revocableHere: false, blocked: false }),
      expect.objectContaining({ privilege: 'MODIFY', revocableHere: true, blocked: true }),
    ]);
    expect(j.grants[0].usage).toHaveLength(1);
  });

  it('reports whether the group closure was ACTUALLY resolved', async () => {
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [],
      principal_closure: ['ada@contoso.com'],
      closure_resolved: false,
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true&principal=ada%40contoso.com'));
    const j = await res.json();
    // The pane keys its "…nor any group it belongs to" empty state off this. It
    // must not assert a negative it never verified.
    expect(j.closureResolved).toBe(false);
  });

  // ── ROUND-3: the two arrays the pane pairs by INDEX ────────────────────────
  // `page.tsx` rendered `g.privileges.map((p, i) => <Badge color={
  // privilegeBadgeColor(g.detail?.[i])}>)`. The BFF built those two arrays with
  // DIFFERENT filters over the same raw list — `raw.map(format).filter(Boolean)`
  // vs `raw.filter(v => typeof v === 'object')` — so any string entry, or any
  // object whose privilege formats to '', shifted every later index and a
  // BLOCKED privilege could render brand-tinted "granted here". They are one
  // list now, and these specs pin the invariant.

  it('keeps detail[] index-aligned with privileges[] when the row MIXES strings and objects', async () => {
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [{
        principal: 'ada@contoso.com',
        privileges: [
          'SELECT',                                                               // a plain string — the shifter
          { privilege: '' },                                                      // formats to '' — dropped from privileges[]
          { privilege: 'MODIFY', inherited_from_type: 'CATALOG', inherited_from_name: 'main' },
          { privilege: 'APPLY_TAG', blocked_by: ['USE_CATALOG on CATALOG main'] },
        ],
      }],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    const row = (await res.json()).grants[0];

    expect(row.detail).toHaveLength(row.privileges.length);
    row.detail.forEach((d: any, i: number) => expect(d.display).toBe(row.privileges[i]));

    // The three that survive, in order, each carrying ITS OWN provenance.
    expect(row.privileges).toEqual([
      'SELECT',
      'MODIFY (inherited from CATALOG main)',
      'APPLY_TAG (BLOCKED — needs USE_CATALOG on CATALOG main)',
    ]);
    // The direct grant is revocable here and NOT blocked…
    expect(row.detail[0]).toMatchObject({ privilege: 'SELECT', revocableHere: true, blocked: false });
    // …the inherited one is NOT revocable here (revoking it here does nothing)…
    expect(row.detail[1]).toMatchObject({ privilege: 'MODIFY', revocableHere: false, blocked: false });
    // …and the BLOCKED one is flagged blocked. Under the old index pairing this
    // landed on detail[1] and rendered as an ordinary inherited badge.
    expect(row.detail[2]).toMatchObject({ privilege: 'APPLY_TAG', blocked: true });
  });

  it('gives a plain direct-grant row a detail[] too, so the pane never falls back to positional guessing', async () => {
    (listPermissions as any).mockResolvedValue({
      privilege_assignments: [{ principal: 'ada@contoso.com', privileges: ['SELECT', 'MODIFY'] }],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders'));
    const row = (await res.json()).grants[0];
    expect(row.detail).toHaveLength(2);
    expect(row.detail.map((d: any) => d.display)).toEqual(row.privileges);
    // A grant recorded here IS revocable here.
    expect(row.detail.every((d: any) => d.revocableHere && !d.blocked)).toBe(true);
  });
});
