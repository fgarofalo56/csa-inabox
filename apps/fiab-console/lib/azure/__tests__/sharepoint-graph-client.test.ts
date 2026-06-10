/**
 * Unit tests for the SharePoint / OneDrive shortcut connector
 * (sharepoint-graph-client.ts). They lock in the targetUri parse/build round
 * trip, the per-level Microsoft Graph request path (sites → drives → driveItems),
 * the parsing of each Graph response into RemoteEntry rows, and the
 * config-enablement gate. `@azure/identity` (token) and `fetch` are mocked —
 * these assert the request we build + entries we parse, not live Graph calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-graph-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return {
    ChainedTokenCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ManagedIdentityCredential: FakeCred,
  };
});

// Pin the Graph base/scope so URL assertions are deterministic.
vi.mock('../cloud-endpoints', () => ({
  graphBase: () => 'https://graph.microsoft.com/v1.0',
  graphScope: () => 'https://graph.microsoft.com/.default',
}));

import {
  parseSharePointUri,
  buildSharePointUri,
  browseSharePoint,
  testSharePointTarget,
  sharePointConfigGate,
  SHAREPOINT_APP_ROLE,
} from '../sharepoint-graph-client';

const SITE_ID = 'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222';
const DRIVE_ID = 'b!abcDEF123';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
});

describe('parseSharePointUri / buildSharePointUri', () => {
  it('round-trips a drive-root target (siteId contains commas)', () => {
    const uri = buildSharePointUri({ siteId: SITE_ID, driveId: DRIVE_ID, itemId: '' });
    expect(uri).toBe(`sharepoint://${SITE_ID}/${DRIVE_ID}`);
    const t = parseSharePointUri(uri);
    expect(t).toEqual({ siteId: SITE_ID, driveId: DRIVE_ID, itemId: '' });
  });

  it('round-trips an item target', () => {
    const uri = buildSharePointUri({ siteId: SITE_ID, driveId: DRIVE_ID, itemId: 'ITEM01' });
    expect(uri).toBe(`sharepoint://${SITE_ID}/${DRIVE_ID}/ITEM01`);
    expect(parseSharePointUri(uri)).toEqual({ siteId: SITE_ID, driveId: DRIVE_ID, itemId: 'ITEM01' });
  });

  it('rejects a non-sharepoint or incomplete uri', () => {
    expect(parseSharePointUri('abfss://x@y/z')).toBeNull();
    expect(parseSharePointUri('sharepoint://onlysite')).toBeNull();
  });
});

describe('sharePointConfigGate', () => {
  it('returns null when enabled', () => {
    expect(sharePointConfigGate()).toBeNull();
  });
  it('gates with the exact remediation when disabled', () => {
    delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
    const g = sharePointConfigGate();
    expect(g?.code).toBe('sharepoint_not_configured');
    expect(g?.hint).toContain('LOOM_SHAREPOINT_SHORTCUTS_ENABLED');
    expect(g?.hint).toContain('Sites.Read.All');
  });
  it('exposes the Sites.Read.All app-role id', () => {
    expect(SHAREPOINT_APP_ROLE.name).toBe('Sites.Read.All');
    expect(SHAREPOINT_APP_ROLE.appRoleId).toBe('332a536c-c7ef-4017-ab91-336970924f0d');
  });
});

describe('browseSharePoint — per-level Graph request + parse', () => {
  it('level 1 lists sites (search filter)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [{ id: SITE_ID, displayName: 'Contoso Finance' }] }), { status: 200 }) as any,
    );
    const res = await browseSharePoint({ search: 'Contoso' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('https://graph.microsoft.com/v1.0/sites?search=Contoso');
    expect((init as any).headers.authorization).toBe('Bearer fake-graph-token');
    expect(res.entries).toEqual([{ name: 'Contoso Finance', path: SITE_ID, isDirectory: true }]);
    fetchSpy.mockRestore();
  });

  it('level 2 lists a site drives (document libraries)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [{ id: DRIVE_ID, name: 'Documents', quota: { used: 1024 } }] }), { status: 200 }) as any,
    );
    const res = await browseSharePoint({ prefix: SITE_ID });
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/sites/${encodeURIComponent(SITE_ID)}/drives`);
    expect(res.entries).toEqual([{ name: 'Documents', path: `${SITE_ID}/${DRIVE_ID}`, isDirectory: true, size: 1024 }]);
    fetchSpy.mockRestore();
  });

  it('level 3 lists driveItems from drive root (folders first)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        value: [
          { id: 'F1', name: 'reports', folder: { childCount: 3 } },
          { id: 'X1', name: 'data.csv', size: 99, file: { mimeType: 'text/csv' }, lastModifiedDateTime: '2026-06-01T00:00:00Z' },
        ],
      }), { status: 200 }) as any,
    );
    const res = await browseSharePoint({ prefix: `${SITE_ID}/${DRIVE_ID}` });
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/drives/${encodeURIComponent(DRIVE_ID)}/root/children`);
    expect(res.entries[0]).toMatchObject({ name: 'reports', path: `${SITE_ID}/${DRIVE_ID}/F1`, isDirectory: true });
    expect(res.entries[1]).toMatchObject({ name: 'data.csv', path: `${SITE_ID}/${DRIVE_ID}/X1`, isDirectory: false, size: 99 });
    fetchSpy.mockRestore();
  });

  it('level 4 lists children of a folder item', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [] }), { status: 200 }) as any,
    );
    await browseSharePoint({ prefix: `${SITE_ID}/${DRIVE_ID}/F1` });
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/drives/${encodeURIComponent(DRIVE_ID)}/items/F1/children`);
    fetchSpy.mockRestore();
  });

  it('maps a 403 to sharepoint_auth_failure with the grant hint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'denied' } }), { status: 403 }) as any,
    );
    await expect(browseSharePoint({})).rejects.toMatchObject({ code: 'sharepoint_auth_failure', status: 403 });
    fetchSpy.mockRestore();
  });
});

describe('testSharePointTarget', () => {
  it('reads the drive for a root target', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: DRIVE_ID, webUrl: 'https://contoso.sharepoint.com/Documents' }), { status: 200 }) as any,
    );
    const r = await testSharePointTarget({ siteId: SITE_ID, driveId: DRIVE_ID, itemId: '' });
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/drives/${encodeURIComponent(DRIVE_ID)}?`);
    expect(r.webUrl).toContain('contoso.sharepoint.com');
    fetchSpy.mockRestore();
  });

  it('reads the driveItem for an item target', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'ITEM01', webUrl: 'https://contoso.sharepoint.com/Documents/file.csv' }), { status: 200 }) as any,
    );
    await testSharePointTarget({ siteId: SITE_ID, driveId: DRIVE_ID, itemId: 'ITEM01' });
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/drives/${encodeURIComponent(DRIVE_ID)}/items/ITEM01?`);
    fetchSpy.mockRestore();
  });
});
