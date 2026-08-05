/**
 * discovery-scanner tests.
 *
 * ## The fake transport models AZURE, not this module
 *
 * `FakeArg` below reproduces the Resource Graph behaviour MEASURED live on
 * 2026-08-05, including the behaviour that makes the naive implementation
 * wrong:
 *
 *   - a subscription in `subscriptions[]` that the identity cannot read is
 *     **dropped silently**: HTTP 200, rows for the readable scopes only, no
 *     field anywhere indicating a scope was skipped;
 *   - `allowPartialScopes` does not change that;
 *   - only when EVERY scope is ineligible does ARG fail, with HTTP 400
 *     `BadRequest` / `NoValidSubscriptionsInQueryRequest` (verbatim body shape
 *     below);
 *   - `ResourceContainers` returns a row per readable subscription including
 *     empty ones.
 *
 * A fake that simply echoed back whatever scope it was given would let the
 * "derive the ledger from the result rows" bug pass every test — which is
 * exactly how the shipped `subscriptionsScanned: subsSeen.size` survived.
 */
import { describe, it, expect } from 'vitest';
import {
  scanForAdoptionCandidates,
  probeCoverage,
  listVisibleSubscriptions,
  armErrorMessage,
  type DiscoveryTransport,
  type HttpResult,
} from '../discovery-scanner';

const SUB_READABLE = '11111111-1111-1111-1111-111111111111';
const SUB_EMPTY = '22222222-2222-2222-2222-222222222222';
const SUB_UNREADABLE = '33333333-3333-3333-3333-333333333333';
const SUB_NOT_IN_ARM = '44444444-4444-4444-4444-444444444444';

interface FakeOpts {
  /** Subscriptions ARM `GET /subscriptions` returns for this token. */
  armVisible?: string[];
  /** Subscriptions ARG can actually read (a subset, in general). */
  argReadable?: string[];
  /** Inventory rows, keyed by subscription. */
  rowsBySub?: Record<string, any[]>;
  /** Force the ARM subscriptions list to fail. */
  armListStatus?: number;
  /** Force the ARG inventory query to fail with this status. */
  inventoryStatus?: number;
  /** Emit a $skipToken forever, to exercise the paging budget. */
  neverEndingPages?: boolean;
}

/** Records every call so a test can assert what was NOT called. */
class FakeArg implements DiscoveryTransport {
  argCalls: any[] = [];
  armCalls: string[] = [];
  constructor(private readonly o: FakeOpts) {}

  async armGet(_token: string, url: string): Promise<HttpResult> {
    this.armCalls.push(url);
    if (this.o.armListStatus && this.o.armListStatus >= 400) {
      return {
        status: this.o.armListStatus,
        body: { error: { code: 'AuthorizationFailed', message: 'does not have authorization' } },
      };
    }
    return {
      status: 200,
      body: {
        value: (this.o.armVisible ?? []).map((id) => ({
          subscriptionId: id,
          displayName: `Sub ${id.slice(0, 4)}`,
          state: 'Enabled',
        })),
      },
    };
  }

