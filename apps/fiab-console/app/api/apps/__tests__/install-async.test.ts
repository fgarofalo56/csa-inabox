/**
 * Backend contract tests for the async app-install path (harness task-019):
 *   • POST /api/apps/[id]/install          — kickoff: validates, writes a
 *     `running` AppInstallJob, returns 202 { jobId } (never blocks on the
 *     provision, so a long install can't 504).
 *   • GET  /api/apps/install-jobs/[jobId]  — poll: tenant-guarded point-read.
 *
 * session, cosmos-client, item-crud, content-bundles, and provisioning-engine
 * are all mocked so this is a pure backend contract spec (the repo's DOM render
 * tests are pre-existing red on a node vitest env issue).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  appsCatalogContainer: vi.fn(),
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  appInstallJobsContainer: vi.fn(),
}));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ createOwnedItem: vi.fn() }));
vi.mock('@/lib/apps/content-bundles', () => ({ resolveBundleItem: vi.fn(), getBundle: vi.fn() }));
vi.mock('@/lib/install/provisioning-engine', () => ({ runProvisioning: vi.fn() }));

import { POST } from '../[id]/install/route';
import { GET } from '../install-jobs/[jobId]/route';
import { getSession } from '@/lib/auth/session';
import {
  appsCatalogContainer,
  itemsContainer,
  workspacesContainer,
  appInstallJobsContainer,
} from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { getBundle, resolveBundleItem } from '@/lib/apps/content-bundles';
import { runProvisioning } from '@/lib/install/provisioning-engine';

const OID = 'tenant-oid';

function req(body: any) {
  return { json: async () => body } as any;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function jobsCtx(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

/** Wire the workspace read to succeed for the caller's tenant. */
function stubWorkspaceOk() {
  (workspacesContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: OID } }) }),
  });
}
/** Wire the apps-catalog query to return one app. */
function stubApp(app: any) {
  (appsCatalogContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: app ? [app] : [] }) }) },
  });
}
/** Capture every job doc written (create + replace) so we can assert progress. */
function stubJobsContainer() {
  const created: any[] = [];
  let current: any = null;
  (appInstallJobsContainer as any).mockResolvedValue({
    items: { create: async (doc: any) => { created.push(doc); current = doc; return { resource: doc }; } },
    item: () => ({
      read: async () => ({ resource: current }),
      replace: async (doc: any) => { current = doc; created.push(doc); return { resource: doc }; },
    }),
  });
  return { created, get current() { return current; } };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Worker-path defaults so the floating promise never throws after the 202.
  (itemsContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
    item: () => ({ read: async () => ({ resource: null }), replace: async () => ({}) }),
  });
  (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'item-1' } });
  (getBundle as any).mockReturnValue(undefined);
  (resolveBundleItem as any).mockReturnValue(undefined);
  (runProvisioning as any).mockResolvedValue({ outcome: 'all-created', mode: 'shared', target: { mode: 'shared' }, steps: [] });
});

describe('POST /api/apps/[id]/install — async kickoff', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ workspaceId: 'ws-1' }), ctx('app-1'));
    expect(res.status).toBe(401);
  });

  it('400 when workspaceId is missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    const res = await POST(req({}), ctx('app-1'));
    expect(res.status).toBe(400);
  });

  it('404 when the workspace is not owned by the caller', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    (workspacesContainer as any).mockResolvedValue({
      item: () => ({ read: async () => ({ resource: { tenantId: 'someone-else' } }) }),
    });
    const res = await POST(req({ workspaceId: 'ws-1' }), ctx('app-1'));
    expect(res.status).toBe(404);
  });

  it('404 when the app is not found', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    stubWorkspaceOk();
    stubApp(null); // empty for both tenant + GLOBAL queries
    const res = await POST(req({ workspaceId: 'ws-1' }), ctx('missing-app'));
    expect(res.status).toBe(404);
  });

  it('202 + jobId + totalItems, and writes a running job doc (does NOT block on the provision)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID, upn: 'u@x' } });
    stubWorkspaceOk();
    stubApp({ id: 'app-1', name: 'App One', items: [{ type: 'lakehouse', displayName: 'LH' }, { type: 'notebook', displayName: 'NB' }] });
    const jobs = stubJobsContainer();

    const res = await POST(req({ workspaceId: 'ws-1', deploy: true, mode: 'shared' }), ctx('app-1'));
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(typeof j.jobId).toBe('string');
    expect(j.totalItems).toBe(2);

    // The kickoff wrote exactly one `running` doc before returning.
    expect(jobs.created.length).toBeGreaterThanOrEqual(1);
    const initial = jobs.created[0];
    expect(initial.status).toBe('running');
    expect(initial.tenantId).toBe(OID);
    expect(initial.appId).toBe('app-1');
    expect(initial.totalItems).toBe(2);
    expect(initial.percentComplete).toBe(0);
  });

  it('500 (not a fake 202) when the job doc cannot be created', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    stubWorkspaceOk();
    stubApp({ id: 'app-1', name: 'App One', items: [] });
    (appInstallJobsContainer as any).mockResolvedValue({
      items: { create: async () => { throw new Error('cosmos down'); } },
    });
    const res = await POST(req({ workspaceId: 'ws-1' }), ctx('app-1'));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});

describe('GET /api/apps/install-jobs/[jobId] — poll', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET({} as any, jobsCtx('job-1'));
    expect(res.status).toBe(401);
  });

  it('200 with the job when it belongs to the caller tenant', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    const job = { id: 'job-1', tenantId: OID, status: 'running', phase: 'provisioning', percentComplete: 60 };
    (appInstallJobsContainer as any).mockResolvedValue({
      item: () => ({ read: async () => ({ resource: job }) }),
    });
    const res = await GET({} as any, jobsCtx('job-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.job.percentComplete).toBe(60);
  });

  it('404 for an unknown job', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    (appInstallJobsContainer as any).mockResolvedValue({
      item: () => ({ read: async () => ({ resource: undefined }) }),
    });
    const res = await GET({} as any, jobsCtx('nope'));
    expect(res.status).toBe(404);
  });

  it('404 when the job belongs to a different tenant (no cross-tenant leak)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    (appInstallJobsContainer as any).mockResolvedValue({
      item: () => ({ read: async () => ({ resource: { id: 'job-1', tenantId: 'other' } }) }),
    });
    const res = await GET({} as any, jobsCtx('job-1'));
    expect(res.status).toBe(404);
  });
});
