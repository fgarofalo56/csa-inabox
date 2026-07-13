/**
 * Contract tests for the MLflow tracking-backend resolver (mlflow-client.ts).
 *
 * Per loom_default_on_opt_out the experiment registry must be reachable by
 * DEFAULT: AML MLflow is preferred, but when the configured AML workspace does
 * not answer the tracking API (e.g. an AI Foundry account that is not a
 * Microsoft.MachineLearningServices workspace → 404 "Workspace not found") Loom
 * falls through to the Databricks-hosted MLflow server (LOOM_DATABRICKS_HOSTNAME,
 * wired day-one), which serves the identical MLflow REST 2.0 contract.
 *
 * These assert: candidate ordering, the AML-preferred path, the 404→Databricks
 * fallback (the live failure this fixes), and the only-when-no-backend gate.
 * Nothing is faked beyond stubbing global fetch + the AAD credential.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class AcaManagedIdentityCredential { async getToken() { return { token: 'AAD.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { AcaManagedIdentityCredential };
});

import {
  searchExperiments,
  isMlflowConfigured,
  mlflowBackendCandidates,
  _resetMlflowBackendCache,
  MlflowNotConfiguredError,
} from '../mlflow-client';

const ENV = [
  'LOOM_SUBSCRIPTION_ID', 'LOOM_AML_WORKSPACE', 'LOOM_FOUNDRY_NAME',
  'LOOM_AML_RG', 'LOOM_FOUNDRY_RG', 'LOOM_AML_REGION', 'LOOM_FOUNDRY_REGION',
  'LOOM_MLFLOW_TRACKING_URI', 'LOOM_DATABRICKS_HOSTNAME',
  'AZURE_CLOUD', 'LOOM_ARM_ENDPOINT', 'LOOM_AML_DATAPLANE_HOST',
];
function clearEnv() { for (const k of ENV) delete process.env[k]; }

/** Stub global fetch; return per-URL {status, body}. Returns the captured call list. */
function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
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

describe('mlflow backend resolver', () => {
  beforeEach(() => { clearEnv(); _resetMlflowBackendCache(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); _resetMlflowBackendCache(); clearEnv(); });

  it('candidates: AML preferred, Databricks fallback, none', () => {
    // Only AML.
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_AML_WORKSPACE = 'ws-aml';
    process.env.LOOM_AML_REGION = 'eastus2';
    let c = mlflowBackendCandidates();
    expect(c.map((x) => x.kind)).toEqual(['aml']);
    expect(isMlflowConfigured()).toBe(true);

    // AML + Databricks → AML first.
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-999.19.azuredatabricks.net';
    c = mlflowBackendCandidates();
    expect(c.map((x) => x.kind)).toEqual(['aml', 'databricks']);

    // Only Databricks (no AML env) → Databricks alone.
    delete process.env.LOOM_AML_WORKSPACE;
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_AML_REGION;
    c = mlflowBackendCandidates();
    expect(c.map((x) => x.kind)).toEqual(['databricks']);
    expect(isMlflowConfigured()).toBe(true);

    // Nothing.
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    expect(mlflowBackendCandidates()).toEqual([]);
    expect(isMlflowConfigured()).toBe(false);
  });

  it('AML answers → uses the AML tracking host', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_AML_WORKSPACE = 'ws-aml';
    process.env.LOOM_AML_REGION = 'eastus2';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-999.19.azuredatabricks.net';

    const calls = captureFetch((url) => {
      if (url.includes('api.azureml.ms')) return { status: 200, body: { experiments: [{ experiment_id: '1', name: 'exp-a' }] } };
      return { status: 200, body: { experiments: [{ experiment_id: '9', name: 'dbx' }] } };
    });

    const exps = await searchExperiments();
    expect(exps.map((e) => e.name)).toEqual(['exp-a']);
    // Every data call went to the AML host, none to Databricks.
    expect(calls.every((c) => c.url.includes('api.azureml.ms'))).toBe(true);
    expect(calls.some((c) => c.url.includes('azuredatabricks.net'))).toBe(false);
  });

  it('AML 404 "Workspace not found" → falls back to Databricks-hosted MLflow (the live fix)', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_AML_WORKSPACE = 'foundry-account'; // not a real ML workspace → 404
    process.env.LOOM_AML_REGION = 'centralus';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.19.azuredatabricks.net';

    const calls = captureFetch((url) => {
      if (url.includes('api.azureml.ms')) return { status: 404, body: { error: { message: 'Workspace not found' } } };
      // Databricks tracking server answers.
      return { status: 200, body: { experiments: [{ experiment_id: '42', name: '/Users/me/exp-dbx' }] } };
    });

    const exps = await searchExperiments();
    expect(exps.map((e) => e.name)).toEqual(['/Users/me/exp-dbx']);
    // The AML host was probed (404) and the real search resolved against Databricks.
    expect(calls.some((c) => c.url.includes('centralus.api.azureml.ms'))).toBe(true);
    const dataCall = calls.find((c) => c.url.includes('azuredatabricks.net/api/2.0/mlflow/experiments/search'));
    expect(dataCall).toBeTruthy();
  });

  it('no backend configured → MlflowNotConfiguredError (the only honest gate)', async () => {
    captureFetch(() => ({ status: 200, body: {} }));
    await expect(searchExperiments()).rejects.toBeInstanceOf(MlflowNotConfiguredError);
  });
});