  async argQuery(_token: string, payload: any): Promise<HttpResult> {
    this.argCalls.push(payload);
    const requested: string[] = payload?.subscriptions ?? [];
    const readable = this.o.argReadable ?? [];
    const eligible = requested.filter((s) => readable.includes(s));

    // MEASURED: every scope ineligible → 400, regardless of allowPartialScopes.
    if (eligible.length === 0) {
      return {
        status: 400,
        body: {
          error: {
            code: 'BadRequest',
            message: 'Please provide below info when asking for support: …',
            details: [
              {
                code: 'NoValidSubscriptionsInQueryRequest',
                message: `There must be at least one subscription that is eligible to contain resources. Given: '${requested.join("','")}'.`,
              },
            ],
          },
        },
      };
    }

    // The coverage probe STARTS with ResourceContainers; the inventory query
    // starts with `Resources` and only *joins* ResourceContainers for the
    // subscription display name. An `includes` check matches both — which is
    // how the first draft of this fake answered every inventory query with
    // coverage rows and made three real assertions pass for the wrong reason.
    const isCoverage = String(payload?.query ?? '').trimStart().startsWith('ResourceContainers');
    if (isCoverage) {
      // MEASURED: a row per readable subscription, including empty ones. The
      // ineligible scopes are simply absent — no error, no marker.
      return {
        status: 200,
        body: {
          count: eligible.length,
          totalRecords: eligible.length,
          resultTruncated: 'false',
          data: eligible.map((id) => ({ subscriptionId: id, subName: `Sub ${id.slice(0, 4)}` })),
        },
      };
    }

    const rows = eligible.flatMap((id) => (this.o.rowsBySub ?? {})[id] ?? []);
    if (this.o.inventoryStatus && this.o.inventoryStatus >= 400) {
      return {
        status: this.o.inventoryStatus,
        body: { error: { code: 'Forbidden', message: 'Resource Graph refused the query' } },
      };
    }
    const body: any = { count: rows.length, totalRecords: rows.length, resultTruncated: 'false', data: rows };
    // MEASURED: $skipToken is the ONLY truncation signal; resultTruncated stays
    // "false" even on a page that carries one.
    if (this.o.neverEndingPages) body.$skipToken = 'more';
    return { status: 200, body };
  }
}

function adxRow(sub: string, name = 'adx-demo') {
  return {
    id: `/subscriptions/${sub}/resourceGroups/rg-demo/providers/Microsoft.Kusto/clusters/${name}`,
    name,
    type: 'microsoft.kusto/clusters',
    kind: '',
    location: 'centralus',
    resourceGroup: 'rg-demo',
    subscriptionId: sub,
    subName: `Sub ${sub.slice(0, 4)}`,
    skuName: 'Standard_D13_v2',
    skuTier: 'Standard',
    pna: 'Enabled',
    aclDefault: '',
    peCount: 0,
    isHns: '',
    tags: null,
  };
}

const CREDS = { userToken: 'user-tok', uamiToken: 'uami-tok' };

describe('scanForAdoptionCandidates — the coverage ledger', () => {
  it('THE CORE CASE: a subscription ARG silently drops is reported no-access, NOT scanned-with-zero', async () => {
    // Ask for three. ARM lists all three. ARG can only read two — and says
    // nothing about the third. Deriving the ledger from the rows would credit
    // SUB_UNREADABLE with a clean, empty read.
    const t = new FakeArg({
      armVisible: [SUB_READABLE, SUB_EMPTY, SUB_UNREADABLE],
      argReadable: [SUB_READABLE, SUB_EMPTY],
      rowsBySub: { [SUB_READABLE]: [adxRow(SUB_READABLE)] },
    });
    const out = await scanForAdoptionCandidates(
      { subscriptions: [SUB_READABLE, SUB_EMPTY, SUB_UNREADABLE] },
      CREDS,
      t,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const byId = Object.fromEntries(out.result.subscriptions.map((s) => [s.subscriptionId, s]));

    expect(byId[SUB_READABLE].status).toBe('scanned');
    expect(byId[SUB_READABLE].matchedResources).toBe(1);

    // Genuinely empty: read, nothing there. A real and DIFFERENT answer.
    expect(byId[SUB_EMPTY].status).toBe('scanned');
    expect(byId[SUB_EMPTY].matchedResources).toBe(0);

    // Silently dropped by ARG: unknown, never "empty".
    expect(byId[SUB_UNREADABLE].status).toBe('no-access');
    expect(byId[SUB_UNREADABLE].established).toContain('did not return its container row');
  });

  it('the ledger has one entry per REQUESTED subscription, not per subscription with matches', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE, SUB_EMPTY],
      argReadable: [SUB_READABLE, SUB_EMPTY],
      rowsBySub: { [SUB_READABLE]: [adxRow(SUB_READABLE)] },
    });
    const out = await scanForAdoptionCandidates({ subscriptions: [SUB_READABLE, SUB_EMPTY] }, CREDS, t);
    expect(out.ok && out.result.subscriptions.length).toBe(2);
    expect(out.ok && out.result.summary).toContain('Requested 2 subscriptions');
    expect(out.ok && out.result.summary).toContain('Read 2 of them');
  });

  it('a subscription ARM never listed is no-access with a DIFFERENT established reason', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE],
      argReadable: [SUB_READABLE],
      rowsBySub: {},
    });
    const out = await scanForAdoptionCandidates(
      { subscriptions: [SUB_READABLE, SUB_NOT_IN_ARM] },
      CREDS,
      t,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const missing = out.result.subscriptions.find((s) => s.subscriptionId === SUB_NOT_IN_ARM)!;
    expect(missing.status).toBe('no-access');
    expect(missing.established).toContain('ARM GET /subscriptions did not return');
  });

  it('scans everything visible when no explicit scope is supplied (opt-out, not opt-in)', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE, SUB_EMPTY],
      argReadable: [SUB_READABLE, SUB_EMPTY],
      rowsBySub: {},
    });
    const out = await scanForAdoptionCandidates({}, CREDS, t);
    expect(out.ok && out.result.subscriptions.map((s) => s.subscriptionId).sort()).toEqual(
      [SUB_READABLE, SUB_EMPTY].sort(),
    );
  });
});

