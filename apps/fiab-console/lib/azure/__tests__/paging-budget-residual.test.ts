/**
 * The RESIDUAL pagers (#2582) — a page cap is not a time cap.
 *
 * #2568 bounded the hot-path `nextLink` walks but left fourteen carrying only a
 * hand-rolled `guard < N`. Those cannot spin forever, but N pages x the 30s
 * per-request ceiling is still minutes of unbounded await on a request path,
 * and a breach in them was shaped as "stop at N pages", never as a deadline.
 *
 * Each case here stubs a backend whose page 1 answers instantly and whose page 2
 * HANGS until its AbortSignal fires — the production shape of #2557, where the
 * breach lands INSIDE a fetch rather than at a loop top. The assertion is always
 * the same: the call RESOLVES with page 1's rows instead of rejecting, because
 * `PagingBudget.runPage` absorbed the walk's own `FetchTimeoutError`.
 *
 * The stub MUST settle only on `AbortSignal`. A plain async stub that ignores
 * the signal makes the mid-fetch branch unreachable, so the test would pass
 * without testing anything — the exact review miss that let the original defect
 * through in #2568.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { AcaManagedIdentityCredential: Cred };
});

const SUB = '00000000-0000-0000-0000-000000000000';

/** A response that only ever settles when its AbortSignal fires. */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    // No signal at all => never settles. That is deliberate: if a call site
    // stops threading the deadline down, this test HANGS (and the suite times
    // out) instead of quietly passing.
    if (!signal) return;
    const onAbort = () => {
      const err: any = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Page 1 (per distinct first-page body) resolves instantly with a `nextLink`;
 * every subsequent request hangs until aborted.
 *
 * `firstBody` is a function so a caller can vary page 1 per call index (the
 * discovery clients list subscriptions BEFORE listing resources).
 */
function stubHangAfterFirstPage(firstBody: (call: number) => unknown, answerFirstN = 1) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
      if (calls.length <= answerFirstN) {
        return Promise.resolve(
          new Response(JSON.stringify(firstBody(calls.length)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return hangUntilAborted(init);
    }),
  );
  return calls;
}

/** `{ value, nextLink }` — the ARM / Key Vault / Graph list envelope. */
const pagedArm = (value: unknown[]) => ({ value, nextLink: 'https://arm.example.com/next?p=2' });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Small enough that page 2's hang trips the walk deadline straight away.
  process.env.LOOM_ARM_PAGING_BUDGET_MS = '80';
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  process.env.LOOM_ADMIN_RG = 'rg-loom';
  process.env.LOOM_EVENTSTREAM_CERT_VAULT = 'https://kv-loom.vault.azure.net';
  process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
});

afterEach(() => {
  // PROOF that every case above exercised the MID-FETCH branch, not the loop
  // top. A hanging page is only reachable if the walk actually ISSUED it, so a
  // second fetch call means the abort came from the deadline this budget handed
  // down to `fetchWithTimeout` — the branch #2568 left unreachable. Had a call
  // site stopped threading `timeoutMs`, the hanging page would never settle and
  // the test would time out instead.
  const f = (globalThis as any).fetch;
  if (f?.mock) expect(f.mock.calls.length).toBeGreaterThanOrEqual(2);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const k of [
    'LOOM_ARM_PAGING_BUDGET_MS',
    'LOOM_ARM_PAGING_MAX_PAGES',
    'LOOM_SUBSCRIPTION_ID',
    'LOOM_ADMIN_RG',
    'LOOM_EVENTSTREAM_CERT_VAULT',
    'LOOM_IDENTITY_PICKER_ENABLED',
  ]) delete process.env[k];
});

