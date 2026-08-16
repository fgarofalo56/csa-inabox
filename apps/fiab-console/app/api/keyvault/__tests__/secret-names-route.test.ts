/**
 * GET /api/keyvault/secret-names
 *
 * There was no route anywhere that listed Key Vault secret NAMES — only
 * certificates — so surfaces that want a `secretRef` ask users to type one, and
 * several ask for the secret VALUE in a password box instead.
 *
 * The three properties that make this route safe to adopt widely:
 *   1. it returns NAMES and never calls GET /secrets/{name}, so no vault
 *      material can leave through it;
 *   2. `?vault=` is bounded to the ACTIVE CLOUD's Key Vault suffix — without
 *      that, a caller-supplied host would receive a bearer token (SSRF), and a
 *      Commercial host in a Gov deployment would be a sovereignty breach;
 *   3. a 403 names the role that fixes it, and names the READER role rather
 *      than over-asking for Secrets Officer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  vaultUrl: vi.fn(),
  shortcutVaultUrl: vi.fn(() => null),
  certVaultUrl: vi.fn(() => null),
}));
const requireTenantAdmin = vi.fn();
vi.mock('@/lib/auth/feature-gate', () => ({
  requireTenantAdmin: (...a: any[]) => requireTenantAdmin(...a),
}));
const getToken = vi.fn();
vi.mock('@/lib/azure/workspace-credential-factory', () => ({
  workspaceScopedCredential: () => ({ getToken: (...a: any[]) => getToken(...a) }),
}));
const fetchWithTimeout = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeout(...a),
}));

import { GET, resolveVaultBase, isValidVaultName } from '../secret-names/route';
import { getSession } from '@/lib/auth/session';
import { vaultUrl } from '@/lib/azure/kv-secrets-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };

function req(qs = '') {
  return { nextUrl: new URL(`http://x/api/keyvault/secret-names?${qs}`) } as any;
}
function kvPage(rows: unknown[], nextLink?: string) {
  return { ok: true, status: 200, json: async () => ({ value: rows, ...(nextLink ? { nextLink } : {}) }) } as any;
}
function secretRow(name: string, extra: Record<string, unknown> = {}) {
  return { id: `https://kv-loom.vault.azure.net/secrets/${name}`, attributes: { enabled: true }, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (vaultUrl as any).mockReturnValue('https://kv-loom.vault.azure.net');
  requireTenantAdmin.mockReturnValue(null); // admin by default; overridden per test
  getToken.mockResolvedValue({ token: 'kv-token' });
});

describe('vault resolution', () => {
  it('accepts a bare vault name', () => {
    expect(isValidVaultName('kv-loom')).toBe(true);
    expect(isValidVaultName('1kv')).toBe(false);
    expect(isValidVaultName('kv--loom')).toBe(false);
    expect(resolveVaultBase('kv-loom')).toEqual({ base: 'https://kv-loom.vault.azure.net' });
  });

  it('REFUSES a host that is not a Key Vault in the active cloud (SSRF + sovereignty)', () => {
    const r = resolveVaultBase('https://attacker.example.com') as { error: string };
    expect(r.error).toContain('not a Key Vault host in this cloud');
    const http = resolveVaultBase('http://kv-loom.vault.azure.net') as { error: string };
    expect(http.error).toContain('must be https');
  });

  it('falls back to the deployment vault, and says so honestly when there is none', () => {
    expect(resolveVaultBase('')).toEqual({ base: 'https://kv-loom.vault.azure.net' });
    (vaultUrl as any).mockReturnValue(null);
    const r = resolveVaultBase(null) as { error: string };
    expect(r.error).toContain('LOOM_KEY_VAULT_URI');
  });
});

describe('GET', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req(), {} as any)).status).toBe(401);
  });

  it('returns NAMES and never a value — and never calls the per-secret GET', async () => {
    fetchWithTimeout.mockResolvedValue(kvPage([
      secretRow('sql-admin', { contentType: 'password' }),
      secretRow('adls-sas'),
    ]));
    const j = await (await GET(req(), {} as any)).json();

    expect(j.ok).toBe(true);
    expect(j.names.map((n: any) => n.name)).toEqual(['adls-sas', 'sql-admin']);
    expect(JSON.stringify(j)).not.toContain('"value"');
    // Every request is the LIST endpoint; a `/secrets/<name>` GET would be a
    // value read, which this route must never perform.
    for (const call of fetchWithTimeout.mock.calls) {
      expect(String(call[0])).toMatch(/\/secrets\?api-version=/);
    }
  });

  it('follows KV paging so a large vault is not silently half-listed', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(kvPage([secretRow('a')], 'https://kv-loom.vault.azure.net/secrets?$skiptoken=x'))
      .mockResolvedValueOnce(kvPage([secretRow('b')]));
    const j = await (await GET(req(), {} as any)).json();
    expect(j.names.map((n: any) => n.name)).toEqual(['a', 'b']);
  });

  it('403 names the READER role, not the Officer role writing would need', async () => {
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' } as any);
    const res = await GET(req(), {} as any);
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.error).toContain('Key Vault Secrets User');
    expect(j.error).toContain('not Secrets Officer');
  });

  it('400 on a refused vault, before any token is minted', async () => {
    const res = await GET(req('vault=https://attacker.example.com'), {} as any);
    expect(res.status).toBe(400);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('reports a disabled secret rather than offering it as usable', async () => {
    fetchWithTimeout.mockResolvedValue(kvPage([{ ...secretRow('old-key'), attributes: { enabled: false } }]));
    const j = await (await GET(req(), {} as any)).json();
    expect(j.names[0].enabled).toBe(false);
  });
});

describe('authorization — the deployment\'s OWN vault vs anyone else\'s', () => {
  it('a non-admin may list the deployment\'s own vault (that is the picker\'s job)', async () => {
    fetchWithTimeout.mockResolvedValue(kvPage([secretRow('sql-admin')]));
    const res = await GET(req('vault=kv-loom'), {} as any);
    expect(res.status).toBe(200);
    // No admin gate consulted for the deployment's own vault.
    expect(requireTenantAdmin).not.toHaveBeenCalled();
  });

  it('an ARBITRARY tenant vault is an estate-wide read — tenant admins only', async () => {
    const denied = { status: 403, json: async () => ({ ok: false, code: 'admin_only' }) };
    requireTenantAdmin.mockReturnValue(denied);
    const res: any = await GET(req('vault=someone-elses-kv'), {} as any);
    expect(res.status).toBe(403);
    expect(requireTenantAdmin).toHaveBeenCalledWith(SESSION);
    // Denied BEFORE any token is minted or any vault is contacted.
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('an admin may list an arbitrary vault', async () => {
    requireTenantAdmin.mockReturnValue(null);
    fetchWithTimeout.mockResolvedValue(kvPage([secretRow('x')]));
    const res = await GET(req('vault=someone-elses-kv'), {} as any);
    expect(res.status).toBe(200);
    expect(requireTenantAdmin).toHaveBeenCalled();
  });
});
