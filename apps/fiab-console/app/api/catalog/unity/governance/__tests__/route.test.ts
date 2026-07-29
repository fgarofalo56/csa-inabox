/**
 * LU-5 — BFF tests for the governance-overlay + governed-tag routes.
 *
 * These are ATTACK tests first. The first pass of this PR shipped a
 * session-only mutation path; the negative cases below are what proves that is
 * closed, and they are written so that REMOVING the gate makes them fail.
 *
 * Authorization is exercised against the REAL `enforceCapability` /
 * `checkCapability` (only the Cosmos `feature-permissions` container is faked),
 * so the tiering, the tenant-admin bypass, and the fail-closed behaviour are
 * all production code paths — not a stubbed `() => null`.
 *
 * Bugs these catch:
 *   1. an unauthenticated caller reading or writing another tenant's governance.
 *   2. ANY authenticated user forging a certification / flipping a governed tag
 *      / driving a write into the shared tenant Purview account (the security
 *      finding this file exists to close).
 *   3. the route bypassing the vocabulary gate (400 must come from the model,
 *      and NOTHING may be persisted when it fires).
 *   4. unvalidated / unbounded attribute JSON reaching Cosmos.
 *   5. a tenant-scoped write landing under the wrong partition key.
 *   6. an emptied overlay being persisted as a hollow row instead of deleted —
 *      and the converse, a row with revocable Purview residue being deleted.
 *   7. `syncPurview` silently succeeding when Purview is unconfigured.
 *   8. a Purview push happening BEFORE the Cosmos persist (orphaned classifications).
 *   9. a non-admin editing the tenant governed-tag vocabulary.
 *  10. any of the above going unaudited — including the denials.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/session')>();
  return { ...actual, getSession: vi.fn(), tenantScopeId: (s: any) => s.claims.tid || s.claims.oid };
});

/** Feature grants the REAL feature-gate will read. Mutated per test. */
let GRANTS: Array<{ capabilityId: string; principalId: string; role: string }> = [];
/** Every audit document the routes wrote, in order. */
const AUDITS: any[] = [];

vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const caps: string[] = spec.parameters.find((p: any) => p.name === '@caps').value;
          const principals: string[] = spec.parameters.find((p: any) => p.name === '@principals').value;
          return {
            resources: GRANTS.filter(
              (g) => caps.includes(g.capabilityId) && principals.includes(g.principalId),
            ),
          };
        },
      }),
    },
  }),
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { AUDITS.push(doc); return { resource: doc }; } },
  }),
}));

vi.mock('@/lib/governance/uc-overlay/store', () => ({
  readGovernedTags: vi.fn(),
  writeGovernedTags: vi.fn(),
  readAttributeGroups: vi.fn(),
  readOverlay: vi.fn(),
  listOverlays: vi.fn(),
  listColumnOverlays: vi.fn(),
  writeOverlay: vi.fn(),
  deleteOverlay: vi.fn(),
  // NOTE: `isEmptyOverlay` / `hasPurviewResidue` are deliberately NOT listed.
  // They live in the PURE model, so the route always exercises the real
  // predicates — a store mock can no longer substitute its own copy and make
  // the delete-vs-persist assertions unfalsifiable.
}));
vi.mock('@/lib/governance/uc-overlay/purview-sync', () => ({
  syncOverlayToPurview: vi.fn(),
  provenanceFromSync: vi.fn(() => undefined),
}));

import { GET, POST } from '../route';
import { GET as TAGS_GET, POST as TAGS_POST } from '../../governed-tags/route';
import { getSession } from '@/lib/auth/session';
import {
  readGovernedTags, readAttributeGroups, readOverlay, listOverlays, listColumnOverlays,
  writeOverlay, deleteOverlay, writeGovernedTags,
} from '@/lib/governance/uc-overlay/store';
import { syncOverlayToPurview, provenanceFromSync } from '@/lib/governance/uc-overlay/purview-sync';
import { emptyOverlay } from '@/lib/governance/uc-overlay/model';
import { DENIAL_LIMITS } from '@/lib/governance/uc-overlay/audit';

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

