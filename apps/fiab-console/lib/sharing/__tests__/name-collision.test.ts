/**
 * LU-9 round-4 — SHARE / RECIPIENT NAMES ARE CASE-INSENSITIVE IDENTIFIERS.
 *
 * The round-4 finding on this surface: `recipientCanAccessShare` compares share
 * names case-INsensitively (`'Share-A'.toLowerCase() === 'share-a'`) while the
 * Cosmos document id is built from the name VERBATIM (`share:${name}`) and
 * Cosmos ids are case-SENSITIVE. Two records that differ only by case can
 * therefore coexist, and the authorization compare and the record lookup then
 * disagree about which share was meant:
 *
 *     recipient A granted ['share-a']
 *     recipient B owns a share literally named 'Share-A'
 *     A asks for 'Share-A'  ->  authz: canonical match, ALLOWED
 *                           ->  lookup: doc `share:Share-A`, which is B's record
 *
 * On the one surface whose whole purpose is moving data OUTSIDE the boundary
 * that is a cross-recipient read. The same divergence also breaks the two
 * control-plane operations an incident depends on — revoke and delete-cascade
 * both use case-sensitive `Array#includes` against a grant list the data plane
 * reads case-insensitively, so a revocation typed in the wrong case silently
 * does nothing while access continues.
 *
 * THE INVARIANT ASSERTED HERE: exactly one function, `canonicalSharingName`,
 * decides identity — at the point of STORAGE (the document id and the stored
 * name), at the point of COMPARISON (grants, revokes, cascade, authorization),
 * and on the way back OUT of the store (a non-canonical record is refused, so a
 * legacy or hand-inserted document cannot be served either). Two shares that
 * differ only by case cannot coexist, and no spelling of a name can resolve to a
 * record outside the caller's grants.
 *
 * These tests drive the REAL store against a fake Cosmos container rather than
 * mocking the store, because the defect lives precisely in the document-id
 * construction that a store mock would replace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TENANT = '11111111-2222-3333-4444-555555555555';
const OID_A = '99999999-8888-7777-6666-555555555555';
const OID_B = '12121212-3434-5656-7878-909090909090';

/** Fake Cosmos: a Map keyed on the document id, which is exactly what makes the
 *  defect real — Cosmos ids are case-sensitive, so `share:share-a` and
 *  `share:Share-A` are two different documents. */
const docs = new Map<string, any>();

vi.mock('@/lib/azure/cosmos-client', () => ({
  sharingContainer: vi.fn(async () => ({
    items: {
      query: (spec: { query: string; parameters: Array<{ name: string; value: string }> }) => ({
        fetchAll: async () => {
          const tenant = spec.parameters.find((p) => p.name === '@t')?.value;
          const kind = spec.query.includes("'share'") ? 'share' : 'recipient';
          return {
            resources: [...docs.values()].filter((d) => d.tenantId === tenant && d.kind === kind),
          };
        },
      }),
      upsert: async (doc: any) => {
        docs.set(doc.id, JSON.parse(JSON.stringify(doc)));
        return { resource: doc };
      },
    },
    item: (id: string, _pk: string) => ({
      read: async () => ({ resource: docs.get(id) }),
      delete: async () => {
        if (!docs.has(id)) {
          const e: any = new Error('NotFound');
          e.code = 404;
          throw e;
        }
        docs.delete(id);
      },
    }),
  })),
}));

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_SHARING_URL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  docs.clear();
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

/** Create a share + a recipient granted it, through the real control plane. */
async function seed(shareName: string, recipientName: string, oid: string) {
  const be = await import('@/app/api/marketplace/sharing/_loom-backend');
  const created = await be.loomCreateShare({ name: shareName }, 'admin@estate.gov');
  expect(created.status).toBe(200);
  const rec = await be.loomCreateRecipient({ name: recipientName, principalIds: [oid] }, 'admin@estate.gov');
  expect(rec.status).toBe(200);
  const patched = await be.loomPatchShare(shareName, {
    addObjects: [{
      schema: 'gold', name: shareName === 'share-a' ? 't1' : 'secret',
      location: `abfss://lake@st.dfs.core.usgovcloudapi.net/gold/${shareName}`,
    }],
    grant: [recipientName],
  });
  expect(patched.status).toBe(200);
}

/**
 * The two halves of the invariant — canonical at COMPARISON and canonical at
 * STORAGE — are deliberately redundant with each other, which means a behavioural
 * test can stay green with either half reverted. These assertions are therefore
 * white-box, straight at the stored document, so the STORAGE half has a test that
 * cannot be rescued by a comparison and vice versa.
 */
