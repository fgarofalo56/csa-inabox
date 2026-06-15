/**
 * Unit tests for apimFetchJson — the safe-fetch helper the APIM admin panes use
 * so a non-JSON body (Next.js HTML 404/500 page) or an honest 503 config-gate
 * surfaces as a readable Error (for a Fluent MessageBar) instead of crashing the
 * pane with "Unexpected token '<' … is not valid JSON".
 *
 * This is the regression guard for the apim-apis / apim-products / apim-policies
 * panes that were migrated off raw `fetch(url).then(r => r.json())`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apimFetchJson } from '../apim-pane-fetch';

function mockFetch(status: number, body: string, ok = status >= 200 && status < 300) {
  const res = {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async () => res));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('apimFetchJson', () => {
  it('returns the parsed payload on a JSON 200', async () => {
    mockFetch(200, JSON.stringify({ ok: true, apis: [{ id: 'a' }] }));
    const d = await apimFetchJson('/api/items/apim-api');
    expect(d.ok).toBe(true);
    expect((d.apis as unknown[]).length).toBe(1);
  });

  it('throws a readable error (no parse crash) on an HTML 404 page', async () => {
    mockFetch(404, '<!DOCTYPE html><html><body>404</body></html>', false);
    await expect(apimFetchJson('/api/items/apim-api')).rejects.toThrow(/HTTP 404|non-JSON/);
  });

  it('throws a readable error on an HTML 500 page', async () => {
    mockFetch(500, '<html>Internal Server Error</html>', false);
    await expect(apimFetchJson('/api/items/apim-product')).rejects.toThrow(/HTTP 500|non-JSON/);
  });

  it('surfaces the honest 503 not_configured gate naming the missing env var', async () => {
    mockFetch(503, JSON.stringify({ ok: false, code: 'not_configured', missing: 'LOOM_SUBSCRIPTION_ID', error: 'API Management is not configured in this deployment (set LOOM_SUBSCRIPTION_ID).' }), false);
    await expect(apimFetchJson('/api/items/apim-api')).rejects.toThrow(/LOOM_SUBSCRIPTION_ID/);
  });

  it('surfaces a structured {ok:false,error} as the error message', async () => {
    mockFetch(502, JSON.stringify({ ok: false, error: 'APIM 403: Forbidden' }), false);
    await expect(apimFetchJson('/api/items/apim-policy?scope=service')).rejects.toThrow(/Forbidden/);
  });

  it('wraps a network error rather than letting it propagate raw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(apimFetchJson('/api/items/apim-api')).rejects.toThrow(/Network error.*ECONNREFUSED/);
  });
});
