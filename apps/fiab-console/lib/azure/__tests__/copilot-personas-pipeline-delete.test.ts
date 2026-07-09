import { describe, it, expect, vi } from 'vitest';

// Light LoomToolRegistry so importing the persona doesn't pull the whole
// orchestrator client graph (mirrors copilot-personas-kql.test.ts).
vi.mock('../copilot-orchestrator', () => ({
  LoomToolRegistry: class {
    tools = new Map<string, any>();
    register(t: any) { this.tools.set(t.name, t); }
    list() { return Array.from(this.tools.values()); }
    get(name: string) { return this.tools.get(name); }
  },
}));
// The persona module imports these clients at load; stub to keep the import light.
vi.mock('../adf-client', () => ({ upsertPipeline: vi.fn(), runPipeline: vi.fn() }));
vi.mock('../synapse-dev-client', () => ({ upsertPipeline: vi.fn(), runPipeline: vi.fn() }));
vi.mock('../../copilot/pipeline-tools', () => ({
  handlePipelineDeletePipeline: vi.fn(async () => ({ kind: 'summary', deleted: true })),
  handlePipelineRemoveFactoryObject: vi.fn(async () => ({ kind: 'summary', deleted: true })),
}));

import * as pipelineTools from '../../copilot/pipeline-tools';
import { buildPipelineRegistry } from '../copilot-personas-pipeline';
import { FACTORY_OBJECT_KINDS } from '../adf-resource-ops';

const AOAI = { endpoint: 'https://x', deployment: 'gpt', apiVersion: '2024-10-21' } as any;

describe('buildPipelineRegistry — delete/remove tools', () => {
  it('registers pipeline_delete_pipeline with a confirm-guarded schema', () => {
    const r = buildPipelineRegistry('adf', 'copy_orders', AOAI);
    const tool = r.get('pipeline_delete_pipeline') as any;
    expect(tool).toBeTruthy();
    expect(tool.parameters.required).toEqual(['name']);
    expect(tool.parameters.properties.confirm.type).toBe('boolean');
    expect(tool.description).toMatch(/DESTRUCTIVE/);
  });

  it('registers pipeline_remove_factory_object with the object-type enum', () => {
    const r = buildPipelineRegistry('adf', 'copy_orders', AOAI);
    const tool = r.get('pipeline_remove_factory_object') as any;
    expect(tool).toBeTruthy();
    expect(tool.parameters.required.sort()).toEqual(['name', 'objectType']);
    expect(tool.parameters.properties.objectType.enum).toEqual([...FACTORY_OBJECT_KINDS]);
    expect(tool.parameters.properties.confirm.type).toBe('boolean');
  });

  it('delete tool forwards the bound pipeline name + coerces confirm', async () => {
    const r = buildPipelineRegistry('adf', 'copy_orders', AOAI);
    await (r.get('pipeline_delete_pipeline') as any).handler({ name: 'other_pipe', confirm: true });
    expect(pipelineTools.handlePipelineDeletePipeline).toHaveBeenCalledWith({
      name: 'other_pipe',
      backend: 'adf',
      confirm: true,
      boundPipeline: 'copy_orders',
    });
  });

  it('remove tool never passes confirm:true unless explicitly set', async () => {
    const r = buildPipelineRegistry('synapse', 'ws_pipe', AOAI);
    await (r.get('pipeline_remove_factory_object') as any).handler({ objectType: 'trigger', name: 't1' });
    expect(pipelineTools.handlePipelineRemoveFactoryObject).toHaveBeenCalledWith({
      objectType: 'trigger',
      name: 't1',
      backend: 'synapse',
      confirm: false,
    });
  });
});
