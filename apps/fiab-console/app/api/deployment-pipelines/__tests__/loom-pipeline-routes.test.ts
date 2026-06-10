/**
 * BFF route tests for the Loom-native deployment pipelines
 * (/api/deployment-pipelines/loom/**).
 *
 * Cosmos, item-crud, the provisioning-engine, and the session are all mocked so
 * this is a pure backend-contract spec: list/create, content-level compare,
 * selective deploy (re-provision with the target stage's data-source rule
 * applied → receipt of diff + deployed item ids), and per-stage rule CRUD.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

let session: any = { claims: { oid: 'oid-1', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 };
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(() => session) }));

// The compare engine reaches semantic-model.ts → @azure/identity (real ESM has
// an unresolved transitive in this env); stub it.
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// item-crud — source/target workspace item reads + target writes.
const listAllOwnedItems = vi.fn();
const createOwnedItem = vi.fn();
const updateOwnedItem = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ listAllOwnedItems, createOwnedItem, updateOwnedItem }));

// provisioning-engine — capture the patched target each provisioner receives.
const semanticProvisioner = vi.fn(async (input: any) => ({ status: 'created', resourceId: input.cosmosItemId, secondaryIds: { backend: 'loom-native' } }));
vi.mock('@/lib/install/provisioning-engine', () => ({
  PROVISIONERS: { 'semantic-model': semanticProvisioner },
  resolveTarget: vi.fn(() => ({ mode: 'shared', warehouseServer: 'base-wh.database.windows.net' })),
}));

// Cosmos containers.
const pipelineDoc: any = {
  id: 'p1', tenantId: 'oid-1', displayName: 'Sales CI/CD',
  stages: [
    { id: 'dev', displayName: 'Development', order: 0, workspaceId: 'ws-dev' },
    { id: 'test', displayName: 'Test', order: 1, workspaceId: 'ws-test' },
  ],
  createdAt: 'now', updatedAt: 'now', createdBy: 'u@t.com',
};
let rulesDoc: any = null;
const historyCreate = vi.fn(async (doc: any) => ({ resource: doc }));
const pipelinesCreate = vi.fn(async (doc: any) => ({ resource: doc }));
const rulesUpsert = vi.fn(async (doc: any) => ({ resource: doc }));

function notFound() { const e: any = new Error('not found'); e.code = 404; throw e; }

vi.mock('@/lib/azure/cosmos-client', () => ({
  loomPipelinesContainer: vi.fn(async () => ({
    item: (id: string, _pk: string) => ({
      read: async () => (id === pipelineDoc.id ? { resource: pipelineDoc } : notFound()),
      delete: async () => ({}),
    }),
    items: {
      query: () => ({ fetchAll: async () => ({ resources: [pipelineDoc] }) }),
      create: pipelinesCreate,
    },
  })),
  pipelineStageRulesContainer: vi.fn(async () => ({
    item: (_id: string, _pk: string) => ({
      read: async () => (rulesDoc ? { resource: rulesDoc } : notFound()),
      delete: async () => ({}),
    }),
    items: { upsert: rulesUpsert },
  })),
  pipelineHistoryContainer: vi.fn(async () => ({
    items: { create: historyCreate, query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, _pk: string) => ({ read: async () => ({ resource: { id, tenantId: 'oid-1', name: id } }) }),
  })),
}));

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const sm = (name: string, tables: any[]) => ({ id: `${name}-id`, workspaceId: 'ws-dev', itemType: 'semantic-model', displayName: name, state: { content: { tables, measures: [], relationships: [] } }, createdBy: 'u', createdAt: 'n', updatedAt: 'n' });

beforeEach(() => {
  session = { claims: { oid: 'oid-1', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 };
  rulesDoc = null;
  vi.clearAllMocks();
});

describe('GET /api/deployment-pipelines/loom', () => {
  it('lists the tenant pipelines', async () => {
    const { GET } = await import('@/app/api/deployment-pipelines/loom/route');
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.pipelines[0].displayName).toBe('Sales CI/CD');
  });
  it('401 when unauthenticated', async () => {
    session = null;
    const { GET } = await import('@/app/api/deployment-pipelines/loom/route');
    expect((await GET()).status).toBe(401);
  });
});

describe('POST /api/deployment-pipelines/loom', () => {
  function req(body: unknown) {
    return new NextRequest('https://loom.test/api/deployment-pipelines/loom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('creates a pipeline with owned-workspace stages', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/loom/route');
    const r = await POST(req({ displayName: 'P', stages: [{ displayName: 'Dev', workspaceId: 'ws-dev' }, { displayName: 'Test', workspaceId: 'ws-test' }] }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.pipeline.stages).toHaveLength(2);
    expect(pipelinesCreate).toHaveBeenCalled();
  });
  it('rejects fewer than 2 stages → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/loom/route');
    expect((await POST(req({ displayName: 'P', stages: [{ displayName: 'Dev', workspaceId: 'ws-dev' }] }))).status).toBe(400);
  });
  it('rejects a stage without a workspace → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/loom/route');
    expect((await POST(req({ displayName: 'P', stages: [{ displayName: 'Dev' }, { displayName: 'Test', workspaceId: 'ws-test' }] }))).status).toBe(400);
  });
  it('rejects two stages bound to the same workspace → 400 duplicate_workspace (C-86 self-modification guard)', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/loom/route');
    const r = await POST(req({ displayName: 'P', stages: [{ displayName: 'Dev', workspaceId: 'ws-dev' }, { displayName: 'Test', workspaceId: 'ws-dev' }] }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('duplicate_workspace');
    expect(j.error).toMatch(/distinct workspace/i);
    // The invalid pipeline must never reach Cosmos.
    expect(pipelinesCreate).not.toHaveBeenCalled();
  });
});

describe('GET /api/deployment-pipelines/loom/[id]/compare', () => {
  it('detects a Different model between Dev and Test', async () => {
    listAllOwnedItems.mockImplementation(async (_t: string, ws: string) =>
      ws === 'ws-dev' ? [sm('Sales', [{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }, { name: 'Dim', columns: [{ name: 'Id', dataType: 'int64' }] }])]
                      : [{ ...sm('Sales', [{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }]), id: 'sales-test', workspaceId: 'ws-test' }]);
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/compare/route');
    const r = await GET(new NextRequest('https://loom.test/x?source=dev&target=test'), ctx({ id: 'p1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.summary.different).toBe(1);
    expect(j.data.pairs[0].status).toBe('Different');
  });
  it('missing source/target → 400', async () => {
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/compare/route');
    expect((await GET(new NextRequest('https://loom.test/x?source=dev'), ctx({ id: 'p1' }))).status).toBe(400);
  });
  it('unknown pipeline → 404', async () => {
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/compare/route');
    expect((await GET(new NextRequest('https://loom.test/x?source=dev&target=test'), ctx({ id: 'nope' }))).status).toBe(404);
  });
});

describe('POST /api/deployment-pipelines/loom/[id]/deploy', () => {
  function req(body: unknown) {
    return new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('re-provisions the chosen model into Test with the Test data-source rule applied', async () => {
    // Test stage rule rebinds the warehouse server.
    rulesDoc = { id: 'rules:p1:test', pipelineId: 'p1', stageId: 'test', rules: [{ itemType: 'semantic-model', kind: 'datasource', key: 'warehouseServer', value: 'test-wh.database.windows.net' }] };
    listAllOwnedItems.mockImplementation(async (_t: string, ws: string) => ws === 'ws-dev' ? [sm('Sales', [{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }])] : []);
    createOwnedItem.mockResolvedValue({ ok: true, item: { id: 'test-item-1', workspaceId: 'ws-test', itemType: 'semantic-model', displayName: 'Sales' } });
    updateOwnedItem.mockResolvedValue({ id: 'test-item-1' });

    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/deploy/route');
    const r = await POST(req({ sourceStageId: 'dev', targetStageId: 'test', items: [{ sourceItemId: 'Sales-id', itemType: 'semantic-model' }] }), ctx({ id: 'p1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.deployedItemIds).toEqual(['test-item-1']);
    expect(j.data.status).toBe('succeeded');
    // The receipt diff shows the Dev model was new to Test.
    expect(j.data.diff.some((p: any) => p.status === 'OnlyInSource')).toBe(true);
    // The provisioner ran against the rule-patched target.
    expect(semanticProvisioner).toHaveBeenCalledTimes(1);
    expect(semanticProvisioner.mock.calls[0][0].target.warehouseServer).toBe('test-wh.database.windows.net');
    expect(historyCreate).toHaveBeenCalled();
  });
  it('missing sourceStageId → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/deploy/route');
    expect((await POST(req({ targetStageId: 'test' }), ctx({ id: 'p1' }))).status).toBe(400);
  });
  it('legacy pipeline whose source+target share a workspace → 400 duplicate_workspace with a clear remediation', async () => {
    const original = pipelineDoc.stages;
    pipelineDoc.stages = [
      { id: 'dev', displayName: 'Development', order: 0, workspaceId: 'ws-shared' },
      { id: 'test', displayName: 'Test', order: 1, workspaceId: 'ws-shared' },
    ];
    try {
      const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/deploy/route');
      const r = await POST(req({ sourceStageId: 'dev', targetStageId: 'test' }), ctx({ id: 'p1' }));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.ok).toBe(false);
      expect(j.code).toBe('duplicate_workspace');
      expect(j.error).toMatch(/same workspace/i);
      expect(j.error).toMatch(/Re-bind one stage/i);
      // No deploy side-effects when the pipeline is self-referential.
      expect(historyCreate).not.toHaveBeenCalled();
    } finally {
      pipelineDoc.stages = original;
    }
  });
});

describe('GET/PUT /api/deployment-pipelines/loom/[id]/stages/[stageId]/rules', () => {
  it('GET returns [] when no rules doc', async () => {
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/rules/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.rules).toEqual([]);
  });
  it('PUT round-trips a valid rule set', async () => {
    const { PUT } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/rules/route');
    const body = { rules: [{ itemType: 'semantic-model', kind: 'datasource', key: 'warehouseServer', value: 'test-wh' }] };
    const r = await PUT(new NextRequest('https://loom.test/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.rules[0].value).toBe('test-wh');
    expect(rulesUpsert).toHaveBeenCalled();
  });
  it('PUT rejects an unknown key → 400', async () => {
    const { PUT } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/rules/route');
    const body = { rules: [{ itemType: '*', kind: 'datasource', key: 'bogusKey', value: 'x' }] };
    const r = await PUT(new NextRequest('https://loom.test/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(400);
  });
});
