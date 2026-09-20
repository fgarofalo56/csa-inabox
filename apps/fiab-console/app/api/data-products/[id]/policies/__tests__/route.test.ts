/**
 * #3580 (second pass) — discoverability contract for
 * `GET /api/data-products/[id]/policies`.
 *
 * THE DEFECT THESE PIN. The route's docblock said the permitted purposes are
 * "resolved across tenants for the consumer Request-access flow", and the code
 * took that literally: step 1 was the unscoped cross-partition
 * `SELECT c.workspaceId FROM c WHERE c.id = @id AND c.itemType = @t` that
 * `[id]` and `[id]/ports` were fixed for under GHSA-hf73-rp4q-66pf, with no
 * workspace, tid or lifecycle predicate, and every later step keyed off the
 * OWNER's tenant. So any signed-in caller holding any product GUID received the
 * owner's `Access` policy `name` AND `rule` — a governance rule string authored
 * by that owner — for a DRAFT product in ANOTHER Entra tenant.
 *
 * WHAT EVERY ASSERTION BELOW WOULD FAIL ON is stated at its site
 * (`.claude/rules/assertion-design.md`). The "no rule text" assertions are
 * absence-only and are therefore PAIRED with the two admitted-population tests
 * in the last block: deleting the policy lookup outright would satisfy the
 * absence half and fail those.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `resolveDiscoveryAccess`,
 * `authorizeWorkspace`, `sameTenantConfirmed` and `resolveLifecycleState` all
 * RUN FOR REAL; only Cosmos, the ACL resolver and the session are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessRole } from '@/lib/auth/workspace-access';

let items: Record<string, any> = {};
/** Workspace rows carry BOTH fields on purpose: `resolveDiscoveryAccess` reads
 *  `c.tid` (the Entra tenant) and this route reads `c.tenantId` (the CREATOR's
 *  oid) off the same doc. A fixture with only one of them exercises half the
 *  path and the other half silently short-circuits. */
let workspaces: Record<string, { tid?: string; tenantId?: string }> = {};
/** `tenant-settings` docs, keyed by doc id. */
let settings: Record<string, any> = {};

const idOf = (params: any[]) => params.find((p) => p.name === '@id')?.value;

/**
 * THE MOCK HONOURS THE SELECT PROJECTION, AND IT HAS TO.
 *
 * The first cut of this file returned the whole fixture row for every query.
 * That made the "the projection still carries `state`" test UNKILLABLE: the
 * mutation it exists to catch — narrowing the route's SELECT back to
 * `c.workspaceId`, which is what `origin/main` had — left all seven tests green,
 * because the fixture handed `state` back regardless of what was asked for. The
 * test could not fail, which is not coverage (`.claude/rules/assertion-design.md`).
 *
 * `SELECT *` returns the row; `SELECT c.a, c.b` returns exactly those fields.
 * That is the Cosmos behaviour the route depends on, and it is why a narrowed
 * projection now makes `resolveLifecycleState` read `undefined` and deny.
 */
function project(row: any, query: string) {
  const list = /^\s*SELECT\s+(.+?)\s+FROM\s/i.exec(query)?.[1] ?? '*';
  if (list.trim() === '*') return row;
  const out: any = {};
  for (const field of list.split(',')) {
    const name = field.trim().replace(/^c\./, '');
    if (name in row) out[name] = row[name];
  }
  return out;
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const row = items[idOf(spec.parameters)];
          return { resources: row ? [project(row, spec.query)] : [] };
        },
      }),
    },
  }),
  workspacesContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const row = workspaces[idOf(spec.parameters)];
          return { resources: row ? [project(row, spec.query)] : [] };
        },
      }),
    },
  }),
  tenantSettingsContainer: async () => ({
    item: (docId: string) => ({
      read: async () => {
        const resource = settings[docId];
        if (!resource) {
          const e: any = new Error('NotFound');
          e.code = 404;
          throw e;
        }
        return { resource };
      },
    }),
  }),
}));

const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

let SESSION: any = { claims: { oid: 'oid-1', tid: 'tid-1' } };
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

import { GET } from '../route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const req = {} as any;

const MEMBER = { workspace: { id: 'ws-1' }, role: 'Viewer' as AccessRole, via: 'acl', canWrite: false };

/** The owner's governance rule text. If this reaches a caller who may not
 *  discover the product, the disclosure this issue is about is live. */
const SECRET_RULE = 'allow when purpose in (fraud-review) and region = eu-west-internal';

const product = (id: string, opts: { workspaceId: string; lifecycle?: string }) => ({
  id,
  itemType: 'data-product',
  workspaceId: opts.workspaceId,
  state: { ...(opts.lifecycle ? { lifecycleState: opts.lifecycle } : {}) },
});

