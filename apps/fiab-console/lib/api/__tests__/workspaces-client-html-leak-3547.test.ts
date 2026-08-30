/**
 * #3547 — the raw HTML 504 page that reached the item-creation dialog.
 *
 * LIVE REPRO, 2026-08-15 (V&V sprint, workspace `uat-apps-1786813692048`):
 * creating a `sql-server-2025-vector-index` item hit a real Front Door /
 * Container Apps ingress 504, and the "Name your…" dialog printed
 *
 *   504 : <!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN' …>
 *   <html …><style type='text/css'> body { font-family: Arial; … } …
 *
 * verbatim into its error MessageBar. `new-item-dialog.tsx` does
 * `setError((e as Error).message)`, so whatever `lib/api/workspaces.ts` throws IS
 * what the user reads — and that module's own `fetchJson` did
 * `` `${res.status} ${res.statusText}: ${await res.text()}` ``.
 *
 * `lib/client-fetch.ts` has carried the warning against exactly this since it
 * was written, plus the fix (`describeNonJsonResponse`); this module simply had
 * its own transport and used neither.
 *
 * WHAT THESE SPECS PIN. Not "the message changed" — that a plausible edge body
 * can no longer reach a caller. Each failure shape (504/502/503/generic, a 2xx
 * interstitial, an unreadable body) is fed as REAL BYTES through the real
 * `fetchJson`, and the thrown message is checked for HTML markers. The last
 * describe is the counterfactual: the old concatenation, restored locally,
 * leaks every one of them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/client-fetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-fetch')>('@/lib/client-fetch');
  return { ...actual, clientFetch: vi.fn() };
});

import { clientFetch } from '@/lib/client-fetch';
import { listWorkspaces, createItem, getItem, listItems, deleteWorkspace } from '../workspaces';

/**
 * The Front Door / Container Apps ingress interstitial, in the shape the issue
 * recorded it. Kept as bytes rather than a marker string so the assertions are
 * about a real body and not about a token this file invented.
 */
const EDGE_HTML =
  "<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN' "
  + "'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'>\n"
  + "<html xmlns='http://www.w3.org/1999/xhtml'><head>"
  + "<meta content='text/html; charset=utf-8' http-equiv='content-type' />"
  + "<style type='text/css'> body { font-family: Arial; margin-left: 40px; } </style>"
  + '<title>Service unavailable</title></head>'
  + "<body><div id='content'><div id='message'></span></div></div></body></html>";

/** Markers that must never survive into anything a MessageBar renders. */
const HTML_MARKERS = [/<!DOCTYPE/i, /<html/i, /<style/i, /font-family/i, /Service unavailable/i, /<body/i];

function stub(status: number, body: string, contentType = 'text/html') {
  (clientFetch as any).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 504 ? 'Gateway Timeout' : 'Error',
    text: async () => body,
    json: async () => JSON.parse(body),
    headers: { get: () => contentType },
  });
}

async function messageFrom(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the call to reject, but it resolved');
}

beforeEach(() => { vi.clearAllMocks(); });

