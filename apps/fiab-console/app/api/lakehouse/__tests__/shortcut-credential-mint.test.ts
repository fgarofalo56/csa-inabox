/**
 * POST /api/lakehouse/shortcuts/credentials — the mint records who saved the
 * credential, and every mint gets a fresh name.
 *
 * The route runs for real; `putShortcutSecret` is mocked so the name, the value
 * and the owner record it is handed can be read.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - owner record: calling `putShortcutSecret(name, value)` without the owner
 *     (the pre-change call) — the third argument is then undefined.
 *   - fresh names: the pre-change deterministic `loom-sc-<type>-<lh>-<name>`,
 *     which gives two principals (or two saves) the SAME secret — the two
 *     names compared below would be equal.
 *   - suffix survives the 127-character limit: suffixing AFTER a full-length
 *     `sanitizeSecretName` (the 127-char cut removes the suffix, and the names
 *     collide again).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/kv-secrets-client', async () => {
  const { sanitizeSecretName } = await import('@/lib/azure/kv-secret-name');
  class KeyVaultError extends Error { constructor(m: string, public status: number) { super(m); } }
  return {
    putShortcutSecret: vi.fn(async (name: string) => ({ name })),
    shortcutKeyVaultConfigGate: vi.fn(() => null),
    sanitizeSecretName,
    KeyVaultError,
  };
});

import { POST } from '../shortcuts/credentials/route';
import { getSession } from '@/lib/auth/session';
import { putShortcutSecret } from '@/lib/azure/kv-secrets-client';
import { isValidKeyVaultSecretName } from '@/lib/azure/kv-secret-name';

const put = putShortcutSecret as unknown as ReturnType<typeof vi.fn>;
const req = (body: any) => ({ json: async () => body }) as any;
const VALUE = 'AKIAEXAMPLE:not-a-real-key';

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'oid-alice', upn: 'Alice@contoso.com', tid: 'tid-1' } });
});

describe('credential mint', () => {
  it('records the saving principal and the lakehouse with the secret, and returns only the name', async () => {
    const res = await POST(req({ lakehouseId: 'lh-1', name: 'partner', sourceType: 's3', secretValue: VALUE }));
    expect(res.status).toBe(200);
    const j = await res.json();
    const [name, value, owner] = put.mock.calls[0];
    expect(name).toMatch(/^loom-sc-s3-lh-1-partner-[0-9a-f]{12}$/);
    expect(value).toBe(VALUE);
    expect(owner).toEqual({ oid: 'oid-alice', upn: 'Alice@contoso.com', tid: 'tid-1', lakehouseId: 'lh-1' });
    expect(j).toEqual({ ok: true, data: { secretName: name } });
    expect(JSON.stringify(j)).not.toContain(VALUE);
  });

  it('two saves of the same shortcut get different secrets', async () => {
    const b = { lakehouseId: 'lh-1', name: 'partner', sourceType: 's3', secretValue: VALUE };
    await POST(req(b));
    (getSession as any).mockReturnValue({ claims: { oid: 'oid-bob', upn: 'bob@contoso.com', tid: 'tid-1' } });
    await POST(req(b));
    const [a1, a2] = [put.mock.calls[0][0], put.mock.calls[1][0]];
    expect(a1).not.toBe(a2);
    expect(put.mock.calls[1][2]).toMatchObject({ oid: 'oid-bob' });
  });

  it('the random suffix survives Key Vault\'s 127-character limit', async () => {
    await POST(req({ lakehouseId: 'l'.repeat(90), name: 'n'.repeat(80), sourceType: 'gcs',
      secretValue: JSON.stringify({ client_email: 'a@b', private_key: 'x' }) }));
    await POST(req({ lakehouseId: 'l'.repeat(90), name: 'n'.repeat(80), sourceType: 'gcs',
      secretValue: JSON.stringify({ client_email: 'a@b', private_key: 'x' }) }));
    const [n1, n2] = [put.mock.calls[0][0], put.mock.calls[1][0]];
    for (const n of [n1, n2]) {
      expect(n.length).toBeLessThanOrEqual(127);
      expect(isValidKeyVaultSecretName(n)).toBe(true);
      expect(n).toMatch(/-[0-9a-f]{12}$/);
    }
    expect(n1).not.toBe(n2);
  });
});
