// CosmosFhirUserStore over a fake Container (#5454 PR2 review): the query text
// and parameters listForTenant sends, and delete's 404 -> false mapping.

import type { Container } from '@azure/cosmos';
import { describe, expect, it } from 'vitest';
import { CosmosFhirUserStore } from '../src/auth/cosmos.js';

interface QuerySpec {
  query: string;
  parameters: Array<{ name: string; value: unknown }>;
}

function fakeContainer(o: { pages?: Array<{ resources?: Record<string, unknown>[] }>; deleteError?: unknown } = {}) {
  const queries: Array<{ spec: QuerySpec; options: unknown }> = [];
  const deletes: Array<[string, string]> = [];
  const pages = o.pages ?? [];
  let i = 0;
  const container = {
    items: {
      query: (spec: QuerySpec, options: unknown) => {
        queries.push({ spec, options });
        return { hasMoreResults: () => i < pages.length, fetchNext: async () => pages[i++] };
      },
    },
    item: (id: string, pk: string) => ({
      delete: async () => {
        deletes.push([id, pk]);
        if (o.deleteError !== undefined) throw o.deleteError;
        return {};
      },
    }),
  } as unknown as Container;
  return { container, queries, deletes };
}

describe('CosmosFhirUserStore.listForTenant', () => {
  it('sends a kind-filtered, tenant-PARAMETERISED query and strips system fields', async () => {
    const row = { id: 'fhiruser-visn-01-o', kind: 'fhiruser', tenant: 'visn-01', oid: 'o', resource: 'Practitioner/p1', _rid: 'r', _ts: 1, _self: 's', _attachments: 'a' };
    const f = fakeContainer({ pages: [{ resources: [row] }] });
    const tenant = "visn-01' OR 1=1 --";
    const rows = await new CosmosFhirUserStore(f.container).listForTenant(tenant, 7);
    expect(f.queries).toHaveLength(1);
    const { spec, options } = f.queries[0]!;
    // Breaks if the kind filter is dropped (a client or binding doc in the same container would be listed), or if
    // the tenant is concatenated: the injection string would then appear in the query TEXT.
    expect(spec.query).toBe('SELECT * FROM c WHERE c.kind = @kind AND c.tenant = @tenant ORDER BY c.id');
    expect(spec.query).not.toContain('OR 1=1');
    expect(spec.parameters).toEqual([
      { name: '@kind', value: 'fhiruser' },
      { name: '@tenant', value: tenant },
    ]);
    expect(options).toEqual({ maxItemCount: 7 });
    expect(rows).toEqual([{ id: 'fhiruser-visn-01-o', kind: 'fhiruser', tenant: 'visn-01', oid: 'o', resource: 'Practitioner/p1' }]);
  });

  it('pages past an empty page and stops at the limit', async () => {
    const r = (id: string) => ({ id, kind: 'fhiruser', tenant: 't' });
    const f = fakeContainer({ pages: [{ resources: [] }, { resources: [r('a'), r('b')] }, { resources: [r('c')] }] });
    // Breaks (0 rows) if an empty first page ends the read, or (3) without the slice.
    expect((await new CosmosFhirUserStore(f.container).listForTenant('t', 2)).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('CosmosFhirUserStore.delete', () => {
  it('true on delete, false on a Cosmos 404, and any other error propagates', async () => {
    const ok = fakeContainer();
    expect(await new CosmosFhirUserStore(ok.container).delete('fhiruser-t-o')).toBe(true);
    expect(ok.deletes).toEqual([['fhiruser-t-o', 'fhiruser-t-o']]); // partition key = id (/id partitioning)
    // Breaks (throws) if the 404 mapping is removed; breaks (true) if 404 is treated as a deletion.
    expect(await new CosmosFhirUserStore(fakeContainer({ deleteError: { code: 404 } }).container).delete('x')).toBe(false);
    // Breaks (false) if every error is swallowed as "absent": a 403 must not read as an idempotent success.
    await expect(new CosmosFhirUserStore(fakeContainer({ deleteError: Object.assign(new Error('forbidden'), { code: 403 }) }).container).delete('x')).rejects.toThrow('forbidden');
  });
});
