/**
 * #2651 — `listEffectivePermissions` on the DEFAULT (Databricks) backend must
 * read the securable's owner alongside the native effective-permissions
 * passthrough.
 *
 * The live evidence from the issue, reproduced here as fixtures: `CATALOG
 * finance` answers `{"privilege_assignments": []}` from
 * `/effective-permissions/catalog/finance` while `/catalogs/finance` reports
 * `owner: f4f25dd9-…`. Databricks' permissions APIs never surface an owner's
 * implied privileges ("Azure Databricks doesn't explicitly grant the ALL
 * PRIVILEGES privilege to the owner"), so without this read Loom has no basis
 * for any statement about ownership — and the pane was making one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'STUB.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { listEffectivePermissions } from '../unity-catalog-client';

const OWNER = 'f4f25dd9-e7aa-4ba0-ae18-6c902217964d';
const HOST = 'adb-1.azuredatabricks.net';

const realFetch = global.fetch;
let seen: string[] = [];

/** Route by path so the two concurrent reads are answered independently. */
function mockFetch(routes: Record<string, { status?: number; body: any }>) {
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    seen.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    const r = routes[key];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as any;
}

beforeEach(() => {
  seen = [];
  // Force the Databricks backend explicitly — this bug is on the DEFAULT path.
  process.env.LOOM_UC_BACKEND = 'databricks';
  process.env.LOOM_DATABRICKS_HOSTNAME = HOST;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_UC_BACKEND;
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
});

describe('listEffectivePermissions — Databricks backend reads the owner (#2651)', () => {
  it('returns the owner of a catalog whose effective-permissions answer is empty', async () => {
    mockFetch({
      '/effective-permissions/catalog/finance': { body: { privilege_assignments: [] } },
      '/unity-catalog/catalogs/finance': { body: { name: 'finance', catalog_type: 'MANAGED_CATALOG', owner: OWNER } },
    });
    const p = await listEffectivePermissions(HOST, 'CATALOG', 'finance');
    expect(p.privilege_assignments).toEqual([]);
    expect(p.owner).toBe(OWNER);
    expect(p.owner_unreadable).toBeUndefined();
    // The passthrough is still the passthrough — ownership is reported as a
    // fact, never synthesized into rows Databricks did not return.
    expect(p.privilege_assignments).toHaveLength(0);
    expect(seen.some((u) => u.includes('/effective-permissions/catalog/finance'))).toBe(true);
    expect(seen.some((u) => u.includes('/unity-catalog/catalogs/finance'))).toBe(true);
  });

  it('reads the owner for a schema too, and preserves the principal scope', async () => {
    mockFetch({
      '/effective-permissions/schema/finance.core': { body: { privilege_assignments: [] } },
      '/unity-catalog/schemas/finance.core': { body: { name: 'core', owner: 'data-eng' } },
    });
    const p = await listEffectivePermissions(HOST, 'SCHEMA', 'finance.core', { principal: 'ada@contoso.com' });
    expect(p.owner).toBe('data-eng');
    expect(seen.some((u) => u.includes('principal=ada%40contoso.com'))).toBe(true);
  });

  it('degrades an unreadable owner to a warning — never to a 502', async () => {
    mockFetch({
      '/effective-permissions/catalog/finance': { body: { privilege_assignments: [] } },
      '/unity-catalog/catalogs/finance': { status: 403, body: { message: 'PERMISSION_DENIED' } },
    });
    const p = await listEffectivePermissions(HOST, 'CATALOG', 'finance');
    expect(p.owner).toBeUndefined();
    expect(p.owner_unreadable).toBe(true);
    expect(p.warnings?.join(' ')).toContain('Could not read the owner of CATALOG finance');
  });

  it('still throws when the effective-permissions call itself fails', async () => {
    mockFetch({
      '/effective-permissions/catalog/finance': { status: 403, body: { message: 'PERMISSION_DENIED' } },
      '/unity-catalog/catalogs/finance': { body: { name: 'finance', owner: OWNER } },
    });
    await expect(listEffectivePermissions(HOST, 'CATALOG', 'finance')).rejects.toThrow();
  });

  it('makes no owner read for METASTORE — neither backend records one', async () => {
    mockFetch({ '/effective-permissions/metastore/': { body: { privilege_assignments: [] } } });
    const p = await listEffectivePermissions(HOST, 'METASTORE', '');
    expect(p.owner).toBeUndefined();
    expect(p.owner_unreadable).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});
