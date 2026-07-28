/**
 * The hand-rolled `PagingBudget` loops — a deadline must TRUNCATE there too.
 *
 * `PagingBudget.runPage` absorbs the walk's OWN `FetchTimeoutError` and turns it
 * into a `PAGE_DEADLINE` truncation, and #2557's whole documented contract is
 * "TRUNCATE, NEVER THROW". But `runPage` only helps the loops that USE it: the
 * six loops migrated by hand in that PR passed `budget.remainingMs()` straight
 * to `fetchWithTimeout` and never absorbed the throw, so in those clients a
 * deadline still rejected the caller — the exact behaviour the change claims to
 * have removed, surviving in the majority of the migrated call sites.
 *
 * One test per hand-rolled loop. Each stubs an ARM whose page 1 answers and
 * whose page 2 HANGS until the walk's deadline aborts it (the production shape
 * of #2557 — the breach lands inside a fetch, not at a loop top), then asserts
 * the call RESOLVES with page 1's rows instead of rejecting.
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

/**
 * Page 1 resolves instantly; every later page hangs until its AbortSignal
 * fires. `fetchWithTimeout` converts that abort into a FetchTimeoutError — the
 * throw the loop under test has to absorb.
 */
function stubHangAfterFirstPage(firstPageValue: any[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ value: firstPageValue, nextLink: 'https://arm.example.com/next?p=2' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles — the budget must still bound us
        const onAbort = () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Small enough that page 2's hang trips the walk deadline straight away.
  process.env.LOOM_ARM_PAGING_BUDGET_MS = '80';
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
  // aml-client / aml-automl-client
  process.env.LOOM_AML_RESOURCE_GROUP = 'rg-loom';
  process.env.LOOM_AML_WORKSPACE = 'ws-loom';
  // eventhubs-client
  process.env.LOOM_EVENTHUB_RG = 'rg-loom';
  process.env.LOOM_EVENTHUB_NAMESPACE = 'ehns-loom';
  // eventgrid-topics-client
  process.env.LOOM_EVENTGRID_RG = 'rg-loom';
  // synapse-artifacts-client
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const k of [
    'LOOM_ARM_PAGING_BUDGET_MS',
    'LOOM_ARM_PAGING_MAX_PAGES',
    'LOOM_SUBSCRIPTION_ID',
    'LOOM_AML_RESOURCE_GROUP',
    'LOOM_AML_WORKSPACE',
    'LOOM_EVENTHUB_RG',
    'LOOM_EVENTHUB_NAMESPACE',
    'LOOM_EVENTGRID_RG',
    'LOOM_SYNAPSE_WORKSPACE',
  ]) delete process.env[k];
});

describe('hand-rolled PagingBudget loops absorb their OWN deadline (#2557 re-review)', () => {
  it('aml-client.listJobs truncates instead of rejecting', async () => {
    stubHangAfterFirstPage([{ id: '/j/1', name: 'job-1', properties: { jobType: 'Command' } }]);
    const { listJobs } = await import('@/lib/azure/aml-client');

    const jobs = await listJobs(); // must RESOLVE, not reject

    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('job-1');
  });

  it('aml-automl-client.listAutoMlJobs truncates instead of rejecting', async () => {
    stubHangAfterFirstPage([
      { id: '/j/1', name: 'automl-1', properties: { jobType: 'AutoML', status: 'Completed' } },
    ]);
    const { listAutoMlJobs } = await import('@/lib/azure/aml-automl-client');

    const jobs = await listAutoMlJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('automl-1');
  });

  it('eventhubs-client armList truncates instead of rejecting', async () => {
    stubHangAfterFirstPage([{ name: 'hub-1', properties: {} }]);
    const { listEventHubs } = await import('@/lib/azure/eventhubs-client');

    const hubs = await listEventHubs();

    expect(hubs).toHaveLength(1);
    expect(hubs[0].name).toBe('hub-1');
  });

  it('eventgrid-topics-client.listEventGridTopics truncates instead of rejecting', async () => {
    stubHangAfterFirstPage([{ name: 'topic-1', properties: {} }]);
    const { listEventGridTopics } = await import('@/lib/azure/eventgrid-topics-client');

    const topics = await listEventGridTopics();

    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe('topic-1');
  });

  it('eventgrid-topics-client.listTopicEventSubscriptions truncates instead of rejecting', async () => {
    stubHangAfterFirstPage([{ name: 'sub-1', properties: { provisioningState: 'Succeeded' } }]);
    const { listTopicEventSubscriptions } = await import('@/lib/azure/eventgrid-topics-client');

    const subs = await listTopicEventSubscriptions('topic-1');

    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe('sub-1');
  });

  it('synapse-artifacts-client listAll truncates instead of rejecting', async () => {
    stubHangAfterFirstPage([{ name: 'pipeline-1', properties: {} }]);
    const { listPipelines } = await import('@/lib/azure/synapse-artifacts-client');

    const pipelines = await listPipelines();

    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe('pipeline-1');
  });
});
