/**
 * useItemDocState — the data-loss guard, tested directly (FINISHLINE C19).
 *
 * The editor specs (fusion-sheet / notepad / analysis-board) prove the guard
 * through the UI. These prove the PRIMITIVE, because the primitive is the
 * chokepoint every adopter relies on: if `save()` can be talked into PATCHing
 * over an unread document, every adopter loses data at once.
 *
 * The case that matters most, and the one a naive "is the state empty?" check
 * gets WRONG, is `absent` vs `error`:
 *   - `absent` — the read SUCCEEDED and the record simply has no state yet.
 *     Saving over nothing destroys nothing, so it must be allowed.
 *   - `error`  — the read FAILED; the stored content is UNKNOWN. Saving would
 *     destroy it, so it must be refused.
 * Both render an empty editor. Only an EXPLICIT status can tell them apart,
 * which is why the hook never infers one from the shape of the state.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import {
  useItemDocState, canPersistItemState, SAVE_REFUSED_UNLOADED,
  type ItemLoadStatus,
} from '../use-item-doc-state';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }

function installFetch(onRead: () => Response | never, onWrite?: () => Response) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    if (init?.method === 'PATCH') {
      return (onWrite ? onWrite() : new Response(JSON.stringify({ ok: true }), { status: 200 })) as any;
    }
    return onRead() as any;
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function render(id = 'fixture') {
  return renderHook(() =>
    useItemDocState<{ cells: Record<string, string> }>({
      slug: 'fusion-sheet',
      id,
      empty: { cells: {} },
      select: (d) => {
        const c = (d as any)?.state?.cells;
        return c ? { cells: c } : undefined;
      },
      toPatchBody: (s) => ({ state: { cells: s.cells } }),
    }),
  );
}

describe('canPersistItemState — the rule itself', () => {
  const table: Array<[ItemLoadStatus, boolean]> = [
    ['new', true],
    ['loaded', true],
    ['absent', true],
    ['loading', false],
    ['error', false],
  ];
  for (const [status, allowed] of table) {
    it(`${status} → ${allowed ? 'persistable' : 'REFUSED'}`, () => {
      expect(canPersistItemState(status)).toBe(allowed);
    });
  }
});

describe('useItemDocState — load lifecycle is explicit, never inferred', () => {
  it('a successful read with state → loaded', async () => {
    installFetch(() => json({ state: { cells: { A1: '1' } } }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('loaded'));
    expect(result.current.state.cells).toEqual({ A1: '1' });
    expect(result.current.canSave).toBe(true);
  });

  it('a successful read with NO state → absent (still savable — nothing to destroy)', async () => {
    installFetch(() => json({ id: 'fixture' }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('absent'));
    expect(result.current.canSave).toBe(true);
    expect(result.current.load.error).toBeNull();
  });

  it('a 500 → error, with the OBSERVED status in the message (R7)', async () => {
    installFetch(() => new Response('boom', { status: 500 }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));
    expect(result.current.load.error).toContain('HTTP 500');
    expect(result.current.canSave).toBe(false);
  });

  it('a 200 {ok:false} envelope → error, carrying the server\'s own reason', async () => {
    installFetch(() => json({ ok: false, error: 'Cosmos partition unavailable' }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));
    expect(result.current.load.error).toContain('Cosmos partition unavailable');
    expect(result.current.canSave).toBe(false);
  });

  it('a transport rejection → error naming the transport failure, not an invented cause', async () => {
    installFetch(() => { throw new TypeError('Failed to fetch'); });
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));
    expect(result.current.load.error).toContain('Failed to fetch');
  });

  it('a 200 whose body is not JSON → error, and says THAT rather than guessing', async () => {
    installFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));
    expect(result.current.load.error).toMatch(/not valid JSON/);
  });

  it("id 'new' skips the read entirely and is immediately savable", async () => {
    const calls = installFetch(() => json({}));
    const { result } = render('new');
    await waitFor(() => expect(result.current.load.status).toBe('new'));
    expect(result.current.canSave).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe('useItemDocState — THE DATA-LOSS GUARD', () => {
  it('save() after a failed load issues NO request and reports the refusal', async () => {
    const calls = installFetch(() => new Response('boom', { status: 500 }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));

    const before = calls.length;
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.save(); });

    expect(ok).toBe(false);
    // The critical assertion: the PATCH was never even attempted, so the stored
    // document cannot have been touched.
    expect(calls.slice(before).some((c) => c.init?.method === 'PATCH')).toBe(false);
    expect(result.current.saveMessage).toBe(SAVE_REFUSED_UNLOADED);
    expect(result.current.saveFailed).toBe(true);
  });

  it('save() DURING the load is refused too — an in-flight read is not a verdict', async () => {
    // Never resolve the read: status stays 'loading'.
    const calls = installFetch(() => new Promise(() => {}) as any);
    const { result } = render();
    expect(result.current.load.status).toBe('loading');

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.save(); });
    expect(ok).toBe(false);
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('editing after a failed load STILL cannot save — the guard is on the load, not on dirtiness', async () => {
    // This is the exact harm: the user sees a blank sheet, types, hits Save.
    const calls = installFetch(() => new Response('boom', { status: 500 }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));

    act(() => { result.current.setState({ cells: { A1: 'typed after the failure' } }); });
    await act(async () => { await result.current.save(); });

    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('Retry recovers: a successful re-read flips to loaded and re-enables save', async () => {
    let attempt = 0;
    installFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response('boom', { status: 500 })
        : json({ state: { cells: { A1: '42' } } });
    });
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('error'));

    act(() => { result.current.load.retry(); });
    await waitFor(() => expect(result.current.load.status).toBe('loaded'));
    expect(result.current.state.cells).toEqual({ A1: '42' });
    expect(result.current.canSave).toBe(true);
  });

  it('a loaded document saves normally, with the declared PATCH body', async () => {
    const calls = installFetch(() => json({ state: { cells: { A1: '7' } } }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('loaded'));

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.save(); });
    expect(ok).toBe(true);

    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch!.url).toContain('/api/items/fusion-sheet/');
    expect(JSON.parse(String(patch!.init!.body))).toEqual({ state: { cells: { A1: '7' } } });
    expect(result.current.saveMessage).toBe('Saved.');
  });

  it('a REJECTED save is reported as failed, not silently swallowed', async () => {
    installFetch(() => json({ state: { cells: { A1: '7' } } }), () => new Response('nope', { status: 500 }));
    const { result } = render();
    await waitFor(() => expect(result.current.load.status).toBe('loaded'));

    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.save(); });
    expect(ok).toBe(false);
    expect(result.current.saveMessage).toBe('Save failed.');
    expect(result.current.saveFailed).toBe(true);
  });
});
