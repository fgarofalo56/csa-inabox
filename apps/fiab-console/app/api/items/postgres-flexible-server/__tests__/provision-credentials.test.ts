/**
 * POST /api/items/postgres-flexible-server — the credential-minting path.
 *
 * This is the only new code in the console-ui-w2 wave that mints a live
 * credential, and it shipped with no coverage at all (independent re-review,
 * 2026-09-07, should-fix 5). Four contracts are asserted here, and each one is
 * a thing that has actually gone wrong somewhere in this repo:
 *
 *   1. THE PASSWORD NEVER LEAVES THE FUNCTION. Not in a success body, not in a
 *      failure body, not in the 409 or the 503. The route's whole reason for
 *      existing is that the operator no longer types one; putting it in an
 *      HTTP response would reinstate the exposure in a worse place.
 *   2. NOTHING IS PROVISIONED BEHIND A GATE. The Key Vault gate, the existence
 *      check and the collision refusal each return before `putKeyVaultSecret`
 *      AND before `createServer` — asserted as "not called", because a gate
 *      that returns 503 after the write has already happened is not a gate.
 *   3. KEY VAULT BEFORE ARM, and only for a name that is free.
 *   4. THE FAILURE TEXT SAYS ONLY WHAT WAS ESTABLISHED (`deploy-integrity.md`
 *      R7). The blocking defect this file was written for: the route wrote
 *      `pg-admin-<name>` unconditionally, so a POST reusing an existing
 *      server's name overwrote that LIVE server's password and then told the
 *      operator the secret "belongs to no server" — a claim the code had
 *      checked nothing about.
 *
 * MUTATION RECEIPT (measured 2026-09-07, each mutation applied alone, reverted
 * after; `npx vitest run app/api/items/postgres-flexible-server/__tests__/`):
 *   - delete the `listServers()` pre-check and the `hit` refusal → RC=1, the
 *     three "name already in use" cases fail: `putKeyVaultSecret` is called
 *     with `pg-admin-pg1` and the status is 502 instead of 409.
 *   - swallow the lookup failure (`existing = await listServers().catch(() =>
 *     [])`) → RC=1, the fail-closed case fails: 502 instead of 503 and the
 *     secret is written after absence was never established.
 *   - restore the old "it belongs to no server" sentence → RC=1, the R7 case
 *     fails on `expected '… belongs to no server …' not to contain 'belongs to
 *     no server'`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const UPN = 'owner@loom.test';
const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1', upn: UPN, tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

class PostgresError extends Error {
  status: number;
  constructor(m: string, s: number) { super(m); this.status = s; }
}
class KeyVaultError extends Error {
  status: number;
  constructor(m: string, s: number) { super(m); this.status = s; }
}

const listServersMock = vi.fn(async () => [] as any[]);
const createServerMock = vi.fn(async () => ({ ok: true, id: '/subscriptions/s/…/flexibleServers/pg1', provisioningState: 'Ready' }) as any);
vi.mock('@/lib/azure/postgres-flex-client', () => ({
  listServers: (...a: any[]) => listServersMock(...a),
  createServer: (...a: any[]) => createServerMock(...a),
  PostgresError,
}));

const kvGateMock = vi.fn(() => null as { missing: string; detail: string } | null);
const putKeyVaultSecretMock = vi.fn(async (name: string) => ({ name }));
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  kvSecretsConfigGate: () => kvGateMock(),
  putKeyVaultSecret: (...a: any[]) => putKeyVaultSecretMock(...(a as [string, string])),
  KeyVaultError,
}));

const BASE = 'http://localhost/api/items/postgres-flexible-server';
const VALID = {
  name: 'pg1', resourceGroup: 'rg-loom', location: 'eastus',
  administratorLogin: 'loomadmin', skuName: 'Standard_B1ms', tier: 'Burstable',
};
const postReq = (body: unknown) => new NextRequest(BASE, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** Every string this response could carry, so a leak anywhere is caught. */
const bodyText = async (r: Response) => JSON.stringify(await r.json());

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: UPN, tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  kvGateMock.mockReturnValue(null);
  listServersMock.mockResolvedValue([]);
  createServerMock.mockResolvedValue({ ok: true, id: '/subscriptions/s/x/flexibleServers/pg1', provisioningState: 'Ready' });
  putKeyVaultSecretMock.mockImplementation(async (name: string) => ({ name }));
});
afterEach(() => { vi.clearAllMocks(); });

