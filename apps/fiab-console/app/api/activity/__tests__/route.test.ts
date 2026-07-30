/**
 * /api/activity — the /governance + /monitor feed.
 *
 * REGRESSION SPEC (round-3 adversarial review of LU-3, PR #2611).
 *
 * `_auditLog` is a SHARED Cosmos container. Besides per-item rows it holds whole
 * TRAILS that are not items: LU-3 writes one `itemType: 'loom-unity'` row per
 * Unity Catalog REST call, and LU-3's remediation extended that from the OSS/Gov
 * path to the Commercial DEFAULT path (`dbxFetch`) — where nearly all catalog
 * traffic lives.
 *
 * The route pulled `SELECT TOP @n … FROM c ORDER BY c._ts DESC` over the WHOLE
 * container and only then filtered to the caller's items in JS. Unity rows carry
 * an `itemId` that is a securable FQN or a `unity:<op>:<date>` partition bucket,
 * so they never match an item — they just consumed the entire page budget and
 * were thrown away, and the feeds rendered EMPTY on any estate that browses the
 * catalog.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auditQuery = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'tenant-1', upn: 'alice@contoso.com' } }),
}));

const container = (query: (spec: unknown) => unknown) => ({
  items: { query: (spec: unknown) => ({ fetchAll: async () => query(spec) }) },
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => container(() => ({ resources: [{ id: 'ws1', name: 'W' }] })),
  itemsContainer: async () => container(() => ({
    resources: [
      { id: 'item-1', itemType: 'lakehouse', workspaceId: 'ws1', displayName: 'Bronze' },
      { id: 'item-2', itemType: 'notebook', workspaceId: 'ws1', displayName: 'NB' },
    ],
  })),
  auditLogContainer: async () => container((spec) => auditQuery(spec)),
  commentsContainer: async () => container(() => ({ resources: [] })),
  sharesContainer: async () => container(() => ({ resources: [] })),
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';

beforeEach(() => {
  auditQuery.mockReset();
  auditQuery.mockResolvedValue({ resources: [] });
});

function req() {
  return new NextRequest('http://localhost/api/activity?n=5');
}
/** `withSession` handlers take `(req, ctx)`; this route declares no params. */
const call = () => GET(req(), undefined as never);

describe('/api/activity — the audit page budget must not be eaten by non-item trails', () => {
  it('scopes the audit query to the caller-owned itemTypes IN THE QUERY, not in JS', async () => {
    await call();
    const spec = auditQuery.mock.calls[0][0] as { query: string; parameters: Array<{ name: string; value: unknown }> };
    // The predicate must be pushed DOWN. Filtering after `SELECT TOP @n` is what
    // let `loom-unity` rows fill the page and blank the feed.
    expect(spec.query).toMatch(/ARRAY_CONTAINS\(@types, c\.itemType\)/);
    expect(spec.query.indexOf('WHERE')).toBeLessThan(spec.query.indexOf('ORDER BY'));
    const types = spec.parameters.find((p) => p.name === '@types')?.value as string[];
    expect(new Set(types)).toEqual(new Set(['lakehouse', 'notebook']));
    // Positive scope, not a `!= 'loom-unity'` blocklist: a FUTURE non-item trail
    // must be excluded by construction rather than by remembering to add it.
    expect(spec.query).not.toContain('loom-unity');
  });

  it('keeps legacy rows that predate the itemType stamp', async () => {
    await call();
    const spec = auditQuery.mock.calls[0][0] as { query: string };
    expect(spec.query).toContain('NOT IS_DEFINED(c.itemType)');
  });

  it('still returns the caller-owned item rows the feed exists to show', async () => {
    auditQuery.mockResolvedValue({
      resources: [
        { id: 'a1', itemId: 'item-1', itemType: 'lakehouse', action: 'update', summary: 'schema', upn: 'a@x', _ts: 2 },
      ],
    });
    const res = await call();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].summary).toContain('Bronze');
  });
});
