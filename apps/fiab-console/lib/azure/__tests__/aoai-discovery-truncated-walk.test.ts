/**
 * resolveAoaiTarget over a TRUNCATED connections walk — search first, require
 * completeness last (#2557 re-review).
 *
 * The remediation for the original defect over-corrected and made the fix
 * defeat itself: discovery called
 *   `listConnections({ requireComplete: true })`
 * BEFORE looking for the AOAI connection, so a walk that had ALREADY collected
 * that connection still raised a PagingDeadlineError and Copilot failed holding
 * the answer.
 *
 * The distinction that has to survive:
 *   • found in a truncated list        → a real answer, use it;
 *   • NOT found in a COMPLETE list     → a real answer ("no model is deployed");
 *   • NOT found in a TRUNCATED list    → not an answer at all — raise the
 *                                        deadline, never "deploy a gpt-4o".
 *
 * These go through the REAL foundry-client + foundry-connections-cache against a
 * stubbed ARM, not a hand-written fake of listConnections, so the test cannot
 * drift from the contract it is asserting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// copilot-orchestrator pulls the whole client fleet at module load (some with
// native deps). None are reached on the discovery path under test — and
// foundry-client is deliberately NOT among them: it is the code under test.
vi.mock('@/lib/azure/synapse-sql-client', () => ({ executeQuery: vi.fn(), dedicatedTarget: vi.fn(), serverlessTarget: vi.fn() }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({}));
vi.mock('@/lib/azure/synapse-pool-arm', () => ({}));
vi.mock('@/lib/azure/databricks-client', () => ({}));
vi.mock('@/lib/azure/apim-client', () => ({}));
vi.mock('@/lib/azure/adf-client', () => ({}));
vi.mock('@/lib/azure/kusto-client', () => ({}));
vi.mock('@/lib/azure/adls-client', () => ({}));
vi.mock('@/lib/azure/powerbi-client', () => ({}));
vi.mock('@/lib/azure/fabric-client', () => ({}));
vi.mock('@/lib/azure/activator-client', () => ({}));
vi.mock('@/lib/admin/self-audit', () => ({ runSelfAudit: vi.fn(), applyFix: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSessionsContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: null }), replace: async () => ({}) }),
    items: { create: async () => ({}) },
  })),
}));

/** One ARM connection row in the shape foundry-client's `shapeConnection` reads. */
function row(name: string, category: string, target: string) {
  return { id: `/c/${name}`, name, properties: { category, target } };
}

/**
 * Page 1 answers instantly with `firstPage`; page 2 HANGS until the walk's own
 * deadline aborts it. That is the production shape of #2557 — the breach lands
 * INSIDE a fetch — and it leaves the walk truncated with page 1's rows in hand.
 */
function stubTruncatedAfterFirstPage(firstPage: any[]) {
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (n === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ value: firstPage, nextLink: 'https://arm.example.com/next?p=2' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
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
}

/** A walk that finishes cleanly — no nextLink, so nothing is truncated. */
function stubCompleteWalk(rows: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ value: rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

beforeEach(() => {
  delete process.env.LOOM_AOAI_ENDPOINT;
  delete process.env.LOOM_AOAI_DEPLOYMENT;
  process.env.LOOM_FOUNDRY_NAME = 'foundry-test';
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
  // Tight enough that page 2's hang trips the walk deadline immediately.
  process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS = '80';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_FOUNDRY_NAME;
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS;
});

describe('resolveAoaiTarget — completeness is the LAST question, not the first', () => {
  it('RESOLVES when the AOAI connection is already in hand from a truncated walk', async () => {
    // The regression this locks: requiring a complete list up front threw a
    // PagingDeadlineError even though the answer had been collected on page 1.
    stubTruncatedAfterFirstPage([row('aoai', 'AzureOpenAI', 'https://aoai-x.openai.azure.com')]);
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');

    const target = await resolveAoaiTarget(true);

    expect(target.endpoint).toBe('https://aoai-x.openai.azure.com');
  });

  it('RAISES a deadline (never "no AOAI deployment") when the truncated walk misses it', async () => {
    // Same truncated walk, but the AOAI connection is NOT in the part that was
    // read. "Absent from an incomplete list" is not a conclusion — so this must
    // NOT come out as the deploy-a-model gate.
    stubTruncatedAfterFirstPage([row('blob', 'AzureBlob', 'https://storage.example')]);
    const { resolveAoaiTarget, NoAoaiDeploymentError, AoaiDiscoveryTimeoutError } =
      await import('@/lib/azure/copilot-orchestrator');

    let thrown: any;
    try {
      await resolveAoaiTarget(true);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AoaiDiscoveryTimeoutError);
    expect(thrown).not.toBeInstanceOf(NoAoaiDeploymentError);
    expect(thrown.message).toContain('INCOMPLETE');
    expect(thrown.message).not.toContain('Deploy a gpt-4o');
    expect(thrown.message).toContain('do not deploy');
  });

  it('still reports the honest missing-deployment gate when a COMPLETE walk misses it', async () => {
    // The negative conclusion is only legitimate over a whole list — and there
    // it must stay the actionable config gate, not a deadline.
    stubCompleteWalk([row('blob', 'AzureBlob', 'https://storage.example')]);
    const { resolveAoaiTarget, NoAoaiDeploymentError, AoaiDiscoveryTimeoutError } =
      await import('@/lib/azure/copilot-orchestrator');

    let thrown: any;
    try {
      await resolveAoaiTarget(true);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(NoAoaiDeploymentError);
    expect(thrown).not.toBeInstanceOf(AoaiDiscoveryTimeoutError);
    expect(thrown.message).toContain('Deploy a gpt-4o');
  });
});
