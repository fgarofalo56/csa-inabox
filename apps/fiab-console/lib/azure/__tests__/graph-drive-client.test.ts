/**
 * Unit tests for the Microsoft Graph Drive client (graph-drive-client.ts) that
 * backs OneLake shortcuts to SharePoint document libraries / OneDrive folders.
 *
 * They lock in: the honest-gate when the feature flag is unset, the Graph REST
 * request shapes (site search, site drives, drive-item children, sharing-link
 * resolution), the response → typed-entry parsing, and the sharepoint:// target
 * URI round-trip. `@azure/identity` (token) and global `fetch` are mocked — these
 * assert the requests we build + responses we parse, not live Graph.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-graph-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return {
    ChainedTokenCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ManagedIdentityCredential: FakeCred,
  };
});

import {
  searchSites,
  listSiteDrives,
  listDriveChildren,
  resolveSharingUrl,
  graphDriveConfigGate,
  GraphDriveNotConfiguredError,
  sharepointTargetUri,
  parseSharepointUri,
} from '../graph-drive-client';

const baseEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...baseEnv };
  process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED = 'true';
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;
}

describe('graphDriveConfigGate (honest gate)', () => {
  it('returns a 503 gate when the feature flag is unset', () => {
    delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
    const gate = graphDriveConfigGate();
    expect(gate).toBeInstanceOf(GraphDriveNotConfiguredError);
    expect(gate?.status).toBe(503);
    expect(gate?.code).toBe('sharepoint_not_configured');
    expect(gate?.hint.rolesRequired.map((r) => r.name)).toEqual(['Sites.Read.All', 'Files.Read.All']);
  });
  it('returns null when enabled', () => {
    expect(graphDriveConfigGate()).toBeNull();
  });
  it('search throws the not-configured error when the flag is unset', async () => {
    delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
    await expect(searchSites('finance')).rejects.toBeInstanceOf(GraphDriveNotConfiguredError);
  });
});

describe('searchSites', () => {
  it('hits /sites?search and maps the results', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ value: [{ id: 'site-1', displayName: 'Finance', name: 'finance', webUrl: 'https://c.sharepoint.com/sites/finance' }] }),
    );
    const sites = await searchSites('finance');
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('/v1.0/sites?');
    expect(url).toContain('search=finance');
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ id: 'site-1', displayName: 'Finance', webUrl: 'https://c.sharepoint.com/sites/finance' });
    // bearer token from the mocked credential is attached
    const init = fetchSpy.mock.calls[0][1] as any;
    expect(init.headers.authorization).toBe('Bearer fake-graph-token');
    fetchSpy.mockRestore();
  });
});

describe('listSiteDrives', () => {
  it('hits /sites/{id}/drives', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ value: [{ id: 'drive-1', name: 'Documents', driveType: 'documentLibrary' }] }),
    );
    const drives = await listSiteDrives('site-1');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/sites/site-1/drives');
    expect(drives[0]).toMatchObject({ id: 'drive-1', name: 'Documents', driveType: 'documentLibrary' });
    fetchSpy.mockRestore();
  });
});

describe('listDriveChildren', () => {
  it('lists root children, folders first, with computed paths', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        value: [
          { id: 'f1', name: 'readme.txt', size: 42, file: {}, lastModifiedDateTime: '2026-06-01T00:00:00Z' },
          { id: 'd1', name: 'Reports', folder: { childCount: 3 } },
        ],
      }),
    );
    const { entries, truncated } = await listDriveChildren({ driveId: 'drive-1' });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/drives/drive-1/root/children');
    expect(truncated).toBe(false);
    // folder sorts first
    expect(entries[0]).toMatchObject({ name: 'Reports', isFolder: true, path: 'Reports' });
    expect(entries[1]).toMatchObject({ name: 'readme.txt', isFolder: false, path: 'readme.txt', size: 42 });
    fetchSpy.mockRestore();
  });

  it('uses the colon-escaped path syntax for a sub-folder and prefixes child paths', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ value: [{ id: 'x', name: 'q1.csv', size: 10, file: {} }] }),
    );
    const { entries } = await listDriveChildren({ driveId: 'drive-1', prefix: 'Reports/2026' });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/drives/drive-1/root:/Reports/2026:/children');
    expect(entries[0].path).toBe('Reports/2026/q1.csv');
    fetchSpy.mockRestore();
  });

  it('surfaces a 403 as graph_access_denied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'Access denied' } }, 403),
    );
    await expect(listDriveChildren({ driveId: 'drive-1' })).rejects.toMatchObject({ code: 'graph_access_denied', status: 403 });
    fetchSpy.mockRestore();
  });
});

describe('resolveSharingUrl', () => {
  it('base64url-encodes the URL into a u! share id and returns the drive + item', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        id: 'item-9', name: 'Q4.xlsx', size: 1234, file: {},
        parentReference: { driveId: 'drive-7', path: '/drive/root:/Reports' },
      }),
    );
    const { driveId, item } = await resolveSharingUrl('https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Q4.xlsx');
    const url = String(fetchSpy.mock.calls[0][0]);
    // share id is the literal "u!<base64url>" token used directly in the path
    // (per MS Graph "encode sharing URLs"; the "!" is not percent-encoded).
    expect(url).toContain('/shares/u!');
    expect(url).toContain('/driveItem');
    expect(driveId).toBe('drive-7');
    expect(item).toMatchObject({ id: 'item-9', name: 'Q4.xlsx', isFolder: false, path: 'Reports/Q4.xlsx' });
    fetchSpy.mockRestore();
  });

  it('rejects a non-http url', async () => {
    await expect(resolveSharingUrl('not-a-url')).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('sharepoint target URI round-trip', () => {
  it('builds and parses sharepoint://<driveId>/<path>', () => {
    const uri = sharepointTargetUri('drive-1', '/Reports/2026/');
    expect(uri).toBe('sharepoint://drive-1/Reports/2026');
    expect(parseSharepointUri(uri)).toEqual({ driveId: 'drive-1', path: 'Reports/2026' });
  });
  it('handles a drive-root target', () => {
    expect(parseSharepointUri('sharepoint://drive-1/')).toEqual({ driveId: 'drive-1', path: '' });
  });
  it('returns null for a non-sharepoint uri', () => {
    expect(parseSharepointUri('abfss://c@a.dfs.core.windows.net/p')).toBeNull();
  });
});
