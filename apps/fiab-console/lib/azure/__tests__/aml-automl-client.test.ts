/**
 * Contract tests for aml-automl-client — the AutoML wizard's real backend. Each
 * test stubs `fetch` and asserts the exact ARM URL, method, and body so a
 * wire-format regression (jobType, taskDetails shape, $filter, cancel path) is
 * caught.
 *
 * Grounded in Microsoft Learn:
 *   - AutoMLJob ARM shape (jobType:'AutoML', taskDetails):
 *     https://learn.microsoft.com/javascript/api/@azure/arm-machinelearning/automljob
 *   - Forecasting task settings:
 *     https://learn.microsoft.com/azure/machine-learning/how-to-auto-train-forecast
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_AML_SUBSCRIPTION = 'sub-1';
  process.env.LOOM_AML_RESOURCE_GROUP = 'rg-aml';
  process.env.LOOM_AML_WORKSPACE = 'ws-loom';
  process.env.LOOM_AML_REGION = 'eastus2';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown } = () => ({ body: {} })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('submitAutoMlJob', () => {
  it('PUTs an AutoML job with the classification taskDetails + computeId', async () => {
    const calls = captureFetch(() => ({ body: { name: 'loom-automl-x', properties: { status: 'NotStarted', taskDetails: { taskType: 'Classification' } } } }));
    const { submitAutoMlJob } = await import('../aml-automl-client');
    const job = await submitAutoMlJob({
      task: 'Classification',
      trainingDataUri: 'abfss://fs@acct.dfs.core.windows.net/datasets/titanic/mltable/',
      targetColumnName: 'Survived',
      computeName: 'cpu-cluster',
      maxTrials: 10,
      experimentTimeoutMinutes: 30,
    });
    expect(calls[0].url).toMatch(/workspaces\/ws-loom\/jobs\/loom-automl-[a-z0-9-]+\?api-version=2024-10-01$/);
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.jobType).toBe('AutoML');
    expect(body.properties.taskDetails.taskType).toBe('Classification');
    expect(body.properties.taskDetails.targetColumnName).toBe('Survived');
    expect(body.properties.taskDetails.trainingData).toMatchObject({ jobInputType: 'mltable' });
    expect(body.properties.taskDetails.limitSettings).toMatchObject({ maxTrials: 10, timeout: 'PT30M' });
    expect(body.properties.computeId).toMatch(/\/workspaces\/ws-loom\/computes\/cpu-cluster$/);
    expect(job.taskType).toBe('Classification');
  });

  it('forecasting threads forecastingSettings + requires a time column', async () => {
    const calls = captureFetch(() => ({ body: { name: 'loom-automl-y', properties: { taskDetails: { taskType: 'Forecasting' } } } }));
    const { submitAutoMlJob } = await import('../aml-automl-client');
    await submitAutoMlJob({
      task: 'Forecasting',
      trainingDataUri: 'abfss://x/',
      targetColumnName: 'sales',
      computeName: 'cpu-cluster',
      forecastingSettings: { timeColumnName: 'date', forecastHorizon: 14, timeSeriesIdColumnNames: ['store'] },
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.taskDetails.taskType).toBe('Forecasting');
    expect(body.properties.taskDetails.forecastingSettings.timeColumnName).toBe('date');
    expect(body.properties.taskDetails.forecastingSettings.forecastHorizon).toMatchObject({ mode: 'Custom', value: 14 });
    expect(body.properties.taskDetails.forecastingSettings.timeSeriesIdColumnNames).toEqual(['store']);
  });

  it('rejects a forecasting job with no time column', async () => {
    captureFetch();
    const { submitAutoMlJob } = await import('../aml-automl-client');
    await expect(submitAutoMlJob({
      task: 'Forecasting', trainingDataUri: 'abfss://x/', targetColumnName: 's', computeName: 'c',
    } as any)).rejects.toThrow(/timeColumnName/);
  });
});

describe('listAutoMlJobs', () => {
  it('GETs /jobs filtered to jobType eq AutoML and shapes the rows', async () => {
    const calls = captureFetch(() => ({ body: { value: [
      { name: 'a', properties: { jobType: 'AutoML', status: 'Completed', taskDetails: { taskType: 'Regression', primaryMetric: 'R2Score' }, creationContext: { createdAt: '2026-06-01T00:00:00Z' } } },
      { name: 'b', properties: { jobType: 'Command' } }, // must be filtered out client-side
    ] } }));
    const { listAutoMlJobs } = await import('../aml-automl-client');
    const out = await listAutoMlJobs();
    // The $filter is carried as a URLSearchParams query: spaces become '+', and
    // depending on how the URL is captured the '$' and quotes may be percent-
    // encoded (%24 / %27). Decode first, then assert (decodeURIComponent leaves
    // '+' intact, so spaces remain '+' in the decoded form).
    expect(decodeURIComponent(calls[0].url)).toMatch(/\/jobs\?api-version=2024-10-01&\$filter=jobType\+eq\+'AutoML'/);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('a');
    expect(out[0].taskType).toBe('Regression');
    expect(out[0].primaryMetric).toBe('R2Score');
  });
});

describe('cancelAutoMlJob', () => {
  it('POSTs /jobs/{name}/cancel', async () => {
    const calls = captureFetch(() => ({ status: 202, body: {} }));
    const { cancelAutoMlJob } = await import('../aml-automl-client');
    await cancelAutoMlJob('loom-automl-z');
    expect(calls[0].url).toMatch(/\/jobs\/loom-automl-z\/cancel\?api-version=2024-10-01$/);
    expect(calls[0].init?.method).toBe('POST');
  });

  it('treats an already-terminal 409 as success', async () => {
    captureFetch(() => ({ status: 409, body: 'job is in a terminal state' }));
    const { cancelAutoMlJob } = await import('../aml-automl-client');
    await expect(cancelAutoMlJob('done-job')).resolves.toBeUndefined();
  });
});

describe('getAutoMlJob', () => {
  it('returns null on 404', async () => {
    captureFetch(() => ({ status: 404, body: {} }));
    const { getAutoMlJob } = await import('../aml-automl-client');
    expect(await getAutoMlJob('nope')).toBeNull();
  });
});

describe('automlConfigGate', () => {
  it('returns null when the workspace env is set', async () => {
    const { automlConfigGate } = await import('../aml-automl-client');
    expect(automlConfigGate()).toBeNull();
  });
});
