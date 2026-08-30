/**
 * `data-agent-source-candidates` — the picker's candidate lookup (#4092).
 *
 * This is the code the bug lived in. Inside the 2000-line editor it was
 * unreachable by test; as its own hook the states that were collapsed
 * into one screen are asserted directly:
 *
 *   DEFERRED  no workspaceId yet ⇒ do not query (scoping is mandatory).
 *             THE #4092 SYMPTOM: the route never sent one, so the picker sat
 *             here forever while rendering the same thing an empty workspace
 *             renders. This state must be REPRESENTABLE in the placeholder's
 *             input — the first repair listed it here and then shipped a
 *             function that could not take it, so this file could name the
 *             state but not supply it, and it silently rendered as EMPTY.
 *   EMPTY     queried, workspace genuinely holds none.
 *   FAILED    queried, the lookup broke ⇒ say so, and offer a retry. Never
 *             "None" (deploy-integrity.md R7).
 *
 * The CONSUMER's adoption of all three is pinned separately, in
 * `data-agent-editor-source-picker.test.tsx` — these specs prove the functions
 * behave, that one proves the editor still uses them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

import { clientFetch } from '@/lib/client-fetch';
import {
  useSourceCandidates, sourceCandidatePlaceholder, sourceTypeBindsLoomItem,
} from '../data-agent-source-candidates';

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
    // …and the state SAYS so. Without this flag the caller receives a state
    // indistinguishable from an empty workspace and renders it as one.
    expect(result.current.deferred).toBe(true);
  });

  it('stops deferring the moment a workspaceId exists', async () => {
    (clientFetch as any).mockResolvedValue(ok([]));
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(clientFetch).toHaveBeenCalled());
    // Discriminating half of the flag: a constant `true` would pass the spec
    // above. An EMPTY answer from a REAL query is not deferred — it is the one
    // state in which "None in this workspace" is a true statement.
    expect(result.current.deferred).toBe(false);
    expect(result.current.options).toEqual([]);
    expect(result.current.error).toBeNull();
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
    // …and the state SAYS so (#4102). Without this the caller receives a state
    // indistinguishable from an empty workspace — which is exactly what
    // `metric-view` rendered.
    expect(result.current.unbound).toBe(true);
  });

  it('reports UNBOUND for metric-view, the type that had no picker branch (#4102)', async () => {
    // The live defect. `metric-view` declares `itemType: ''` exactly as
    // `microsoft-graph` does, but the editor's "no item picker" branch was keyed
    // on the NAME, so this kind got a dropdown that could never populate.
    (clientFetch as any).mockResolvedValue(ok([]));
    const { result } = renderHook(() => useSourceCandidates(WS, 'metric-view', ''));
    await waitFor(() => expect(result.current.options).toEqual([]));
    expect(clientFetch).not.toHaveBeenCalled();
    expect(result.current.unbound).toBe(true);
    // Discriminating half: with a workspace present, `deferred` is FALSE — so
    // before `unbound` existed this state was indistinguishable from "queried,
    // found nothing", and rendered as it.
    expect(result.current.deferred).toBe(false);
  });

  it('a kind that DOES bind an item is not unbound', async () => {
    // A constant `true` would pass the two specs above.
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result } = renderHook(() => useSourceCandidates(WS, 'warehouse', 'warehouse'));
    await waitFor(() => expect(result.current.options).toHaveLength(1));
    expect(result.current.unbound).toBe(false);
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

describe('sourceCandidatePlaceholder — five states, never collapsed', () => {
  it('distinguishes loading / populated / failed / unbound / deferred / genuinely empty', () => {
    expect(sourceCandidatePlaceholder({ options: [], loading: true, error: null, deferred: false, unbound: false })).toBe('Loading…');
    expect(sourceCandidatePlaceholder({ options: [{ id: 'a', name: 'A' }], loading: false, error: null, deferred: false, unbound: false })).toBe('Select…');
    expect(sourceCandidatePlaceholder({ options: [], loading: false, error: 'HTTP 500', deferred: false, unbound: false })).toBe("Couldn't load — retry");
    expect(sourceCandidatePlaceholder({ options: [], loading: false, error: null, deferred: false, unbound: true })).toBe('No item to pick — configured below');
    expect(sourceCandidatePlaceholder({ options: [], loading: false, error: null, deferred: true, unbound: false })).toBe('Waiting for the workspace…');
    expect(sourceCandidatePlaceholder({ options: [], loading: false, error: null, deferred: false, unbound: false })).toBe('None in this workspace');
  });

  it('never renders the old "None found" for a FAILED lookup', () => {
    const p = sourceCandidatePlaceholder({ options: [], loading: false, error: 'cosmos unavailable', deferred: false, unbound: false });
    expect(p).not.toMatch(/None/);
  });

  it('never claims the workspace is EMPTY for a lookup that never ran (R7)', () => {
    // The state the first repair could not express, and therefore could not
    // assert on. "None in this workspace" is a positive claim about the
    // workspace's contents; DEFERRED means nothing was ever asked, so the claim
    // is not merely unproven, it is manufactured — a STRONGER falsehood than
    // the 'None found' this module replaced.
    const p = sourceCandidatePlaceholder({ options: [], loading: false, error: null, deferred: true, unbound: false });
    expect(p).not.toBe('None in this workspace');
    expect(p).not.toMatch(/None/);
    expect(p).not.toMatch(/in this workspace/); // no claim about the contents at all
  });

  it('never claims the workspace is EMPTY for a kind that binds no item (#4102)', () => {
    // Same R7 error by a third route. There is no item TYPE to look up, so the
    // lookup is not deferred — it will never happen — and any sentence about
    // "this workspace" is manufactured.
    const p = sourceCandidatePlaceholder({ options: [], loading: false, error: null, deferred: false, unbound: true });
    expect(p).not.toBe('None in this workspace');
    expect(p).not.toMatch(/None in/);
    expect(p).not.toMatch(/in this workspace/);
    // …and it must not borrow the DEFERRED sentence either: that promises a wait
    // that never ends.
    expect(p).not.toMatch(/Waiting for the workspace/);
  });

  it('UNBOUND wins over DEFERRED — an unbound kind on /new is still unbound', () => {
    // Both flags are true while a `metric-view` picker sits on an unsaved item.
    // The older, more specific truth is that there is no item type at all.
    const p = sourceCandidatePlaceholder({ options: [], loading: false, error: null, deferred: true, unbound: true });
    expect(p).toBe('No item to pick — configured below');
  });

  it('takes DEFERRED straight from the hook, so the wiring is pinned too', async () => {
    // Guards the JOIN: a placeholder that reads `deferred` is worth nothing if
    // the hook never sets it. Feed the real hook's real output to the real
    // placeholder for the exact case the editor hits while an item is loading.
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result } = renderHook(() => useSourceCandidates('', 'warehouse', 'warehouse'));
    await new Promise((r) => setTimeout(r, 30));
    expect(sourceCandidatePlaceholder(result.current)).not.toBe('None in this workspace');
  });

  it('takes UNBOUND straight from the hook too (#4102 join)', async () => {
    // The join that was missing. `metric-view` + a REAL workspace is the exact
    // live state: the hook must set `unbound`, and the placeholder must use it.
    (clientFetch as any).mockResolvedValue(ok(WAREHOUSE));
    const { result } = renderHook(() => useSourceCandidates(WS, 'metric-view', ''));
    await waitFor(() => expect(result.current.options).toEqual([]));
    expect(sourceCandidatePlaceholder(result.current)).toBe('No item to pick — configured below');
  });
});

describe('sourceTypeBindsLoomItem — the SHAPE, not a list of names (#4102)', () => {
  it('is false for every kind declared with an empty itemType', () => {
    expect(sourceTypeBindsLoomItem('')).toBe(false);
    // Whitespace is the same declaration with a typo, and must not silently
    // become a real item type that nothing can ever list.
    expect(sourceTypeBindsLoomItem('   ')).toBe(false);
  });

  it('is true for a real Loom item type', () => {
    expect(sourceTypeBindsLoomItem('warehouse')).toBe(true);
    expect(sourceTypeBindsLoomItem('kql-database')).toBe(true);
    expect(sourceTypeBindsLoomItem('loom-app-runtime')).toBe(true);
  });
});