const SESSION = { claims: { upn: 'ana@contoso.com', oid: 'oid-1', tid: 'tenant-1', groups: [] }, exp: 9_999_999_999 };
/** Tenant-admin is env-driven (LOOM_TENANT_ADMIN_OID) — see lib/auth/feature-gate.isTenantAdmin. */
function asTenantAdmin() { process.env.LOOM_TENANT_ADMIN_OID = 'oid-1'; }
/** Delegated grant on the governance capability — the /admin/permissions path. */
function grant(role: 'Reader' | 'Contributor' | 'Admin') {
  GRANTS.push({ capabilityId: 'admin.security', principalId: 'oid-1', role });
}
const denials = () => AUDITS.filter((a) => a.kind === 'uc-governance.denied');

function getReq(qs = '') {
  return { nextUrl: new URL(`http://x/api/catalog/unity/governance${qs}`) } as never;
}
function postReq(body: unknown) {
  return { json: async () => body } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  GRANTS = [];
  AUDITS.length = 0;
  delete process.env.LOOM_TENANT_ADMIN_OID;
  mock(getSession).mockReturnValue(SESSION);
  mock(readGovernedTags).mockResolvedValue([
    { key: 'pii', allowedValues: ['yes', 'no'] },
  ]);
  mock(readAttributeGroups).mockResolvedValue([]);
  mock(listOverlays).mockResolvedValue([]);
  mock(listColumnOverlays).mockResolvedValue([]);
  mock(provenanceFromSync).mockReturnValue(undefined);
  mock(readOverlay).mockImplementation(async (tenantId: string, p: { fullName: string; column?: string }) =>
    emptyOverlay({ tenantId, fullName: p.fullName, column: p.column }));
  mock(writeOverlay).mockImplementation(async (o: unknown) => o);
});