describe('mintAdminPassword — the value the operator no longer invents', () => {
  it('satisfies the four Azure PostgreSQL complexity classes, every time', async () => {
    const { mintAdminPassword } = await import('../route');
    for (let i = 0; i < 200; i++) {
      const pw = mintAdminPassword();
      expect(pw.length).toBeGreaterThanOrEqual(8);
      expect(pw.length).toBeLessThanOrEqual(128);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('does not repeat — 500 draws, 500 distinct values', async () => {
    const { mintAdminPassword } = await import('../route');
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(mintAdminPassword());
    expect(seen.size).toBe(500);
  });

  it('names the secret after the server it belongs to', async () => {
    const { adminSecretNameFor } = await import('../route');
    expect(adminSecretNameFor('pg1')).toBe('pg-admin-pg1');
  });
});

describe('POST — nothing is provisioned behind a gate', () => {
  it('401s unauthenticated: no lookup, no secret, no server', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(401);
    expect(listServersMock).not.toHaveBeenCalled();
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('400s a body missing a required field, before anything is minted', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ ...VALID, tier: '' }));
    expect(r.status).toBe(400);
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('503s with kv_not_configured and provisions NOTHING', async () => {
    kvGateMock.mockReturnValue({ missing: 'LOOM_KEY_VAULT_URI', detail: 'set it' });
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('kv_not_configured');
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('does not create the server when the Key Vault write fails', async () => {
    putKeyVaultSecretMock.mockRejectedValue(new KeyVaultError('forbidden', 403));
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('secret_write_failed');
    expect(createServerMock).not.toHaveBeenCalled();
  });
});

describe('POST — the name is RESOLVED before the password is written (blocking review 2026-09-07)', () => {
  it('409s a name this subscription already uses, and does NOT overwrite its secret', async () => {
    listServersMock.mockResolvedValue([
      { id: '/subscriptions/s/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg1', name: 'pg1', location: 'eastus', fqdn: 'pg1.postgres.database.azure.com' },
    ]);
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(409);
    const j = JSON.parse(await bodyText(r));
    expect(j.code).toBe('server_exists');
    // THE DEFECT: the live server's password must survive the attempt.
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('matches the existing name case-insensitively — ARM names are not case-sensitive', async () => {
    listServersMock.mockResolvedValue([{ id: '/subscriptions/s/x/PG1', name: 'PG1', location: 'eastus', fqdn: 'pg1.x' }]);
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(409);
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the lookup itself fails — absence was never established', async () => {
    listServersMock.mockRejectedValue(new PostgresError('Resource Graph unavailable', 500));
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(503);
    const j = JSON.parse(await bodyText(r));
    expect(j.code).toBe('existence_check_failed');
    expect(j.error).toMatch(/Could not determine whether/);
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('propagates an AUTHORIZATION failure of the lookup as 403, still writing nothing', async () => {
    listServersMock.mockRejectedValue(new PostgresError('forbidden', 403));
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(403);
    expect(putKeyVaultSecretMock).not.toHaveBeenCalled();
  });

  it('CONTROL: a free name mints, writes Key Vault, THEN calls ARM — in that order', async () => {
    const order: string[] = [];
    putKeyVaultSecretMock.mockImplementation(async (name: string) => { order.push('kv'); return { name }; });
    createServerMock.mockImplementation(async () => { order.push('arm'); return { ok: true, id: '/x/pg1', provisioningState: 'Ready' }; });
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(201);
    expect(order).toEqual(['kv', 'arm']);
    expect(putKeyVaultSecretMock.mock.calls[0][0]).toBe('pg-admin-pg1');
    // The minted value reaches ARM and Key Vault, and they agree.
    expect(createServerMock.mock.calls[0][0].administratorLoginPassword)
      .toBe(putKeyVaultSecretMock.mock.calls[0][1]);
  });
});

describe('POST — the password never leaves the function, and the error text is true', () => {
  it('returns the secret NAME on success and never the value', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    expect(r.status).toBe(201);
    const text = await bodyText(r);
    const written = putKeyVaultSecretMock.mock.calls[0][1] as string;
    expect(text).toContain('pg-admin-pg1');
    expect(text).not.toContain(written);
  });

  it('never leaks the value on an ARM failure either', async () => {
    createServerMock.mockResolvedValue({ ok: false, error: 'NameAlreadyInUse', status: 409 });
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    const text = await bodyText(r);
    const written = putKeyVaultSecretMock.mock.calls[0][1] as string;
    expect(text).not.toContain(written);
  });

  /**
   * R7. The old text asserted the secret "belongs to no server", which the
   * route had established nothing about — and after a name collision it was
   * flatly false. The replacement may only claim the SCOPE that was checked.
   */
  it('scopes the post-failure claim to what the lookup actually established', async () => {
    createServerMock.mockResolvedValue({ ok: false, error: 'NameAlreadyInUse', status: 409 });
    const { POST } = await import('../route');
    const r = await POST(postReq(VALID));
    const j = JSON.parse(await bodyText(r));
    expect(j.error).not.toContain('belongs to no server');
    expect(j.error).toMatch(/THIS subscription/);
    expect(j.error).toMatch(/another\s+subscription or tenant/);
    expect(j.adminSecretName).toBe('pg-admin-pg1');
  });
});
