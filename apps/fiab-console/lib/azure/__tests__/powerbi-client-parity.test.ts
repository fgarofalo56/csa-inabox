/**
 * Backend contract tests for the Power BI family A-grade parity helpers added
 * to powerbi-client.ts:
 *   - getReportPages          GET  /reports/{id}/pages
 *   - getRefreshSchedule      GET  /datasets/{id}/refreshSchedule
 *   - patchRefreshSchedule    PATCH/datasets/{id}/refreshSchedule  { value }
 *   - takeOverDataset         POST /datasets/{id}/Default.TakeOver
 *
 * These assert URL + method + payload shaping against the REAL Power BI REST
 * surface (groupId-scoped, per the PowerBIEntityNotFound fix). Stubs
 * @azure/identity + global.fetch — no live tenant required. Per no-vaporware,
 * the tests exercise the actual code path, not a mock of it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  getReportPages,
  getRefreshSchedule,
  patchRefreshSchedule,
  takeOverDataset,
  listDatasetRelationships,
  createPushDataset,
  putPushTable,
  postPushRows,
  PowerBiError,
} from '../powerbi-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(out === undefined ? '' : JSON.stringify(out), { status });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; });

describe('getReportPages', () => {
  it('GETs groupId-scoped /reports/{id}/pages and returns the value array', async () => {
    let url = '';
    let method = '';
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET';
      return { value: [{ name: 'ReportSection1', displayName: 'Overview' }, { name: 'ReportSection2', displayName: 'Detail' }] };
    });
    const pages = await getReportPages('ws-1', 'rep-9');
    expect(url).toContain('/groups/ws-1/reports/rep-9/pages');
    expect(method).toBe('GET');
    expect(pages).toHaveLength(2);
    expect(pages[0].name).toBe('ReportSection1');
    expect(pages[0].displayName).toBe('Overview');
  });
});

describe('getRefreshSchedule', () => {
  it('returns the schedule object on 200', async () => {
    mockFetch(() => ({ enabled: true, days: ['Monday'], times: ['07:00'], localTimeZoneId: 'UTC', notifyOption: 'MailOnFailure' }));
    const sch = await getRefreshSchedule('ws-1', 'ds-1');
    expect(sch.enabled).toBe(true);
    expect(sch.days).toEqual(['Monday']);
  });

  it('returns null on 404 (no schedule configured) instead of throwing', async () => {
    mockFetch(() => ({ _status: 404, error: { message: 'not found' } }));
    const sch = await getRefreshSchedule('ws-1', 'ds-1');
    expect(sch).toBeNull();
  });
});

describe('patchRefreshSchedule', () => {
  it('PATCHes /datasets/{id}/refreshSchedule wrapping the body in { value }', async () => {
    let url = '';
    let method = '';
    let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET';
      body = JSON.parse((init?.body as string) || '{}');
      return undefined; // PBI returns 200 with empty body
    });
    const out = await patchRefreshSchedule('ws-1', 'ds-1', {
      enabled: true, days: ['Monday', 'Wednesday'], times: ['07:00', '12:30'], localTimeZoneId: 'UTC', notifyOption: 'MailOnFailure',
    });
    expect(url).toContain('/groups/ws-1/datasets/ds-1/refreshSchedule');
    expect(method).toBe('PATCH');
    expect(body.value.enabled).toBe(true);
    expect(body.value.days).toEqual(['Monday', 'Wednesday']);
    expect(body.value.times).toEqual(['07:00', '12:30']);
    expect(body.value.notifyOption).toBe('MailOnFailure');
    expect(out).toEqual({ ok: true });
  });

  it('surfaces a Power BI 400 verbatim as PowerBiError', async () => {
    mockFetch(() => ({ _status: 400, error: { message: 'Days and Times must be set when Enabled is true' } }));
    await expect(patchRefreshSchedule('ws-1', 'ds-1', { enabled: true })).rejects.toBeInstanceOf(PowerBiError);
    await expect(patchRefreshSchedule('ws-1', 'ds-1', { enabled: true })).rejects.toThrow(/Days and Times/);
  });
});

describe('takeOverDataset', () => {
  it('POSTs to /datasets/{id}/Default.TakeOver', async () => {
    let url = '';
    let method = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return undefined; });
    const out = await takeOverDataset('ws-1', 'ds-1');
    expect(url).toContain('/groups/ws-1/datasets/ds-1/Default.TakeOver');
    expect(method).toBe('POST');
    expect(out).toEqual({ ok: true });
  });

  it('propagates a 403 as PowerBiError (caller cannot take over)', async () => {
    mockFetch(() => ({ _status: 403, error: { message: 'PowerBINotAuthorizedException' } }));
    await expect(takeOverDataset('ws-1', 'ds-1')).rejects.toBeInstanceOf(PowerBiError);
  });
});

describe('listDatasetRelationships', () => {
  it('GETs the real groupId-scoped /datasets/{id}/relationships endpoint', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ name: 'rel1', fromTable: 'Sales', fromColumn: 'CustId', toTable: 'Customer', toColumn: 'Id' }] }; });
    const rels = await listDatasetRelationships('ws-1', 'ds-1');
    expect(url).toContain('/groups/ws-1/datasets/ds-1/relationships');
    expect(rels).toHaveLength(1);
    expect(rels[0].fromTable).toBe('Sales');
  });

  it('returns [] on 404/400 instead of throwing', async () => {
    mockFetch(() => ({ _status: 404, error: { message: 'not found' } }));
    await expect(listDatasetRelationships('ws-1', 'ds-1')).resolves.toEqual([]);
  });
});

describe('createPushDataset', () => {
  it('POSTs /groups/{ws}/datasets with tables, measures, relationships and defaultMode', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET';
      body = JSON.parse((init?.body as string) || '{}');
      return { id: 'new-ds-1', name: body.name };
    });
    const out = await createPushDataset('ws-1', {
      name: 'My model',
      tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'Double' }], measures: [{ name: 'Total', expression: 'SUM(Sales[Amount])' }] }],
      relationships: [{ name: 'r1', fromTable: 'Sales', fromColumn: 'CustId', toTable: 'Customer', toColumn: 'Id' }],
    });
    expect(url).toContain('/groups/ws-1/datasets');
    expect(method).toBe('POST');
    expect(body.name).toBe('My model');
    expect(body.defaultMode).toBe('Push');
    expect(body.tables[0].columns[0].dataType).toBe('Double');
    expect(body.tables[0].measures[0].expression).toBe('SUM(Sales[Amount])');
    expect(body.relationships[0].toTable).toBe('Customer');
    expect(out.id).toBe('new-ds-1');
  });

  it('appends defaultRetentionPolicy when basicFIFO is requested', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { id: 'x', name: 'n' }; });
    await createPushDataset('ws-1', { name: 'n', tables: [{ name: 'T', columns: [{ name: 'c', dataType: 'String' }] }] }, 'basicFIFO');
    expect(url).toContain('defaultRetentionPolicy=basicFIFO');
  });

  it('surfaces a 401 as PowerBiError (SP not registered in PBI tenant)', async () => {
    mockFetch(() => ({ _status: 401, error: { message: 'Unauthorized' } }));
    await expect(createPushDataset('ws-1', { name: 'n', tables: [{ name: 'T', columns: [{ name: 'c', dataType: 'String' }] }] }))
      .rejects.toBeInstanceOf(PowerBiError);
  });
});

describe('putPushTable / postPushRows', () => {
  it('PUTs the table schema to /datasets/{id}/tables/{name}', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    const out = await putPushTable('ws-1', 'ds-1', { name: 'Sales', columns: [{ name: 'Amount', dataType: 'Double' }], measures: [{ name: 'Total', expression: 'SUM(Sales[Amount])' }] });
    expect(url).toContain('/groups/ws-1/datasets/ds-1/tables/Sales');
    expect(method).toBe('PUT');
    expect(body.measures[0].name).toBe('Total');
    expect(out).toEqual({ ok: true });
  });

  it('POSTs rows to /datasets/{id}/tables/{name}/rows', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    await postPushRows('ws-1', 'ds-1', 'Sales', [{ Amount: 10 }, { Amount: 20 }]);
    expect(url).toContain('/groups/ws-1/datasets/ds-1/tables/Sales/rows');
    expect(method).toBe('POST');
    expect(body.rows).toHaveLength(2);
    expect(body.rows[1].Amount).toBe(20);
  });
});
