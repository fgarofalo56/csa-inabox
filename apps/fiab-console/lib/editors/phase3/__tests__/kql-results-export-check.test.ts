/**
 * #4456 — export-check must FAIL CLOSED on anything that is not a genuine
 * `{ blocked: false }` 2xx body.
 *
 * Before this fix, `evaluateExportCheck` parsed `j?.blocked` off ANY response
 * it could call `.json()` on, including a 404/401/403/5xx. `!!undefined` is
 * `false`, so every one of those refusals read as "not blocked" and the
 * sensitivity-label export protection was silently skipped — exactly the
 * population most likely to be refused (a read-only Viewer hitting the
 * route's old write-scoped 404).
 *
 * Each spec below names the input that would make it fail if the fail-closed
 * behaviour regressed back to the old `!!j?.blocked` parse.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/client-fetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/client-fetch')>('@/lib/client-fetch');
  return { ...actual, clientFetch: vi.fn() };
});

import { clientFetch } from '@/lib/client-fetch';
import { evaluateExportCheck } from '../kql-results';

function stubResponse(status: number, body: unknown) {
  (clientFetch as any).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('evaluateExportCheck (#4456 fail-closed)', () => {
  it('blocks on a 404 (write-scoped refusal) body shaped { blocked: false } — the exact old-regime input', async () => {
    // Pre-fix this returned `{ blocked: false }` because `!!j?.blocked` reads
    // the same whether the key is genuinely false or simply never asserted by
    // a refusal body. A route that returns `blocked:false` on refusal is the
    // one input the old parse could not distinguish from a real permit, so it
    // is the one this spec feeds in.
    stubResponse(404, { blocked: false });
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(true);
  });

  it('blocks on a 401 with no JSON body at all', async () => {
    stubResponse(401, {});
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(true);
  });

  it('blocks on a 5xx', async () => {
    stubResponse(503, { blocked: false });
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(true);
  });

  it('blocks on a network/fetch error (clientFetch rejects)', async () => {
    (clientFetch as any).mockRejectedValue(new Error('fetch failed'));
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(true);
  });

  it('blocks on a 2xx with an unparseable body (blocked is not a boolean)', async () => {
    (clientFetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('invalid json'); },
    });
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(true);
  });

  // POSITIVE CONTROL — proves the fix is fail-CLOSED, not fail-ALWAYS. A
  // genuine 2xx `{ blocked: false }` (an unlabeled item, or a labeled one the
  // caller's rights permit) must still let the export proceed.
  it('permits the export on a genuine 2xx { blocked: false }', async () => {
    stubResponse(200, { blocked: false });
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(false);
  });

  // Second positive-shaped control: a genuine 2xx { blocked: true } (a
  // protected label the rights check refused) must still block and must
  // carry the server's reason through, not the generic fail-closed message.
  it('blocks and carries the reason on a genuine 2xx { blocked: true, reason }', async () => {
    stubResponse(200, { blocked: true, reason: 'Protected by sensitivity label X' });
    const result = await evaluateExportCheck('kql-database', 'item-1');
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Protected by sensitivity label X');
  });
});