describe('GET /api/catalog/unity/governance', () => {
  it('401 without a session', async () => {
    mock(getSession).mockReturnValue(null);
    expect((await GET(getReq('?fullName=main.sales.orders'), undefined as never)).status).toBe(401);
  });

  it('400 without fullName or prefix', async () => {
    const res = await GET(getReq(''), undefined as never);
    expect(res.status).toBe(400);
  });

  it('returns the overlay + vocabulary + attribute groups on the DEFAULT path (no infra gate; reading needs no grant)', async () => {
    const res = await GET(getReq('?fullName=main.sales.orders'), undefined as never);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.gated).toBeUndefined();
    expect(j.overlay.identity).toBe('uc:main.sales.orders');
    expect(j.vocabulary).toHaveLength(1);
  });

  // NOT a cross-tenant isolation proof — the store is vi.mocked here, so this
  // only shows the ROUTE forwards `tenantScopeId(session)` and never a
  // caller-supplied tenant. The partition key itself (and the fact that another
  // tenant's row is invisible) is pinned against the real query in
  // lib/governance/uc-overlay/__tests__/store.test.ts.
  it('forwards the SESSION tenant scope to the store (never a body/query-supplied one)', async () => {
    await GET(getReq('?fullName=main.sales.orders'), undefined as never);
    expect(readOverlay).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ fullName: 'main.sales.orders' }));
  });

  it('prefix listing does not point-read a securable', async () => {
    const res = await GET(getReq('?prefix=main.sales'), undefined as never);
    expect((await res.json()).ok).toBe(true);
    expect(listOverlays).toHaveBeenCalledWith('tenant-1', 'main.sales');
    expect(readOverlay).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ATTACK SURFACE — authorization on the mutation path
// ===========================================================================
describe('POST /api/catalog/unity/governance — AUTHORIZATION (attack cases)', () => {
  it('401 without a session', async () => {
    mock(getSession).mockReturnValue(null);
    expect((await POST(postReq({ fullName: 'a.b.c' }), undefined as never)).status).toBe(401);
  });

  it('ATTACK: a merely-authenticated user CANNOT forge a certification', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', certification: { rung: 'certified', note: 'trust me' } }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect(writeOverlay).not.toHaveBeenCalled();
    expect(deleteOverlay).not.toHaveBeenCalled();
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.requiredRole).toBe('Admin');
  });

  it('ATTACK: a merely-authenticated user CANNOT flip a GOVERNED tag (LU-6 turns these into access control)', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }] }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: casing does not smuggle a governed tag past the elevated tier', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'PII', value: 'no' }] }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).requiredRole).toBe('Admin');
  });

  it('ATTACK: removing a governed tag is elevated too (a silent de-classification)', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    // The TIER is the assertion, not just the refusal: this caller holds no
    // grant at all, so a bare `403` is produced whether or not the removal is
    // elevated. `requiredRole` is what pins the removal half of
    // `touchesGoverned` — without it, deleting that clause changes nothing.
    expect((await res.json()).requiredRole).toBe('Admin');
    expect(writeOverlay).not.toHaveBeenCalled();
    expect(deleteOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: a real CONTRIBUTOR is refused a governed tag ASSIGN', async () => {
    grant('Contributor');
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }] }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).requiredRole).toBe('Admin');
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: a real CONTRIBUTOR is refused a governed tag REMOVE', async () => {
    grant('Contributor');
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).requiredRole).toBe('Admin');
    expect(writeOverlay).not.toHaveBeenCalled();
    expect(deleteOverlay).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The elevation decision must consult the ROW, not only the live vocabulary.
  //
  // A tenant admin saving `POST /api/catalog/unity/governed-tags {tags: []}`
  // empties the vocabulary in one request while every already-persisted
  // `governed: true` assignment stays on its row. If the tier were derived from
  // the vocabulary alone, that single save would demote every historical
  // governed tag to the Contributor tier — and a Contributor could then
  // de-classify `pii=yes`, the exact access-control input LU-6 compiles.
  // -------------------------------------------------------------------------
  describe('ATTACK: a key dropped from the vocabulary does NOT demote the tier of an already-governed row', () => {
    beforeEach(() => {
      mock(readGovernedTags).mockResolvedValue([]); // the vocabulary was emptied
      mock(readOverlay).mockImplementation(async (tenantId: string, p: { fullName: string; column?: string }) => ({
        ...emptyOverlay({ tenantId, fullName: p.fullName, column: p.column }),
        tags: [{ key: 'pii', value: 'yes', governed: true }],
      }));
      grant('Contributor');
    });

    it('REMOVING it is still Admin-tier — a Contributor cannot silently de-classify', async () => {
      const res = await POST(
        postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
        undefined as never,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).requiredRole).toBe('Admin');
      expect(writeOverlay).not.toHaveBeenCalled();
      expect(deleteOverlay).not.toHaveBeenCalled();
    });

    it('OVERWRITING it is still Admin-tier — a Contributor cannot downgrade pii=yes to an ungoverned pii=no', async () => {
      const res = await POST(
        postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }] }),
        undefined as never,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).requiredRole).toBe('Admin');
      expect(writeOverlay).not.toHaveBeenCalled();
    });

    it('casing on the ROW-sourced check does not smuggle it past the tier either', async () => {
      const res = await POST(
        postReq({ fullName: 'main.sales.orders', removeTagKeys: ['PII'] }),
        undefined as never,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).requiredRole).toBe('Admin');
    });

    it('an UNRELATED free tag on the same row stays Contributor-tier (the row check is not a blanket escalation)', async () => {
      const res = await POST(
        postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'owner', value: 'ana' }] }),
        undefined as never,
      );
      expect(res.status).toBe(200);
      expect(writeOverlay).toHaveBeenCalledTimes(1);
    });

    it('an Admin grant still gets through (the gate is a tier, not a wall)', async () => {
      GRANTS = [];
      grant('Admin');
      const res = await POST(
        postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
        undefined as never,
      );
      expect(res.status).toBe(200);
    });
  });

  it('ATTACK: a merely-authenticated user CANNOT drive a write into the shared tenant Purview account', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', syncPurview: true }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect(syncOverlayToPurview).not.toHaveBeenCalled();
  });

  it('ATTACK: a merely-authenticated user cannot even set a FREE tag (Contributor required)', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'owner', value: 'ana' }] }),
      undefined as never,
    );
    expect(res.status).toBe(403);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: a Contributor may set a free tag but is STILL refused a certification', async () => {
    grant('Contributor');
    const ok = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'owner', value: 'ana' }] }),
      undefined as never,
    );
    expect(ok.status).toBe(200);
    expect(writeOverlay).toHaveBeenCalledTimes(1);

    const denied = await POST(
      postReq({ fullName: 'main.sales.orders', certification: { rung: 'certified' } }),
      undefined as never,
    );
    expect(denied.status).toBe(403);
    expect(writeOverlay).toHaveBeenCalledTimes(1); // still 1 — nothing persisted
  });

  it('a delegated Admin grant (no tenant-admin) unlocks the elevated tier', async () => {
    grant('Admin');
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', certification: { rung: 'certified' } }),
      undefined as never,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).overlay.certification.rung).toBe('certified');
  });

  it('a tenant admin bypasses the capability lookup entirely', async () => {
    asTenantAdmin();
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'yes' }] }),
      undefined as never,
    );
    expect(res.status).toBe(200);
  });

  it('EVERY denial is audited with what the caller attempted', async () => {
    await POST(
      postReq({ fullName: 'main.sales.orders', certification: { rung: 'certified' } }),
      undefined as never,
    );
    const d = denials();
    expect(d).toHaveLength(1);
    expect(d[0].who).toBe('ana@contoso.com');
    expect(d[0].tenantId).toBe('tenant-1');
    expect(d[0].details.status).toBe(403);
    expect(d[0].details.attempted.certificationRung).toBe('certified');
    expect(d[0].details.target).toBe('main.sales.orders');
  });

  it('ATTACK: an UNGRANTED caller cannot amplify the shared audit container with an unbounded denial payload', async () => {
    // The 403 branch records `attempted` BEFORE any request validation runs
    // (validateTagAssignment lives inside applyOverlayMutation, which a denial
    // never reaches) and `withSession` applies no rate limit — so without a cap
    // at the audit sink, a caller with NO grant can write arbitrarily large
    // attacker-controlled documents into the shared Cosmos audit log, one per
    // refused request. This is the storage-amplification class the success path
    // closed via OVERLAY_LIMITS.
    const huge = Array.from({ length: 5_000 }, (_, i) => ({
      key: `k${i}`.padEnd(300, 'x'),
      value: 'v'.repeat(50_000),
    }));
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: huge, syncPurview: true }),
      undefined as never,
    );
    expect(res.status).toBe(403);

    const d = denials();
    expect(d).toHaveLength(1);
    const attemptedTags = d[0].details.attempted.setTags as unknown[];
    expect(attemptedTags.length).toBeLessThanOrEqual(DENIAL_LIMITS.maxArrayItems + 1);
    for (const t of attemptedTags) {
      if (typeof t !== 'object' || t === null) continue;
      for (const v of Object.values(t as Record<string, unknown>)) {
        expect(String(v).length).toBeLessThanOrEqual(DENIAL_LIMITS.maxStringLength + 32);
      }
    }
    // Whole-document bound: the raw body is ~250 MB of tag values; a bounded
    // record is a few KB. 64 KB is a generous ceiling that still fails hard
    // against the unbounded write.
    expect(JSON.stringify(d[0]).length).toBeLessThan(64 * 1024);
  });

  it('ATTACK: the 400 (validation) denial branch is bounded too, not just the 403 branch', async () => {
    asTenantAdmin(); // pass authz so the request reaches validation
    const res = await POST(
      postReq({
        fullName: 'main.sales.orders',
        setTags: [{ key: 'pii', value: 'x'.repeat(80_000) }],
      }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    const d = denials();
    expect(d).toHaveLength(1);
    expect(d[0].details.status).toBe(400);
    expect(JSON.stringify(d[0]).length).toBeLessThan(64 * 1024);
  });

  it('ATTACK: `certification.by` is stamped from the SESSION, never from the request body', async () => {
    asTenantAdmin();
    const res = await POST(
      postReq({
        fullName: 'main.sales.orders',
        certification: { rung: 'certified', by: 'ciso@contoso.com', at: '1999-01-01T00:00:00.000Z' },
      }),
      undefined as never,
    );
    const j = await res.json();
    expect(j.overlay.certification.by).toBe('ana@contoso.com');
    expect(j.overlay.certification.at).not.toBe('1999-01-01T00:00:00.000Z');
  });
});

