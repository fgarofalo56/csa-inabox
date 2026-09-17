/**
 * #3580 (second pass) — discoverability contract for
 * `GET /api/data-products/[id]/certification`.
 *
 * THE DEFECT THESE PIN. The route ran the SAME unscoped cross-partition
 * `SELECT * FROM c WHERE c.id = @id AND c.itemType = @t` that `[id]` and
 * `[id]/ports` were fixed for under GHSA-hf73-rp4q-66pf, behind `withSession`
 * and nothing else. Its docblock said "not ownership-gated (the trust signal is
 * discoverable)" — the unimplemented-posture sentence this advisory is about.
 * And the payload was wider than a trust signal: `dq.breakdown` is
 * `DqRuleResult[]`, whose `scope` is `table:<name>` / `column:<table>.<column>`
 * and whose `detail` interpolates the rule's own `pattern`/`min`/`max`. So a
 * DRAFT product in ANOTHER Entra tenant handed its table and column names to
 * any signed-in caller holding the GUID.
 *
 * WHAT EVERY ASSERTION BELOW WOULD FAIL ON is stated at its site
 * (`.claude/rules/assertion-design.md`). The two redaction tests are paired
 * with the MEMBER test immediately after them: "the breakdown is absent" is
 * satisfied by deleting the breakdown outright, so the member arm pins that the
 * field still works for the population that is supposed to have it.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `resolveDiscoveryAccess`,
 * `authorizeWorkspace`, `sameTenantConfirmed`, the DP-1 `resolveLifecycleState`
 * resolver, `readCertificationDq` and the certification evaluator all RUN FOR
 * REAL; only Cosmos, the ACL resolver and the owner-tenant helper are stubbed.
 * Fixture shape follows `../../__tests__/route.test.ts` so both sides of the
 * shared decision are exercised against the same rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

/** Cosmos `items` rows, keyed by the id the query asked for. */
let items: Record<string, any> = {};
/** Cosmos `workspaces` rows: workspaceId → { tid }. */
let workspaces: Record<string, { tid?: string }> = {};

const idOf = (params: any[]) => params.find((p) => p.name === '@id')?.value;
const emptyQuery = () => ({ query: () => ({ fetchAll: async () => ({ resources: [] }) }) });

/* DISCLOSED LIMITATION OF THESE MOCKS: they return the whole fixture row and do
 * NOT honour the SELECT projection, unlike the sibling `policies` spec, which
 * had to. It is not load-bearing here — this route reads the item with
 * `SELECT *` and the only narrow query on its path (`workspaceTid`'s
 * `SELECT c.tid`) reads a field the fixture carries — but it does mean these
 * mocks would not witness a projection-narrowing regression on this route the
 * way the policies spec now does. Named rather than left as a silent gap. */

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const row = items[idOf(spec.parameters)];
          return { resources: row ? [row] : [] };
        },
      }),
    },
  }),
  workspacesContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const row = workspaces[idOf(spec.parameters)];
          return { resources: row ? [row] : [] };
        },
      }),
    },
  }),
  accessRequestsContainer: async () => ({ items: emptyQuery() }),
  auditLogContainer: async () => ({ items: emptyQuery() }),
}));

const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

vi.mock('@/lib/dataproducts/owner-tenant', () => ({
  resolveOwnerTenantId: async () => 'creator-oid',
  resolveDataProductDocTenant: async () => null,
}));

/** withSession supplies the session; injecting it here keeps the real route
 *  handler (and every guard inside it) running unmocked. */
let SESSION: any = { claims: { oid: 'oid-1', tid: 'tid-1' } };
vi.mock('@/lib/api/route-toolkit', () => ({
  withSession: (fn: any) => (req: any, ctx: any) =>
    fn(req, { session: SESSION, params: ctx.params }),
}));

import { GET } from '../route';

const ctx = (id: string) => ({ params: { id } }) as any;
const req = {} as any;

const MEMBER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

/**
 * The address-bearing strings. `scope` is verbatim the `DqRule.scope` format
 * (`lib/azure/data-quality-client.ts:53`) and `detail` is the `regex` arm at
 * `:192`, which interpolates the owner's own pattern. If either reaches a
 * non-member the disclosure this issue is about is live.
 */
