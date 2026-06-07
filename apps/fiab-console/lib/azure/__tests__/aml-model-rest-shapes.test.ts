/**
 * Contract tests for the Azure ML model surfaces in foundry-client — the REST
 * calls the bound ml-model editor drives. Each test stubs `fetch` and asserts
 * the exact ARM URL, method, and body so a wire-format regression is caught.
 *
 * Grounded in Microsoft Learn (how-to-manage-rest / ARM model registry):
 *   - ML workspaces list:   .../resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces
 *   - Models in a workspace: .../workspaces/{ws}/models[/{name}/versions[/{ver}]]
 *   - Register model version: PUT .../workspaces/{ws}/models/{name}/versions/{ver}
 *   - Online endpoint + deployment: PUT .../workspaces/{ws}/onlineEndpoints/...
 * Crucially: a NAMED workspace must route under that workspace, NOT the hub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-aml';
  process.env.LOOM_FOUNDRY_NAME = 'hub-loom';
  process.env.LOOM_FOUNDRY_REGION = 'eastus2';
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

describe('listMlWorkspaces', () => {
  it('lists workspaces under the configured RG and flags the hub', async () => {
    const calls = captureFetch(() => ({ body: { value: [
      { name: 'hub-loom', kind: 'Hub', location: 'eastus2', properties: { provisioningState: 'Succeeded' } },
      { name: 'aml-prod', kind: 'Default', location: 'eastus2', properties: {} },
    ] } }));
    const { listMlWorkspaces } = await import('../foundry-client');
    const out = await listMlWorkspaces();
    expect(calls[0].url).toMatch(/subscriptions\/sub-1\/resourceGroups\/rg-aml\/providers\/Microsoft\.MachineLearningServices\/workspaces\?api-version=/);
    expect(out.find((w) => w.name === 'hub-loom')?.isHub).toBe(true);
    expect(out.find((w) => w.name === 'aml-prod')?.isHub).toBe(false);
  });
});

describe('listModels / getModel / listModelVersions', () => {
  it('lists models in a NAMED workspace (not the hub) via ARM', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ name: 'm1', properties: { latestVersion: '4' } }] } }));
    const { listModels } = await import('../foundry-client');
    const out = await listModels('aml-prod');
    expect(calls[0].url).toMatch(/workspaces\/aml-prod\/models\?api-version=/);
    expect(calls[0].url).not.toContain('/workspaces/hub-loom/');
    expect(out[0].latestVersion).toBe('4');
  });

  it('getModel(name, ws) hits the named workspace model container', async () => {
    const calls = captureFetch(() => ({ body: { name: 'fraud', properties: { latestVersion: '2' } } }));
    const { getModel } = await import('../foundry-client');
    const m = await getModel('fraud', 'aml-prod');
    expect(calls[0].url).toMatch(/workspaces\/aml-prod\/models\/fraud\?api-version=/);
    expect(m?.latestVersion).toBe('2');
  });

  it('listModelVersions(name, ws) hits the versions sub-collection', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ name: '1', properties: { modelType: 'mlflow_model', modelUri: 'azureml://x' } }] } }));
    const { listModelVersions } = await import('../foundry-client');
    const out = await listModelVersions('fraud', 'aml-prod');
    expect(calls[0].url).toMatch(/workspaces\/aml-prod\/models\/fraud\/versions\?api-version=/);
    expect(out[0].modelType).toBe('mlflow_model');
  });
});

describe('registerModelVersion', () => {
  it('PUTs a model version under the bound workspace with the artifact URI', async () => {
    const calls = captureFetch(() => ({ body: { name: '5', properties: { modelUri: 'azureml://run/model', modelType: 'mlflow_model' } } }));
    const { registerModelVersion } = await import('../foundry-client');
    await registerModelVersion('fraud', { version: '5', modelUri: 'azureml://run/model', modelType: 'mlflow_model', workspaceName: 'aml-prod' });
    expect(calls[0].url).toMatch(/workspaces\/aml-prod\/models\/fraud\/versions\/5\?api-version=/);
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.modelUri).toBe('azureml://run/model');
    expect(body.properties.modelType).toBe('mlflow_model');
  });
});

describe('createOnlineEndpoint / createOnlineDeployment', () => {
  it('createOnlineEndpoint PUTs under the bound workspace', async () => {
    const calls = captureFetch((url) => {
      // workspace location lookup then endpoint PUT
      if (url.includes('/onlineEndpoints/')) return { body: { name: 'ep-x', properties: { authMode: 'Key' } } };
      return { body: { location: 'eastus2', properties: {} } };
    });
    const { createOnlineEndpoint } = await import('../foundry-client');
    await createOnlineEndpoint('ep-x', { authMode: 'Key', workspaceName: 'aml-prod' });
    const put = calls.find((c) => c.init?.method === 'PUT' && c.url.includes('/onlineEndpoints/ep-x'));
    expect(put, 'endpoint PUT under named workspace').toBeTruthy();
    expect(put!.url).toMatch(/workspaces\/aml-prod\/onlineEndpoints\/ep-x\?api-version=/);
  });

  it('createOnlineDeployment PUTs deployment with azureml:<model>:<ver> under the workspace', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('/deployments/')) return { body: { name: 'blue', properties: { model: 'azureml:fraud:5' } } };
      return { body: { location: 'eastus2', properties: {} } };
    });
    const { createOnlineDeployment } = await import('../foundry-client');
    await createOnlineDeployment('ep-x', 'blue', { modelId: 'azureml:fraud:5', instanceType: 'Standard_DS3_v2', workspaceName: 'aml-prod' });
    const put = calls.find((c) => c.init?.method === 'PUT' && c.url.includes('/deployments/blue'));
    expect(put!.url).toMatch(/workspaces\/aml-prod\/onlineEndpoints\/ep-x\/deployments\/blue\?api-version=/);
    const body = JSON.parse(String(put!.init?.body));
    expect(body.properties.model).toBe('azureml:fraud:5');
    expect(body.properties.endpointComputeType).toBe('Managed');
  });
});

// MLflow registry — stages + lineage. These live on the MLflow REST surface
// AML hosts (api.azureml.ms/mlflow/v1.0/...), NOT on ARM — per Microsoft Learn
// "how-to-manage-models-mlflow" stages are an MLflow-layer concept.
describe('transitionModelVersionStage (MLflow REST)', () => {
  it('POSTs model-versions/transition-stage with the stage + parses current_stage', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('/model-versions/transition-stage')) {
        return { body: { model_version: { name: 'fraud', version: '5', current_stage: 'Production', run_id: 'run-9' } } };
      }
      return { body: {} };
    });
    const { transitionModelVersionStage } = await import('../mlflow-client');
    const mv = await transitionModelVersionStage('fraud', '5', 'Production', { workspace: 'aml-prod' });
    const call = calls.find((c) => c.url.includes('/model-versions/transition-stage'));
    expect(call, 'transition-stage POST').toBeTruthy();
    // MLflow tracking base for the BOUND workspace (not the env hub).
    expect(call!.url).toMatch(/mlflow\/v1\.0\/.*\/workspaces\/aml-prod\/api\/2\.0\/mlflow\/model-versions\/transition-stage$/);
    expect(call!.init?.method).toBe('POST');
    const body = JSON.parse(String(call!.init?.body));
    expect(body).toMatchObject({ name: 'fraud', version: '5', stage: 'Production', archive_existing_versions: false });
    expect(mv.currentStage).toBe('Production');
    expect(mv.runId).toBe('run-9');
  });

  it('threads archive_existing_versions when requested', async () => {
    const calls = captureFetch(() => ({ body: { model_version: { name: 'fraud', version: '5', current_stage: 'Production' } } }));
    const { transitionModelVersionStage } = await import('../mlflow-client');
    await transitionModelVersionStage('fraud', '5', 'Production', { archiveExisting: true });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.archive_existing_versions).toBe(true);
  });
});

describe('getMlflowModelVersion (lineage)', () => {
  it('GETs model-versions/get and surfaces run_id as runId', async () => {
    const calls = captureFetch(() => ({ body: { model_version: { name: 'fraud', version: '3', current_stage: 'Staging', run_id: 'run-77', source: 'azureml://x' } } }));
    const { getMlflowModelVersion } = await import('../mlflow-client');
    const mv = await getMlflowModelVersion('fraud', '3');
    expect(calls[0].url).toMatch(/\/model-versions\/get\?name=fraud&version=3$/);
    expect(mv?.runId).toBe('run-77');
    expect(mv?.currentStage).toBe('Staging');
  });

  it('returns null on 404', async () => {
    captureFetch(() => ({ status: 404, body: { error_code: 'RESOURCE_DOES_NOT_EXIST' } }));
    const { getMlflowModelVersion } = await import('../mlflow-client');
    expect(await getMlflowModelVersion('nope', '1')).toBeNull();
  });
});

describe('createMlflowModelVersion (register-from-run)', () => {
  it('POSTs model-versions/create with source + run_id and parses the version', async () => {
    const calls = captureFetch(() => ({ body: { model_version: { name: 'fraud', version: '6', source: 'azureml://run/model', run_id: 'run-42' } } }));
    const { createMlflowModelVersion } = await import('../mlflow-client');
    const mv = await createMlflowModelVersion('fraud', { source: 'azureml://run/model', runId: 'run-42' });
    const call = calls.find((c) => c.url.includes('/model-versions/create'));
    expect(call, 'create POST').toBeTruthy();
    expect(call!.init?.method).toBe('POST');
    const body = JSON.parse(String(call!.init?.body));
    expect(body).toMatchObject({ name: 'fraud', source: 'azureml://run/model', run_id: 'run-42' });
    expect(mv.version).toBe('6');
    expect(mv.runId).toBe('run-42');
  });
});