// ===========================================================================
// Validation + persistence
// ===========================================================================
describe('POST /api/catalog/unity/governance', () => {
  beforeEach(() => { asTenantAdmin(); });

  it('400 with nothing to apply', async () => {
    const res = await POST(postReq({ fullName: 'main.sales.orders' }), undefined as never);
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('400 — and NO write — when a governed value is outside the vocabulary', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'maybe' }] }),
      undefined as never,
    );
    const j = await res.json();
    expect(res.status).toBe(400);
    expect(j.error).toMatch(/not an allowed value for governed tag "pii"/);
    expect(writeOverlay).not.toHaveBeenCalled();
    // …and the rejection is on the record.
    expect(denials()[0].details.status).toBe(400);
  });

  it('persists a valid governed tag with the governed flag set', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'yes' }] }),
      undefined as never,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.overlay.tags).toEqual([{ key: 'pii', value: 'yes', governed: true }]);
    expect(mock(writeOverlay).mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-1', id: 'uc:main.sales.orders' });
  });

  it('400 on an unknown securableType instead of persisting junk', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', securableType: 'wormhole', setTags: [{ key: 'x', value: 'y' }] }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('an applied mutation is audited with BEFORE and AFTER facts (the overwritten certifier stays recoverable)', async () => {
    mock(readOverlay).mockResolvedValue({
      ...emptyOverlay({ tenantId: 'tenant-1', fullName: 'main.sales.orders' }),
      certification: { rung: 'certified', by: 'first@contoso.com', at: '2020-01-01T00:00:00.000Z' },
    });
    await POST(
      postReq({ fullName: 'main.sales.orders', certification: { rung: 'promoted' } }),
      undefined as never,
    );
    const rec = AUDITS.find((a) => a.kind === 'uc-governance.overlay.update');
    expect(rec.details.before.certificationRung).toBe('certified');
    expect(rec.details.before.certifiedBy).toBe('first@contoso.com');
    expect(rec.details.after.certificationRung).toBe('promoted');
    expect(rec.details.after.certifiedBy).toBe('ana@contoso.com');
  });

  it('deletes the row instead of persisting an empty overlay (REAL isEmptyOverlay — the store mock cannot fake it)', async () => {
    mock(readOverlay).mockResolvedValue({
      ...emptyOverlay({ tenantId: 'tenant-1', fullName: 'main.sales.orders' }),
      tags: [{ key: 'pii', value: 'yes', governed: true }],
    });
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
      undefined as never,
    );
    expect((await res.json()).deleted).toBe(true);
    expect(deleteOverlay).toHaveBeenCalledWith('tenant-1', 'uc:main.sales.orders');
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK on the hollow-row claim: a row with revocable Purview residue is KEPT, not deleted', async () => {
    // The original guard was `!next.purview`, and `purview` is a persisted
    // provenance stamp — so any ever-synced securable produced exactly the
    // hollow row the rule claims to prevent. Residue-based keying fixes it.
    mock(readOverlay).mockResolvedValue({
      ...emptyOverlay({ tenantId: 'tenant-1', fullName: 'main.sales.orders' }),
      tags: [{ key: 'pii', value: 'yes', governed: true }],
      purview: { guid: 'g1', classifications: ['Loom_ffff_pii_yes'], businessMetadataKeys: [] },
    });
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
      undefined as never,
    );
    const j = await res.json();
    expect(j.deleted).toBeUndefined();
    expect(deleteOverlay).not.toHaveBeenCalled();
    // Kept so the NEXT sync still knows which classification to revoke.
    expect(mock(writeOverlay).mock.calls[0][0].purview.classifications).toEqual(['Loom_ffff_pii_yes']);
  });

  it('a stamp that is ONLY the `loom_certification` tombstone is not residue — the row is dropped', async () => {
    mock(readOverlay).mockResolvedValue({
      ...emptyOverlay({ tenantId: 'tenant-1', fullName: 'main.sales.orders' }),
      tags: [{ key: 'owner', value: 'ana' }],
      purview: { guid: 'g1', classifications: [], businessMetadataKeys: ['loom_certification'] },
    });
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', removeTagKeys: ['owner'] }),
      undefined as never,
    );
    expect((await res.json()).deleted).toBe(true);
    expect(deleteOverlay).toHaveBeenCalled();
  });

  it('surfaces an unsynced Purview result honestly while still saving the overlay', async () => {
    mock(syncOverlayToPurview).mockResolvedValue({
      synced: false, reason: 'Microsoft Purview is not configured … LOOM_PURVIEW_ACCOUNT',
      classifications: [], removedClassifications: [], businessMetadataKeys: [],
    });
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }], syncPurview: true }),
      undefined as never,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.purview.synced).toBe(false);
    expect(j.purview.reason).toMatch(/LOOM_PURVIEW_ACCOUNT/);
    expect(writeOverlay).toHaveBeenCalled();
  });

  it('PERSISTS BEFORE it pushes to Purview (a failed Cosmos write must not leave orphaned classifications)', async () => {
    const order: string[] = [];
    mock(writeOverlay).mockImplementation(async (o: unknown) => { order.push('cosmos'); return o; });
    mock(syncOverlayToPurview).mockImplementation(async () => {
      order.push('purview');
      return { synced: true, guid: 'g1', classifications: [], removedClassifications: [], businessMetadataKeys: [] };
    });
    await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }], syncPurview: true }),
      undefined as never,
    );
    expect(order[0]).toBe('cosmos');
    expect(order.indexOf('purview')).toBeGreaterThan(0);
  });

  it('a Purview push is audited, including what it REMOVED', async () => {
    mock(syncOverlayToPurview).mockResolvedValue({
      synced: true, guid: 'g1', classifications: ['Loom_ffff_pii_no'],
      removedClassifications: ['Loom_ffff_pii_yes'], businessMetadataKeys: ['loom_certification'],
    });
    await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }], syncPurview: true }),
      undefined as never,
    );
    const rec = AUDITS.find((a) => a.kind === 'uc-governance.overlay.purview-sync');
    expect(rec.details.synced).toBe(true);
    expect(rec.details.classificationsRemoved).toEqual(['Loom_ffff_pii_yes']);
  });
});

