/**
 * `getJob` — the ARM 404 must become `AsaJobNotFoundError`, and NOTHING ELSE
 * may.
 *
 * WHY THIS FILE EXISTS (review of #4354): the 404 branch is the load-bearing
 * half of the #3573 fix and no test could see it. Deleting
 *
 *     if (r.status === 404) throw new AsaJobNotFoundError(...)
 *
 * from `stream-analytics-client.ts` left the ASA provisioner + route suites at
 * RC=0, 22/22 green — a SILENT mutation. Without that throw, ARM's 404 falls
 * through to `jsonOrThrow`, becomes a generic `Error`, and the route's
 * `instanceof AsaJobNotFoundError` arm never runs: the caller gets a 502
 * carrying the "provision an ASA job and set LOOM_ASA_RG" hint instead of a
 * 404, `code:'asa-job-not-provisioned'` never fires, and the editor's Fix-it
 * button never renders. That is precisely the `deploy-integrity.md` R7
 * false-cause the PR was opened to remove, so it gets a test that fails when
 * the branch is removed.
 *
 * The three conditions are asserted as three DIFFERENT outcomes, because
 * collapsing them is the original defect:
 *   - env unset        -> AsaNotConfiguredError   (the env vars really are the fix)
 *   - configured + 404 -> AsaJobNotFoundError     (a fact the code established)
 *   - configured + 403 -> a generic Error         (a cause the code did NOT establish)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {
    async getToken() { return { token: 'fake-arm-token' }; }
  },
  DefaultAzureCredential: class {
    async getToken() { return { token: 'fake-arm-token' }; }
  },
  ManagedIdentityCredential: class {
    async getToken() { return { token: 'fake-arm-token' }; }
  },
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class {
    async getToken() { return { token: 'fake-arm-token' }; }
  },
}));

const fetchWithTimeout = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeout(...a),
  FetchTimeoutError: class extends Error {},
  DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30000,
  LLM_FETCH_TIMEOUT_MS: 60000,
  withDeadline: async (p: Promise<any>) => p,
}));

/** A real `Response`, so `r.status` / `r.ok` / `r.text()` behave as ARM's do. */
function armResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.resetModules();
  fetchWithTimeout.mockReset();
  process.env.LOOM_ASA_SUB = 'sub-asa';
  process.env.LOOM_ASA_RG = 'rg-asa';
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_DLZ_RG;
});

describe('getJob — the three conditions #3573 separated', () => {
  it('throws AsaJobNotFoundError on an ARM 404, naming the RG and sub it looked in', async () => {
    fetchWithTimeout.mockResolvedValue(
      armResponse(404, { error: { code: 'ResourceNotFound', message: 'not found' } }),
    );
    const { getJob, AsaJobNotFoundError } = await import('../stream-analytics-client');

    await expect(getJob('orders-stream')).rejects.toBeInstanceOf(AsaJobNotFoundError);

    // Re-throw to inspect the typed payload the route reads.
    const err = await getJob('orders-stream').catch((e: any) => e);
    expect(err.jobName).toBe('orders-stream');
    expect(err.resourceGroup).toBe('rg-asa');
    expect(err.subscriptionId).toBe('sub-asa');
    // The message must state ONLY the absence — never a remediation the code
    // did not establish (R7).
    expect(err.message).toContain("'orders-stream'");
    expect(err.message).toContain('rg-asa');
    expect(err.message).not.toContain('LOOM_ASA_RG');
  });

  it('does NOT turn a 403 into AsaJobNotFoundError — an authz failure is not an absence', async () => {
    fetchWithTimeout.mockResolvedValue(
      armResponse(403, { error: { code: 'AuthorizationFailed', message: 'denied' } }),
    );
    const { getJob, AsaJobNotFoundError, AsaNotConfiguredError } = await import(
      '../stream-analytics-client'
    );

    const err = await getJob('orders-stream').catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AsaJobNotFoundError);
    expect(err).not.toBeInstanceOf(AsaNotConfiguredError);
    expect(err.message).toContain('403');
  });

  it('throws AsaNotConfiguredError when the env vars are unset, without calling ARM', async () => {
    delete process.env.LOOM_ASA_RG;
    delete process.env.LOOM_DLZ_RG;
    const { getJob, AsaNotConfiguredError } = await import('../stream-analytics-client');

    await expect(getJob('orders-stream')).rejects.toBeInstanceOf(AsaNotConfiguredError);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns the mapped job on a 200 (the 404 branch does not swallow the success path)', async () => {
    fetchWithTimeout.mockResolvedValue(
      armResponse(200, {
        name: 'orders-stream',
        id: '/subscriptions/sub-asa/resourceGroups/rg-asa/providers/Microsoft.StreamAnalytics/streamingjobs/orders-stream',
        location: 'eastus2',
        properties: {
          jobState: 'Running',
          sku: { name: 'Standard' },
          transformation: { properties: { streamingUnits: 3, query: 'SELECT * INTO [out] FROM [in]' } },
          inputs: [{ name: 'in', properties: { type: 'Stream', serialization: { type: 'Json' } } }],
          outputs: [{ name: 'out', properties: { datasource: { type: 'Microsoft.Storage/Blob' } } }],
          functions: [],
        },
      }),
    );
    const { getJob } = await import('../stream-analytics-client');

    const job = await getJob('orders-stream');
    expect(job.name).toBe('orders-stream');
    expect(job.jobState).toBe('Running');
    expect(job.inputs).toEqual([{ name: 'in', type: 'Stream', serialization: 'Json' }]);
    expect(job.outputs).toEqual([{ name: 'out', type: 'Microsoft.Storage/Blob' }]);
    // The GET must $expand the children the editor renders, or inputs/outputs
    // come back empty on a job that has them.
    const url = String(fetchWithTimeout.mock.calls[0][0]);
    expect(url).toContain('/streamingjobs/orders-stream');
    expect(url).toContain('$expand=inputs,outputs,transformation,functions');
  });
});