describe('residual ARM pagers get a wall clock, and a breach TRUNCATES (#2582)', () => {
  it('databricks-discovery armList truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      {
        id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Databricks/workspaces/dbw-1`,
        name: 'dbw-1',
        properties: { workspaceUrl: 'adb-1.azuredatabricks.net', workspaceId: '1' },
      },
    ]));
    const { listDatabricksWorkspaces } = await import('@/lib/azure/databricks-discovery');

    const rows = await listDatabricksWorkspaces(); // must RESOLVE

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('dbw-1');
  });

  it('storage-discovery armList truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      {
        id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1`,
        name: 'st1',
        properties: { isHnsEnabled: true, primaryEndpoints: { dfs: 'https://st1.dfs.core.windows.net/' } },
      },
    ]));
    const { listStorageAccounts } = await import('@/lib/azure/storage-discovery');

    const rows = await listStorageAccounts();

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('st1');
  });

  it('network-discovery armList truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      {
        id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet-1`,
        name: 'vnet-1',
        properties: { addressSpace: { addressPrefixes: ['10.0.0.0/16'] }, subnets: [] },
      },
    ]));
    const { listVirtualNetworks } = await import('@/lib/azure/network-discovery');

    const rows = await listVirtualNetworks();

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('vnet-1');
  });

  it('network-discovery ARG $skipToken walk truncates instead of rejecting', async () => {
    // ARG answers `data` + `$skipToken` (not `value`/`nextLink`).
    stubHangAfterFirstPage(() => ({
      data: [
        {
          id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/privateEndpoints/pe-1`,
          name: 'pe-1',
          subscriptionId: SUB,
          properties: { customDnsConfigs: [] },
        },
      ],
      $skipToken: 'more',
    }));
    const { listPrivateEndpoints } = await import('@/lib/azure/network-discovery');

    const rows = await listPrivateEndpoints();

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('pe-1');
  });

  it('azure-connections-client armList truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      {
        id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law-1`,
        name: 'law-1',
        location: 'eastus',
        properties: { customerId: 'cid', provisioningState: 'Succeeded' },
      },
    ]));
    const { listLogAnalyticsWorkspaces } = await import('@/lib/clients/azure-connections-client');

    const rows = await listLogAnalyticsWorkspaces(SUB);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('law-1');
  });

  it('iothub-client listIoTHubConsumerGroups truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([{ name: 'cg-1' }]));
    const { listIoTHubConsumerGroups } = await import('@/lib/azure/iothub-client');

    const rows = await listIoTHubConsumerGroups('hub-1', { subscriptionId: SUB, resourceGroup: 'rg' });

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('cg-1');
  });

  it('kv-secrets-client listKeyVaultCertificates truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      { id: 'https://kv-loom.vault.azure.net/certificates/cert-1', attributes: { enabled: true } },
    ]));
    const { listKeyVaultCertificates } = await import('@/lib/azure/kv-secrets-client');

    const rows = await listKeyVaultCertificates();

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('cert-1');
  });

  it('cmk-client listVaultKeys truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      { kid: 'https://kv-loom.vault.azure.net/keys/key-1', attributes: { enabled: true, created: 1 } },
    ]));
    const { listVaultKeys } = await import('@/lib/clients/cmk-client');

    const rows = await listVaultKeys('https://kv-loom.vault.azure.net');

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('key-1');
  });

  it('cmk-client listKeyVersions truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      { kid: 'https://kv-loom.vault.azure.net/keys/key-1/v1', attributes: { enabled: true, created: 1 } },
    ]));
    const { listKeyVersions } = await import('@/lib/clients/cmk-client');

    const rows = await listKeyVersions('https://kv-loom.vault.azure.net', 'key-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe('v1');
  });

  it('monitor-client listAlertHistory truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      {
        name: 'alert-1',
        properties: { essentials: { alertRule: 'rule-1', monitorCondition: 'Fired', alertState: 'New', startDateTime: '2026-07-01T00:00:00Z' } },
      },
    ]));
    const { listAlertHistory } = await import('@/lib/azure/monitor-client');

    const rows = await listAlertHistory();

    expect(rows).toHaveLength(1);
    expect(rows[0].alertRule).toBe('rule-1');
  });

  it('monitor-client activity-log walk truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => pagedArm([
      { eventTimestamp: '2026-07-01T00:00:00Z', operationName: { value: 'op' }, resourceGroupName: 'rg-loom' },
    ]));
    const { listActivityLog } = await import('@/lib/azure/monitor-client');

    const rows = await listActivityLog();

    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('graph-identity-client getGroupTransitiveMembers truncates instead of rejecting', async () => {
    stubHangAfterFirstPage(() => ({
      value: [{ id: 'u1', displayName: 'User One', '@odata.type': '#microsoft.graph.user' }],
      '@odata.nextLink': 'https://graph.example.com/next?p=2',
    }));
    const { getGroupTransitiveMembers } = await import('@/lib/azure/graph-identity-client');

    const rows = await getGroupTransitiveMembers('group-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('u1');
  });

  it('spark-binding route listSynapseWorkspaces truncates instead of rejecting', async () => {
    // The route calls `listSynapseWorkspaces().catch(() => [])`, so a THROW on a
    // deadline would silently blank the picker — the operator would be told the
    // subscription has no Synapse workspace and pushed to provision a duplicate.
    stubHangAfterFirstPage(() => pagedArm([
      { name: 'syn-1', id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/syn-1` },
    ]));
    vi.doMock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'u1' } }) }));
    vi.doMock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => true }));
    vi.doMock('@/lib/admin/platform-settings', () => ({
      resolveSparkStreamingBinding: async () => null,
      writeSparkStreamingBinding: async () => {},
    }));
    vi.doMock('@/lib/azure/databricks-discovery', () => ({ listDatabricksWorkspaces: async () => [] }));
    const { GET } = await import('@/app/api/items/eventstream/spark-binding/route');

    const res = await GET({
      nextUrl: new URL('https://loom.example.com/api/items/eventstream/spark-binding?discover=1'),
    } as any);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.options?.synapseWorkspaces?.map((w: any) => w.name)).toContain('syn-1');
  });

  it('workspace-roles graphUserInGroup FAILS CLOSED on a deadline, and says why', async () => {
    // The membership probe 500s, so the code falls through to the paged walk;
    // page 1 does not contain the user and page 2 hangs. An authorization check
    // must NOT answer "member" off a list it never finished reading — false is
    // correct — but the deadline has to be logged as a deadline.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        calls.push(String(url));
        if (calls.length === 1) return Promise.resolve(new Response('boom', { status: 500 }));
        if (calls.length === 2) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ value: [{ id: 'someone-else' }], '@odata.nextLink': 'https://graph.example.com/next?p=2' }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return hangUntilAborted(init);
      }),
    );
    const { userIsTransitiveGroupMember } = await import('@/lib/azure/workspace-roles-client');

    const isMember = await userIsTransitiveGroupMember('u1', 'group-1'); // must RESOLVE

    expect(isMember).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[paging-budget]'))).toBe(true);
  });
});
