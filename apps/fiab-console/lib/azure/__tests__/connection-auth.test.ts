/**
 * Regression tests for the mirroring credential path.
 *
 * THE BUG THESE EXIST TO CATCH
 * ----------------------------
 * The mirroring wizard collects a Loom Connection whose secret lives in Key
 * Vault, and `/api/items/mirrored-database/[id]/sources` persists its
 * `connectionId` on the item. Exactly one surface consumed it — the
 * schema-browse `/tables` route. The replication path did not:
 * `MirrorSource` had no credential field, `sourceFromState()` never read
 * `state.connectionId`, and `mirror-engine.ts` contained zero references to it.
 * So Start/Restart always authenticated as the Console UAMI and silently
 * ignored the operator's credential.
 *
 * Every test below asserts the CONSUMPTION, not the existence, of the
 * credential — i.e. that a resolved secret actually reaches the driver call.
 * A test that only checked "the resolver exists" would have stayed green
 * through the entire lifetime of the original bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above the imports, so the mock fns must be created in a
// hoisted block too — otherwise the factory closes over a TDZ binding.
const { loadConnection, getKeyVaultSecretValue } = vi.hoisted(() => ({
  loadConnection: vi.fn(),
  getKeyVaultSecretValue: vi.fn(),
}));

vi.mock('@/lib/azure/connections-store', () => ({ loadConnection }));
vi.mock('@/lib/azure/kv-secrets-client', () => ({ getKeyVaultSecretValue }));

import {
  resolveSqlAuthDescribed, resolvePgAuthDescribed, resolveSqlAuth, UAMI_AUTH,
} from '../connection-auth';

const TENANT = 'tenant-oid';

beforeEach(() => {
  loadConnection.mockReset();
  getKeyVaultSecretValue.mockReset();
});

describe('resolveSqlAuthDescribed', () => {
  it('returns the UAMI descriptor and NO auth when no connection is bound', async () => {
    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, undefined);
    expect(auth).toBeUndefined();
    expect(descriptor).toEqual(UAMI_AUTH);
    expect(loadConnection).not.toHaveBeenCalled();
  });

  it('builds a SQL login from a sql-password connection, fetching the secret from Key Vault', async () => {
    loadConnection.mockResolvedValue({
      name: 'prod-sql', authMethod: 'sql-password', username: 'loom_reader', secretRef: 'kv-secret-name',
    });
    getKeyVaultSecretValue.mockResolvedValue('s3cret');

    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, 'conn-1');

    expect(auth).toEqual({ user: 'loom_reader', password: 's3cret' });
    expect(descriptor.identity).toBe('connection');
    expect(descriptor.connectionName).toBe('prod-sql');
    // The KV lookup goes by secret NAME (secretRef), never a stored value.
    expect(getKeyVaultSecretValue).toHaveBeenCalledWith('kv-secret-name', 'connection-secret');
  });

  it('builds a connection-string auth from a connection-string connection', async () => {
    loadConnection.mockResolvedValue({ name: 'cs', authMethod: 'connection-string', secretRef: 'kv-cs' });
    getKeyVaultSecretValue.mockResolvedValue('Server=x;Database=y;User Id=u;Password=p;');

    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, 'conn-2');

    expect(auth).toEqual({ connectionString: 'Server=x;Database=y;User Id=u;Password=p;' });
    expect(descriptor.identity).toBe('connection');
  });

  it('falls back to UAMI for entra-mi WITHOUT claiming a failure', async () => {
    loadConnection.mockResolvedValue({ name: 'mi', authMethod: 'entra-mi' });
    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, 'conn-3');
    expect(auth).toBeUndefined();
    expect(descriptor.identity).toBe('uami');
    // entra-mi is the intended path, not a degraded one — no fallbackReason.
    expect(descriptor.fallbackReason).toBeUndefined();
    expect(getKeyVaultSecretValue).not.toHaveBeenCalled();
  });

  it('states WHY it fell back when the connection was deleted (deploy-integrity R7)', async () => {
    loadConnection.mockResolvedValue(null);
    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, 'gone');
    expect(auth).toBeUndefined();
    expect(descriptor.identity).toBe('uami');
    expect(descriptor.fallbackReason).toMatch(/no longer exists/i);
  });

  it('states WHY it fell back for a non-TDS auth method rather than silently using UAMI', async () => {
    loadConnection.mockResolvedValue({ name: 'spn', authMethod: 'service-principal', secretRef: 'kv-spn' });
    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, 'conn-4');
    expect(auth).toBeUndefined();
    expect(descriptor.fallbackReason).toMatch(/service-principal/);
    expect(getKeyVaultSecretValue).not.toHaveBeenCalled();
  });

  it('falls back with a reason when a sql-password connection has no username', async () => {
    loadConnection.mockResolvedValue({ name: 'nouser', authMethod: 'sql-password', secretRef: 'kv-x' });
    const { auth, descriptor } = await resolveSqlAuthDescribed(TENANT, 'conn-5');
    expect(auth).toBeUndefined();
    expect(descriptor.fallbackReason).toMatch(/no username/i);
  });

  it('never places secret material on the descriptor', async () => {
    loadConnection.mockResolvedValue({
      name: 'prod-sql', authMethod: 'sql-password', username: 'u', secretRef: 'kv-name',
    });
    getKeyVaultSecretValue.mockResolvedValue('TOP-SECRET-VALUE');
    const { descriptor } = await resolveSqlAuthDescribed(TENANT, 'conn-6');
    // The descriptor is what gets persisted to Cosmos + returned by the API.
    expect(JSON.stringify(descriptor)).not.toContain('TOP-SECRET-VALUE');
    expect(JSON.stringify(descriptor)).not.toContain('kv-name');
  });

  it('resolveSqlAuth is the thin wrapper over the described form', async () => {
    loadConnection.mockResolvedValue({ name: 'c', authMethod: 'sql-password', username: 'u', secretRef: 'k' });
    getKeyVaultSecretValue.mockResolvedValue('p');
    await expect(resolveSqlAuth(TENANT, 'conn-7')).resolves.toEqual({ user: 'u', password: 'p' });
  });
});

describe('resolvePgAuthDescribed', () => {
  it('builds a PG login from a sql-password connection', async () => {
    loadConnection.mockResolvedValue({ name: 'pg', authMethod: 'sql-password', username: 'pguser', secretRef: 'kv-pg' });
    getKeyVaultSecretValue.mockResolvedValue('pgpass');
    const { auth, descriptor } = await resolvePgAuthDescribed(TENANT, 'conn-8');
    expect(auth).toEqual({ user: 'pguser', password: 'pgpass' });
    expect(descriptor.identity).toBe('connection');
  });

  it('does NOT guess at a libpq URI for a connection-string connection — it says so', async () => {
    loadConnection.mockResolvedValue({ name: 'pgcs', authMethod: 'connection-string', secretRef: 'kv-pgcs' });
    const { auth, descriptor } = await resolvePgAuthDescribed(TENANT, 'conn-9');
    expect(auth).toBeUndefined();
    expect(descriptor.fallbackReason).toMatch(/connection-string/);
  });

  it('returns UAMI with no lookup when no connection is bound', async () => {
    const { auth, descriptor } = await resolvePgAuthDescribed(TENANT, undefined);
    expect(auth).toBeUndefined();
    expect(descriptor).toEqual(UAMI_AUTH);
    expect(loadConnection).not.toHaveBeenCalled();
  });
});
