/**
 * Contract tests for the Synapse Livy statements helpers that back the in-cell
 * Copilot /fix command — listLivyStatements + getLastLivyError. Per
 * .claude/rules/no-vaporware.md these assert the real REST URL the client hits
 * and the error-selection behaviour; only global.fetch + the AAD credential are
 * stubbed. Also covers the sovereign devBase (LOOM_SYNAPSE_DEV_SUFFIX) host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'STUB.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { listLivyStatements, getLastLivyError } from '../synapse-livy-client';

const realFetch = global.fetch;

function mockFetch(body: any, calls?: string[]) {
  global.fetch = vi.fn(async (url: any) => {
    calls?.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  delete process.env.LOOM_SYNAPSE_DEV_SUFFIX;
});

describe('listLivyStatements', () => {
  it('GETs the session statements endpoint and returns the statements array', async () => {
    const calls: string[] = [];
    mockFetch({ from: 0, total: 1, statements: [{ id: 1, state: 'available', output: { status: 'ok' } }] }, calls);
    const res = await listLivyStatements('spark-loom', 42);
    expect(res).toHaveLength(1);
    expect(calls[0]).toBe('https://syn-loom.dev.azuresynapse.net/livyApi/versions/2019-11-01-preview/sparkPools/spark-loom/sessions/42/statements');
  });

  it('uses the sovereign dev suffix host when LOOM_SYNAPSE_DEV_SUFFIX is set (GCC-High)', async () => {
    process.env.LOOM_SYNAPSE_DEV_SUFFIX = 'azuresynapse.us';
    const calls: string[] = [];
    mockFetch({ statements: [] }, calls);
    await listLivyStatements('spark-loom', 7);
    expect(calls[0]).toContain('https://syn-loom.dev.azuresynapse.us/');
  });

  it('returns [] when the body has no statements field', async () => {
    mockFetch({ from: 0, total: 0 });
    expect(await listLivyStatements('p', 1)).toEqual([]);
  });
});

describe('getLastLivyError', () => {
  it('returns the highest-id available error statement output fields', async () => {
    mockFetch({
      statements: [
        { id: 0, state: 'available', output: { status: 'ok' } },
        { id: 1, state: 'available', output: { status: 'error', ename: 'NameError', evalue: "name 'df' is not defined", traceback: ['Traceback...'] } },
        { id: 2, state: 'running', output: null },
      ],
    });
    const e = await getLastLivyError('spark-loom', 42);
    expect(e).toEqual({ ename: 'NameError', evalue: "name 'df' is not defined", traceback: ['Traceback...'] });
  });

  it('returns null when there are no error statements', async () => {
    mockFetch({ statements: [{ id: 0, state: 'available', output: { status: 'ok' } }] });
    expect(await getLastLivyError('p', 1)).toBeNull();
  });

  it('soft-fails to null when the session is unreachable', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(await getLastLivyError('p', 1)).toBeNull();
  });
});
