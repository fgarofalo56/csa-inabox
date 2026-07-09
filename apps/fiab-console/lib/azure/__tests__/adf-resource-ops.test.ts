import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adf-client', () => ({
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
vi.mock('../synapse-dev-client', () => ({
  synapseConfigGate: vi.fn(() => null),
  deletePipeline: vi.fn(async () => undefined),
  deleteTrigger: vi.fn(async () => undefined),
  deleteSynapseIr: vi.fn(async () => undefined),
}));

import * as adf from '../adf-client';
import * as synapseDev from '../synapse-dev-client';
import {
  normalizeFactoryObjectKind,
  deleteFactoryObject,
  isFactoryObjectDeletable,
  factoryOpsGate,
  FACTORY_OBJECT_KINDS,
} from '../adf-resource-ops';

beforeEach(() => vi.clearAllMocks());

describe('normalizeFactoryObjectKind', () => {
  it('canonicalizes aliases', () => {
    expect(normalizeFactoryObjectKind('Datasets')).toBe('dataset');
    expect(normalizeFactoryObjectKind('linked service')).toBe('linked-service');
    expect(normalizeFactoryObjectKind('connection')).toBe('linked-service');
    expect(normalizeFactoryObjectKind('IR')).toBe('integration-runtime');
    expect(normalizeFactoryObjectKind('data flow')).toBe('dataflow');
    expect(normalizeFactoryObjectKind('MPE')).toBe('managed-private-endpoint');
  });
  it('returns null for unknown / empty', () => {
    expect(normalizeFactoryObjectKind('widget')).toBeNull();
    expect(normalizeFactoryObjectKind('')).toBeNull();
  });
  it('every canonical kind normalizes to itself', () => {
    for (const k of FACTORY_OBJECT_KINDS) expect(normalizeFactoryObjectKind(k)).toBe(k);
  });
});

describe('deleteFactoryObject dispatch', () => {
  it('routes each ADF kind to its real client fn', async () => {
    await deleteFactoryObject('adf', 'pipeline', 'p1');
    await deleteFactoryObject('adf', 'dataset', 'd1');
    await deleteFactoryObject('adf', 'linked-service', 'l1');
    await deleteFactoryObject('adf', 'managed-private-endpoint', 'm1');
    expect(adf.deletePipeline).toHaveBeenCalledWith('p1');
    expect(adf.deleteDataset).toHaveBeenCalledWith('d1');
    expect(adf.deleteLinkedService).toHaveBeenCalledWith('l1');
    expect(adf.deleteManagedPrivateEndpoint).toHaveBeenCalledWith('m1');
  });

  it('routes supported Synapse kinds to the Synapse client', async () => {
    await deleteFactoryObject('synapse', 'pipeline', 'sp');
    await deleteFactoryObject('synapse', 'trigger', 'st');
    expect(synapseDev.deletePipeline).toHaveBeenCalledWith('sp');
    expect(synapseDev.deleteTrigger).toHaveBeenCalledWith('st');
  });

  it('throws for a kind unsupported on the backend', async () => {
    expect(isFactoryObjectDeletable('synapse', 'dataset')).toBe(false);
    await expect(deleteFactoryObject('synapse', 'dataset', 'x')).rejects.toThrow(/not supported/i);
    expect(adf.deleteDataset).not.toHaveBeenCalled();
  });

  it('throws on a blank name', async () => {
    await expect(deleteFactoryObject('adf', 'pipeline', '  ')).rejects.toThrow(/name is required/i);
  });
});

describe('factoryOpsGate', () => {
  it('surfaces the missing env var from the underlying client gate', () => {
    (adf.adfConfigGate as any).mockReturnValue({ missing: 'LOOM_ADF_NAME' });
    expect(factoryOpsGate('adf')).toEqual({ missing: 'LOOM_ADF_NAME' });
  });
});