describe('scanForAdoptionCandidates — refusing to manufacture a false negative', () => {
  it('does NOT call Resource Graph when no requested subscription is visible', async () => {
    // ARG would answer 400 NoValidSubscriptionsInQueryRequest, and a caller
    // that read that as "nothing found" would be inventing an empty estate.
    const t = new FakeArg({ armVisible: [SUB_READABLE], argReadable: [SUB_READABLE] });
    const out = await scanForAdoptionCandidates({ subscriptions: [SUB_NOT_IN_ARM] }, CREDS, t);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(t.argCalls.length).toBe(0);
    expect(out.code).toBe('no_access');
    expect(out.established).toContain('are visible to this identity');
  });

  it('an ARG failure is an ERROR, never an empty inventory', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE],
      argReadable: [SUB_READABLE],
      inventoryStatus: 403,
    });
    const out = await scanForAdoptionCandidates({ subscriptions: [SUB_READABLE] }, CREDS, t);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('arg_error');
    expect(out.established).toContain('inventory query failed');
    // The operator-facing message must not claim the estate is empty.
    expect(out.error).toContain('NOT a statement that your estate is empty');
  });

  it('an ARM subscriptions-list failure is reported per tier, not as an empty result', async () => {
    const t = new FakeArg({ armListStatus: 403 });
    const out = await scanForAdoptionCandidates({}, CREDS, t);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.established).toContain('could not list subscriptions');
    expect(out.established).toContain('user:');
    expect(out.established).toContain('uami:');
  });

  it('with no credential at all, says so — it does not report an empty estate', async () => {
    const t = new FakeArg({});
    const out = await scanForAdoptionCandidates({}, { userToken: null, uamiToken: null }, t);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('no_identity');
    expect(t.armCalls.length).toBe(0);
  });
});

describe('scanForAdoptionCandidates — credential ladder', () => {
  it('prefers the signed-in operator token (tier 1) and reports which tier answered', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE],
      argReadable: [SUB_READABLE],
      rowsBySub: { [SUB_READABLE]: [adxRow(SUB_READABLE)] },
    });
    const out = await scanForAdoptionCandidates({}, CREDS, t);
    expect(out.ok && out.result.credentialTier).toBe('user');
    expect(out.ok && out.result.subscriptions[0].credentialTier).toBe('user');
  });

  it('falls back to the UAMI when the operator has no cached token', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE],
      argReadable: [SUB_READABLE],
      rowsBySub: {},
    });
    const out = await scanForAdoptionCandidates({}, { userToken: null, uamiToken: 'uami-tok' }, t);
    expect(out.ok && out.result.credentialTier).toBe('uami');
  });
});

