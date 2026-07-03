/**
 * Unit tests for the %%pyspark cell-routing route:
 *   POST/GET /api/items/notebook/[id]/execute-spark
 * plus the pure helpers resolveSparkBackend / notebookSparkPool and the AML
 * runner builder. Network-touching Livy + AML client calls and Cosmos are
 * mocked. The synapse-livy-client mock supplies faithful pure implementations
 * of parseMagicKind / normalizeLivyOutput (rather than importActual) so the
 * real module — and its @azure/identity import — never loads under the
 * pnpm-junctioned test sandbox.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const replaceMock = vi.fn();
const readMock = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    item: () => ({ read: readMock, replace: replaceMock }),
  })),
  // #1602 gates the route with assertOwner(workspaceId, tenantId); return an
  // owned workspace (tenantId === the session oid 'u1') so the guard passes.
  workspacesContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws1', tenantId: 'u1' } }) }),
  })),
}));

vi.mock('@/lib/azure/synapse-livy-client', () => {
  const MAGIC: Record<string, string> = {
    '%%pyspark': 'pyspark', '%%python': 'pyspark', '%%spark': 'spark', '%%scala': 'spark',
    '%%sql': 'sql', '%%sparksql': 'sql', '%%sparkr': 'sparkr', '%%r': 'sparkr',
  };
  return {
    parseMagicKind: (source: string) => {
      const lines = source.split('\n');
      const firstIdx = lines.findIndex(l => l.trim() !== '');
      if (firstIdx < 0) return null;
      const token = lines[firstIdx].trim().toLowerCase().split(/\s+/)[0];
      const kind = MAGIC[token];
      if (!kind) return null;
      return { kind, strippedCode: [...lines.slice(0, firstIdx), ...lines.slice(firstIdx + 1)].join('\n') };
    },
    normalizeLivyOutput: (output: any) => {
      if (!output) return null;
      if (output.status === 'error') {
        return { status: 'error', ename: output.ename, evalue: output.evalue, traceback: output.traceback };
      }
      const tp = output.data?.['text/plain'];
      return { status: 'ok', textPlain: Array.isArray(tp) ? tp.join('') : tp };
    },
    createLivySession: vi.fn(),
    getLivySession: vi.fn(),
    submitLivyStatement: vi.fn(),
    getLivyStatement: vi.fn(),
  };
});

vi.mock('@/lib/azure/aml-spark-client', () => ({
  AmlSparkNotConfiguredError: class extends Error { hint = 'set LOOM_AML_SPARK'; },
  submitAmlSparkCell: vi.fn(),
  getAmlSparkJob: vi.fn(),
  readAmlSparkResult: vi.fn(),
}));

import {
  POST as sparkPost, GET as sparkGet,
  resolveSparkBackend, notebookSparkPool,
} from '../[id]/execute-spark/route';
import { getSession } from '@/lib/auth/session';
import { createLivySession, getLivySession, submitLivyStatement, getLivyStatement } from '@/lib/azure/synapse-livy-client';
import { submitAmlSparkCell, getAmlSparkJob, readAmlSparkResult } from '@/lib/azure/aml-spark-client';
// buildRunnerPy lives in a pure, dependency-free module (no @azure/* imports).
import { buildRunnerPy } from '@/lib/azure/aml-spark-runner';

const NB = { id: 'nb1', itemType: 'notebook', displayName: 'nb', state: {} };

function postReq(body: any, ws = 'ws1') {
  return { nextUrl: new URL(`http://x/api/items/notebook/nb1/execute-spark?workspaceId=${ws}`), json: async () => body } as any;
}
function getReq(qs: string) {
  return { nextUrl: new URL(`http://x/api/items/notebook/nb1/execute-spark?${qs}`) } as any;
}
const ctx = { params: Promise.resolve({ id: 'nb1' }) };

beforeEach(() => {
  // clearAllMocks (not resetAllMocks) so the itemsContainer factory keeps its
  // implementation; we only want call history cleared between tests.
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'u1' } });
  readMock.mockResolvedValue({ resource: { ...NB, state: {} } });
  replaceMock.mockResolvedValue({});
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_AML_SPARK;
  delete process.env.LOOM_CLOUD_TIER;
  delete process.env.LOOM_SYNAPSE_SPARK_POOL;
  delete process.env.LOOM_SPARK_POOL;
});

describe('resolveSparkBackend', () => {
  it('returns synapse in Azure Government even with AML set', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    process.env.LOOM_AML_SPARK = 'aml-ws';
    expect(resolveSparkBackend()).toBe('synapse');
  });
  it('returns synapse at IL5 tier', () => {
    process.env.LOOM_CLOUD_TIER = 'IL5';
    process.env.LOOM_AML_SPARK = 'aml-ws';
    expect(resolveSparkBackend()).toBe('synapse');
  });
  it('returns aml on Commercial when LOOM_AML_SPARK is set', () => {
    process.env.LOOM_AML_SPARK = 'aml-ws';
    expect(resolveSparkBackend()).toBe('aml');
  });
  it('defaults to synapse when AML is not configured', () => {
    expect(resolveSparkBackend()).toBe('synapse');
  });
});

describe('notebookSparkPool', () => {
  it('prefers LOOM_SYNAPSE_SPARK_POOL', () => {
    process.env.LOOM_SYNAPSE_SPARK_POOL = 'nbpool';
    process.env.LOOM_SPARK_POOL = 'other';
    expect(notebookSparkPool()).toBe('nbpool');
  });
  it('falls back to LOOM_SPARK_POOL', () => {
    process.env.LOOM_SPARK_POOL = 'sharedpool';
    expect(notebookSparkPool()).toBe('sharedpool');
  });
});

describe('buildRunnerPy', () => {
  it('wraps a base64 cell with a SparkSession + stdout capture', () => {
    const py = buildRunnerPy('cHJpbnQoMSk=');
    expect(py).toContain('SparkSession.builder');
    expect(py).toContain("base64.b64decode('cHJpbnQoMSk=')");
    expect(py).toContain('redirect_stdout');
    expect(py).toContain('result.json');
  });
});

describe('POST execute-spark', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await sparkPost(postReq({ source: '%%pyspark\nx' }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when source is empty', async () => {
    const res = await sparkPost(postReq({ source: '' }), ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the cell is only a magic line', async () => {
    const res = await sparkPost(postReq({ source: '%%pyspark\n' }), ctx);
    expect(res.status).toBe(400);
  });

  it('routes %%pyspark to AML when configured, returning an aml runId', async () => {
    process.env.LOOM_AML_SPARK = 'aml-ws';
    (submitAmlSparkCell as any).mockResolvedValue({ jobName: 'loom-abc-1', resultBlobPath: 'loom-spark-out/loom-abc-1/result.json' });
    const res = await sparkPost(postReq({ source: '%%pyspark\nprint(spark.range(5).count())', cellId: 'c1' }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('aml');
    expect(j.runId).toBe('aml:loom-abc-1');
    // magic must be stripped before submitting to AML
    expect((submitAmlSparkCell as any).mock.calls[0][0]).toBe('print(spark.range(5).count())');
  });

  it('routes %%pyspark to Synapse Livy by default, creating a session', async () => {
    process.env.LOOM_SYNAPSE_SPARK_POOL = 'nbpool';
    (createLivySession as any).mockResolvedValue({ id: 7, state: 'starting' });
    const res = await sparkPost(postReq({ source: '%%pyspark\nprint(spark.range(5).count())', cellId: 'c1' }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('synapse');
    expect(j.runId).toBe('synapse-spark:nbpool:7');
    expect(createLivySession).toHaveBeenCalledWith('nbpool', expect.objectContaining({ kind: 'pyspark' }));
  });

  it('503 with an honest gate when no Synapse pool is configured', async () => {
    const res = await sparkPost(postReq({ source: '%%pyspark\nx = 1' }), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).hint).toContain('LOOM_SYNAPSE_SPARK_POOL');
  });
});

describe('GET execute-spark', () => {
  it('polls an AML job that is still running', async () => {
    (getAmlSparkJob as any).mockResolvedValue({ status: 'Running', terminal: false, succeeded: false });
    const res = await sparkGet(getReq('workspaceId=ws1&runId=aml:loom-abc-1'), ctx);
    const j = await res.json();
    expect(j.status).toBe('Running');
    expect(j.output).toBeUndefined();
  });

  it('reads the AML result.json once the job completes', async () => {
    (getAmlSparkJob as any).mockResolvedValue({ status: 'Completed', terminal: true, succeeded: true });
    (readAmlSparkResult as any).mockResolvedValue({ status: 'ok', textPlain: '5' });
    const res = await sparkGet(getReq('workspaceId=ws1&runId=aml:loom-abc-1'), ctx);
    const j = await res.json();
    expect(j.output.status).toBe('ok');
    expect(j.output.textPlain).toBe('5');
  });

  it('submits the Synapse statement once the session is idle', async () => {
    readMock.mockResolvedValue({ resource: { ...NB, state: { pendingRuns: { 'synapse-spark:nbpool:7': { source: 'print(spark.range(5).count())', lang: 'pyspark', cellId: 'c1' } } } } });
    (getLivySession as any).mockResolvedValue({ id: 7, state: 'idle' });
    (submitLivyStatement as any).mockResolvedValue({ id: 3, state: 'running' });
    const res = await sparkGet(getReq('workspaceId=ws1&runId=synapse-spark:nbpool:7'), ctx);
    const j = await res.json();
    expect(j.phase).toBe('statement-submitted');
    expect(j.runId).toBe('synapse-spark:nbpool:7:3');
    expect(submitLivyStatement).toHaveBeenCalledWith('nbpool', 7, 'print(spark.range(5).count())', 'pyspark');
  });

  it('returns the Synapse statement output (count = 5)', async () => {
    (getLivyStatement as any).mockResolvedValue({ id: 3, state: 'available', output: { status: 'ok', data: { 'text/plain': '5' } } });
    const res = await sparkGet(getReq('workspaceId=ws1&runId=synapse-spark:nbpool:7:3'), ctx);
    const j = await res.json();
    expect(j.phase).toBe('statement-running');
    expect(j.output.status).toBe('ok');
    expect(j.output.textPlain).toBe('5');
  });
});
