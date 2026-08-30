/**
 * #3746 — THE CATALOG FAILURE CARRIES ITS MEASURED CLASS, NOT A GUESS.
 *
 * `/admin/catalog` titled EVERY `catalog.error` "Catalog unreachable". The live
 * failure was an HTTP 403 — the catalog was reached, it answered, and it refused
 * — and #3312 recorded the cost: the word "unreachable" sent an investigation
 * down the reachability path. deploy-integrity R7: an error must not assert a
 * cause the code did not establish.
 *
 * The classification is taken from what `IcebergCatalogError` actually MEASURED
 * (`status` / `code`), never from a substring of the message. A bare substring
 * signal is the failure this repo has already paid for once
 * (`csa_loom_a_bare_substring_signal_misclassifies_and_blocks`): the same words
 * appear in errors about different resources.
 *
 * `unknown` is a first-class outcome with its own test. Folding an unclassifiable
 * failure into either "unreachable" or "denied" would re-create the defect in a
 * new spelling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IcebergCatalogError } from '@/lib/azure/iceberg-catalog-client';

let sessionValue: any = {
  claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' },
  exp: Date.now() / 1000 + 3600,
};
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionValue }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  lakehouseInteropContainer: async () => ({
    item: () => ({ read: async () => ({ resource: null }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  auditLogContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
  maintenanceJobsContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: () => 'loomlake' }));

/** What `listNamespacesResolved` throws for a given test. `null` = succeed. */
let thrown: unknown = null;

vi.mock('@/lib/azure/iceberg-catalog-client', async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    listNamespacesResolved: async () => {
      if (thrown !== null) throw thrown;
      return { namespaces: [] };
    },
    listTables: async () => ({ identifiers: [] }),
    listNamespaceGrants: async () => ({ namespace: 'gold', supported: true, assignments: [] }),
    logIcebergAccess: async () => {},
  };
});

function req(url: string) {
  const u = new URL(url);
  const headers = new Headers({ host: u.host });
  return { url, method: 'GET', nextUrl: u, headers } as any;
}

const URL_UNDER_TEST = 'https://loom.test/api/catalog/iceberg/overview';

beforeEach(() => {
  thrown = null;
  sessionValue = {
    claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' },
    exp: Date.now() / 1000 + 3600,
  };
  // The REAL tenant-admin gate, satisfied rather than mocked away.
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-1';
  // Configured, so the route takes the catalog-calling branch at all.
  process.env.LOOM_ICEBERG_CATALOG_URL = 'https://iceberg-catalog.internal.test';
});

afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_ICEBERG_CATALOG_URL;
  vi.resetModules();
});

describe('classifyCatalogError — the class comes from the MEASURED status', () => {
  it('403 after a response is an AUTHORIZATION denial, not a reachability failure', async () => {
    const { classifyCatalogError } = await import('../overview/route');
    expect(classifyCatalogError(new IcebergCatalogError('denied', 403, 'permission_denied')))
      .toEqual({ errorClass: 'authorization', errorStatus: 403 });
    expect(classifyCatalogError(new IcebergCatalogError('denied', 401)))
      .toEqual({ errorClass: 'authorization', errorStatus: 401 });
  });

  it("code 'unreachable' — and ONLY that — is reported as unreachable", async () => {
    const { classifyCatalogError } = await import('../overview/route');
    expect(classifyCatalogError(new IcebergCatalogError('no route to host', 502, 'unreachable')))
      .toEqual({ errorClass: 'unreachable', errorStatus: 502 });
  });

  it('a 500 the catalog itself returned is REFUSED, not unreachable', async () => {
    const { classifyCatalogError } = await import('../overview/route');
    expect(classifyCatalogError(new IcebergCatalogError('boom', 500)))
      .toEqual({ errorClass: 'refused', errorStatus: 500 });
  });

  it('an unwired catalog is NOT-CONFIGURED', async () => {
    const { classifyCatalogError } = await import('../overview/route');
    expect(classifyCatalogError(new IcebergCatalogError('set the url', 503, 'not_configured')))
      .toEqual({ errorClass: 'not-configured', errorStatus: 503 });
  });

  it('anything else is UNKNOWN — the code says it does not know (R7)', async () => {
    const { classifyCatalogError } = await import('../overview/route');
    // A plain Error carries no measured status at all.
    expect(classifyCatalogError(new Error('Iceberg REST Catalog returned HTTP 403')))
      .toEqual({ errorClass: 'unknown', errorStatus: null });
    // The message CONTAINS "403" and "unreachable"; a substring classifier would
    // have answered 'authorization' or 'unreachable' here. That is the point.
    expect(classifyCatalogError(new Error('catalog unreachable: HTTP 403')))
      .toEqual({ errorClass: 'unknown', errorStatus: null });
    expect(classifyCatalogError('a string')).toEqual({ errorClass: 'unknown', errorStatus: null });
    // status 0 means the client never established one.
    expect(classifyCatalogError(new IcebergCatalogError('?', 0)))
      .toEqual({ errorClass: 'unknown', errorStatus: null });
  });
});

describe('GET /api/catalog/iceberg/overview — the payload carries the class', () => {
  it('a 403 is reported as authorization, with its status', async () => {
    thrown = new IcebergCatalogError('Iceberg REST Catalog returned HTTP 403', 403, 'permission_denied');
    const { GET } = await import('../overview/route');
    const res = await GET(req(URL_UNDER_TEST), {} as any);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.catalog.configured).toBe(true);
    expect(body.catalog.error).toContain('403');
    expect(body.catalog.errorClass).toBe('authorization');
    expect(body.catalog.errorStatus).toBe(403);
  });

  it('a genuine transport failure is reported as unreachable — the two are distinguishable', async () => {
    thrown = new IcebergCatalogError('Iceberg REST Catalog unreachable at …: ECONNREFUSED', 502, 'unreachable');
    const { GET } = await import('../overview/route');
    const res = await GET(req(URL_UNDER_TEST), {} as any);
    const body = await res.json();

    expect(body.catalog.errorClass).toBe('unreachable');
    expect(body.catalog.errorStatus).toBe(502);
  });

  it('CONTROL: a successful call carries no error and no class', async () => {
    const { GET } = await import('../overview/route');
    const res = await GET(req(URL_UNDER_TEST), {} as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.catalog.configured).toBe(true);
    expect(body.catalog.error).toBeUndefined();
    expect(body.catalog.errorClass).toBeUndefined();
  });
});