describe('scanForAdoptionCandidates — truncation', () => {
  it('a budget breach marks every scanned subscription truncated and every empty service uncertain', async () => {
    const t = new FakeArg({
      armVisible: [SUB_READABLE],
      argReadable: [SUB_READABLE],
      rowsBySub: { [SUB_READABLE]: [adxRow(SUB_READABLE)] },
      neverEndingPages: true,
    });
    const out = await scanForAdoptionCandidates({ subscriptions: [SUB_READABLE] }, CREDS, t);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncatedBy).not.toBeNull();
    expect(out.result.subscriptions[0].status).toBe('truncated');
    // A service with no candidate cannot be told "none exist" off a short walk.
    const purview = out.result.services.find((s) => s.serviceKey === 'purview')!;
    expect(purview.noCandidateOutcome).toBe('could-not-look');
    expect(purview.uncertain).toBe(true);
    expect(out.result.summary).toContain('cut short');
  });
});

describe('scanForAdoptionCandidates — greenfield', () => {
  it('an empty subscription yields every service create, none uncertain', async () => {
    const t = new FakeArg({
      armVisible: [SUB_EMPTY],
      argReadable: [SUB_EMPTY],
      rowsBySub: { [SUB_EMPTY]: [] },
    });
    const out = await scanForAdoptionCandidates({ subscriptions: [SUB_EMPTY] }, CREDS, t);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.subscriptions[0].status).toBe('scanned');
    expect(out.result.services.every((s) => s.candidates.length === 0)).toBe(true);
    expect(out.result.services.every((s) => s.recommendation === 'create')).toBe(true);
    expect(out.result.services.every((s) => !s.uncertain)).toBe(true);
    expect(out.result.summary).toContain('Coverage is complete.');
  });
});

describe('probeCoverage', () => {
  it('refuses an empty scope rather than sending a query ARG would 400', async () => {
    const t = new FakeArg({ argReadable: [SUB_READABLE] });
    const r = await probeCoverage(t, 'tok', []);
    expect(r.ok).toBe(false);
    expect(t.argCalls.length).toBe(0);
  });

  it('returns only the subscriptions ARG proved readable', async () => {
    const t = new FakeArg({ argReadable: [SUB_READABLE] });
    const r = await probeCoverage(t, 'tok', [SUB_READABLE, SUB_UNREADABLE]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.readable.keys()]).toEqual([SUB_READABLE]);
  });
});

describe('listVisibleSubscriptions', () => {
  it('skips disabled subscriptions — ARG rejects them as ineligible scopes', async () => {
    const t: DiscoveryTransport = {
      async armGet() {
        return {
          status: 200,
          body: {
            value: [
              { subscriptionId: SUB_READABLE, displayName: 'Live', state: 'Enabled' },
              { subscriptionId: SUB_UNREADABLE, displayName: 'Dead', state: 'Disabled' },
            ],
          },
        };
      },
      async argQuery() {
        return { status: 200, body: {} };
      },
    };
    const r = await listVisibleSubscriptions(t, 'tok');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subscriptions.map((s) => s.subscriptionId)).toEqual([SUB_READABLE]);
  });
});

describe('armErrorMessage', () => {
  it('surfaces the most specific ARM detail code, not the useless outer message', () => {
    const msg = armErrorMessage({
      status: 400,
      body: {
        error: {
          code: 'BadRequest',
          message: 'Please provide below info when asking for support: correlationId = abc',
          details: [
            { code: 'NoValidSubscriptionsInQueryRequest', message: 'There must be at least one subscription…' },
          ],
        },
      },
    });
    expect(msg).toContain('There must be at least one subscription');
    expect(msg).not.toContain('correlationId');
  });

  it('falls back to the status when there is no body at all', () => {
    expect(armErrorMessage({ status: 502, body: null })).toBe('HTTP 502');
  });
});
