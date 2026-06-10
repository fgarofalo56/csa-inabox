/**
 * databricks-client — Unity Catalog write-path + DLT / MLflow / Serving REST
 * contract tests.
 *
 * Real tests (per .claude/rules/no-vaporware.md): prove each new client fn issues
 * the *actual* Databricks REST call with the right method, URL, and body — no
 * stubs. We mock only:
 *   - @azure/identity → fake credential (module loads without real AAD)
 *   - global.fetch    → captures the exact request the client makes.
 *
 * Endpoints (Microsoft Learn):
 *   - UC volumes   : POST   /api/2.1/unity-catalog/volumes ; DELETE /…/{full_name}
 *   - DLT pipelines: POST   /api/2.0/pipelines ; POST /…/{id}/updates ; DELETE /…/{id}
 *   - MLflow       : POST   /api/2.0/mlflow/experiments/search|create ;
 *                    GET    /api/2.0/mlflow/registered-models/list ;
 *                    POST   /api/2.0/mlflow/registered-models/create
 *   - Serving      : GET/POST /api/2.0/serving-endpoints
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1234567890.7.azuredatabricks.net';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

import {
  createUcVolume, deleteUcVolume,
  createDltPipeline, startDltUpdate, deleteDltPipeline, listDltPipelines,
  listMlflowExperiments, createMlflowExperiment, listRegisteredModels, createRegisteredModel,
  listServingEndpoints, createServingEndpoint, deleteServingEndpoint,
} from '../databricks-client';

const HOST = 'adb-1234567890.7.azuredatabricks.net';

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function setup(body: unknown = {}) {
  // Typed with `any` args so `.mock.calls[0]` is the [url, init] tuple under
  // strict tsc (matches the pattern in databricks-client-create-delete.test.ts).
  const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async (..._args: any[]) => okResponse(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('databricks-client — UC volumes write', () => {
  it('createUcVolume POSTs /api/2.1/unity-catalog/volumes with EXTERNAL storage_location', async () => {
    const fetchMock = setup({ name: 'landing', full_name: 'main.bronze.landing' });
    const out = await createUcVolume({
      name: 'landing', catalog_name: 'main', schema_name: 'bronze',
      volume_type: 'EXTERNAL', storage_location: 'abfss://c@a.dfs.core.windows.net/landing',
    });
    expect(out.full_name).toBe('main.bronze.landing');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/volumes`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      name: 'landing', catalog_name: 'main', schema_name: 'bronze',
      volume_type: 'EXTERNAL', storage_location: 'abfss://c@a.dfs.core.windows.net/landing',
    });
  });

  it('createUcVolume throws when EXTERNAL has no storage_location (no REST call)', async () => {
    const fetchMock = setup();
    await expect(createUcVolume({ name: 'v', catalog_name: 'main', schema_name: 'bronze', volume_type: 'EXTERNAL' }))
      .rejects.toThrow(/storage_location/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleteUcVolume DELETEs /api/2.1/unity-catalog/volumes/{full_name}', async () => {
    const fetchMock = setup();
    await deleteUcVolume('main.bronze.landing');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/volumes/main.bronze.landing`);
    expect(init.method).toBe('DELETE');
  });
});

describe('databricks-client — DLT pipelines', () => {
  it('listDltPipelines GETs /api/2.0/pipelines and unwraps statuses', async () => {
    const fetchMock = setup({ statuses: [{ pipeline_id: 'p1', name: 'bronze-etl', state: 'IDLE' }] });
    const out = await listDltPipelines();
    expect(out).toHaveLength(1);
    expect(out[0].pipeline_id).toBe('p1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/pipelines`);
  });

  it('createDltPipeline POSTs /api/2.0/pipelines with libraries + dev mode', async () => {
    const fetchMock = setup({ pipeline_id: 'p-new' });
    const out = await createDltPipeline({ name: 'bronze', libraries: [{ notebook: { path: '/Workspace/bronze' } }], catalog: 'main', target: 'bronze' });
    expect(out.pipeline_id).toBe('p-new');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/pipelines`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent.name).toBe('bronze');
    expect(sent.libraries[0].notebook.path).toBe('/Workspace/bronze');
    expect(sent.catalog).toBe('main');
    expect(sent.development).toBe(true);
  });

  it('startDltUpdate POSTs /api/2.0/pipelines/{id}/updates with full_refresh', async () => {
    const fetchMock = setup({ update_id: 'u1' });
    const out = await startDltUpdate('p1', true);
    expect(out.update_id).toBe('u1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/pipelines/p1/updates`);
    expect(JSON.parse(init.body as string)).toEqual({ full_refresh: true });
  });

  it('deleteDltPipeline DELETEs /api/2.0/pipelines/{id}', async () => {
    const fetchMock = setup();
    await deleteDltPipeline('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/pipelines/p1`);
    expect(init.method).toBe('DELETE');
  });
});

describe('databricks-client — MLflow', () => {
  it('listMlflowExperiments POSTs /api/2.0/mlflow/experiments/search', async () => {
    const fetchMock = setup({ experiments: [{ experiment_id: 'e1', name: '/Users/me/exp' }] });
    const out = await listMlflowExperiments();
    expect(out[0].experiment_id).toBe('e1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/mlflow/experiments/search`);
    expect(init.method).toBe('POST');
  });

  it('createMlflowExperiment POSTs /api/2.0/mlflow/experiments/create', async () => {
    const fetchMock = setup({ experiment_id: 'e-new' });
    const out = await createMlflowExperiment('/Users/me/exp');
    expect(out.experiment_id).toBe('e-new');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/mlflow/experiments/create`);
    expect(JSON.parse(init.body as string)).toMatchObject({ name: '/Users/me/exp' });
  });

  it('listRegisteredModels GETs /api/2.0/mlflow/registered-models/list', async () => {
    const fetchMock = setup({ registered_models: [{ name: 'main.ml.churn' }] });
    const out = await listRegisteredModels();
    expect(out[0].name).toBe('main.ml.churn');
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`https://${HOST}/api/2.0/mlflow/registered-models/list`);
  });

  it('createRegisteredModel POSTs /api/2.0/mlflow/registered-models/create and unwraps registered_model', async () => {
    const fetchMock = setup({ registered_model: { name: 'main.ml.churn' } });
    const out = await createRegisteredModel('main.ml.churn');
    expect(out.name).toBe('main.ml.churn');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/mlflow/registered-models/create`);
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'main.ml.churn' });
  });
});

describe('databricks-client — Model serving', () => {
  it('listServingEndpoints GETs /api/2.0/serving-endpoints', async () => {
    const fetchMock = setup({ endpoints: [{ name: 'churn', state: { ready: 'READY' } }] });
    const out = await listServingEndpoints();
    expect(out[0].name).toBe('churn');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/serving-endpoints`);
  });

  it('createServingEndpoint POSTs /api/2.0/serving-endpoints with served_entities', async () => {
    const fetchMock = setup({ name: 'churn' });
    const out = await createServingEndpoint({ name: 'churn', model_name: 'main.ml.churn', model_version: '3', workload_size: 'Medium' });
    expect(out.name).toBe('churn');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/serving-endpoints`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent.name).toBe('churn');
    expect(sent.config.served_entities[0]).toMatchObject({
      entity_name: 'main.ml.churn', entity_version: '3', workload_size: 'Medium', scale_to_zero_enabled: true,
    });
  });

  it('deleteServingEndpoint DELETEs /api/2.0/serving-endpoints/{name}', async () => {
    const fetchMock = setup();
    await deleteServingEndpoint('churn');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/serving-endpoints/churn`);
    expect(init.method).toBe('DELETE');
  });
});
