/**
 * `data-agent-source-candidates` — the picker's candidate lookup (#4092).
 *
 * This is the code the bug lived in. Inside the 2000-line editor it was
 * unreachable by test; as its own hook the three states that were collapsed
 * into one screen are asserted directly:
 *
 *   DEFERRED  no workspaceId yet ⇒ do not query (scoping is mandatory).
 *             THE #4092 SYMPTOM: the route never sent one, so the picker sat
 *             here forever while rendering the same thing an empty workspace
 *             renders.
 *   EMPTY     queried, workspace genuinely holds none.
 *   FAILED    queried, the lookup broke ⇒ say so, and offer a retry. Never
 *             "None" (deploy-integrity.md R7).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

import { clientFetch } from '@/lib/client-fetch';
import { useSourceCandidates, sourceCandidatePlaceholder } from '../data-agent-source-candidates';

const WS = 'ws-casino-analytics';
const ok = (items: any[]) => ({ ok: true, status: 200, json: async () => ({ ok: true, items }) });
const WAREHOUSE = [{ id: '335e10ae', displayName: 'Casino Data Warehouse' }];

beforeEach(() => { vi.clearAllMocks(); });

describe('useSourceCandidates', () => {
  it('lists every item its API returns (acceptance 1)', async () => {
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.options).toHaveLength(1));
    expect(result.current.options[0]).toEqual({ id: '335e10ae', name: 'Casino Data Warehouse' });
    expect(result.current.error).toBeNull();
  });

  it('scopes the query to the workspace and asks for the right item type', async () => {
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result } = renderHook(() => useSourceCandidates(WS, 'kql', 'kql-database'));
    await waitFor(() => expect(clientFetch).toHaveBeenCalled());
    const url = String((clientFetch as any).mock.calls[0][0]);
    expect(url).toContain('types=kql-database');
    expect(url).toContain(`workspaceId=${encodeURIComponent(WS)}`);
    expect(result.current.error).toBeNull();
  });

  it('DEFERS entirely without a workspaceId — the exact #4092 dead end', async () => {
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result } = renderHook(() => useSourceCandidates('', 'warehouse', 'warehouse'));
    await new Promise((r) => setTimeout(r, 30));
    // The endpoint is never called, so the list is empty for a reason that has
    // nothing to do with the workspace's contents.
    expect(clientFetch).not.toHaveBeenCalled();
    expect(result.current.options).toEqual([]);
  });

  it('queries as soon as the workspaceId arrives (the route fix landing)', async () => {
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result, rerender } = renderHook(
      ({ ws }) => useSourceCandidates(ws, 'warehouse', 'warehouse'),
      { initialProps: { ws: '' } },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(clientFetch).not.toHaveBeenCalled();
    rerender({ ws: WS });
    await waitFor(() => expect(result.current.options).toHaveLength(1));
  });

  it('never queries for a source kind with no backing Loom item', async () => {
    (clientFetch as any).mockResolvedValue(ok([]));
    const { result } = renderHook(() => useSourceCandidates(WS, 'microsoft-graph', ''));
    await waitFor(() => expect(result.current.options).toEqual([]));
    expect(clientFetch).not.toHaveBeenCalled();
    // An intentional empty list, NOT a gate — nothing to remediate.
    expect(result.current.error).toBeNull();
  });

  it('reports a non-2xx as a FAILURE, not as an empty workspace (R7)', async () => {
    (clientFetch as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false, error: 'cosmos unavailable' }) });
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.error).toBe('cosmos unavailable'));
    expect(result.current.options).toEqual([]);
  });

  it('reports an `ok:false` 200 body as a failure too', async () => {
    (clientFetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: 'workspace not found' }) });
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.error).toBe('workspace not found'));
  });

  it('reports a thrown transport error', async () => {
    (clientFetch as any).mockRejectedValue(new Error('NetworkError'));
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.error).toBe('NetworkError'));
  });

  it('records a failure in the CACHE, so returning to the type does not re-query', async () => {
    // The discriminating property of seeding `[]` on failure. NOT an
    // infinite-loop test: a plain re-render cannot re-arm the effect either way,
    // because `cache` is one of its deps and an unseeded failure leaves it
    // untouched. What the seed actually buys is that a dependency-changing round
    // trip (type away and back) does not silently re-issue the request — the
    // Retry button is the intended remediation, so a repeat is explicit.
    (clientFetch as any).mockRejectedValueOnce(new Error('boom'));
    const { result, rerender } = renderHook(
      ({ t, it }) => useSourceCandidates(WS, t, it),
      { initialProps: { t: 'warehouse', it: 'warehouse' } },
    );
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect((clientFetch as any).mock.calls.length).toBe(1);

    (clientFetch as any).mockResolvedValue(ok([]));
    rerender({ t: 'lakehouse', it: 'lakehouse' });
    await waitFor(() => expect((clientFetch as any).mock.calls.length).toBe(2));

    rerender({ t: 'warehouse', it: 'warehouse' });
    await new Promise((r) => setTimeout(r, 40));
    // Still 2: the failed type was recorded, not left looking un-attempted.
    expect((clientFetch as any).mock.calls.length).toBe(2);
    expect(result.current.error).toBe('boom');
  });

  it('a plain re-render never re-issues the request after a failure', async () => {
    (clientFetch as any).mockRejectedValue(new Error('boom'));
    const { result, rerender } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    for (let i = 0; i < 5; i++) rerender();
    await new Promise((r) => setTimeout(r, 40));
    expect((clientFetch as any).mock.calls.length).toBe(1);
  });

  it('retries on demand and recovers', async () => {
    (clientFetch as any).mockRejectedValueOnce(new Error('transient'));
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.error).toBe('transient'));

    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    await act(async () => { result.current.reload(); });
    await waitFor(() => expect(result.current.options).toHaveLength(1));
    // The stale reason must be cleared, not left accusing a healthy endpoint.
    expect(result.current.error).toBeNull();
  });

  it('caches per type — switching back does not re-query', async () => {
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result, rerender } = renderHook(
      ({ t, it }) => useSourceCandidates(WS, t, it),
      { initialProps: { t: 'warehouse', it: 'warehouse' } },
    );
    await waitFor(() => expect(result.current.options).toHaveLength(1));
    rerender({ t: 'lakehouse', it: 'lakehouse' });
    await waitFor(() => expect((clientFetch as any).mock.calls.length).toBe(2));
    rerender({ t: 'warehouse', it: 'warehouse' });
    await new Promise((r) => setTimeout(r, 30));
    expect((clientFetch as any).mock.calls.length).toBe(2);
  });

  it('falls back to the id when an item has no displayName', async () => {
    (clientFetch as any).mockResolvedValue(ok([{ id: 'w-1' }]));
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.options).toEqual([{ id: 'w-1', name: 'w-1' }]));
  });

  it('survives a body whose items is not an array', async () => {
    (clientFetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, items: 'nope' }) });
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    // Wait for the request to SETTLE before asserting. `waitFor(options == [])`
    // alone is satisfied by the INITIAL empty state and resolves on its first
    // check — before the promise rejects — so it passed even when the coercion
    // was removed and a TypeError was on its way. A mutation test caught that.
    await waitFor(() => expect(clientFetch).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.options).toEqual([]);
    // The coercion means this is a clean empty list, NOT a swallowed TypeError.
    expect(result.current.error).toBeNull();
  });
});

describe('sourceCandidatePlaceholder — three states, never collapsed', () => {
  it('distinguishes loading / populated / failed / genuinely empty', () => {
    expect(sourceCandidatePlaceholder({ options: [], loading: true, error: null })).toBe('Loading…');
    expect(sourceCandidatePlaceholder({ options: [{ id: 'a', name: 'A' }], loading: false, error: null })).toBe('Select…');
    expect(sourceCandidatePlaceholder({ options: [], loading: false, error: 'HTTP 500' })).toBe("Couldn't load — retry");
    expect(sourceCandidatePlaceholder({ options: [], loading: false, error: null })).toBe('None in this workspace');
  });

  it('never renders the old "None found" for a FAILED lookup', () => {
    const p = sourceCandidatePlaceholder({ options: [], loading: false, error: 'cosmos unavailable' });
    expect(p).not.toMatch(/None/);
  });
});
