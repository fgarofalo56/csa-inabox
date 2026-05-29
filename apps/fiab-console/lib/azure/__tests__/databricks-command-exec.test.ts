/**
 * Contract tests for the Databricks Command Execution API (api/1.2) client
 * functions that back the interactive notebook editor, plus the workspace
 * import/export and clusters/list calls the notebook relies on.
 *
 * Per .claude/rules/no-vaporware.md: these assert the *exact* REST URL +
 * payload the client sends to the real Databricks workspace, and the
 * polling / shaping behaviour — no behavior is faked beyond stubbing
 * global.fetch + the AAD credential.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'STUB.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  createExecutionContext,
  destroyExecutionContext,
  runCommand,
  getCommandStatus,
  executeCommand,
  listClusters,
  getNotebook,
  importNotebook,
  listWorkspace,
} from '../databricks-client';

const realFetch = global.fetch;

interface Call { url: string; init?: RequestInit }

function mockFetch(handler: (url: string, init?: RequestInit) => any, calls?: Call[]) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls?.push({ url: String(url), init });
    const body = await handler(String(url), init);
    if (body instanceof Response) return body;
    const status = body?._status || 200;
    return new Response(JSON.stringify(body), { status });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.19.azuredatabricks.net';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
});

describe('createExecutionContext', () => {
  it('POSTs /api/1.2/contexts/create with clusterId + language', async () => {
    let body: any; let url = '';
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return { id: 'ctx-1' }; });
    const ctx = await createExecutionContext('cl-1', 'python');
    expect(url).toBe('https://adb-123.19.azuredatabricks.net/api/1.2/contexts/create');
    expect(body).toEqual({ clusterId: 'cl-1', language: 'python' });
    expect(ctx.id).toBe('ctx-1');
  });
});

describe('runCommand', () => {
  it('POSTs /api/1.2/commands/execute with the cell source as command', async () => {
    let body: any; let url = '';
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return { id: 'cmd-9' }; });
    const out = await runCommand('cl-1', 'ctx-1', 'sql', 'SELECT 1');
    expect(url).toBe('https://adb-123.19.azuredatabricks.net/api/1.2/commands/execute');
    expect(body).toEqual({ clusterId: 'cl-1', contextId: 'ctx-1', language: 'sql', command: 'SELECT 1' });
    expect(out.id).toBe('cmd-9');
  });
});

describe('getCommandStatus', () => {
  it('GETs /api/1.2/commands/status with the id triple in the query', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { id: 'cmd-9', status: 'Finished', results: { resultType: 'text', data: 'ok' } }; });
    const r = await getCommandStatus('cl-1', 'ctx-1', 'cmd-9');
    expect(url).toContain('/api/1.2/commands/status?');
    expect(url).toContain('clusterId=cl-1');
    expect(url).toContain('contextId=ctx-1');
    expect(url).toContain('commandId=cmd-9');
    expect(r.results?.data).toBe('ok');
  });
});

describe('executeCommand (submit + poll to terminal)', () => {
  it('submits then polls until Finished, returning the terminal result', async () => {
    let statusHits = 0;
    mockFetch((url) => {
      if (url.includes('/commands/execute')) return { id: 'cmd-1' };
      if (url.includes('/commands/status')) {
        statusHits += 1;
        // first poll: still Running, second: Finished with a table result
        if (statusHits < 2) return { id: 'cmd-1', status: 'Running' };
        return {
          id: 'cmd-1',
          status: 'Finished',
          results: { resultType: 'table', schema: [{ name: 'n' }], data: [[1], [2]] },
        };
      }
      return {};
    });
    const r = await executeCommand('cl-1', 'ctx-1', 'python', 'spark.range(2)');
    expect(r.status).toBe('Finished');
    expect(r.results?.resultType).toBe('table');
    expect(statusHits).toBeGreaterThanOrEqual(2);
  });

  it('returns an Error result rather than throwing on command failure', async () => {
    mockFetch((url) => {
      if (url.includes('/commands/execute')) return { id: 'cmd-2' };
      if (url.includes('/commands/status')) {
        return { id: 'cmd-2', status: 'Error', results: { resultType: 'error', summary: 'NameError', cause: 'x not defined' } };
      }
      return {};
    });
    const r = await executeCommand('cl-1', 'ctx-1', 'python', 'print(x)');
    expect(r.status).toBe('Error');
    expect(r.results?.resultType).toBe('error');
    expect(r.results?.summary).toBe('NameError');
  });
});

describe('destroyExecutionContext', () => {
  it('POSTs /api/1.2/contexts/destroy and swallows a 404 (stale context)', async () => {
    let url = '';
    mockFetch((u) => { url = u; return new Response('{}', { status: 404 }); });
    await expect(destroyExecutionContext('cl-1', 'ctx-1')).resolves.toBeUndefined();
    expect(url).toBe('https://adb-123.19.azuredatabricks.net/api/1.2/contexts/destroy');
  });
});

describe('listClusters', () => {
  it('GETs /api/2.0/clusters/list and returns the clusters array', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { clusters: [{ cluster_id: 'c1', state: 'RUNNING' }] }; });
    const cs = await listClusters();
    expect(url).toBe('https://adb-123.19.azuredatabricks.net/api/2.0/clusters/list');
    expect(cs[0].cluster_id).toBe('c1');
  });
});

describe('workspace export/import (notebook source round-trip)', () => {
  it('getNotebook GETs workspace/export?format=SOURCE and base64-decodes content', async () => {
    let url = '';
    const decoded = '# Databricks notebook source\nprint(1)\n';
    mockFetch((u) => { url = u; return { content: Buffer.from(decoded, 'utf-8').toString('base64') }; });
    const nb = await getNotebook('/Workspace/foo.py');
    expect(url).toContain('/api/2.0/workspace/export');
    expect(url).toContain('format=SOURCE');
    expect(nb.content).toBe(decoded);
    expect(nb.language).toBe('PYTHON');
  });

  it('importNotebook POSTs workspace/import with base64 + overwrite', async () => {
    let body: any; let url = '';
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return {}; });
    await importNotebook('/Workspace/foo', 'SQL', 'SELECT 1', true);
    expect(url).toBe('https://adb-123.19.azuredatabricks.net/api/2.0/workspace/import');
    expect(body.path).toBe('/Workspace/foo');
    expect(body.format).toBe('SOURCE');
    expect(body.language).toBe('SQL');
    expect(body.overwrite).toBe(true);
    expect(Buffer.from(body.content, 'base64').toString('utf-8')).toBe('SELECT 1');
  });

  it('listWorkspace GETs workspace/list and returns objects', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { objects: [{ object_type: 'NOTEBOOK', path: '/Workspace/a' }] }; });
    const objs = await listWorkspace('/Workspace');
    expect(url).toContain('/api/2.0/workspace/list');
    expect(objs[0].object_type).toBe('NOTEBOOK');
  });
});
