import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @azure/identity — pipeline-tools builds a credential at module load.
vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'x', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

// Mock the real Azure clients that adf-resource-ops dispatches to. Config gates
// default to null (configured); individual tests override them.
vi.mock('../../azure/adf-client', () => ({
  adfConfigGate: vi.fn(() => null),
  deletePipeline: vi.fn(async () => undefined),
  deleteDataset: vi.fn(async () => undefined),
  deleteDataFlow: vi.fn(async () => undefined),
  deleteTrigger: vi.fn(async () => undefined),
  deleteLinkedService: vi.fn(async () => undefined),
  deleteIntegrationRuntime: vi.fn(async () => undefined),
  deleteAdfCdc: vi.fn(async () => undefined),
  deleteManagedPrivateEndpoint: vi.fn(async () => undefined),
}));
vi.mock('../../azure/synapse-dev-client', () => ({
  synapseConfigGate: vi.fn(() => null),
  deletePipeline: vi.fn(async () => undefined),
  deleteTrigger: vi.fn(async () => undefined),
  deleteSynapseIr: vi.fn(async () => undefined),
}));

import * as adf from '../../azure/adf-client';
import * as synapseDev from '../../azure/synapse-dev-client';
import {
  handlePipelineDeletePipeline,
  handlePipelineRemoveFactoryObject,
} from '../pipeline-tools';

beforeEach(() => {
  vi.clearAllMocks();
  (adf.adfConfigGate as any).mockReturnValue(null);
  (synapseDev.synapseConfigGate as any).mockReturnValue(null);
});

describe('handlePipelineDeletePipeline — confirm-intent guard', () => {
  it('does NOT delete on the first (unconfirmed) call and asks to confirm', async () => {
    const out = await handlePipelineDeletePipeline({ name: 'copy_orders', backend: 'adf' });
    expect(out.awaitingConfirmation).toBe(true);
    expect(out.deleted).toBe(false);
    expect(out.kind).toBe('summary');
    expect(out.markdown).toMatch(/confirm/i);
    expect(adf.deletePipeline).not.toHaveBeenCalled();
  });

  it('warns when the named pipeline is the one currently open (bound)', async () => {
    const out = await handlePipelineDeletePipeline({
      name: 'copy_orders',
      backend: 'adf',
      boundPipeline: 'copy_orders',
    });
    expect(out.awaitingConfirmation).toBe(true);
    expect(out.markdown).toMatch(/currently have open/i);
    expect(adf.deletePipeline).not.toHaveBeenCalled();
  });

  it('deletes via the real ADF client when confirm:true', async () => {
    const out = await handlePipelineDeletePipeline({ name: 'copy_orders', backend: 'adf', confirm: true });
    expect(adf.deletePipeline).toHaveBeenCalledWith('copy_orders');
    expect(out.deleted).toBe(true);
    expect(out.awaitingConfirmation).toBe(false);
    expect(out.markdown).toMatch(/deleted/i);
  });

  it('routes to the Synapse client for the synapse backend', async () => {
    const out = await handlePipelineDeletePipeline({ name: 'ws_pipe', backend: 'synapse', confirm: true });
    expect(synapseDev.deletePipeline).toHaveBeenCalledWith('ws_pipe');
    expect(adf.deletePipeline).not.toHaveBeenCalled();
    expect(out.deleted).toBe(true);
  });

  it('honest-gates (no delete) when the backend is not configured', async () => {
    (adf.adfConfigGate as any).mockReturnValue({ missing: 'LOOM_ADF_NAME' });
    const out = await handlePipelineDeletePipeline({ name: 'copy_orders', backend: 'adf', confirm: true });
    expect(out.gated).toBe(true);
    expect(out.deleted).toBe(false);
    expect(out.markdown).toContain('LOOM_ADF_NAME');
    expect(adf.deletePipeline).not.toHaveBeenCalled();
  });
});

describe('handlePipelineRemoveFactoryObject — dispatch by type', () => {
  it('removes a dataset via the real ADF client on confirm', async () => {
    const out = await handlePipelineRemoveFactoryObject({ objectType: 'dataset', name: 'ds_orders', backend: 'adf', confirm: true });
    expect(adf.deleteDataset).toHaveBeenCalledWith('ds_orders');
    expect(out.deleted).toBe(true);
    expect(out.objectKind).toBe('dataset');
  });

  it('normalizes free-form aliases ("linked service" → linked-service)', async () => {
    await handlePipelineRemoveFactoryObject({ objectType: 'linked service', name: 'ls_adls', backend: 'adf', confirm: true });
    expect(adf.deleteLinkedService).toHaveBeenCalledWith('ls_adls');
  });

  it('normalizes "IR" → integration-runtime and dispatches to Synapse', async () => {
    await handlePipelineRemoveFactoryObject({ objectType: 'IR', name: 'AutoResolveIR', backend: 'synapse', confirm: true });
    expect(synapseDev.deleteSynapseIr).toHaveBeenCalledWith('AutoResolveIR');
  });

  it('confirm-intent: does NOT remove on the unconfirmed first call', async () => {
    const out = await handlePipelineRemoveFactoryObject({ objectType: 'trigger', name: 't1', backend: 'adf' });
    expect(out.awaitingConfirmation).toBe(true);
    expect(out.deleted).toBe(false);
    expect(adf.deleteTrigger).not.toHaveBeenCalled();
  });

  it('backend-support gate: Synapse dataset removal is honestly gated, not called', async () => {
    const out = await handlePipelineRemoveFactoryObject({ objectType: 'dataset', name: 'ds1', backend: 'synapse', confirm: true });
    expect(out.gated).toBe(true);
    expect(out.deleted).toBe(false);
    expect(out.markdown).toMatch(/Synapse Studio/i);
  });

  it('throws on an unknown object type, listing supported types', async () => {
    await expect(
      handlePipelineRemoveFactoryObject({ objectType: 'widget', name: 'x', backend: 'adf', confirm: true }),
    ).rejects.toThrow(/Unknown factory object type/i);
  });
});