const SECRET_SCOPE = 'column:crm_customers.email_address';
const SECRET_TABLE_SCOPE = 'table:crm_customers';
const SECRET_DETAIL = '98.2% match /^[a-z]+@contoso-internal\\.example$/';

function product(id: string, opts: { workspaceId: string; lifecycle?: string }) {
  return {
    id,
    itemType: 'data-product',
    workspaceId: opts.workspaceId,
    displayName: `Product ${id}`,
    description: 'A product',
    createdBy: 'creator-oid',
    state: {
      ...(opts.lifecycle ? { lifecycleState: opts.lifecycle } : {}),
      contract: { version: '2.1.0', schema: [{ name: 'a' }, { name: 'b' }] },
      owners: [{ oid: 'creator-oid' }],
      // The persisted measurement `readCertificationDq` reads. `measuredAt` is
      // fixed in the past, so `stale` is deterministic and not clock-dependent.
      dqMeasurement: {
        score: 75,
        meanPercentage: 88,
        gate: null,
        gateId: null,
        missing: [],
        ruleCount: 2,
        passingRules: 1,
        breakdown: [
          {
            ruleId: 'r1', name: 'Email well-formed', check: 'regex',
            scope: SECRET_SCOPE, percentage: 98.2, passed: true, detail: SECRET_DETAIL,
          },
          {
            ruleId: 'r2', name: 'Row freshness', check: 'freshness',
            scope: SECRET_TABLE_SCOPE, percentage: 40, passed: false, detail: 'stale (50h old, limit 1d)',
          },
        ],
        measuredAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
  resolveWorkspaceAccessByOid.mockResolvedValue(null); // non-member by default
  workspaces = { 'ws-1': { tid: 'tid-1' }, 'ws-other': { tid: 'tid-OTHER' } };
  items = {
    'dp-published': product('dp-published', { workspaceId: 'ws-1', lifecycle: 'published' }),
    'dp-draft': product('dp-draft', { workspaceId: 'ws-1', lifecycle: 'draft' }),
    'dp-deprecated': product('dp-deprecated', { workspaceId: 'ws-1', lifecycle: 'deprecated' }),
    'dp-foreign': product('dp-foreign', { workspaceId: 'ws-other', lifecycle: 'published' }),
  };
});

describe('GET is discovery-gated (#3580)', () => {
  it('a DRAFT product 404s a non-member — its DQ rule scopes are not disclosed', async () => {
    // FAILS ON: deleting the `access === 'denied'` early return in route.ts.
    // That restores the pre-fix behaviour exactly: 200, and the body carries
    // `column:crm_customers.email_address`. Measured both ways before landing.
    const res = await GET(req, ctx('dp-draft'));
    // CONTENT FIRST, DELIBERATELY. Status-first throws on `200 !== 404` and the
    // disclosure never gets printed, so a reader of the mutation run sees only a
    // status mismatch and has to take the leak on trust. Body first makes the
    // failure message carry the leaked `column:<table>.<column>` itself.
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(SECRET_SCOPE);
    expect(body).not.toContain(SECRET_TABLE_SCOPE);
    expect(res.status).toBe(404);
  });

  it('a product in ANOTHER Entra tenant 404s even when published', async () => {
    // FAILS ON: setting workspaces['ws-other'].tid = 'tid-1' (then it IS the
    // caller's tenant and 200 is correct), or on replacing `sameTenantConfirmed`
    // with the non-contradiction shape `a && b && a !== b`, which this fixture
    // would still refuse — so the NEXT test covers the absent-tid arm that
    // shape actually breaks on.
    const res = await GET(req, ctx('dp-foreign'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_SCOPE);
  });

  it('a caller whose session carries NO tid claim is REFUSED (positive-match tenant test)', async () => {
    // FAILS ON: swapping `sameTenantConfirmed` for `if (a && b && a !== b)`.
    // With `tid` absent that condition is false for EVERY published product in
    // EVERY tenant and the route answers 200 — the #3843 shape.
    SESSION = { claims: { oid: 'outsider', tid: undefined } };
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(404);
  });

  it('a legacy workspace doc with NO recorded tid is REFUSED', async () => {
    // FAILS ON: the same swap, from the record side.
    workspaces['ws-1'] = {};
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(404);
  });

  it('the refusal is content-identical to "no such product", so it is not an existence oracle', async () => {
    // FAILS ON: wording the denial differently from NOT_FOUND, or answering 403
    // instead of 404 — either makes `dp-draft` distinguishable from an id that
    // does not exist. Deliberately NOT a timing claim: a refusal costs two more
    // Cosmos round-trips than a miss and that side-channel is disclosed in the
    // route rather than implied away here.
    const missing = await GET(req, ctx('dp-does-not-exist'));
    const refused = await GET(req, ctx('dp-draft'));
    expect(missing.status).toBe(refused.status);
    expect(await missing.json()).toEqual(await refused.json());
  });
});

describe('the trust signal still reaches a catalog reader — with the addresses removed', () => {
  it('a PUBLISHED in-tenant product answers a non-member, breakdown EMPTIED and SAID SO', async () => {
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // POSITIVE half — the badge this route exists to serve is intact. FAILS ON:
    // 404ing published in-tenant products (i.e. treating 'discoverable' as
    // 'denied'), which is the over-correction that would make the redaction
    // tests below pass for the wrong reason.
    expect(body.ok).toBe(true);
    expect(body.certification.state).toBeTruthy();
    expect(typeof body.certification.score).toBe('number');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThan(0);

    // The dq SUMMARY is real, not zeroed — the counts are the measured ones.
    // FAILS ON: blanking the whole `dq` block for non-members (ruleCount would
    // be 0, not 2), which would make the redaction indistinguishable from
    // "never measured" and state something the code did not establish (R7).
    expect(body.dq.ruleCount).toBe(2);
    expect(body.dq.passingRules).toBe(1);
    expect(body.dq.score).toBe(75);
    expect(body.dq.measuredAt).toBe('2026-01-01T00:00:00.000Z');

    // REDACTION half. FAILS ON: dropping the `access === 'member'` ternary in
    // route.ts — breakdown then carries both rules and `SECRET_SCOPE` is in the
    // body. FAILS ALSO ON: emptying the array without the flag, which is the
    // silent version that reads as "no rules ran".
    expect(body.dq.breakdown).toEqual([]);
    expect(body.dq.breakdownRedacted).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET_SCOPE);
    expect(JSON.stringify(body)).not.toContain(SECRET_DETAIL);
  });

  it('a DEPRECATED in-tenant product is still discoverable (DP-9 needs it)', async () => {
    // FAILS ON: narrowing DISCOVERABLE to ['published'] — then downstream
    // consumers lose the deprecation notice that is the point of DP-9.
    const res = await GET(req, ctx('dp-deprecated'));
    expect(res.status).toBe(200);
    expect((await res.json()).dq.breakdownRedacted).toBe(true);
  });
});

describe('a MEMBER of the owning workspace is unaffected', () => {
  it('sees the FULL breakdown, rule scopes included — the redaction did not delete the feature', async () => {
    // This is the positive pairing for the two absence assertions above: they
    // are satisfied by removing `breakdown` from the response entirely, and
    // this one is not. FAILS ON: inverting the ternary to
    // `access === 'member' ? [] : (dqResult?.breakdown ?? [])`, or on returning
    // `[]` unconditionally — both leave the owner's own Certification tab with
    // no per-rule detail while every test above still passes.
    resolveWorkspaceAccessByOid.mockResolvedValue(MEMBER);
    const res = await GET(req, ctx('dp-draft')); // a DRAFT: members see drafts
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dq.breakdown).toHaveLength(2);
    expect(body.dq.breakdown[0].scope).toBe(SECRET_SCOPE);
    expect(body.dq.breakdown[0].detail).toBe(SECRET_DETAIL);
    // FAILS ON: emitting `breakdownRedacted: false` for members instead of
    // omitting it — the member payload must stay byte-identical to pre-fix.
    expect('breakdownRedacted' in body.dq).toBe(false);
  });
});
