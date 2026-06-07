/**
 * Unit tests for the AML Compute-Instance Jupyter backend routes:
 *   /api/notebook/[id]/execute   (POST aml-ci branch + GET state)
 *   /api/notebook/[id]/contents  (GET read + PUT write)
 *
 * The network-touching jupyter-server-client functions are mocked; the pure
 * normalizeJupyterOutput stays real (vi.importActual). LOOM_NOTEBOOK_BACKEND is
 * pinned to 'aml-ci' so resolveNotebookBackend() routes into the new branch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
// The execute route statically imports the Synapse clients (which pull in
// @azure/identity at module-eval). Stub them so this aml-ci unit test stays
// hermetic — resolveNotebookBackend mirrors the real env logic; the magic
// parsers return null for plain Python cells (the only cells exercised here).
vi.mock('@/lib/azure/synapse-livy-client', () => ({
  resolveNotebookBackend: () => {
    const v = (process.env.LOOM_NOTEBOOK_BACKEND || '').trim().toLowerCase();
    if (v === 'databricks') return 'databricks';
    if (v === 'aml-ci' || v === 'aml' || v === 'jupyter') return 'aml-ci';
    return 'synapse';
  },
  parseMagicKind: () => null,
  parseConfigureMagic: () => null,
  normalizeLivyOutput: () => null,
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({ synapseConfigGate: () => null }));
vi.mock('@/lib/clients/jupyter-server-client', async () => {
  const actual: any = await vi.importActual('@/lib/clients/jupyter-server-client');
  return {
    ...actual, // keep normalizeJupyterOutput + error classes (pure, no network)
    isJupyterCiConfigured: vi.fn(() => true),
    getNotebookToken: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsGet: vi.fn(),
    contentsGet: vi.fn(),
    contentsPut: vi.fn(),
    executeViaKernelWs: vi.fn(),
  };
});

import { POST as executePost, GET as executeGet } from '../[id]/execute/route';
import { GET as contentsGet, PUT as contentsPut } from '../[id]/contents/route';
import { getSession } from '@/lib/auth/session';
import {
  isJupyterCiConfigured, getNotebookToken, sessionsCreate, sessionsGet,
  executeViaKernelWs, contentsGet as contentsGetFn, contentsPut as contentsPutFn,
} from '@/lib/clients/jupyter-server-client';

function postReq(body: any) { return { json: async () => body } as any; }
function getReq(path: string, qs: string) { return { nextUrl: new URL(`http://x/api/notebook/nb1/${path}?${qs}`) } as any; }

const TOKEN = { accessToken: 't', hostName: 'h.notebooks.azure.net', expiresIn: 28800 };

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ userId: 'u1' });
  (isJupyterCiConfigured as any).mockReturnValue(true);
  (getNotebookToken as any).mockResolvedValue(TOKEN);
  process.env.LOOM_NOTEBOOK_BACKEND = 'aml-ci';
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_AML_WORKSPACE = 'ws-1';
});

describe('POST /api/notebook/[id]/execute (aml-ci)', () => {
  it('returns 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await executePost(postReq({ code: 'print(1)' }));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the AML CI backend is not configured', async () => {
    (isJupyterCiConfigured as any).mockReturnValue(false);
    const res = await executePost(postReq({ code: 'print(1+1)', notebookPath: 'n.ipynb' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('not_configured');
    expect(j.missing).toContain('LOOM_AML_WORKSPACE');
  });

  it('creates a kernel session then returns real output 2 for print(1+1)', async () => {
    (sessionsCreate as any).mockResolvedValue({ sessionId: 'sess-9', kernelId: 'kern-9' });
    (executeViaKernelWs as any).mockResolvedValue({ status: 'ok', textPlain: '2\n' });
    const res = await executePost(postReq({ code: 'print(1+1)', notebookPath: 'Users/u/nb.ipynb' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('aml-ci');
    expect(j.kernelId).toBe('kern-9');
    expect(j.output.textPlain).toBe('2\n');
    expect(sessionsCreate).toHaveBeenCalledWith(TOKEN, 'Users/u/nb.ipynb', 'python3');
    expect(executeViaKernelWs).toHaveBeenCalledWith(TOKEN, 'kern-9', 'sess-9', 'print(1+1)');
  });

  it('reuses a kernelId without creating a new session', async () => {
    (executeViaKernelWs as any).mockResolvedValue({ status: 'ok', textPlain: '2' });
    const res = await executePost(postReq({ code: '1+1', kernelId: 'kern-warm', sessionId: 'sess-warm' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(executeViaKernelWs).toHaveBeenCalledWith(TOKEN, 'kern-warm', 'sess-warm', '1+1');
  });

  it('returns ok:false with captured traceback for a failing cell', async () => {
    (executeViaKernelWs as any).mockResolvedValue({
      status: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['tb1', 'tb2'], textPlain: 'stderr\n',
    });
    const res = await executePost(postReq({ code: 'raise ValueError("bad")', kernelId: 'k', sessionId: 's' }));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.state).toBe('error');
    expect(j.output.status).toBe('error');
    expect(j.output.ename).toBe('ValueError');
    expect(j.output.traceback).toEqual(['tb1', 'tb2']);
  });

  it('400 when starting a new session without a notebookPath', async () => {
    const res = await executePost(postReq({ code: 'print(1)' }));
    expect(res.status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('400 when the cell is empty', async () => {
    const res = await executePost(postReq({ code: '   ' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notebook/[id]/execute (aml-ci state poll)', () => {
  it('returns the kernel session state', async () => {
    (sessionsGet as any).mockResolvedValue({ sessionId: 'sess-9', kernelId: 'kern-9', state: 'idle' });
    const res = await executeGet(getReq('execute', 'sessionId=sess-9'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('aml-ci');
    expect(j.state).toBe('idle');
  });

  it('400 when sessionId missing', async () => {
    const res = await executeGet(getReq('execute', ''));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notebook/[id]/contents', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await contentsGet(getReq('contents', 'path=n.ipynb'));
    expect(res.status).toBe(401);
  });

  it('503 when not configured', async () => {
    (isJupyterCiConfigured as any).mockReturnValue(false);
    const res = await contentsGet(getReq('contents', 'path=n.ipynb'));
    expect(res.status).toBe(503);
  });

  it('400 when path missing', async () => {
    const res = await contentsGet(getReq('contents', ''));
    expect(res.status).toBe(400);
  });

  it('reads the notebook model', async () => {
    (contentsGetFn as any).mockResolvedValue({ name: 'nb.ipynb', path: 'Users/u/nb.ipynb', type: 'notebook', content: { cells: [] } });
    const res = await contentsGet(getReq('contents', 'path=Users/u/nb.ipynb'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.model.type).toBe('notebook');
    expect(contentsGetFn).toHaveBeenCalledWith(TOKEN, 'Users/u/nb.ipynb', { content: true });
  });
});

describe('PUT /api/notebook/[id]/contents', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await contentsPut(postReq({ path: 'n.ipynb', content: {} }));
    expect(res.status).toBe(401);
  });

  it('400 when content missing', async () => {
    const res = await contentsPut(postReq({ path: 'n.ipynb' }));
    expect(res.status).toBe(400);
  });

  it('writes the notebook and returns the saved model', async () => {
    (contentsPutFn as any).mockResolvedValue({ name: 'nb.ipynb', path: 'Users/u/nb.ipynb', type: 'notebook' });
    const ipynb = { cells: [{ cell_type: 'code', source: 'print(1+1)' }], nbformat: 4 };
    const res = await contentsPut(postReq({ path: 'Users/u/nb.ipynb', content: ipynb }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.model.path).toBe('Users/u/nb.ipynb');
    expect(contentsPutFn).toHaveBeenCalledWith(TOKEN, 'Users/u/nb.ipynb', ipynb, 'notebook');
  });
});
