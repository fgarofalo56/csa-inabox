/**
 * SEAM test for the cost-allocation tag breakdown: drives the real
 * `computeLoomCostSummary` through mocked HTTP, so a mutation at the CALL SITE
 * (not only inside the pure helpers) is visible. The pure-helper tests live in
 * `cost-tag-value-column.test.ts`; this file exists because a mutation that
 * deletes the `tagQueryErrors.push` in the per-subscription loop survived them.
 *
 * Response shape is the one measured live against api-version 2023-03-01.
 * What breaks each test is stated at its site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SUB = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUB2 = 'bbbbbbbb-0000-0000-0000-000000000002';
/** The subscriptions in scope for the current test (two in the grouped-failure case). */
let SCOPE: string[] = [SUB];

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } },
}));
vi.mock('../monitor-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../monitor-client')>()),
  readMonitorConfig: () => ({ subscriptionId: SUB, resourceGroups: ['rg-a'], resourceGroupScopes: [], subscriptions: SCOPE }),
}));
vi.mock('../loom-subscriptions', () => ({ loomSubscriptionScope: () => SCOPE }));
vi.mock('../attached-services-store', () => ({ attachedRegistrySubscriptionIds: async () => [] }));

/** How the TagKey-grouped query answers in the current test. */
let tagAnswer: { status: number; body: unknown };
/** A subscription whose main RG x Service query is refused, or null. */
let groupedRefusedFor: string | null = null;
const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  if (url.includes('/providers/Microsoft.CostManagement/query')) {
    const grouping = JSON.parse(init?.body || '{}')?.dataset?.grouping || [];
    if (grouping.some((g: { type: string }) => g.type === 'TagKey')) return reply(tagAnswer.status, tagAnswer.body);
    const isGrouped = grouping.some((g: { name: string }) => g.name === 'ServiceName');
    if (groupedRefusedFor && isGrouped && url.includes(`/subscriptions/${groupedRefusedFor}/`)) {
      return reply(403, { error: { message: 'grouped query refused for test' } });
    }
    // Every other grouping answers with the main grouped shape and one Loom row.
    return reply(200, { properties: { columns: [{ name: 'Cost' }, { name: 'ResourceGroupName' }, { name: 'Currency' }], rows: [[10, 'rg-a', 'USD']] } });
  }
  if (url.includes('/budgets')) return reply(200, { value: [] });
  return reply(200, { displayName: 'Sub A' });
});
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: (...a: unknown[]) => fetchMock(...(a as [string, { body?: string }])) }));

const MEASURED_TAG_OK = {
  properties: {
    columns: [{ name: 'Cost' }, { name: 'ResourceGroupName' }, { name: 'TagKey' }, { name: 'TagValue' }, { name: 'Currency' }],
    rows: [[7, 'rg-a', 'environment', 'commercial', 'USD'], [3, 'rg-a', 'environment', null, 'USD']],
  },
};

beforeEach(() => { fetchMock.mockClear(); SCOPE = [SUB]; groupedRefusedFor = null; });

describe('computeLoomCostSummary — tag breakdown at the seam', () => {
  it('buckets by tag value and records no tag error on the measured shape', async () => {
    tagAnswer = { status: 200, body: MEASURED_TAG_OK };
    const { computeLoomCostSummary } = await import('../cost-client');
    const s = await computeLoomCostSummary({ timeframe: 'Last7Days' });
    // Breaks if the call site folds by position: byTag would be [{ key: 'environment', cost: 10 }].
    expect(s.byTag).toEqual([{ key: 'commercial', cost: 7 }, { key: '(untagged)', cost: 3 }]);
    // Breaks if a successful query is recorded as an error.
    expect(s.tagQueryErrors).toEqual([]);
  });

  it('records a REFUSED tag query instead of reporting an empty breakdown', async () => {
    tagAnswer = { status: 403, body: { error: { message: 'tag query refused for test' } } };
    const { computeLoomCostSummary } = await import('../cost-client');
    const s = await computeLoomCostSummary({ timeframe: 'Last7Days' });
    // Breaks if the per-subscription loop drops the failed outcome (the
    // surviving mutant M6 of review 5892151649): tagQueryErrors would be [].
    expect(s.tagQueryErrors).toEqual([{ subscription: SUB, error: 'tag query refused for test' }]);
    expect(s.byTag).toEqual([]);
    // Positive pair: the rest of the report still came back.
    expect(s.monthToDate).toBe(10);
  });

  it('records an UNRECOGNISED tag response instead of folding it into (untagged)', async () => {
    tagAnswer = {
      status: 200,
      body: { properties: { columns: [{ name: 'Cost' }, { name: 'ResourceGroupName' }, { name: 'TagKey' }, { name: 'Currency' }], rows: [[5, 'rg-a', 'environment', 'USD']] } },
    };
    const { computeLoomCostSummary } = await import('../cost-client');
    const s = await computeLoomCostSummary({ timeframe: 'Last7Days' });
    // Breaks if an unresolvable value column falls through to foldByTag: byTag
    // would be [] via hasRealTag and tagQueryErrors [] — the "no tags" claim.
    expect(s.tagQueryErrors).toHaveLength(1);
    expect(s.tagQueryErrors?.[0].error).toMatch(/unrecognised tag response.*columns: Cost, ResourceGroupName, TagKey, Currency/);
  });

  it('records a sub whose GROUPED query failed as a tag error too (#4771 R7, B-4)', async () => {
    SCOPE = [SUB, SUB2];
    groupedRefusedFor = SUB2;
    // SUB2's TAG query answers with rows: were its fold not skipped they would
    // double the byTag totals, so the exact byTag below also pins the skip.
    tagAnswer = { status: 200, body: MEASURED_TAG_OK };
    const { computeLoomCostSummary } = await import('../cost-client');
    const s = await computeLoomCostSummary({ timeframe: 'Last7Days' });
    expect(s.subscriptionErrors).toEqual([{ subscription: SUB2, error: 'grouped query refused for test' }]);
    // Breaks if the early return skips the tag fold WITHOUT recording it (the
    // B-4 defect): tagQueryErrors would be [] and SUB2's never-read tag spend
    // would be silently absent from a breakdown that reads as complete.
    expect(s.tagQueryErrors).toEqual([{ subscription: SUB2, error: 'cost query failed, so tag spend was not read: grouped query refused for test' }]);
    // Positive half: SUB's tags still fold, exactly once.
    expect(s.byTag).toEqual([{ key: 'commercial', cost: 7 }, { key: '(untagged)', cost: 3 }]);
  });
});
