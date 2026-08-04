/**
 * Spark job definitions (Phase 5, J1-J6): the pure model (request shaping +
 * run normalization) and the LoomApi transport against a MOCKED route. Proves
 * the client speaks the real dedicated SJD contract — `PUT …/[id]`,
 * `POST …/submit`, `GET …/runs`, `POST …/runs/[b]/cancel`, `POST …/files`
 * (multipart) — and that an honest 400 (`spec.file is required`) surfaces.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoomApi, LoomApiError } from '../src/api/loom-client';
import {
  buildSubmitBody,
  buildSpecUpdate,
  specFromState,
  runState,
  isTerminalRun,
  runIcon,
  summarizeRun,
  runsFromResponse,
  type SparkBatchJob,
} from '../src/spark-job/spark-job-model';

const api = () => new LoomApi('https://loom.example', { kind: 'pat', value: 'loom_pat_test' });
afterEach(() => vi.unstubAllGlobals());

describe('spark-job-model (pure request shaping)', () => {
  it('buildSubmitBody is empty for a plain run (uses persisted spec)', () => {
    expect(buildSubmitBody()).toEqual({});
    expect(buildSubmitBody({})).toEqual({});
  });

  it('buildSubmitBody drops empty overrides and trims', () => {
    expect(buildSubmitBody({ pool: '  ', file: '', name: '  Run 1 ' })).toEqual({ name: 'Run 1' });
    expect(buildSubmitBody({ pool: 'p1', file: 'abfss://x/main.py', args: [' a ', '', 'b'] })).toEqual({
      pool: 'p1',
      file: 'abfss://x/main.py',
      args: ['a', 'b'],
    });
  });

  it('buildSpecUpdate merges into state.spec without clobbering other state keys', () => {
    const out = buildSpecUpdate({ note: 'keep', spec: { pool: 'old', file: 'f.py', language: 'PySpark' } }, { pool: 'new', className: '' });
    expect(out).toEqual({
      state: { note: 'keep', spec: { pool: 'new', file: 'f.py', language: 'PySpark' } },
    });
    // an empty patch value ('') is dropped, not written
    expect((out.state.spec as Record<string, unknown>).className).toBeUndefined();
  });

  it('buildSpecUpdate tolerates undefined/empty prior state', () => {
    expect(buildSpecUpdate(undefined, { pool: 'p', file: 'f' })).toEqual({ state: { spec: { pool: 'p', file: 'f' } } });
  });

  it('specFromState reads state.spec safely', () => {
    expect(specFromState({ spec: { pool: 'p' } })).toEqual({ pool: 'p' });
    expect(specFromState(undefined)).toEqual({});
    expect(specFromState({ nope: 1 })).toEqual({});
  });
});

describe('spark-job-model (run normalization)', () => {
  const running: SparkBatchJob = { id: 41, name: 'loom-j-1', livyInfo: { currentState: 'running' } };
  const ok: SparkBatchJob = { id: 42, name: 'loom-j-2', state: 'success', result: 'Succeeded', appId: 'app-1' };
  const failed: SparkBatchJob = { id: 43, result: 'Failed', state: 'error' };

  it('runState prefers livyInfo.currentState', () => {
    expect(runState(running)).toBe('running');
    expect(runState(ok)).toBe('success');
  });

  it('isTerminalRun reflects result/state', () => {
    expect(isTerminalRun(running)).toBe(false);
    expect(isTerminalRun(ok)).toBe(true);
    expect(isTerminalRun(failed)).toBe(true);
  });

  it('runIcon reflects outcome', () => {
    expect(runIcon(running)).toBe('sync~spin');
    expect(runIcon(ok)).toBe('pass');
    expect(runIcon(failed)).toBe('error');
  });

  it('summarizeRun projects a display row', () => {
    expect(summarizeRun(ok)).toEqual({ id: 42, label: 'loom-j-2', state: 'success', result: 'Succeeded', icon: 'pass', appId: 'app-1' });
    // no name → falls back to "batch <id>"
    expect(summarizeRun(failed).label).toBe('batch 43');
  });

  it('runsFromResponse filters non-batch rows', () => {
    expect(runsFromResponse({ sessions: [running, { nope: 1 }, ok] })).toHaveLength(2);
    expect(runsFromResponse(undefined)).toEqual([]);
    expect(runsFromResponse({})).toEqual([]);
  });
});

interface FakeResp {
  status: number;
  body: unknown;
}

function installJsonFetch(handler: (path: string, method: string, body?: unknown) => FakeResp) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const u = new URL(url);
      const r = handler(u.pathname + u.search, method, body);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

describe('LoomApi spark-job transport', () => {
  it('submitSparkJob POSTs to the submit route with the shaped body', async () => {
    const calls = installJsonFetch(() => ({ status: 200, body: { ok: true, pool: 'p1', job: { id: 99, state: 'starting' } } }));
    const res = await api().submitSparkJob('sjd1', buildSubmitBody());
    expect(res.job?.id).toBe(99);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://loom.example/api/items/spark-job-definition/sjd1/submit');
    expect(calls[0].body).toEqual({});
  });

  it('listSparkJobRuns GETs with size/from and returns sessions', async () => {
    const calls = installJsonFetch(() => ({ status: 200, body: { ok: true, pool: 'p1', from: 0, total: 1, sessions: [{ id: 7, state: 'success', result: 'Succeeded' }] } }));
    const res = await api().listSparkJobRuns('sjd1', 20, 0);
    expect(runsFromResponse(res)).toHaveLength(1);
    expect(calls[0].url).toBe('https://loom.example/api/items/spark-job-definition/sjd1/runs?size=20&from=0');
  });

  it('cancelSparkJobRun POSTs to the cancel route', async () => {
    const calls = installJsonFetch(() => ({ status: 200, body: { ok: true } }));
    await api().cancelSparkJobRun('sjd1', 7);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://loom.example/api/items/spark-job-definition/sjd1/runs/7/cancel');
  });

  it('putSparkJobState PUTs {state} and returns the item', async () => {
    const calls = installJsonFetch(() => ({ status: 200, body: { ok: true, item: { id: 'sjd1', displayName: 'J', itemType: 'spark-job-definition', workspaceId: 'ws1' } } }));
    const item = await api().putSparkJobState('sjd1', { spec: { pool: 'p' } });
    expect(item.id).toBe('sjd1');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toEqual({ state: { spec: { pool: 'p' } } });
  });

  it('surfaces an honest 400 (spec.file required) as a LoomApiError with status', async () => {
    installJsonFetch(() => ({ status: 400, body: { error: 'spec.file is required' } }));
    await expect(api().submitSparkJob('sjd1', {})).rejects.toBeInstanceOf(LoomApiError);
    try {
      await api().submitSparkJob('sjd1', {});
    } catch (e) {
      expect((e as LoomApiError).status).toBe(400);
      expect((e as LoomApiError).message).toMatch(/spec\.file/);
    }
  });

  it('uploadSparkJobFile posts multipart (FormData body, no JSON Content-Type)', async () => {
    let sawFormData = false;
    let sawContentType: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sawFormData = init?.body instanceof FormData;
        const headers = (init?.headers || {}) as Record<string, string>;
        sawContentType = headers['Content-Type'];
        return new Response(JSON.stringify({ ok: true, filename: 'main.py', abfssPath: 'abfss://landing@acct.dfs.core.windows.net/sjd/x/Main/main.py', size: 3 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const res = await api().uploadSparkJobFile('sjd1', 'main', 'main.py', new Uint8Array([1, 2, 3]));
    expect(res.abfssPath).toMatch(/^abfss:\/\//);
    expect(sawFormData).toBe(true);
    // We must NOT set Content-Type — fetch sets the multipart boundary.
    expect(sawContentType).toBeUndefined();
  });

  it('uploadSparkJobFile surfaces the honest adls_not_configured gate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'ADLS not configured: set LOOM_LANDING_URL', code: 'adls_not_configured' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    try {
      await api().uploadSparkJobFile('sjd1', 'main', 'main.py', new Uint8Array([1]));
      throw new Error('expected a gate error');
    } catch (e) {
      expect(e).toBeInstanceOf(LoomApiError);
      expect((e as LoomApiError).code).toBe('adls_not_configured');
    }
  });
});
