/**
 * Test shortcut — the hook must SHOW a refused Test.
 *
 * The Test route answers a credential refusal with `403 { ok:false, error }`
 * and leaves the row unchanged (no status write). `parseJsonOrError` returns
 * that body as-is (it does not throw), so a hook that discards the parsed body
 * shows nothing: the row stays as it was and `shortcutsError` stays null.
 *
 * WHAT BREAKS IT: `testShortcut` ignoring the parsed body (the pre-change
 * `await parseJsonOrError(...)` with no `j.ok` check) — `shortcutsError` is then
 * null after a refusal. Setting the error BEFORE `loadShortcuts()` also breaks
 * it, because `loadShortcuts` clears `shortcutsError`.
 *
 * Runs in jsdom (`*.test.tsx`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

import { clientFetch } from '@/lib/client-fetch';
import { useLakehouseShortcuts } from '../hooks/use-lakehouse-shortcuts';

const REFUSAL = 'This credential was saved by another user. Re-add the provider under Data shares, then use Test.';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = { id: 'lh1:files::ext', lakehouseId: 'lh1', name: 'ext', status: 'ok' } as any;

function mountHook() {
  return renderHook(() => useLakehouseShortcuts({
    shortcutLakehouseId: 'lh1', schemasEnabled: false, containers: null, schemas: null,
    bundleShortcuts: [], loadSchemas: async () => {}, confirm: async () => true,
    setSqlText: () => {}, setTab: () => {}, tab: 'files',
  }));
}

/** Route the hook's two calls: the Test POST gets `testRes`, the list GET gets one row. */
function serve(testRes: () => Response) {
  (clientFetch as any).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/lakehouse/shortcuts/test')) return testRes();
    if (url.startsWith('/api/lakehouse/shortcuts?')) return json(200, { ok: true, data: [row] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const listCalls = () => (clientFetch as any).mock.calls.filter((c: any[]) => String(c[0]).startsWith('/api/lakehouse/shortcuts?')).length;

describe('useLakehouseShortcuts — testShortcut', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the refusal text from a 403 and still reloads the list', async () => {
    serve(() => json(403, { ok: false, code: 'shortcut_secret_owner', error: REFUSAL }));
    const { result } = mountHook();
    await act(async () => { await result.current.testShortcut(row); });
    expect(result.current.shortcutsError).toBe(REFUSAL);
    expect(listCalls()).toBe(1);
    expect(result.current.shortcuts).toEqual([row]);
  });

  it('falls back to the HTTP status when the refusal carries no error text', async () => {
    // Breaks if the fallback is dropped: shortcutsError would be undefined/null.
    serve(() => json(403, { ok: false }));
    const { result } = mountHook();
    await act(async () => { await result.current.testShortcut(row); });
    expect(result.current.shortcutsError).toBe('Test shortcut failed (HTTP 403).');
  });

  it('a successful Test shows no error and reloads the list', async () => {
    // Positive twin: breaks if the hook reports an error on { ok: true }.
    serve(() => json(200, { ok: true, data: { ...row, status: 'ok' } }));
    const { result } = mountHook();
    await act(async () => { await result.current.testShortcut(row); });
    expect(result.current.shortcutsError).toBeNull();
    expect(listCalls()).toBe(1);
  });
});
