/**
 * Contract test for safePipelineJson — the content-type guard that fixes the
 * crash where the missing ADF /runs route returned a 404 *HTML* page and
 * `res.json()` threw "Unexpected token <".
 */
import { describe, it, expect } from 'vitest';
import { safePipelineJson } from '../pipeline-fetch';

describe('safePipelineJson', () => {
  it('returns ok:false on an HTML 404 page instead of throwing', async () => {
    const res = new Response('<!DOCTYPE html><html><body>404</body></html>', {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const out = await safePipelineJson(res);
    expect(out.ok).toBe(false);
    expect(out.data).toBeNull();
    expect(out.error).toMatch(/Expected JSON/);
    expect(out.status).toBe(404);
  });

  it('parses a JSON ok:true body', async () => {
    const res = new Response(JSON.stringify({ ok: true, runs: [{ runId: 'r1' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const out = await safePipelineJson(res);
    expect(out.ok).toBe(true);
    expect(out.data?.runs?.[0]?.runId).toBe('r1');
  });

  it('surfaces a JSON ok:false error as not-ok', async () => {
    const res = new Response(JSON.stringify({ ok: false, code: 'unbound', error: 'not bound' }), {
      status: 412, headers: { 'content-type': 'application/json' },
    });
    const out = await safePipelineJson(res);
    expect(out.ok).toBe(false);
    expect(out.data?.code).toBe('unbound');
    expect(out.error).toBe('not bound');
  });

  it('does not throw on malformed JSON with a json content-type', async () => {
    const res = new Response('{ not valid json', {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const out = await safePipelineJson(res);
    expect(out.ok).toBe(false);
    expect(out.data).toBeNull();
  });
});
