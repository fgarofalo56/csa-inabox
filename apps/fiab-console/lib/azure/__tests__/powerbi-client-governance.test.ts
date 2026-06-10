/**
 * Backend contract tests for the Power BI **governance** helpers added to
 * powerbi-client.ts (the auditor's top parity gaps):
 *   - listGroupUsers / addGroupUser / updateGroupUser / deleteGroupUser
 *     (the REAL Power BI workspace ACL — GroupUser REST)
 *   - getItemEndorsement (Fabric Get Item) / setItemEndorsement (Admin REST)
 *   - getDatasetDatasources / discoverGateways / bindToGateway
 *
 * These assert URL + method + payload shaping against the REAL Power BI / Fabric
 * REST surface (groupId-scoped). Stubs @azure/identity + global.fetch — no live
 * tenant required. Per no-vaporware, the tests exercise the actual code path.
 *
 * Learn refs:
 *   Groups Add/Update/DeleteGroupUser:
 *     https://learn.microsoft.com/rest/api/power-bi/groups/add-group-user
 *   EndorsementDetails(endorsement, certifiedBy):
 *     https://learn.microsoft.com/dotnet/api/microsoft.powerbi.api.models.endorsementdetails.-ctor
 *   BindToGateway / DiscoverGateways / GetDatasources In Group:
 *     https://learn.microsoft.com/rest/api/power-bi/datasets/bind-to-gateway-in-group
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  listGroupUsers,
  addGroupUser,
  updateGroupUser,
  deleteGroupUser,
  getItemEndorsement,
  setItemEndorsement,
  getDatasetDatasources,
  discoverGateways,
  bindToGateway,
  generatePaginatedReportEmbedToken,
  startPaginatedReportExport,
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

describe('GroupUsers (workspace ACL)', () => {
  it('GETs /groups/{ws}/users and returns the value array', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ identifier: 'a@x.com', groupUserAccessRight: 'Admin', principalType: 'User' }] }; });
    const users = await listGroupUsers('ws-1');
    expect(url).toContain('/groups/ws-1/users');
    expect(users[0].groupUserAccessRight).toBe('Admin');
  });

  it('POSTs AddGroupUser with identifier + groupUserAccessRight + principalType', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    const out = await addGroupUser('ws-1', { identifier: 'svc@contoso.com', groupUserAccessRight: 'Contributor', principalType: 'App' });
    expect(url).toContain('/groups/ws-1/users');
    expect(method).toBe('POST');
    expect(body.identifier).toBe('svc@contoso.com');
    expect(body.groupUserAccessRight).toBe('Contributor');
    expect(body.principalType).toBe('App');
    expect(out).toEqual({ ok: true });
  });

  it('defaults principalType to User on add', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    await addGroupUser('ws-1', { identifier: 'u@x.com', groupUserAccessRight: 'Viewer' });
    expect(body.principalType).toBe('User');
  });

  it('PUTs UpdateGroupUser with the same body shape', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    await updateGroupUser('ws-1', { identifier: 'u@x.com', groupUserAccessRight: 'Member' });
    expect(url).toContain('/groups/ws-1/users');
    expect(method).toBe('PUT');
    expect(body.groupUserAccessRight).toBe('Member');
  });

  it('DELETEs /groups/{ws}/users/{user}', async () => {
    let url = ''; let method = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return undefined; });
    const out = await deleteGroupUser('ws-1', 'u@x.com');
    expect(url).toContain('/groups/ws-1/users/u%40x.com');
    expect(method).toBe('DELETE');
    expect(out).toEqual({ ok: true });
  });

  it('surfaces a 403 (not workspace Admin) as PowerBiError', async () => {
    mockFetch(() => ({ _status: 403, error: { message: 'PowerBINotAuthorizedException' } }));
    await expect(addGroupUser('ws-1', { identifier: 'u@x.com', groupUserAccessRight: 'Admin' })).rejects.toBeInstanceOf(PowerBiError);
  });
});

describe('endorsement', () => {
  it('reads endorsement via the Fabric Get Item endpoint', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { endorsement: { endorsementStatus: 'Certified', certifiedBy: 'rev@x.com' } }; });
    const e = await getItemEndorsement('ws-1', 'item-9');
    expect(url).toContain('api.fabric.microsoft.com');
    expect(url).toContain('/workspaces/ws-1/items/item-9');
    expect(e.endorsementStatus).toBe('Certified');
    expect(e.certifiedBy).toBe('rev@x.com');
  });

  it('returns None when the item has no endorsement object', async () => {
    mockFetch(() => ({ id: 'item-9' }));
    const e = await getItemEndorsement('ws-1', 'item-9');
    expect(e.endorsementStatus).toBe('None');
  });

  it('PUTs the Admin REST with endorsementDetails { endorsement, certifiedBy } for Certified', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    await setItemEndorsement('ws-1', 'datasets', 'ds-1', 'Certified', 'rev@x.com');
    expect(url).toContain('/admin/groups/ws-1/datasets/ds-1');
    expect(method).toBe('PUT');
    expect(body.endorsementDetails.endorsement).toBe('Certified');
    expect(body.endorsementDetails.certifiedBy).toBe('rev@x.com');
  });

  it('omits certifiedBy when promoting (not certifying)', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    await setItemEndorsement('ws-1', 'reports', 'r-1', 'Promoted');
    expect(body.endorsementDetails.endorsement).toBe('Promoted');
    expect(body.endorsementDetails.certifiedBy).toBeUndefined();
  });

  it('surfaces a 401 (SP not a tenant admin) as PowerBiError', async () => {
    mockFetch(() => ({ _status: 401, error: { message: 'Unauthorized' } }));
    await expect(setItemEndorsement('ws-1', 'datasets', 'ds-1', 'Promoted')).rejects.toBeInstanceOf(PowerBiError);
  });
});

describe('gateway + datasources', () => {
  it('GETs cloud datasources and returns [] on 404', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ datasourceType: 'Sql', connectionDetails: { server: 's', database: 'd' } }] }; });
    const ds = await getDatasetDatasources('ws-1', 'ds-1');
    expect(url).toContain('/groups/ws-1/datasets/ds-1/datasources');
    expect(ds[0].datasourceType).toBe('Sql');

    mockFetch(() => ({ _status: 404, error: { message: 'not found' } }));
    await expect(getDatasetDatasources('ws-1', 'ds-1')).resolves.toEqual([]);
  });

  it('GETs DiscoverGateways via the groupId-scoped Default action', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ id: 'gw-1', name: 'GW', gatewayStatus: 'Live' }] }; });
    const gws = await discoverGateways('ws-1', 'ds-1');
    expect(url).toContain('/groups/ws-1/datasets/ds-1/Default.DiscoverGateways');
    expect(gws[0].id).toBe('gw-1');
  });

  it('POSTs BindToGateway with gatewayObjectId', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return undefined; });
    const out = await bindToGateway('ws-1', 'ds-1', 'gw-1', ['src-1']);
    expect(url).toContain('/groups/ws-1/datasets/ds-1/Default.BindToGateway');
    expect(method).toBe('POST');
    expect(body.gatewayObjectId).toBe('gw-1');
    expect(body.datasourceObjectIds).toEqual(['src-1']);
    expect(out).toEqual({ ok: true });
  });
});

describe('paginated report embed + export', () => {
  it('mints a paginated embed token via the MULTI-RESOURCE GenerateToken', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET';
      body = JSON.parse((init?.body as string) || '{}');
      return { token: 'EMBED', tokenId: 'tid', expiration: '2030-01-01' };
    });
    const out = await generatePaginatedReportEmbedToken('rdl-1', ['ds-a', 'ds-b']);
    // Multi-resource endpoint (workspace-less /GenerateToken), NOT the per-report one.
    expect(url).toMatch(/\/GenerateToken$/);
    expect(url).not.toContain('/reports/rdl-1/GenerateToken');
    expect(method).toBe('POST');
    // reports[] carries the report with allowEdit:false (paginated cannot edit).
    expect(body.reports).toEqual([{ id: 'rdl-1', allowEdit: false }]);
    // datasets[] carries every bound model with xmlaPermissions ReadOnly.
    expect(body.datasets).toEqual([
      { id: 'ds-a', xmlaPermissions: 'ReadOnly' },
      { id: 'ds-b', xmlaPermissions: 'ReadOnly' },
    ]);
    expect(out.token).toBe('EMBED');
  });

  it('omits datasets[] when the paginated report binds no semantic model', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return { token: 'T', tokenId: 'i', expiration: 'e' }; });
    await generatePaginatedReportEmbedToken('rdl-1');
    expect(body.reports).toEqual([{ id: 'rdl-1', allowEdit: false }]);
    expect(body.datasets).toEqual([]);
  });

  it('queues a paginated export with a paginatedReportConfiguration body', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET';
      body = JSON.parse((init?.body as string) || '{}');
      return { id: 'exp-1', status: 'Running' };
    });
    const job = await startPaginatedReportExport('ws-1', 'rdl-1', 'XLSX');
    expect(url).toContain('/groups/ws-1/reports/rdl-1/ExportTo');
    expect(method).toBe('POST');
    expect(body.format).toBe('XLSX');
    // The paginatedReportConfiguration object is REQUIRED for RDL exports.
    expect(body.paginatedReportConfiguration).toBeDefined();
    expect(body.paginatedReportConfiguration.formatSettings).toEqual({});
    expect(job.id).toBe('exp-1');
  });

  it('passes report parameterValues into the paginated export body when provided', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return { id: 'e', status: 'Running' }; });
    await startPaginatedReportExport('ws-1', 'rdl-1', 'PDF', [{ name: 'Year', value: '2026' }]);
    expect(body.paginatedReportConfiguration.parameterValues).toEqual([{ name: 'Year', value: '2026' }]);
  });
});