describe('the stored form is canonical (the storage half, pinned directly)', () => {
  it('the document id and the stored name are canonical whatever case was written', async () => {
    const { upsertShare, upsertRecipient } = await import('../store');
    await upsertShare({ id: '  Share-A  ', tenantId: TENANT, tables: [] });
    expect([...docs.keys()]).toEqual(['share:share-a']);
    expect(docs.get('share:share-a').name).toBe('share-a');

    await upsertRecipient({ id: 'Agency-A', tenantId: TENANT, principalIds: [OID_A], shares: [] });
    expect(docs.get('recipient:agency-a').name).toBe('agency-a');
  });

  it('a point read resolves to the one canonical record whatever case the caller spelled', async () => {
    // This is the property the data plane depends on: it passes the caller's own
    // path segment to getShare. If the document id were built from that segment
    // verbatim, the lookup and the authorization compare would be keyed on
    // different strings again — which is the whole defect.
    const { upsertShare, getShare, upsertRecipient, getRecipient } = await import('../store');
    await upsertShare({ id: 'share-a', tenantId: TENANT, tables: [] });
    for (const spelling of ['share-a', 'Share-A', 'SHARE-A', ' share-a ']) {
      expect((await getShare(TENANT, spelling))?.id).toBe('share-a');
    }
    await upsertRecipient({ id: 'agency-a', tenantId: TENANT, principalIds: [OID_A], shares: [] });
    expect((await getRecipient(TENANT, 'Agency-A'))?.id).toBe('agency-a');
  });

  it('the grant list is stored canonical and de-duplicated', async () => {
    const { upsertRecipient } = await import('../store');
    await upsertRecipient({
      id: 'agency-a', tenantId: TENANT, principalIds: [OID_A],
      // The same grant, three spellings. Stored as one canonical entry, because
      // the grant list IS the authorization input.
      shares: ['Share-A', 'share-a', 'SHARE-A'],
    });
    expect(docs.get('recipient:agency-a').shares).toEqual(['share-a']);
  });
});

describe('the comparison is canonical (the comparison half, pinned directly)', () => {
  it('a canonical grant authorizes every spelling, and nothing else', async () => {
    const { recipientCanAccessShare } = await import('../model');
    const r = { id: 'agency-a', tenantId: TENANT, principalIds: [OID_A], shares: ['share-a'] };
    for (const spelling of ['share-a', 'Share-A', 'SHARE-A', ' share-a ']) {
      expect(recipientCanAccessShare(r, spelling)).toBe(true);
    }
    for (const other of ['share-b', 'Share-B', 'share-a2', '']) {
      expect(recipientCanAccessShare(r, other)).toBe(false);
    }
  });
});

describe('two shares that differ only by case cannot coexist', () => {
  it('creating "Share-A" when "share-a" exists is refused', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await seed('share-a', 'agency-a', OID_A);

    const collide = await be.loomCreateShare({ name: 'Share-A' }, 'admin@estate.gov');
    expect(collide.status).toBe(400);
    expect((await collide.json()).error).toMatch(/already exists/i);

    // And only ONE share document exists for the tenant.
    const { listShares } = await import('../store');
    const all = await listShares(TENANT);
    expect(all.map((s) => s.id)).toEqual(['share-a']);
  });

  it('creating a recipient whose name collides only by case is refused', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await seed('share-a', 'agency-a', OID_A);

    const collide = await be.loomCreateRecipient(
      { name: 'Agency-A', principalIds: [OID_B] },
      'admin@estate.gov',
    );
    expect(collide.status).toBe(400);
    expect((await collide.json()).error).toMatch(/already exists/i);

    const { listRecipients } = await import('../store');
    expect((await listRecipients(TENANT)).map((r) => r.id)).toEqual(['agency-a']);
  });
});

describe('one Entra principal belongs to exactly one recipient', () => {
  it('registering a principal already held by another recipient is refused', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await seed('share-a', 'agency-a', OID_A);
    // Same principal, different case — matchRecipientByPrincipal compares
    // case-insensitively, so this WOULD have authenticated as either record while
    // the kill-switch and DELETE only ever hit one of them.
    const dup = await be.loomCreateRecipient(
      { name: 'agency-a-shadow', principalIds: [OID_A.toUpperCase()] },
      'admin@estate.gov',
    );
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already registered to recipient "agency-a"/);
  });

  it('principal ids are stored canonical, so suspend resolves the record it names', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await be.loomCreateRecipient(
      { name: 'agency-a', principalIds: [OID_A.toUpperCase()] },
      'admin@estate.gov',
    );
    expect(docs.get('recipient:agency-a').principalIds).toEqual([OID_A]);

    const { listRecipients } = await import('../store');
    const { matchRecipientByPrincipal } = await import('../model');
    expect((await be.loomSetRecipientDisabled('Agency-A', true)).status).toBe(200);
    const after = await listRecipients(TENANT);
    // What the toggle wrote is what authentication then refuses — under either
    // spelling of the principal.
    expect(matchRecipientByPrincipal(after, [OID_A])).toBeNull();
    expect(matchRecipientByPrincipal(after, [OID_A.toUpperCase()])).toBeNull();
  });
});