// ===========================================================================
// ATTACK SURFACE — unbounded / untyped attribute values
// ===========================================================================
describe('POST attributes — storage-amplification + type attacks', () => {
  const GROUPS = [{
    id: 'g1', name: 'Ops', attributes: [
      { id: 'tier', name: 'Tier', fieldType: 'Single choice', choices: ['gold', 'silver'] },
      { id: 'active', name: 'Active', fieldType: 'Boolean' },
      { id: 'notes', name: 'Notes', fieldType: 'Text' },
    ],
  }];
  beforeEach(() => { asTenantAdmin(); mock(readAttributeGroups).mockResolvedValue(GROUPS); });

  it('ATTACK: a value outside a Single choice is refused (the PR thesis, applied to attributes too)', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', attributes: { tier: 'platinum' } }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not an allowed value for attribute "Tier"/);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: a deep object handed to a Boolean attribute never reaches Cosmos', async () => {
    const bomb: any = {}; let cur = bomb;
    for (let i = 0; i < 500; i++) { cur.n = { pad: 'x'.repeat(100) }; cur = cur.n; }
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', attributes: { active: bomb } }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: an oversized Text value is refused (bounded document growth)', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', attributes: { notes: 'x'.repeat(500_000) } }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too long/);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: hundreds of unknown attribute ids are refused, not accumulated', async () => {
    const attributes: Record<string, string> = {};
    for (let i = 0; i < 400; i++) attributes[`junk-${i}`] = 'x';
    const res = await POST(postReq({ fullName: 'main.sales.orders', attributes }), undefined as never);
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('ATTACK: a non-object `attributes` body is refused rather than cast', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', attributes: ['tier', 'gold'] }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('a well-typed value persists, canonicalised', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', attributes: { tier: 'GOLD', active: true } }),
      undefined as never,
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.overlay.attributes).toEqual({ tier: 'gold', active: true });
  });
});

