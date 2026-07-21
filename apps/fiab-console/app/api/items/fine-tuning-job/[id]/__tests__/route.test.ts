/**
 * WS-1.3 — contract tests for the fine-tuning-job item BFF route.
 *   - 401 unauthenticated (GET + POST)
 *   - GET returns the honest gate (503-style body carries the gate) on the
 *     Databricks opt-in gate without a real backend call
 *   - POST 503 when a config gate is present
 *   - POST 400 when the training-data-eval gate rejects the dataset
 *   - POST success shapes the job + persists the binding
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/fine-tuning-item', () => ({
  resolveFineTuningItem: vi.fn(),
  persistFineTuningItem: vi.fn(),
  fineTuningItemErrorResponse: (e: any) => ({ status: 404, body: { ok: false, error: e?.message || 'not found' } }),
}));
vi.mock('@/lib/azure/foundry-cs-client', () => ({ listCatalogModels: vi.fn(async () => ({ account: {}, models: [] })) }));
vi.mock('@/lib/azure/fine-tuning-client', () => {
  class CsError extends Error { status = 502; body: any; constructor(m?: string) { super(m); } }
  return {
    CsError,
    resolveFineTuneBackend: vi.fn(() => 'aoai'),
    fineTuneConfigGate: vi.fn(() => null),
    fineTuneGateFromError: vi.fn(() => null),
    submitFineTuningJob: vi.fn(),
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(),
    listDeployments: vi.fn(async () => []),
    shapeFineTuningJobView: (j: any) => ({ id: j.id, status: j.status, terminal: false, succeeded: false, hasModel: false }),
  };
});

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { resolveFineTuningItem, persistFineTuningItem } from '@/lib/azure/fine-tuning-item';
import { fineTuneConfigGate, submitFineTuningJob } from '@/lib/azure/fine-tuning-client';

const TENANT = 'tenant-oid';
const req = (body?: any) => ({ json: async () => body, nextUrl: { searchParams: new URLSearchParams() } } as any);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: TENANT } });
  (resolveFineTuningItem as any).mockResolvedValue({ item: { id: 'i1' } });
  (persistFineTuningItem as any).mockResolvedValue({});
  (fineTuneConfigGate as any).mockReturnValue(null);
});

describe('GET /api/items/fine-tuning-job/[id]', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req(), ctx('i1'));
    expect(res.status).toBe(401);
  });

  it('surfaces the honest gate (full surface still renders)', async () => {
    (fineTuneConfigGate as any).mockReturnValue({ backend: 'databricks', missing: 'x', hint: 'set it', fixEnvVar: 'LOOM_DATABRICKS_HOSTNAME', gateId: 'svc-fine-tuning' });
    const res = await GET(req(), ctx('i1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.gate?.gateId).toBe('svc-fine-tuning');
    expect(body.jobs).toEqual([]);
  });
});

describe('POST /api/items/fine-tuning-job/[id]', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ baseModel: 'gpt-4o-mini' }), ctx('i1'));
    expect(res.status).toBe(401);
  });

  it('400 when baseModel is missing', async () => {
    const res = await POST(req({ trainingData: '{}' }), ctx('i1'));
    expect(res.status).toBe(400);
  });

  it('503 when a config gate is present', async () => {
    (fineTuneConfigGate as any).mockReturnValue({ backend: 'databricks', missing: 'x', hint: 'set it', fixEnvVar: 'LOOM_DATABRICKS_HOSTNAME', gateId: 'svc-fine-tuning' });
    const res = await POST(req({ baseModel: 'gpt-4o-mini', trainingData: 'x' }), ctx('i1'));
    expect(res.status).toBe(503);
  });

  it('400 when the training-data-eval gate rejects the dataset', async () => {
    (submitFineTuningJob as any).mockRejectedValue(new Error('Training data failed validation: Only 2 valid example(s).'));
    const res = await POST(req({ baseModel: 'gpt-4o-mini', trainingData: 'bad' }), ctx('i1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/failed validation/i);
  });

  it('submits a job and persists the binding on success', async () => {
    (submitFineTuningJob as any).mockResolvedValue({ job: { id: 'ftjob-9', status: 'queued' }, trainingDataEval: { ok: true, rows: 12, errors: [], warnings: [] } });
    const res = await POST(req({ baseModel: 'gpt-4o-mini', trainingData: 'ok' }), ctx('i1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.job.id).toBe('ftjob-9');
    expect(persistFineTuningItem).toHaveBeenCalledWith('i1', TENANT, expect.objectContaining({ jobId: 'ftjob-9', baseModel: 'gpt-4o-mini' }));
  });
});