const policiesDoc = (scopeId: string) => ({
  id: `policies:creator-oid`,
  items: [
    { id: 'p1', kind: 'Access', scope: `data-product:${scopeId}`, name: 'Fraud review', rule: SECRET_RULE, enabled: true },
    { id: 'p2', kind: 'Access', scope: 'data-product:someone-else', name: 'Other scope', enabled: true },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
  resolveWorkspaceAccessByOid.mockResolvedValue(null); // non-member by default
  workspaces = {
    'ws-1': { tid: 'tid-1', tenantId: 'creator-oid' },
    'ws-other': { tid: 'tid-OTHER', tenantId: 'creator-oid' },
  };
  items = {
    'dp-published': product('dp-published', { workspaceId: 'ws-1', lifecycle: 'published' }),
    'dp-draft': product('dp-draft', { workspaceId: 'ws-1', lifecycle: 'draft' }),
    'dp-foreign': product('dp-foreign', { workspaceId: 'ws-other', lifecycle: 'published' }),
  };
  settings = {};
  settings['policies:creator-oid'] = {
    id: 'policies:creator-oid',
    items: [
      ...policiesDoc('dp-published').items,
      { id: 'p3', kind: 'Access', scope: 'data-product:dp-draft', name: 'Draft purpose', rule: SECRET_RULE, enabled: true },
      { id: 'p4', kind: 'Access', scope: 'data-product:dp-foreign', name: 'Foreign purpose', rule: SECRET_RULE, enabled: true },
    ],
  };
});

describe('GET is discovery-gated (#3580)', () => {
  it('a DRAFT product 404s a non-member — the owner rule text is not disclosed', async () => {
    // FAILS ON: deleting the `resolveDiscoveryAccess(...) === 'denied'` return
    // in route.ts. That is the pre-fix code exactly: 200 with
    // `{policies:[{name:'Draft purpose', rule: SECRET_RULE}]}`. Measured both
    // ways before landing.
    const res = await GET(req, ctx('dp-draft'));
    // CONTENT FIRST, DELIBERATELY. If the status assertion runs first it throws
    // on `200 !== 404` and the disclosure never gets printed, so a reader of the
    // mutation run sees only a status mismatch and has to take the leak on
    // trust. Asserting the body first makes the failure message carry the leaked
    // rule text itself.
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(SECRET_RULE);
    expect(res.status).toBe(404);
  });

  it('a product in ANOTHER Entra tenant 404s even when published', async () => {
    // FAILS ON: setting workspaces['ws-other'].tid = 'tid-1' — then it IS the
    // caller's tenant and 200 is the correct answer.
    const res = await GET(req, ctx('dp-foreign'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_RULE);
  });

  it('a caller with NO tid claim is REFUSED (positive-match tenant test)', async () => {
    // FAILS ON: swapping `sameTenantConfirmed` for the non-contradiction shape
    // `if (a && b && a !== b)`, which decides nothing when either side is absent
    // and answers 200 for every published product in every tenant (#3843).
    SESSION = { claims: { oid: 'outsider', tid: undefined } };
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(404);
  });

  it('the refusal is content-identical to "no such product"', async () => {
    // FAILS ON: wording the denial differently from NOT_FOUND, answering 403,
    // or answering `{ok:true, policies:[]}` — the last is the tempting one and
    // is indistinguishable from a product that genuinely has no Access policy,
    // which is why the route returns the not-found body instead.
    const missing = await GET(req, ctx('dp-does-not-exist'));
    const refused = await GET(req, ctx('dp-draft'));
    expect(missing.status).toBe(refused.status);
    expect(await missing.json()).toEqual(await refused.json());
  });

  it('the projection still carries `state`, so lifecycle is really resolved', async () => {
    // FAILS ON: narrowing the SELECT back to `c.workspaceId`. `state` would be
    // undefined, `resolveLifecycleState` would read every product as Draft, and
    // this published in-tenant product would 404 instead of answering.
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
  });
});

describe('the Request-access flow still works for callers who may see the product', () => {
  it('a PUBLISHED in-tenant product returns its scoped purposes to a non-member', async () => {
    // POSITIVE pairing for the absence assertions above: they are satisfied by
    // deleting the policy lookup, and this is not. FAILS ON: returning [] for
    // 'discoverable' callers, or on dropping the `scope === data-product:<id>`
    // filter (p2/p3/p4 would appear).
    const res = await GET(req, ctx('dp-published'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.policies).toEqual([{ id: 'p1', name: 'Fraud review', rule: SECRET_RULE }]);
  });

  it('a MEMBER sees the purposes of a DRAFT product', async () => {
    // FAILS ON: gating on lifecycle BEFORE membership (i.e. using
    // `DISCOVERABLE.has(...)` instead of `resolveDiscoveryAccess`), which would
    // lock the owning team out of their own unpublished product.
    resolveWorkspaceAccessByOid.mockResolvedValue(MEMBER);
    const res = await GET(req, ctx('dp-draft'));
    expect(res.status).toBe(200);
    expect((await res.json()).policies).toEqual([
      { id: 'p3', name: 'Draft purpose', rule: SECRET_RULE },
    ]);
  });
});
