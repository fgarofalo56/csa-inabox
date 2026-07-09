/**
 * BFF route tests for Wave-8 ALM promotion (FGC-24 + BR-APPROVAL).
 *
 * Cosmos, item-crud, the provisioning-engine, the audit stream and the session
 * are all mocked, so this is a pure backend-contract spec:
 *   - FGC-24: variable-library rebind at promote time + the variables route;
 *   - BR-APPROVAL: the deploy gate (pending request), policy CRUD, and the
 *     approve/reject/cancel state machine driving a real promotion on approval.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

let session: any = { claims: { oid: 'oid-1', upn: 'u@t.com', tid: 'tid-1', groups: [] }, exp: Date.now() / 1000 + 3600 };
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(() => session) }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// audit stream — no-op (fire-and-forget in prod).
const emitAuditEvent = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent }));

// item-crud.
const listAllOwnedItems = vi.fn();
const createOwnedItem = vi.fn();
const updateOwnedItem = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ listAllOwnedItems, createOwnedItem, updateOwnedItem }));

// provisioning-engine — capture the content each provisioner receives.
const semanticProvisioner = vi.fn(async (input: any) => ({ status: 'created', resourceId: input.cosmosItemId }));
vi.mock('@/lib/install/provisioning-engine', () => ({
  PROVISIONERS: { 'semantic-model': semanticProvisioner },
  resolveTarget: vi.fn(() => ({ mode: 'shared', warehouseServer: 'base-wh' })),
}));

// ---- in-memory Cosmos store for pipeline-stage-rules (rules + approvals) ----
const pipelineDoc: any = {
  id: 'p1', tenantId: 'oid-1', displayName: 'Sales CI/CD',
  stages: [
    { id: 'dev', displayName: 'Development', order: 0, workspaceId: 'ws-dev' },
    { id: 'test', displayName: 'Test', order: 1, workspaceId: 'ws-test' },
    { id: 'prod', displayName: 'Production', order: 2, workspaceId: 'ws-prod' },
  ],
  createdAt: 'now', updatedAt: 'now', createdBy: 'u@t.com',
};
let store: Map<string, any>;
const historyCreate = vi.fn(async (doc: any) => ({ resource: doc }));
function notFound() { const e: any = new Error('not found'); e.code = 404; throw e; }

vi.mock('@/lib/azure/cosmos-client', () => ({
  loomPipelinesContainer: vi.fn(async () => ({
    item: (id: string) => ({ read: async () => (id === pipelineDoc.id ? { resource: pipelineDoc } : notFound()) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [pipelineDoc] }) }) },
  })),
  pipelineStageRulesContainer: vi.fn(async () => ({
    item: (id: string, _pk: string) => ({
      read: async () => (store.has(id) ? { resource: store.get(id) } : notFound()),
    }),
    items: {
      create: async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; },
      upsert: async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; },
      query: (spec: any, opts: any) => ({
        fetchAll: async () => {
          const pk = opts?.partitionKey;
          const wantStatus = (spec.parameters || []).find((p: any) => p.name === '@s')?.value;
          const resources = [...store.values()].filter((d) =>
            d.docType === 'approval-request' && d.pipelineId === pk && (!wantStatus || d.status === wantStatus),
          );
          return { resources };
        },
      }),
    },
  })),
  pipelineHistoryContainer: vi.fn(async () => ({ items: { create: historyCreate } })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string) => ({ read: async () => ({ resource: { id, tenantId: 'oid-1', name: id } }) }),
  })),
}));

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const post = (body: unknown) => new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (body: unknown) => new NextRequest('https://loom.test/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const smItem = (content: any) => ({ id: 'sm-1', workspaceId: 'ws-dev', itemType: 'semantic-model', displayName: 'Sales', state: { content }, createdBy: 'u', createdAt: 'n', updatedAt: 'n' });
const varLib = (workspaceId: string, variables: any[]) => ({ id: `vl-${workspaceId}`, workspaceId, itemType: 'variable-library', displayName: 'Vars', state: { variables }, createdBy: 'u', createdAt: 'n', updatedAt: 'n' });

beforeEach(() => {
  session = { claims: { oid: 'oid-1', upn: 'u@t.com', tid: 'tid-1', groups: [] }, exp: Date.now() / 1000 + 3600 };
  store = new Map();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// FGC-24
// ---------------------------------------------------------------------------
describe('GET /api/deployment-pipelines/loom/[id]/variables', () => {
  it('returns per-stage resolved values and flags differences', async () => {
    listAllOwnedItems.mockImplementation(async (_t: string, ws: string) =>
      ws === 'ws-dev' ? [varLib('ws-dev', [
        { name: 'conn', type: 'string', default: 'dev-sql', test: 'test-sql', prod: 'prod-sql' },
      ])] : []);
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/variables/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ id: 'p1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    const row = j.data.variables.find((v: any) => v.name === 'conn');
    expect(row.differs).toBe(true);
    expect(row.perStage.dev.value).toBe('dev-sql');
    expect(row.perStage.prod.value).toBe('prod-sql');
    expect(j.data.stages.find((s: any) => s.id === 'prod').valueSet).toBe('prod');
  });
});

describe('deploy rebinds {{var:NAME}} tokens against the target stage value set', () => {
  it('substitutes the test value into the promoted content', async () => {
    listAllOwnedItems.mockImplementation(async (_t: string, ws: string) => {
      if (ws === 'ws-dev') return [smItem({ server: '{{var:conn}}', note: 'plain' }), varLib('ws-dev', [{ name: 'conn', type: 'string', default: 'dev-sql', test: 'test-sql' }])];
      return [];
    });
    createOwnedItem.mockResolvedValue({ ok: true, item: { id: 'test-sm', workspaceId: 'ws-test', itemType: 'semantic-model', displayName: 'Sales' } });
    updateOwnedItem.mockResolvedValue({ id: 'test-sm' });

    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/deploy/route');
    const r = await POST(post({ sourceStageId: 'dev', targetStageId: 'test', items: [{ sourceItemId: 'sm-1', itemType: 'semantic-model' }] }), ctx({ id: 'p1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe('succeeded');
    // The provisioner received the REBOUND content (token → test value).
    expect(semanticProvisioner).toHaveBeenCalledTimes(1);
    expect(semanticProvisioner.mock.calls[0][0].content.server).toBe('test-sql');
    // The persisted target item carries the rebound content.
    const persisted = updateOwnedItem.mock.calls[0][3];
    expect(persisted.state.content.server).toBe('test-sql');
    // A rebind step is recorded in the receipt.
    expect(j.data.steps.some((s: string) => s.includes('rebound') && s.includes('conn=test-sql'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BR-APPROVAL
// ---------------------------------------------------------------------------
describe('approval policy CRUD', () => {
  it('GET returns a disabled default policy when none configured', async () => {
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/approvals/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.policy.enabled).toBe(false);
  });
  it('PUT round-trips an enabled policy', async () => {
    const { PUT } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/approvals/route');
    const r = await PUT(put({ enabled: true, requiredApprovals: 1, approvers: [{ id: 'user-b', type: 'user', displayName: 'B' }] }), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.policy.approvers[0].id).toBe('user-b');
    expect(store.get('approval-policy:p1:test').enabled).toBe(true);
  });
  it('PUT rejects an enabled gate with no approvers → 400', async () => {
    const { PUT } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/approvals/route');
    const r = await PUT(put({ enabled: true, requiredApprovals: 1, approvers: [] }), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(400);
  });
  it('PUT rejects requiredApprovals exceeding approver count → 400', async () => {
    const { PUT } = await import('@/app/api/deployment-pipelines/loom/[id]/stages/[stageId]/approvals/route');
    const r = await PUT(put({ enabled: true, requiredApprovals: 3, approvers: [{ id: 'user-b', type: 'user', displayName: 'B' }] }), ctx({ id: 'p1', stageId: 'test' }));
    expect(r.status).toBe(400);
  });
});

describe('deploy gate → pending approval', () => {
  it('defers the promotion and creates a pending request', async () => {
    store.set('approval-policy:p1:test', { id: 'approval-policy:p1:test', docType: 'approval-policy', pipelineId: 'p1', stageId: 'test', enabled: true, requiredApprovals: 1, approvers: [{ id: 'user-b', type: 'user', displayName: 'B' }] });
    listAllOwnedItems.mockResolvedValue([]);
    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/deploy/route');
    const r = await POST(post({ sourceStageId: 'dev', targetStageId: 'test' }), ctx({ id: 'p1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe('pending-approval');
    expect(j.data.requiredApprovals).toBe(1);
    // A request doc was persisted; the promotion did NOT run.
    expect([...store.values()].some((d) => d.docType === 'approval-request' && d.status === 'pending')).toBe(true);
    expect(semanticProvisioner).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.promotion.requested' }));
  });
});

describe('approve → runs the promotion', () => {
  async function seedPendingRequest() {
    store.set('approval-policy:p1:test', { id: 'approval-policy:p1:test', docType: 'approval-policy', pipelineId: 'p1', stageId: 'test', enabled: true, requiredApprovals: 1, approvers: [{ id: 'user-b', type: 'user', displayName: 'B' }] });
    // requester = oid-1
    listAllOwnedItems.mockResolvedValue([]);
    const deploy = await import('@/app/api/deployment-pipelines/loom/[id]/deploy/route');
    await deploy.POST(post({ sourceStageId: 'dev', targetStageId: 'test' }), ctx({ id: 'p1' }));
    return [...store.values()].find((d) => d.docType === 'approval-request');
  }

  it('an eligible approver (not the requester) approves → promoted', async () => {
    const req = await seedPendingRequest();
    // Now act as user-b (an approver, not the requester).
    session = { claims: { oid: 'user-b', upn: 'b@t.com', tid: 'tid-1', groups: [] }, exp: Date.now() / 1000 + 3600 };
    createOwnedItem.mockResolvedValue({ ok: true, item: { id: 'test-sm', displayName: 'Sales', itemType: 'semantic-model', workspaceId: 'ws-test' } });
    updateOwnedItem.mockResolvedValue({ id: 'test-sm' });
    listAllOwnedItems.mockImplementation(async (_t: string, ws: string) => ws === 'ws-dev' ? [smItem({ server: 'x' })] : []);

    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/approvals/[requestId]/route');
    const r = await POST(post({ action: 'approve' }), ctx({ id: 'p1', requestId: req.id }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.request.status).toBe('promoted');
    expect(semanticProvisioner).toHaveBeenCalledTimes(1);
    expect(historyCreate).toHaveBeenCalled();
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.promotion.promoted' }));
  });

  it('blocks the requester from self-approving → 403', async () => {
    const req = await seedPendingRequest();
    // Add the requester (oid-1) as an approver so eligibility passes but SoD blocks.
    req.approvers.push({ id: 'oid-1', type: 'user', displayName: 'Me' });
    store.set(req.id, req);
    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/approvals/[requestId]/route');
    const r = await POST(post({ action: 'approve' }), ctx({ id: 'p1', requestId: req.id }));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/separation of duties/i);
  });

  it('a non-approver is rejected → 403', async () => {
    const req = await seedPendingRequest();
    session = { claims: { oid: 'stranger', upn: 's@t.com', tid: 'tid-1', groups: [] }, exp: Date.now() / 1000 + 3600 };
    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/approvals/[requestId]/route');
    const r = await POST(post({ action: 'approve' }), ctx({ id: 'p1', requestId: req.id }));
    expect(r.status).toBe(403);
  });

  it('the requester can cancel their own request', async () => {
    const req = await seedPendingRequest();
    const { POST } = await import('@/app/api/deployment-pipelines/loom/[id]/approvals/[requestId]/route');
    const r = await POST(post({ action: 'cancel' }), ctx({ id: 'p1', requestId: req.id }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.request.status).toBe('cancelled');
  });
});

describe('GET approvals list', () => {
  it('lists requests and annotates viewer eligibility', async () => {
    store.set('approval-request:1', {
      id: 'approval-request:1', docType: 'approval-request', pipelineId: 'p1', tenantId: 'oid-1',
      sourceStageId: 'dev', targetStageId: 'test', requiredApprovals: 1,
      approvers: [{ id: 'oid-1', type: 'user', displayName: 'Me' }],
      diffSummary: '1 new', status: 'pending', decisions: [], requestedBy: 'someoneelse', requestedByOid: 'other', createdAt: 'now', updatedAt: 'now',
    });
    const { GET } = await import('@/app/api/deployment-pipelines/loom/[id]/approvals/route');
    const r = await GET(new NextRequest('https://loom.test/x?status=pending'), ctx({ id: 'p1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.requests).toHaveLength(1);
    expect(j.data.requests[0].viewerCanApprove).toBe(true);
  });
});
