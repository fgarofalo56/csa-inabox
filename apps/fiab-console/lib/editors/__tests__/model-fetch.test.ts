/**
 * Contract test for safeModelJson — the content-type guard that fixes the
 * reported ml-model crash where a 404 HTML page (or an unbound item) made
 * `res.json()` throw "Unexpected token <" and blanked the editor.
 */
import { describe, it, expect } from 'vitest';
import { safeModelJson } from '../model-fetch';

describe('safeModelJson', () => {
  it('returns ok:false on an HTML 404 page instead of throwing', async () => {
    const res = new Response('<!DOCTYPE html><html><body>404</body></html>', {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const out = await safeModelJson(res);
    expect(out.ok).toBe(false);
    expect(out.data).toBeNull();
    expect(out.error).toMatch(/Expected JSON/);
    expect(out.status).toBe(404);
  });

  it('parses a JSON ok:true model body', async () => {
    const res = new Response(JSON.stringify({ ok: true, model: { name: 'fraud' }, versions: [{ version: '1' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const out = await safeModelJson(res);
    expect(out.ok).toBe(true);
    expect(out.data?.model?.name).toBe('fraud');
  });

  it('surfaces a 412 unbound code without throwing', async () => {
    const res = new Response(JSON.stringify({ ok: false, code: 'unbound', error: 'not bound' }), {
      status: 412, headers: { 'content-type': 'application/json' },
    });
    const out = await safeModelJson(res);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('unbound');
    expect(out.error).toBe('not bound');
  });

  it('does not throw on malformed JSON with a json content-type', async () => {
    const res = new Response('{ not valid json', {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const out = await safeModelJson(res);
    expect(out.ok).toBe(false);
    expect(out.data).toBeNull();
  });
});
