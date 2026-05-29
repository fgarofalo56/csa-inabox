/**
 * BFF gate + contract tests for the interactive Databricks notebook routes:
 *   - POST   /api/items/databricks-notebook/[id]/command
 *   - POST   /api/items/databricks-notebook/[id]/context
 *   - DELETE  /api/items/databricks-notebook/[id]/context
 *
 * Asserts the auth gate (401), input validation (400), and that the happy
 * path delegates to the real databricks-client Command Execution helpers
 * with the right args and shapes the result. The client is stubbed; the
 * client's own REST contract is covered in databricks-command-exec.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/databricks-client');
  return {
    ...actual,
    createExecutionContext: vi.fn(),
    destroyExecutionContext: vi.fn(),
    executeCommand: vi.fn(),
  };
});

import { POST as commandPOST } from '../databricks-notebook/[id]/command/route';
import { POST as contextPOST, DELETE as contextDELETE } from '../databricks-notebook/[id]/context/route';
import { getSession } from '@/lib/auth/session';
import {
  createExecutionContext, destroyExecutionContext, executeCommand,
} from '@/lib/azure/databricks-client';

function bodyReq(body: any) {
  return { url: 'http://x/', nextUrl: new URL('http://x/'), json: async () => body } as any;
}

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /command', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await commandPOST(bodyReq({ clusterId: 'c', language: 'python', command: 'x' }));
    expect(res.status).toBe(401);
  });

  it('400 when clusterId is missing', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await commandPOST(bodyReq({ language: 'python', command: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400 on invalid language', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await commandPOST(bodyReq({ clusterId: 'c', language: 'cobol', command: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400 on empty command', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await commandPOST(bodyReq({ clusterId: 'c', language: 'python', command: '   ' }));
    expect(res.status).toBe(400);
  });

  it('creates a context when none supplied, executes, and shapes a table result', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (createExecutionContext as any).mockResolvedValue({ id: 'ctx-new' });
    (executeCommand as any).mockResolvedValue({
      id: 'cmd', status: 'Finished',
      results: { resultType: 'table', schema: [{ name: 'a' }, { name: 'b' }], data: [[1, 2]] },
    });
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'sql', command: 'SELECT 1' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.contextId).toBe('ctx-new');
    expect(j.resultType).toBe('table');
    expect(j.columns).toEqual(['a', 'b']);
    expect(j.rows).toEqual([[1, 2]]);
    expect(createExecutionContext).toHaveBeenCalledWith('cl', 'sql');
    expect(executeCommand).toHaveBeenCalledWith('cl', 'ctx-new', 'sql', 'SELECT 1');
  });

  it('reuses a supplied contextId (no create) and shapes a text result', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (executeCommand as any).mockResolvedValue({
      id: 'cmd', status: 'Finished', results: { resultType: 'text', data: 'hello' },
    });
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'python', command: 'print(1)', contextId: 'ctx-existing' }));
    const j = await res.json();
    expect(j.contextId).toBe('ctx-existing');
    expect(j.text).toBe('hello');
    expect(createExecutionContext).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith('cl', 'ctx-existing', 'python', 'print(1)');
  });

  it('shapes an error result with summary + cause', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (createExecutionContext as any).mockResolvedValue({ id: 'ctx' });
    (executeCommand as any).mockResolvedValue({
      id: 'cmd', status: 'Error', results: { resultType: 'error', summary: 'NameError', cause: 'x undefined' },
    });
    const res = await commandPOST(bodyReq({ clusterId: 'cl', language: 'python', command: 'print(x)' }));
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
    const res = await contextPOST(bodyReq({ clusterId: 'c', language: 'python' }));
    expect(res.status).toBe(401);
  });
  it('400 without clusterId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await contextPOST(bodyReq({ language: 'python' }));
    expect(res.status).toBe(400);
  });
  it('creates and returns the context id', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (createExecutionContext as any).mockResolvedValue({ id: 'ctx-1' });
    const res = await contextPOST(bodyReq({ clusterId: 'cl', language: 'scala' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.contextId).toBe('ctx-1');
    expect(createExecutionContext).toHaveBeenCalledWith('cl', 'scala');
  });
});

describe('DELETE /context', () => {
  it('400 without contextId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await contextDELETE(bodyReq({ clusterId: 'cl' }));
    expect(res.status).toBe(400);
  });
  it('destroys the context', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (destroyExecutionContext as any).mockResolvedValue(undefined);
    const res = await contextDELETE(bodyReq({ clusterId: 'cl', contextId: 'ctx-1' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(destroyExecutionContext).toHaveBeenCalledWith('cl', 'ctx-1');
  });
});
