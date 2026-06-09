import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @azure/identity so importing pipeline-tools (which builds a credential
// at module load for the generate sub-call) doesn't pull the Azure SDK ESM.
// None of the handlers under test exercise the credential.
vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'x', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

// Mock the Azure clients so the handlers run without network / credentials.
vi.mock('../../azure/adf-client', () => ({
  listLinkedServices: vi.fn(),
  listDatasets: vi.fn(),
  getPipeline: vi.fn(),
  runPipeline: vi.fn(),
  listPipelineRuns: vi.fn(),
  listActivityRuns: vi.fn(),
  upsertPipeline: vi.fn(),
}));
vi.mock('../../azure/synapse-dev-client', () => ({
  listLinkedServices: vi.fn(),
  listDatasets: vi.fn(),
  getPipeline: vi.fn(),
  runPipeline: vi.fn(),
  getPipelineRun: vi.fn(),
  listActivityRuns: vi.fn(),
  upsertPipeline: vi.fn(),
}));

import * as adf from '../../azure/adf-client';
import * as synapseDev from '../../azure/synapse-dev-client';
import {
  handlePipelineListConnections,
  handlePipelineSummarize,
  handlePipelineExplainError,
  handlePipelineRun,
  handlePipelineGetRunStatus,
} from '../pipeline-tools';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handlePipelineListConnections', () => {
  it('classifies ADLS as both source and sink, HTTP as source-only', async () => {
    (adf.listLinkedServices as any).mockResolvedValue([
      { name: 'ls-adls', properties: { type: 'AzureBlobFS' } },
      { name: 'ls-http', properties: { type: 'HttpServer' } },
      { name: 'ls-sql', properties: { type: 'AzureSqlDatabase' } },
    ]);
    const conns = await handlePipelineListConnections({ backend: 'adf' });
    const adls = conns.find((c) => c.name === 'ls-adls')!;
    const http = conns.find((c) => c.name === 'ls-http')!;
    const sql = conns.find((c) => c.name === 'ls-sql')!;
    expect(adls.capable.sort()).toEqual(['sink', 'source']);
    expect(http.capable).toEqual(['source']);
    expect(sql.capable.sort()).toEqual(['sink', 'source']);
  });

  it('uses the Synapse client when backend is synapse', async () => {
    (synapseDev.listLinkedServices as any).mockResolvedValue([
      { name: 'ws-adls', properties: { type: 'AzureDataLakeStoreGen2' } },
    ]);
    const conns = await handlePipelineListConnections({ backend: 'synapse' });
    expect(synapseDev.listLinkedServices).toHaveBeenCalled();
    expect(conns[0].name).toBe('ws-adls');
    expect(conns[0].capable.sort()).toEqual(['sink', 'source']);
  });
});

describe('handlePipelineSummarize', () => {
  it('maps activities + normalizes both string and object dependsOn forms', async () => {
    (adf.getPipeline as any).mockResolvedValue({
      name: 'copy_orders',
      properties: {
        description: 'copy then notify',
        activities: [
          { name: 'CopyOrders', type: 'Copy', dependsOn: [] },
          { name: 'Notify', type: 'WebActivity', dependsOn: [{ activity: 'CopyOrders', dependencyConditions: ['Succeeded'] }] },
        ],
      },
    });
    const out = await handlePipelineSummarize({ pipelineName: 'copy_orders', backend: 'adf' });
    expect(out.activityCount).toBe(2);
    expect(out.activities[0]).toEqual({ name: 'CopyOrders', type: 'Copy', dependsOn: [] });
    expect(out.activities[1].dependsOn).toEqual(['CopyOrders']);
  });
});

describe('handlePipelineExplainError', () => {
  it('returns only Failed activities with real errorCode + message (ADF)', async () => {
    (adf.listActivityRuns as any).mockResolvedValue([
      { activityName: 'CopyOrders', activityType: 'Copy', status: 'Failed', error: { errorCode: 'UserErrorColumnMappingNotCompatible', message: 'Column mapping is invalid', failureType: 'UserError' } },
      { activityName: 'Notify', activityType: 'WebActivity', status: 'Skipped' },
    ]);
    (adf.listPipelineRuns as any).mockResolvedValue([
      { runId: 'run-123', status: 'Failed', message: 'Activity CopyOrders failed' },
    ]);
    const out = await handlePipelineExplainError({ runId: 'run-123', backend: 'adf', pipelineName: 'copy_orders' });
    expect(out.failedActivities).toHaveLength(1);
    expect(out.failedActivities[0]).toMatchObject({
      name: 'CopyOrders',
      type: 'Copy',
      errorCode: 'UserErrorColumnMappingNotCompatible',
      message: 'Column mapping is invalid',
    });
    expect(out.status).toBe('Failed');
    expect(out.runMessage).toBe('Activity CopyOrders failed');
  });

  it('reads Synapse per-activity runs', async () => {
    (synapseDev.listActivityRuns as any).mockResolvedValue([
      { activityName: 'Copy1', activityType: 'Copy', status: 'Failed', error: { errorCode: 'X', message: 'boom' } },
    ]);
    (synapseDev.getPipelineRun as any).mockResolvedValue({ runId: 'r2', status: 'Failed', message: 'pipeline failed' });
    const out = await handlePipelineExplainError({ runId: 'r2', backend: 'synapse' });
    expect(synapseDev.listActivityRuns).toHaveBeenCalledWith('r2');
    expect(out.failedActivities[0].errorCode).toBe('X');
    expect(out.runMessage).toBe('pipeline failed');
  });
});

describe('handlePipelineRun', () => {
  it('returns the real runId from the ADF client', async () => {
    (adf.runPipeline as any).mockResolvedValue({ runId: 'abc-123' });
    const out = await handlePipelineRun({ pipelineName: 'copy_orders', backend: 'adf' });
    expect(adf.runPipeline).toHaveBeenCalledWith('copy_orders', {});
    expect(out).toEqual({ runId: 'abc-123', pipelineName: 'copy_orders' });
  });

  it('routes to the Synapse client for synapse backend', async () => {
    (synapseDev.runPipeline as any).mockResolvedValue({ runId: 'syn-9' });
    const out = await handlePipelineRun({ pipelineName: 'ws_pipe', backend: 'synapse', params: { a: 1 } });
    expect(synapseDev.runPipeline).toHaveBeenCalledWith('ws_pipe', { a: 1 });
    expect(out.runId).toBe('syn-9');
  });
});

describe('handlePipelineGetRunStatus', () => {
  it('finds the run by id in the ADF pipeline-run window', async () => {
    (adf.listPipelineRuns as any).mockResolvedValue([
      { runId: 'abc-123', status: 'Succeeded', durationInMs: 4200 },
    ]);
    const out = await handlePipelineGetRunStatus({ runId: 'abc-123', backend: 'adf', pipelineName: 'copy_orders' });
    expect(out).toMatchObject({ runId: 'abc-123', status: 'Succeeded', durationMs: 4200 });
  });

  it('reads the Synapse run directly', async () => {
    (synapseDev.getPipelineRun as any).mockResolvedValue({ runId: 'syn-9', status: 'InProgress' });
    const out = await handlePipelineGetRunStatus({ runId: 'syn-9', backend: 'synapse' });
    expect(out.status).toBe('InProgress');
  });
});
