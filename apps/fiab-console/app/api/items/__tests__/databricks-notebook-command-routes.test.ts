/**
 * BFF contract tests for the interactive Databricks notebook routes:
 *   - POST   /api/items/databricks-notebook/[id]/command
 *   - POST   /api/items/databricks-notebook/[id]/context
 *   - DELETE /api/items/databricks-notebook/[id]/context
 *
 * Covers the auth gate (401), input validation (400), and that the happy path
 * delegates to the real databricks-client Command Execution helpers with the
 * right args and shapes the result. The client is stubbed; the client's own REST
 * contract is covered in databricks-command-exec.test.ts.
 *
 * #2988 — THIS FILE USED TO ENCODE THE VULNERABILITY AS THE EXPECTED CONTRACT.
 * It called `commandPOST(bodyReq({ clusterId: 'cl', … }))` with NO route params
 * at all and asserted a 200, because the handler genuinely did not accept
 * `ctx.params` and ran no workspace authorization — so the suite was green while
 * any signed-in user could execute arbitrary code on a shared cluster. It also
 * asserted `j.contextId === 'ctx-new'`, i.e. that the raw Databricks context id
 * was handed to the client, which is the cross-tenant REPL-attach pivot.
 *
 * Both are now inverted: the route is called WITH params, the item guard is
 * mocked as authorized, coordinates are bound, and `contextId` is asserted to be
 * an OPAQUE HANDLE rather than the raw id. The authorization + coordinate-
 * binding properties themselves live in
 * `databricks-notebook/[id]/__tests__/exec-scope-authz.test.ts`, which
 * mutation-proves each refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-session-secret-for-exec-context-handles';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));

const ITEM = {
  id: 'nb-1',
  itemType: 'databricks-notebook',
  workspaceId: 'ws-1',
  state: { provisioning: { secondaryIds: { notebookPath: '/Shared/loom-installs/app-a/Silver' } } },
};
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [ITEM] }) }) },
  }),
}));
vi.mock('@/lib/azure/databricks-default-cluster', () => ({
  ensureRunnableCluster: vi.fn(async () => ({ clusterId: 'cl' })),
}));
vi.mock('@/lib/azure/databricks-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/databricks-client');
  return {
    ...actual,
    listClusters: vi.fn(async () => [{ cluster_id: 'cl', cluster_source: 'UI', state: 'RUNNING' }]),
    createExecutionContext: vi.fn(),
    destroyExecutionContext: vi.fn(),
    executeCommand: vi.fn(),
  };
});

import { POST as commandPOST } from '../databricks-notebook/[id]/command/route';
import { POST as contextPOST, DELETE as contextDELETE } from '../databricks-notebook/[id]/context/route';
import { mintExecContextHandle } from '../databricks-notebook/_lib/notebook-exec-scope';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  createExecutionContext, destroyExecutionContext, executeCommand, listClusters,
} from '@/lib/azure/databricks-client';

const ctx = { params: Promise.resolve({ id: 'nb-1' }) } as any;

function bodyReq(body: any) {
  return { url: 'http://x/', nextUrl: new URL('http://x/'), json: async () => body } as any;
}

/** A context handle scoped to (nb-1, cl, <language>) — what a previous response
 *  would have returned. Anything else is refused (see exec-scope-authz). */
function handle(language: string, raw = 'ctx-existing') {
  return mintExecContextHandle({ itemId: 'nb-1', clusterId: 'cl', language }, raw);
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'o', tid: 't' } });
  (authorizeItemWorkspace as any).mockResolvedValue(null);
  (listClusters as any).mockResolvedValue([{ cluster_id: 'cl', cluster_source: 'UI', state: 'RUNNING' }]);
});

describe('POST /command', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'python', command: 'x' }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 on invalid language', async () => {
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'cobol', command: 'x' }), ctx);
    expect(res.status).toBe(400);
  });

  it('400 on empty command', async () => {
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'python', command: '   ' }), ctx);
    expect(res.status).toBe(400);
  });

  it('creates a context when none supplied, executes, and shapes a table result', async () => {
    (createExecutionContext as any).mockResolvedValue({ id: 'ctx-new' });
    (executeCommand as any).mockResolvedValue({
      id: 'cmd', status: 'Finished',
      results: { resultType: 'table', schema: [{ name: 'a' }, { name: 'b' }], data: [[1, 2]] },
    });
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'sql', command: 'SELECT 1' }), ctx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // The RAW Databricks context id is never returned — only a bound handle.
    expect(j.contextId).not.toBe('ctx-new');
    expect(j.contextId).toBe(handle('sql', 'ctx-new'));
    expect(j.resultType).toBe('table');
    expect(j.columns).toEqual(['a', 'b']);
    expect(j.rows).toEqual([[1, 2]]);
    expect(createExecutionContext).toHaveBeenCalledWith('cl', 'sql');
    expect(executeCommand).toHaveBeenCalledWith('cl', 'ctx-new', 'sql', 'SELECT 1');
  });

  it('reuses a supplied context handle (no create) and shapes a text result', async () => {
    (executeCommand as any).mockResolvedValue({
      id: 'cmd', status: 'Finished', results: { resultType: 'text', data: 'hello' },
    });
    const res = await commandPOST(
      bodyReq({ clusterId: 'cl', language: 'python', command: 'print(1)', contextId: handle('python') }),
      ctx,
    );
    const j = await res.json();
    expect(j.contextId).toBe(handle('python'));
    expect(j.text).toBe('hello');
    expect(createExecutionContext).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith('cl', 'ctx-existing', 'python', 'print(1)');
  });

  it('shapes an error result with summary + cause', async () => {
    (createExecutionContext as any).mockResolvedValue({ id: 'ctx' });
    (executeCommand as any).mockResolvedValue({
      id: 'cmd', status: 'Error', results: { resultType: 'error', summary: 'NameError', cause: 'x undefined' },
    });
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'python', command: 'print(x)' }), ctx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.resultType).toBe('error');
    expect(j.error).toBe('NameError');
    expect(j.cause).toBe('x undefined');
  });
});

describe('POST /context', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await contextPOST(bodyReq({ clusterId: 'cl', language: 'python' }), ctx);
    expect(res.status).toBe(401);
  });
  it('400 on invalid language', async () => {
    const res = await contextPOST(bodyReq({ clusterId: 'cl', language: 'cobol' }), ctx);
    expect(res.status).toBe(400);
  });
  it('creates and returns a bound context handle', async () => {
    (createExecutionContext as any).mockResolvedValue({ id: 'ctx-1' });
    const res = await contextPOST(bodyReq({ clusterId: 'cl', language: 'scala' }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.contextId).toBe(handle('scala', 'ctx-1'));
    expect(createExecutionContext).toHaveBeenCalledWith('cl', 'scala');
  });
});

describe('DELETE /context', () => {
  it('400 without contextId', async () => {
    const res = await contextDELETE(bodyReq({ clusterId: 'cl', language: 'python' }), ctx);
    expect(res.status).toBe(400);
  });
  it('destroys the context behind a valid handle', async () => {
    (destroyExecutionContext as any).mockResolvedValue(undefined);
    const res = await contextDELETE(
      bodyReq({ clusterId: 'cl', language: 'python', contextId: handle('python', 'ctx-1') }),
      ctx,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(destroyExecutionContext).toHaveBeenCalledWith('cl', 'ctx-1');
  });
});
