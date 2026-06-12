/**
 * Backend contract tests for the Learning-Hub notebook import route
 * (/api/learn/notebook-import):
 *   • GET  — lists prebuilt notebooks from the content-bundle registry,
 *     401 when unauthenticated.
 *   • POST — validates session + workspace ownership, creates the notebook
 *     item, conditionally creates + provisions the sample-data lakehouse(s),
 *     and runs the real provisioning engine (Synapse → Databricks →
 *     Fabric-opt-in). When withSampleData is false, NO lakehouse is created.
 *
 * session, cosmos-client, item-crud, content-bundles, and provisioning-engine
 * are mocked so this is a pure backend contract spec (the repo's DOM render
 * tests are pre-existing red on a node vitest env issue).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
}));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ createOwnedItem: vi.fn() }));
vi.mock('@/lib/apps/content-bundles', () => ({
  getBundle: vi.fn(),
  getBundleNotebooks: vi.fn(),
  getSampleDataLakehouses: vi.fn(),
  listNotebookImports: vi.fn(),
}));
vi.mock('@/lib/install/provisioning-engine', () => ({ runProvisioning: vi.fn() }));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getBundle, getBundleNotebooks, getSampleDataLakehouses, listNotebookImports,
} from '@/lib/apps/content-bundles';
import { runProvisioning } from '@/lib/install/provisioning-engine';

const OID = 'tenant-oid';

function req(body: any) {
  return { json: async () => body } as any;
}

/** Wire the workspace point-read to succeed for the caller's tenant. */
function stubWorkspaceOk() {
  (workspacesContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: OID } }) }),
  });
}

/** Capture replaced item docs so we can assert the provisioning stamp /
 * attached-sources writes. */
function stubItemsContainer() {
  const replaced: any[] = [];
  let stored: any = { id: 'nb-1', state: {} };
  (itemsContainer as any).mockResolvedValue({
    item: () => ({
      read: async () => ({ resource: stored }),
      replace: async (doc: any) => { stored = doc; replaced.push(doc); return { resource: doc }; },
    }),
  });
  return { replaced };
}

const NB = {
  itemType: 'notebook',
  displayName: 'Bronze→Silver',
  description: 'demo',
  content: { kind: 'notebook', defaultLang: 'pyspark', cells: [{ type: 'code', source: 'print(1)' }] },
};
const LH = {
  itemType: 'lakehouse',
  displayName: 'sales-lh',
  description: 'sample',
  content: { kind: 'lakehouse', sampleRows: [{ a: 1 }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  (getBundle as any).mockReturnValue({ appId: 'app-ml-pipeline' });
  (getBundleNotebooks as any).mockReturnValue([NB]);
  (getSampleDataLakehouses as any).mockReturnValue([LH]);
  (createOwnedItem as any).mockImplementation(async (_s: any, itemType: string) => ({
    ok: true,
    item: { id: itemType === 'lakehouse' ? 'lh-1' : 'nb-1' },
  }));
  (runProvisioning as any).mockResolvedValue({
    outcome: 'all-created', mode: 'shared', target: { mode: 'shared' },
    steps: [{ itemType: 'notebook', displayName: 'Bronze→Silver', cosmosItemId: 'nb-1', result: { status: 'created', resourceId: 'syn/notebooks/Bronze' } }],
  });
});

describe('GET /api/learn/notebook-import', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('lists notebooks from the registry', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    (listNotebookImports as any).mockReturnValue([{ bundleId: 'b', notebookDisplayName: 'n', hasSampleData: true }]);
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.notebooks).toHaveLength(1);
  });
});

describe('POST /api/learn/notebook-import', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ workspaceId: 'ws-1', bundleId: 'b' }));
    expect(res.status).toBe(401);
  });

  it('400 when workspaceId missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    const res = await POST(req({ bundleId: 'b' }));
    expect(res.status).toBe(400);
  });

  it('404 when the workspace is not owned by the caller', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    (workspacesContainer as any).mockResolvedValue({
      item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: 'someone-else' } }) }),
    });
    const res = await POST(req({ workspaceId: 'ws-1', bundleId: 'b' }));
    expect(res.status).toBe(404);
  });

  it('imports the notebook only when withSampleData is false', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    stubWorkspaceOk();
    stubItemsContainer();
    const res = await POST(req({ workspaceId: 'ws-1', bundleId: 'app-ml-pipeline', withSampleData: false }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.withSampleData).toBe(false);
    // Only the notebook item created — never the lakehouse.
    expect((createOwnedItem as any)).toHaveBeenCalledTimes(1);
    expect((getSampleDataLakehouses as any)).not.toHaveBeenCalled();
    expect(body.installed).toHaveLength(1);
    expect(body.installed[0].itemType).toBe('notebook');
  });

  it('seeds the sample-data lakehouse + provisions both when withSampleData is true', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    stubWorkspaceOk();
    stubItemsContainer();
    const res = await POST(req({ workspaceId: 'ws-1', bundleId: 'app-ml-pipeline', withSampleData: true }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.withSampleData).toBe(true);
    // Notebook + lakehouse both created.
    expect((createOwnedItem as any)).toHaveBeenCalledTimes(2);
    expect(body.installed.map((i: any) => i.itemType)).toEqual(['notebook', 'lakehouse']);
    // The real provisioning engine was invoked with both installed items.
    expect((runProvisioning as any)).toHaveBeenCalledTimes(1);
    const passed = (runProvisioning as any).mock.calls[0][3];
    expect(passed).toHaveLength(2);
  });

  it('404 when the bundle has no prebuilt notebook', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OID } });
    stubWorkspaceOk();
    (getBundleNotebooks as any).mockReturnValue([]);
    const res = await POST(req({ workspaceId: 'ws-1', bundleId: 'app-ml-pipeline' }));
    expect(res.status).toBe(404);
  });
});
