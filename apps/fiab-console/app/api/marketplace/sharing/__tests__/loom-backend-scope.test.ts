/**
 * LU-9 — the Marketplace sharing BFF's Loom backend: what a NON-ADMIN may read,
 * and the recipient kill-switch write path.
 *
 * These reads are `withSession`, so every signed-in user reaches them. Three
 * fields in the natural payload are estate infrastructure rather than catalog
 * metadata — the internal sharing-server FQDN, every published table's raw
 * `abfss://` root, and every external recipient's Entra principal ids — and the
 * negative tests here are what keep them behind tenant-admin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LoomRecipient, LoomShare } from '@/lib/sharing/model';

const TENANT = '11111111-2222-3333-4444-555555555555';
const LOCATION = 'abfss://lake@stloom.dfs.core.usgovcloudapi.net/gold/revenue';
const PRINCIPAL = '99999999-8888-7777-6666-555555555555';

const shareA: LoomShare = {
  id: 'share-a', tenantId: TENANT,
  tables: [{ schema: 'gold', name: 't1', location: LOCATION, id: 'id-1' }],
};
let recipientA: LoomRecipient = {
  id: 'agency-a', tenantId: TENANT, principalIds: [PRINCIPAL], shares: ['share-a'],
};

const upsertRecipientMock = vi.fn(async (r: LoomRecipient) => { recipientA = r; return r; });

vi.mock('@/lib/sharing/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sharing/store')>();
  return {
    ...actual,
    listShares: vi.fn(async () => [shareA]),
    getShare: vi.fn(async (_t: string, n: string) => (n === 'share-a' ? shareA : null)),
    listRecipients: vi.fn(async () => [recipientA]),
    getRecipient: vi.fn(async (_t: string, n: string) => (n === 'agency-a' ? recipientA : null)),
    upsertRecipient: upsertRecipientMock,
  };
});

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_SHARING_URL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  upsertRecipientMock.mockClear();
  recipientA = { id: 'agency-a', tenantId: TENANT, principalIds: [PRINCIPAL], shares: ['share-a'] };
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
});
afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('estate infrastructure is withheld from a non-admin reader', () => {
  it('loomListShares hides the server FQDN and every abfss root', async () => {
    const { loomListShares } = await import('../_loom-backend');
    const body = await (await loomListShares({ full: false })).json();
    const asText = JSON.stringify(body);
    expect(asText).not.toContain(LOCATION);
    expect(asText).not.toContain('loom-sharing.internal');
    expect(body.host).toBe('');
    // The catalog shape itself is unchanged, so the UI still renders.
    expect(body.shares[0].name).toBe('share-a');
    expect(body.shares[0].objects[0].name).toBe('gold.t1');
  });

  it('loomListRecipients hides the Entra principal ids', async () => {
    const { loomListRecipients } = await import('../_loom-backend');
    const body = await (await loomListRecipients({ full: false })).json();
    expect(JSON.stringify(body)).not.toContain(PRINCIPAL);
    expect(body.recipients[0].principals).toBeUndefined();
    // A count is still shown so the admin surface is not silently misleading.
    expect(body.recipients[0].principalCount).toBe(1);
  });

  it('loomGetShare hides the abfss root for a non-admin', async () => {
    const { loomGetShare } = await import('../_loom-backend');
    const body = await (await loomGetShare('share-a', { full: false })).json();
    expect(JSON.stringify(body)).not.toContain(LOCATION);
  });

  it('a tenant admin still gets the full payload (so the redaction is not a regression)', async () => {
    const { loomListShares, loomListRecipients } = await import('../_loom-backend');
    const shares = await (await loomListShares({ full: true })).json();
    expect(shares.shares[0].objects[0].location).toBe(LOCATION);
    expect(shares.host).toBe('https://loom-sharing.internal');
    const recips = await (await loomListRecipients({ full: true })).json();
    expect(recips.recipients[0].principals).toEqual([PRINCIPAL]);
  });
});

describe('recipient kill-switch has a write path', () => {
  it('suspending a recipient persists disabled=true and keeps its grants', async () => {
    const { loomSetRecipientDisabled } = await import('../_loom-backend');
    const body = await (await loomSetRecipientDisabled('agency-a', true)).json();
    expect(body.ok).toBe(true);
    expect(body.recipient.disabled).toBe(true);
    const written = upsertRecipientMock.mock.calls[0][0];
    expect(written.disabled).toBe(true);
    // Suspension must NOT lose the grant list — that is what distinguishes it
    // from delete, and what an incident review needs.
    expect(written.shares).toEqual(['share-a']);
    expect(written.principalIds).toEqual([PRINCIPAL]);
  });

  it('a suspended recipient can be restored', async () => {
    const { loomSetRecipientDisabled } = await import('../_loom-backend');
    await loomSetRecipientDisabled('agency-a', true);
    const body = await (await loomSetRecipientDisabled('agency-a', false)).json();
    expect(body.recipient.disabled).toBe(false);
  });

  it('404s an unknown recipient rather than creating one', async () => {
    const { loomSetRecipientDisabled } = await import('../_loom-backend');
    const res = await loomSetRecipientDisabled('nobody', true);
    expect(res.status).toBe(404);
    expect(upsertRecipientMock).not.toHaveBeenCalled();
  });

  it('the suspended record is refused by the authorization rules', async () => {
    const { recipientCanAccessShare, matchRecipientByPrincipal } = await import('@/lib/sharing/model');
    const { loomSetRecipientDisabled } = await import('../_loom-backend');
    await loomSetRecipientDisabled('agency-a', true);
    // End to end: what the toggle writes is exactly what the protocol path reads.
    expect(recipientCanAccessShare(recipientA, 'share-a')).toBe(false);
    expect(matchRecipientByPrincipal([recipientA], [PRINCIPAL])).toBeNull();
  });
});