describe('#3547 — an edge HTML error page never reaches the caller', () => {
  for (const status of [504, 502, 503, 500, 404]) {
    it(`HTTP ${status} with an HTML body throws a mapped message, not the markup`, async () => {
      stub(status, EDGE_HTML);
      const msg = await messageFrom(() => createItem('ws-1', { itemType: 'sql-server-2025-vector-index', displayName: 'vec' }));
      for (const marker of HTML_MARKERS) expect(msg).not.toMatch(marker);
      // Honest and specific: the status is named, and nothing else is claimed.
      expect(msg).toContain(String(status));
      expect(msg).toContain('workspaces service');
    });
  }

  it('maps 504 to the GATEWAY-TIMEOUT sentence, not a generic one', async () => {
    // Discriminating: a fix that returned one constant string for every status
    // would pass the loop above.
    stub(504, EDGE_HTML);
    const msg = await messageFrom(() => listWorkspaces());
    expect(msg).toMatch(/gateway timed out/i);
    // R7 — it must not assert the request FAILED; a 504 does not establish that.
    expect(msg).toMatch(/may still be completing/i);
  });

  it('maps 502 to the UNREACHABLE sentence', async () => {
    stub(502, EDGE_HTML);
    const msg = await messageFrom(() => listItems('ws-1'));
    expect(msg).toMatch(/unreachable through the gateway/i);
    expect(msg).not.toMatch(/gateway timed out/i);
  });

  it('a 2xx carrying an interstitial is also mapped — the same leak, other door', async () => {
    // The edge can answer 200 with a page. `res.json()` would then throw a
    // SyntaxError whose message quotes the HTML, and `new-item-dialog` renders
    // `e.message` unchanged.
    stub(200, EDGE_HTML);
    const msg = await messageFrom(() => getItem('lakehouse', 'itm-1'));
    for (const marker of HTML_MARKERS) expect(msg).not.toMatch(marker);
    expect(msg).toMatch(/non-JSON response/i);
  });

  it('an unreadable body still yields a usable message, not an empty one', async () => {
    (clientFetch as any).mockResolvedValue({
      ok: false, status: 503, statusText: 'Service Unavailable',
      text: async () => { throw new Error('body stream already read'); },
      json: async () => { throw new Error('body stream already read'); },
    });
    const msg = await messageFrom(() => deleteWorkspace('ws-1'));
    expect(msg).toMatch(/temporarily unavailable/i);
    expect(msg.length).toBeGreaterThan(20);
  });
});

describe("#3547 — the BFF's own JSON reason is still preferred", () => {
  it('surfaces `error` from a JSON envelope rather than the generic gateway copy', async () => {
    // The regression risk of the fix: swallowing a real, actionable reason and
    // replacing it with boilerplate would be a different R7 failure.
    stub(409, JSON.stringify({ ok: false, error: 'A workspace with that name already exists' }), 'application/json');
    const msg = await messageFrom(() => createItem('ws-1', { itemType: 'lakehouse', displayName: 'bronze' }));
    expect(msg).toContain('A workspace with that name already exists');
    expect(msg).toContain('409');
    expect(msg).not.toMatch(/non-JSON response/i);
  });

  it('falls back to `message` when the envelope uses that key', async () => {
    stub(400, JSON.stringify({ message: 'displayName is required' }), 'application/json');
    const msg = await messageFrom(() => createItem('ws-1', { itemType: 'lakehouse', displayName: '' }));
    expect(msg).toContain('displayName is required');
  });

  it('a JSON envelope with no reason still gets the mapped copy, never "{}"', async () => {
    stub(500, JSON.stringify({ ok: false }), 'application/json');
    const msg = await messageFrom(() => listWorkspaces());
    expect(msg).not.toContain('{');
    expect(msg).toMatch(/non-JSON response|unexpected/i);
  });
});

describe('#3547 COUNTERFACTUAL: the shape that shipped leaks every one of these', () => {
  it('the removed concatenation puts the raw markup in the message', async () => {
    // The pre-fix body, restored verbatim. If this did NOT leak, the assertions
    // above would be measuring nothing about the change.
    const legacy = async (res: { ok: boolean; status: number; statusText: string; text: () => Promise<string> }) => {
      if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch { /* ignore */ }
        throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
      }
    };
    const res = { ok: false, status: 504, statusText: '', text: async () => EDGE_HTML };
    let leaked = '';
    try { await legacy(res); } catch (e) { leaked = (e as Error).message; }
    expect(leaked).toMatch(/<!DOCTYPE/);
    expect(leaked).toMatch(/font-family/);
    // …and it reproduces the exact prefix the operator saw in the dialog.
    expect(leaked.startsWith('504 : <!DOCTYPE')).toBe(true);
  });
});
