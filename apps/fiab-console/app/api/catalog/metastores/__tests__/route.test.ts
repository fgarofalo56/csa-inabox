/**
 * #4656 — GET /api/catalog/metastores must not report `ok:true` over a failed
 * Unity workspace listing. gov-bff-verify measured, red 10/10:
 *   {"ok":true,"unity":[],"unityWorkspaceErrors":[{"workspace_hostname":
 *   "loom-unity.internal...", ...}]}
 * — a caller checking only `ok` sees a healthy, empty catalog. The shared
 * `ok` field is deliberately left untouched (flipping it blanks the WHOLE
 * Console catalog page, including the registrations/OneLake/Purview backends
 * that still work — a bigger no-vaporware.md violation than the one being
 * fixed). `unityOk` is the new honest, top-level sibling field.
 *
 * WHAT WOULD MAKE EACH ASSERTION FAIL (assertion-design.md): reverting the
 * route to the pre-fix shape — `const result: any = { ok: true }` with no
 * `unityOk` flip in either the per-workspace-error branch or the outer catch
 * — makes `body.unityOk` always `undefined`, so every `expect(body.unityOk)`
 * below fails. See the mutation-proof note in the PR description.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/azure/purview-endpoints', () => ({
  normalizePurviewAccountName: vi.fn((a: string) => a),
  purviewBaseSync: vi.fn(() => 'https://x.purview.azure.com'),
}));

vi.mock('@/lib/azure/unity-catalog-client', () => ({
  listAllMetastores: vi.fn(),
  listMetastoresFromWorkspace: vi.fn(),
  listWorkspaceHostnames: vi.fn(() => []),
  listCatalogs: vi.fn(),
  UnityCatalogNotConfiguredError: class UnityCatalogNotConfiguredError extends Error {
    hint: any;
  },
  UnityCatalogError: class UnityCatalogError extends Error {
    status?: number;
  },
}));

vi.mock('@/lib/azure/unity-catalog-account-client', () => ({
  listAccountMetastores: vi.fn(),
  getWorkspaceMetastoreAssignment: vi.fn(),
  assignMetastore: vi.fn(),
  isAccountApiConfigured: vi.fn(() => false),
  UnityCatalogAccountError: class UnityCatalogAccountError extends Error {
    accountAdmin?: boolean;
  },
}));

vi.mock('@/lib/azure/onelake-catalog-client', () => ({
  listOneLakeWorkspaces: vi.fn(async () => []),
}));

vi.mock('@/lib/azure/databricks-discovery', () => ({
  listDatabricksWorkspaces: vi.fn(async () => []),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  metastoreRegistrationsContainer: vi.fn(async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      upsert: vi.fn(),
    },
  })),
}));

vi.mock('@/lib/azure/purview-client', () => ({
  registerDatabricksUnityCatalogSource: vi.fn(),
  defineDatabricksUnityCatalogScan: vi.fn(),
  triggerScanRun: vi.fn(),
  PurviewNotConfiguredError: class PurviewNotConfiguredError extends Error {
    hint: any;
  },
  PurviewError: class PurviewError extends Error {
    status?: number;
  },
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { listAllMetastores } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { oid: 'tenant-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  delete process.env.LOOM_PURVIEW_ACCOUNT;
  delete process.env.LOOM_DATABRICKS_ACCOUNT_ID;
});

function call() {
  return GET({} as any);
}

describe('GET /api/catalog/metastores — #4656 unityOk honesty', () => {
  it('flips unityOk false when a genuinely-expected workspace errors, without touching ok', async () => {
    // Exact shape listAllMetastores() returns per unity-catalog-client.ts:
    // one real metastore plus a synthetic ERROR_ row for a non-account-admin
    // failure (a DNS/connectivity failure on a configured host, per #4656).
    (listAllMetastores as any).mockResolvedValue([
      { metastore_id: 'm1', name: 'good', workspace_hostname: 'good.azuredatabricks.net' },
      {
        metastore_id: 'ERROR_loom-unity.internal',
        name: '(workspace loom-unity.internal unreachable — no HTTP response (ENOTFOUND): getaddrinfo ENOTFOUND loom-unity.internal)',
        workspace_hostname: 'loom-unity.internal',
      },
    ]);

    const res = await call();
    const body = await res.json();

    expect(body.unity).toHaveLength(1);
    expect(body.unityWorkspaceErrors).toHaveLength(1);
    // THE #4656 FIX: the real state must not be buried only in the sibling
    // array above — a caller checking just `unityOk` must see the failure.
    expect(body.unityOk).toBe(false);
    // THE DELIBERATE NON-CHANGE: `ok` stays true — the envelope executed and
    // the OTHER backends (registrations/onelake/purview) are unaffected; the
    // Console page would otherwise blank entirely on a Unity-only outage.
    expect(body.ok).toBe(true);
  });

  it('positive control: unityOk stays true when every workspace lists cleanly', async () => {
    (listAllMetastores as any).mockResolvedValue([
      { metastore_id: 'm1', name: 'good', workspace_hostname: 'good.azuredatabricks.net' },
    ]);

    const res = await call();
    const body = await res.json();

    expect(body.unityWorkspaceErrors).toBeUndefined();
    expect(body.unityOk).toBe(true);
    expect(body.ok).toBe(true);
  });

  it('an account-admin-only gate (no UC metastore created yet) does NOT flip unityOk', async () => {
    // This is the pre-existing, intentionally benign state (ACCOUNT_ADMIN_GATE)
    // — distinct from the #4656 defect, which is about workspaces that were
    // EXPECTED to list succeeding and silently failing instead.
    (listAllMetastores as any).mockResolvedValue([
      {
        metastore_id: 'ERROR_ws1.azuredatabricks.net',
        name: 'This API is only available to account admins',
        workspace_hostname: 'ws1.azuredatabricks.net',
      },
    ]);

    const res = await call();
    const body = await res.json();

    expect(body.accountAdminGate).toBeDefined();
    expect(body.unityOk).toBe(true);
    expect(body.ok).toBe(true);
  });

  it('a total listing failure (e.g. not configured) also flips unityOk', async () => {
    const err: any = new Error('Unity Catalog is not configured: no hostnames env, no Cosmos rows');
    (listAllMetastores as any).mockRejectedValue(err);

    const res = await call();
    const body = await res.json();

    expect(body.unityError).toBeDefined();
    expect(body.unityOk).toBe(false);
    expect(body.ok).toBe(true);
  });
});
