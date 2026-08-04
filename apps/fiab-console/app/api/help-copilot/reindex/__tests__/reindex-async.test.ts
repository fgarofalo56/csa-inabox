/**
 * Contract test for the ASYNC + POLLABLE `loom-docs` reindex (#2929).
 *
 * WHAT THIS PINS, AND WHY IT EXISTS
 * ---------------------------------
 * copilot-quality-evals run 30937670794 got `HTTP 502` from
 * `POST /api/help-copilot/reindex` — in ~160ms, carrying the route's own
 * `{"ok":false,"backend":"none","totalChunks":0,…,"error":"No corpus chunks
 * discovered …"}`. Two distinct problems hid behind that one status code:
 *
 *   1. the corpus genuinely was not in the image (the routine console builders
 *      never ran stage-copilot-corpus.sh), and
 *   2. a HEALTHY rebuild could ALSO 502 — at the EDGE — because Front Door's
 *      default 60s origin timeout is shorter than a full corpus build.
 *
 * The route now separates them: the empty corpus fails FAST and loud (502, same
 * message), and the long rebuild is ACCEPTED (202) and polled via GET. So these
 * tests assert exactly that split, plus the job state machine underneath.
 *
 * Everything Azure-facing is stubbed; this exercises the route's own contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/internal-token', () => ({
  isValidInternalToken: vi.fn(),
  INTERNAL_TOKEN_HEADER: 'x-loom-internal-token',
}));
vi.mock('@/lib/azure/loom-docs-index', () => ({
  reindex: vi.fn(),
  isSearchConfigured: vi.fn(() => true),
  corpusSourceCount: vi.fn(() => 2453),
  corpusFreshness: vi.fn(async () => ({
    state: 'fresh',
    reason: 'The indexed corpus matches the staged docs.',
    backend: 'ai-search',
    indexedAt: '2026-08-04T18:00:00.000Z',
    indexedChunkCount: 49593,
    currentStatFingerprint: 'abc',
    indexedStatFingerprint: 'abc',
    sourceCommit: 'deadbeef',
    indexedCommit: 'deadbeef',
  })),
}));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { isValidInternalToken } from '@/lib/auth/internal-token';
import { reindex, corpusSourceCount, corpusFreshness } from '@/lib/azure/loom-docs-index';
import {
  startReindexJob,
  getReindexJobStatus,
  __resetReindexJob,
  __awaitReindexJob,
} from '@/lib/azure/reindex-job';

function req(headers: Record<string, string> = {}) {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as any;
}

const OK_RESULT = {
  ok: true,
  backend: 'ai-search' as const,
  totalChunks: 49593,
  uploaded: 49593,
  byKind: { docs: 40000, prp: 9000, adr: 400, repo: 193 },
  warnings: [],
  mode: 'full' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetReindexJob();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin' } });
  (isValidInternalToken as any).mockReturnValue(false);
  (corpusSourceCount as any).mockReturnValue(2453);
  (reindex as any).mockResolvedValue(OK_RESULT);
});

describe('auth — the dual session-OR-internal-token guard stays fail-closed', () => {
  it('rejects with 401 when there is neither a session nor a valid token', async () => {
    (getSession as any).mockReturnValue(null);
    (isValidInternalToken as any).mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthenticated');
    // and the guard must actually PREVENT the work, not just label it
    expect(reindex).not.toHaveBeenCalled();
  });

  it('rejects GET with 401 the same way', async () => {
    (getSession as any).mockReturnValue(null);
    (isValidInternalToken as any).mockReturnValue(false);
    expect((await GET(req())).status).toBe(401);
  });

  it('accepts the VNet-internal Bearer token with no session (the CI path)', async () => {
    (getSession as any).mockReturnValue(null);
    (isValidInternalToken as any).mockImplementation((t: string | null) => t === 'secret');
    const res = await POST(req({ authorization: 'Bearer secret' }));
    expect(res.status).toBe(202);
  });

  it('accepts the x-loom-internal-token header form', async () => {
    (getSession as any).mockReturnValue(null);
    (isValidInternalToken as any).mockImplementation((t: string | null) => t === 'secret');
    const res = await POST(req({ 'x-loom-internal-token': 'secret' }));
    expect(res.status).toBe(202);
  });
});

describe('POST — empty corpus fails FAST and LOUD (the 2026-08-04 502)', () => {
  it('502s with the exact "No corpus chunks discovered" message', async () => {
    (corpusSourceCount as any).mockReturnValue(0);
    const res = await POST(req());
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.backend).toBe('none');
    expect(j.totalChunks).toBe(0);
    // The CI classifier matches on this string — keep it byte-stable.
    expect(j.error).toBe(
      'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd',
    );
    expect(j.remediation).toMatch(/stage-copilot-corpus\.sh/);
  });

  it('does NOT start a background job it could only fail — no polling a doomed run', async () => {
    (corpusSourceCount as any).mockReturnValue(0);
    await POST(req());
    expect(reindex).not.toHaveBeenCalled();
    expect(getReindexJobStatus().state).toBe('idle');
  });
});

describe('POST — the async contract', () => {
  it('returns 202 Accepted with a poll handle instead of blocking', async () => {
    const res = await POST(req());
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.accepted).toBe(true);
    expect(j.state).toBe('running');
    expect(typeof j.jobId).toBe('string');
    expect(j.jobId.length).toBeGreaterThan(0);
    expect(j.poll).toBe('GET /api/help-copilot/reindex');
    await __awaitReindexJob();
  });

  it('answers BEFORE the rebuild finishes (the whole point — no gateway timeout)', async () => {
    let release: (v: typeof OK_RESULT) => void = () => {};
    (reindex as any).mockReturnValue(new Promise((r) => { release = r; }));

    const res = await POST(req());
    expect(res.status).toBe(202);
    // The response is already formed while reindex() is still pending.
    expect(getReindexJobStatus().state).toBe('running');

    release(OK_RESULT);
    await __awaitReindexJob();
    expect(getReindexJobStatus().state).toBe('succeeded');
  });

  it('is idempotent while a run is in flight — no duplicate concurrent rebuild', async () => {
    let release: (v: typeof OK_RESULT) => void = () => {};
    (reindex as any).mockReturnValue(new Promise((r) => { release = r; }));

    const first = await (await POST(req())).json();
    const second = await (await POST(req())).json();

    expect(second.alreadyRunning).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(reindex).toHaveBeenCalledTimes(1);

    release(OK_RESULT);
    await __awaitReindexJob();
  });

  it('a failed run is retryable — the next POST starts a fresh job', async () => {
    (reindex as any).mockResolvedValue({ ...OK_RESULT, ok: false, error: 'upload 503' });
    const first = await (await POST(req())).json();
    await __awaitReindexJob();
    expect(getReindexJobStatus().state).toBe('failed');

    (reindex as any).mockResolvedValue(OK_RESULT);
    const second = await (await POST(req())).json();
    expect(second.alreadyRunning).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    await __awaitReindexJob();
    expect(getReindexJobStatus().state).toBe('succeeded');
  });
});

describe('GET — the poll surface', () => {
  it('reports idle before any run, and the durable freshness alongside', async () => {
    const j = await (await GET(req())).json();
    expect(j.ok).toBe(true);
    expect(j.job.state).toBe('idle');
    expect(j.freshness.state).toBe('fresh');
    expect(j.sourceFiles).toBe(2453);
  });

  it('reports the terminal failure + its reason after a failed run', async () => {
    (reindex as any).mockResolvedValue({ ...OK_RESULT, ok: false, error: 'AI Search upload failed: 403' });
    await POST(req());
    await __awaitReindexJob();
    const j = await (await GET(req())).json();
    expect(j.job.state).toBe('failed');
    expect(j.job.error).toMatch(/403/);
  });

  it('surfaces a stale freshness verdict rather than claiming success', async () => {
    (corpusFreshness as any).mockResolvedValue({
      state: 'stale',
      reason: 'Staged docs have changed since the last index build.',
      backend: 'ai-search',
      indexedAt: null,
      indexedChunkCount: null,
      currentStatFingerprint: 'a',
      indexedStatFingerprint: 'b',
      sourceCommit: null,
      indexedCommit: null,
    });
    const j = await (await GET(req())).json();
    expect(j.ok).toBe(true);
    expect(j.freshness.state).toBe('stale');
  });

  it('still answers when the freshness read throws (poller sees the error, not a hang)', async () => {
    (corpusFreshness as any).mockRejectedValue(new Error('cosmos unreachable'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.freshness).toBeNull();
    expect(j.freshnessError).toMatch(/cosmos unreachable/);
  });
});

describe('reindex-job state machine', () => {
  it('a throwing run is recorded as failed, not left running', async () => {
    __resetReindexJob();
    startReindexJob(async () => { throw new Error('boom'); });
    await __awaitReindexJob();
    const s = getReindexJobStatus();
    expect(s.state).toBe('failed');
    expect(s.error).toMatch(/boom/);
    expect(s.durationMs).not.toBeNull();
  });

  it('ok:false from the rebuild is a FAILURE, not a success', async () => {
    __resetReindexJob();
    startReindexJob(async () => ({ ...OK_RESULT, ok: false, error: 'empty batch' }));
    await __awaitReindexJob();
    expect(getReindexJobStatus().state).toBe('failed');
  });

  it('never exposes the in-flight promise on the status snapshot', async () => {
    __resetReindexJob();
    startReindexJob(async () => OK_RESULT);
    expect(Object.keys(getReindexJobStatus())).not.toContain('promise');
    await __awaitReindexJob();
  });
});
