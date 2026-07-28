/**
 * resolveAoaiTarget — a paging DEADLINE must never be reported as a missing
 * model deployment (#2557 review, `no-vaporware.md` honest-gate rule).
 *
 * The defect this locks: discovery's `catch` turned ANY `listConnections()`
 * rejection into
 *   NoAoaiDeploymentError('No AOAI deployment on Foundry hub. Deploy a
 *                         gpt-4o / gpt-4.1-class model first…')
 * so on the slow tenant #2557 was written for, Copilot told the operator to go
 * deploy a model that already existed — the single worst outcome of the fix,
 * because it sends someone down completely the wrong path.
 *
 * A timeout now gets its own error type with its own remediation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));

// copilot-orchestrator pulls the whole client fleet at module load (some with
// native deps). None are reached on the discovery path under test.
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

const listConnections = vi.fn();
vi.mock('@/lib/azure/foundry-client', () => ({
  listConnections: (opts?: any) => listConnections(opts),
  isSafetyConfigured: () => false,
  shieldPrompt: vi.fn(),
  moderateContent: vi.fn(),
}));

beforeEach(() => {
  listConnections.mockReset();
  delete process.env.LOOM_AOAI_ENDPOINT;
  delete process.env.LOOM_AOAI_DEPLOYMENT;
  process.env.LOOM_FOUNDRY_NAME = 'foundry-test';
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
});

afterEach(() => {
  vi.resetModules();
  delete process.env.LOOM_FOUNDRY_NAME;
  delete process.env.LOOM_SUBSCRIPTION_ID;
});

describe('resolveAoaiTarget — a deadline is a deadline, not a missing model', () => {
  it('surfaces AoaiDiscoveryTimeoutError (NOT "deploy a gpt-4o model") on a paging deadline', async () => {
    const { PagingDeadlineError } = await import('@/lib/azure/paging-budget');
    listConnections.mockRejectedValue(
      new PagingDeadlineError({
        label: 'foundry /connections',
        truncatedBy: 'time',
        budgetMs: 8_000,
        maxPages: 10,
        pagesFetched: 1,
        collected: 0,
      }),
    );
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
    expect(thrown.message).toContain('TIMEOUT');
    expect(thrown.message).not.toContain('Deploy a gpt-4o');
    expect(thrown.message).toContain('do not deploy anything in response to it');
  });

  it('does the same for a raw FetchTimeoutError from the walk', async () => {
    const { FetchTimeoutError } = await import('@/lib/azure/fetch-with-timeout');
    listConnections.mockRejectedValue(new FetchTimeoutError('https://management.azure.com/…', 8_000));
    const { resolveAoaiTarget, AoaiDiscoveryTimeoutError } = await import('@/lib/azure/copilot-orchestrator');

    await expect(resolveAoaiTarget(true)).rejects.toBeInstanceOf(AoaiDiscoveryTimeoutError);
  });

  it('asks for a COMPLETE list so a truncated one is never read as "absent"', async () => {
    listConnections.mockResolvedValue([
      { id: '/c/1', name: 'aoai', category: 'AzureOpenAI', target: 'https://aoai-x.openai.azure.com' },
    ]);
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');

    await resolveAoaiTarget(true);

    expect(listConnections).toHaveBeenCalledWith(expect.objectContaining({ requireComplete: true }));
  });

  it('still reports the honest missing-deployment gate when the hub really has none', async () => {
    listConnections.mockResolvedValue([{ id: '/c/1', name: 'blob', category: 'AzureBlob', target: 'https://s' }]);
    const { resolveAoaiTarget, NoAoaiDeploymentError } = await import('@/lib/azure/copilot-orchestrator');

    await expect(resolveAoaiTarget(true)).rejects.toBeInstanceOf(NoAoaiDeploymentError);
  });
});
