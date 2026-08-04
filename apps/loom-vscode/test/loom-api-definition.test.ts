/**
 * LoomApi's definition transport against a MOCKED route (stubbed global fetch) —
 * proves it speaks the real `GET|PUT /api/items/:type/:id/definition` contract:
 * reads the ETag response header, echoes If-Match on PUT, and maps a 412 to a
 * typed DefinitionConflictError.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoomApi, DefinitionConflictError } from '../src/api/loom-client';

interface FakeState {
  definition: unknown;
  etag: string;
}

function installFetch(state: FakeState) {
  const calls: Array<{ method: string; url: string; ifMatch?: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const ifMatch = headers['If-Match'];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, ifMatch, body });

    if (method === 'GET') {
      return new Response(JSON.stringify({ ok: true, definition: state.definition, schemaVersion: 1, etag: state.etag }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: state.etag },
      });
    }
    // PUT
    if (ifMatch && ifMatch !== '*' && ifMatch !== state.etag) {
      return new Response(JSON.stringify({ ok: false, code: 'precondition_failed', error: 'stale', etag: state.etag }), {
        status: 412,
        headers: { 'Content-Type': 'application/json', ETag: state.etag },
      });
    }
    state.definition = body.definition;
    state.etag = `"v${Number(state.etag.replace(/\D/g, '')) + 1}"`;
    return new Response(JSON.stringify({ ok: true, definition: state.definition, schemaVersion: 1, etag: state.etag }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: state.etag },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const api = () => new LoomApi('https://loom.example', { kind: 'pat', value: 'loom_pat_test' });

afterEach(() => vi.unstubAllGlobals());

describe('LoomApi definition transport', () => {
  it('getDefinition reads the ETag header and returns the definition', async () => {
    installFetch({ definition: { state: { a: 1 } }, etag: '"v1"' });
    const p = await api().getDefinition('notebook', 'id-1');
    expect(p.etag).toBe('"v1"');
    expect(p.schemaVersion).toBe(1);
    expect((p.definition as { state: { a: number } }).state.a).toBe(1);
  });

  it('putDefinition echoes If-Match and returns the new ETag', async () => {
    const calls = installFetch({ definition: { state: {} }, etag: '"v1"' });
    const p = await api().putDefinition('notebook', 'id-1', { state: { a: 2 } }, '"v1"');
    expect(p.etag).toBe('"v2"');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.ifMatch).toBe('"v1"');
    expect(put.body).toEqual({ definition: { state: { a: 2 } } });
    expect(put.url).toBe('https://loom.example/api/items/notebook/id-1/definition');
  });

  it('putDefinition maps a 412 to DefinitionConflictError carrying the current ETag', async () => {
    installFetch({ definition: { state: {} }, etag: '"v9"' });
    await expect(api().putDefinition('notebook', 'id-1', { state: {} }, '"stale"')).rejects.toBeInstanceOf(
      DefinitionConflictError,
    );
    try {
      await api().putDefinition('notebook', 'id-1', { state: {} }, '"stale"');
    } catch (e) {
      expect((e as DefinitionConflictError).currentEtag).toBe('"v9"');
    }
  });
});