describe('governed-tag vocabulary route', () => {
  function tagsPost(body: unknown) { return { json: async () => body } as never; }

  it('GET returns the tenant vocabulary', async () => {
    const res = await TAGS_GET({} as never, undefined as never);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tags).toHaveLength(1);
    expect(readGovernedTags).toHaveBeenCalledWith('tenant-1');
  });

  it('ATTACK: POST is refused for a non-admin (the vocabulary is tenant-wide) AND the refusal is audited', async () => {
    const res = await TAGS_POST(tagsPost({ tags: [{ key: 'pii', allowedValues: ['yes'] }] }), undefined as never);
    expect(res.status).toBe(403);
    expect(writeGovernedTags).not.toHaveBeenCalled();
    expect(denials()[0].details.surface).toBe('catalog/unity/governed-tags');
  });

  it('POST 400s on a definition with no allowed values, and records the rejection', async () => {
    asTenantAdmin();
    const res = await TAGS_POST(tagsPost({ tags: [{ key: 'pii', allowedValues: [] }] }), undefined as never);
    expect(res.status).toBe(400);
    expect(writeGovernedTags).not.toHaveBeenCalled();
    expect(denials()[0].details.status).toBe(400);
  });

  it('POST saves for an admin and audits the BEFORE state (a whole-doc overwrite can wipe the vocabulary)', async () => {
    asTenantAdmin();
    mock(writeGovernedTags).mockResolvedValue({ tags: [], updatedAt: 'now' });
    const res = await TAGS_POST(tagsPost({ tags: [] }), undefined as never);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(writeGovernedTags).toHaveBeenCalledWith('tenant-1', expect.any(Array), 'ana@contoso.com');
    const rec = AUDITS.find((a) => a.kind === 'uc-governance.vocabulary.update');
    expect(rec.details.before).toEqual([{ key: 'pii', allowedValues: ['yes', 'no'] }]);
    expect(rec.details.removedKeys).toEqual(['pii']);
  });
});