describe('no spelling of a share name resolves outside the caller\'s grants', () => {
  /**
   * THE round-4 attack, expressed without the proxy. A hostile / legacy document
   * whose stored name is not canonical is placed directly in Cosmos — the state
   * the create-time check now prevents, but which a hand-edited document or a
   * record written before this fix could still be in. The store must refuse to
   * serve it, so the pair "authorization says yes / lookup returns someone
   * else's record" cannot occur.
   */
  it('a non-canonical share document is never served, so authz and lookup cannot diverge', async () => {
    await seed('share-a', 'agency-a', OID_A);
    // B's share, spelled to collide with A's grant. Injected below the control
    // plane on purpose: this is the state the checks above now prevent.
    docs.set('share:Share-A', {
      id: 'share:Share-A', name: 'Share-A', kind: 'share', tenantId: TENANT,
      tables: [{
        schema: 'gold', name: 'secret', id: 'id-secret',
        location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/b-secret',
      }],
    });

    const { getShare, listShares, listRecipients } = await import('../store');
    const { recipientCanAccessShare, visibleShares } = await import('../model');
    const recipient = (await listRecipients(TENANT)).find((r) => r.id === 'agency-a')!;

    // Every spelling the caller could send.
    for (const spelling of ['Share-A', 'share-a', 'SHARE-A', 'sHaRe-A', ' share-a ']) {
      const resolved = await getShare(TENANT, spelling);
      if (recipientCanAccessShare(recipient, spelling)) {
        // Authorized -> the record we resolve must be one the recipient holds,
        // never a different document that merely spells the same name.
        expect(resolved === null || recipientCanAccessShare(recipient, resolved.id)).toBe(true);
        // …and specifically never B's table.
        expect(JSON.stringify(resolved ?? {})).not.toContain('b-secret');
      }
    }

    // Discovery must not leak the colliding record either.
    const mine = visibleShares(recipient, await listShares(TENANT));
    expect(mine.map((s) => s.id)).toEqual(['share-a']);
    expect(JSON.stringify(mine)).not.toContain('b-secret');
  });
});

describe('revocation and delete-cascade cannot be defeated by case', () => {
  it('a grant made as "Share-A" is revoked by "share-a"', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await seed('share-a', 'agency-a', OID_A);

    // Re-grant using a different spelling, the way an operator or a script would.
    expect((await be.loomPatchShare('share-a', { grant: ['Agency-A'] })).status).toBe(200);
    // Now revoke with yet another spelling.
    expect((await be.loomPatchShare('SHARE-A', { revoke: ['agency-a'] })).status).toBe(200);

    const { listRecipients } = await import('../store');
    const { recipientCanAccessShare } = await import('../model');
    const recipient = (await listRecipients(TENANT)).find((r) => r.id === 'agency-a')!;
    expect(recipient.shares).toEqual([]);
    // The property that actually matters: the data plane refuses it afterwards,
    // under any spelling.
    for (const spelling of ['share-a', 'Share-A', 'SHARE-A']) {
      expect(recipientCanAccessShare(recipient, spelling)).toBe(false);
    }
  });

  it('deleting the share revokes every grant, whatever case the delete used', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await seed('share-a', 'agency-a', OID_A);

    expect((await be.loomDeleteShare('SHARE-A')).status).toBe(200);

    const { listShares, listRecipients } = await import('../store');
    expect(await listShares(TENANT)).toEqual([]);
    const recipient = (await listRecipients(TENANT)).find((r) => r.id === 'agency-a')!;
    // A surviving grant would silently re-authorize if the name were ever reused.
    expect(recipient.shares).toEqual([]);
  });
});

describe('the admin view agrees with what the data plane enforces', () => {
  it('a grant stored in mixed case still shows on the share it grants', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await seed('share-a', 'agency-a', OID_A);
    // A grant list entry written in a different case must not make the share
    // detail page disagree with the authorization decision.
    const { listRecipients, upsertRecipient } = await import('../store');
    const recipient = (await listRecipients(TENANT)).find((r) => r.id === 'agency-a')!;
    await upsertRecipient({ ...recipient, shares: ['Share-A'] });

    const body = await (await be.loomGetShare('share-a', { full: true })).json();
    expect(body.share.recipients).toEqual(['agency-a']);
    expect(body.permissions.privilege_assignments.map((p: { principal: string }) => p.principal))
      .toEqual(['agency-a']);

    const { recipientCanAccessShare } = await import('../model');
    const after = (await listRecipients(TENANT)).find((r) => r.id === 'agency-a')!;
    expect(recipientCanAccessShare(after, 'share-a')).toBe(true);
  });
});
