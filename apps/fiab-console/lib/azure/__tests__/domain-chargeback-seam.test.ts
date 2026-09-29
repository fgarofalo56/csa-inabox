/**
 * SEAM test for the domain chargeback's all-subscriptions-failed path: drives
 * the real `getDomainChargeback` through mocked HTTP. The route maps a thrown
 * 401/403/404 to the "grant Cost Management Reader" gate and passes any other
 * status through, so the status thrown here decides whether an unrecognised
 * response is mislabelled as a missing role (review comment 5892754856).
 *
 * What breaks each test is stated at its site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SUB_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUB_B = 'bbbbbbbb-0000-0000-0000-000000000002';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } },
}));
vi.mock('@/lib/azure/cost-client', () => ({ loomCostSubscriptions: async () => [SUB_A, SUB_B] }));

/** How each subscription's Cost Management query answers in the current test. */
let answers: Record<string, { status: number; body: unknown }>;
const fetchMock = vi.fn(async (url: string) => {
  const sub = [SUB_A, SUB_B].find((s) => url.includes(`/subscriptions/${s}/`)) as string;
  const { status, body } = answers[sub];
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
});
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: (...a: unknown[]) => fetchMock(a[0] as string) }));

/** Rows present but no TagValue / key-named column: the unrecognised shape. */
const UNRECOGNISED = { status: 200, body: { properties: { columns: [{ name: 'Cost' }, { name: 'Currency' }], rows: [[5, 'USD']] } } };
const DENIED = { status: 403, body: { error: { message: 'denied for test' } } };
/** The measured 2023-03-01 TagKey shape: TagKey holds the key name on every row. */
const MEASURED_OK = {
  status: 200,
  body: {
    properties: {
      columns: [{ name: 'Cost' }, { name: 'TagKey' }, { name: 'TagValue' }, { name: 'Currency' }],
      rows: [[7, 'loom-domain', 'finance', 'USD'], [3, 'loom-domain', null, 'USD']],
    },
  },
};

beforeEach(() => { fetchMock.mockClear(); });

describe('getDomainChargeback — every subscription failed', () => {
  it('throws the unrecognised response with its own 502, not an RBAC status', async () => {
    answers = { [SUB_A]: UNRECOGNISED, [SUB_B]: UNRECOGNISED };
    const { getDomainChargeback } = await import('../domain-chargeback');
    // Breaks if the all-failed fallback throws a fixed 403 (the pre-fix code):
    // the route would then render the "grant Cost Management Reader" gate.
    await expect(getDomainChargeback()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('unrecognised tag response') });
  });

  it('still throws the access denial when every subscription refused', async () => {
    answers = { [SUB_A]: DENIED, [SUB_B]: DENIED };
    const { getDomainChargeback } = await import('../domain-chargeback');
    // Breaks if auth errors stop propagating their status (gate lost).
    await expect(getDomainChargeback()).rejects.toMatchObject({ status: 403, message: 'denied for test' });
  });

  it('prefers the access denial when the failures are mixed', async () => {
    answers = { [SUB_A]: UNRECOGNISED, [SUB_B]: DENIED };
    const { getDomainChargeback } = await import('../domain-chargeback');
    // Breaks if the order becomes firstOtherError || firstAuthError (502 here).
    await expect(getDomainChargeback()).rejects.toMatchObject({ status: 403 });
  });
});

describe('getDomainChargeback — one subscription answered', () => {
  it('renders from the answering subscription and records the other', async () => {
    answers = { [SUB_A]: MEASURED_OK, [SUB_B]: UNRECOGNISED };
    const { getDomainChargeback } = await import('../domain-chargeback');
    const m = await getDomainChargeback({ domainNames: { finance: 'Finance' } });
    // Breaks if the value is read from TagKey: the domain would be 'loom-domain'.
    expect(m.rows.map((r) => [r.domainId, r.name, r.cost])).toEqual([['finance', 'Finance', 7]]);
    expect(m.untaggedCost).toBe(3);
    // Breaks if the failing subscription is dropped instead of recorded.
    expect(m.subscriptionErrors).toEqual([{ subscription: SUB_B, error: expect.stringContaining('unrecognised tag response') }]);
  });
});
