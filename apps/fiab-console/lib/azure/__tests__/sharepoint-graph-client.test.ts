/**
 * Unit tests for the SharePoint / OneDrive shortcut connector
 * (sharepoint-graph-client.ts). Locks in the Graph URI grammar, the honest
 * deployment gate, and the drive-item → RemoteEntry mapping. The Azure identity
 * token + Graph fetch are mocked — these assert the URLs we build and the
 * shapes we parse, not live Graph.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class { getToken() { return { token: 'tok' }; } },
  DefaultAzureCredential: class { getToken() { return { token: 'tok' }; } },
  ManagedIdentityCredential: class { getToken() { return { token: 'tok' }; } },
}));
vi.mock('../cloud-endpoints', () => ({
  getGraphHost: () => 'https://graph.microsoft.com',
  getGraphScope: () => 'https://graph.microsoft.com/.default',
}));

import {
  buildSharePointUri,
  buildOneDriveUri,
  parseGraphTarget,
  sharepointShortcutsEnabled,
  searchSites,
  browseSharePoint,
  browseOneDrive,
  testGraphTarget,
} from '../sharepoint-graph-client';

const realFetch = global.fetch;

function mockGraph(jsonBody: any, status = 200) {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(jsonBody),
  })) as any;
}

beforeEach(() => {
  process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED = 'true';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
  vi.restoreAllMocks();
});

describe('URI grammar', () => {
  it('builds + round-trips a SharePoint URI', () => {
    const uri = buildSharePointUri('site-1', 'drive-9', 'Shared Documents/2026');
    const t = parseGraphTarget(uri);
    expect(t.kind).toBe('sharepoint');
    if (t.kind === 'sharepoint') {
      expect(t.siteId).toBe('site-1');
      expect(t.driveId).toBe('drive-9');
      expect(t.itemPath).toBe('Shared Documents/2026');
    }
  });

  it('builds + round-trips a OneDrive URI (no drive segment)', () => {
    const uri = buildOneDriveUri('user@contoso.com', 'reports');
    expect(uri).toContain('onedrive://');
    const t = parseGraphTarget(uri);
    expect(t.kind).toBe('onedrive');
    if (t.kind === 'onedrive') {
      expect(t.userId).toBe('user@contoso.com');
      expect(t.itemPath).toBe('reports');
    }
  });

  it('rejects a non-graph URI', () => {
    expect(() => parseGraphTarget('s3://bucket/key')).toThrow();
  });
});

describe('deployment gate', () => {
  it('is disabled when the env var is unset', () => {
    delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
    expect(sharepointShortcutsEnabled()).toBe(false);
  });

  it('throws a 503 honest gate from a browse when disabled', async () => {
    delete process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED;
    await expect(browseSharePoint({ siteId: 's', driveId: 'd' })).rejects.toMatchObject({
      code: 'sharepoint_not_configured',
      status: 503,
    });
  });
});

describe('site search', () => {
  it('maps Graph site rows', async () => {
    mockGraph({ value: [{ id: 'site-1', displayName: 'Finance', webUrl: 'https://x' }] });
    const sites = await searchSites('fin');
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ id: 'site-1', displayName: 'Finance' });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/sites?search=');
  });
});

describe('drive-item browse', () => {
  it('maps folders + files and sorts folders first', async () => {
    mockGraph({
      value: [
        { name: 'report.csv', size: 120, file: {} },
        { name: 'sub', folder: { childCount: 2 } },
      ],
    });
    const res = await browseSharePoint({ siteId: 's', driveId: 'd', prefix: 'docs' });
    expect(res.entries[0]).toMatchObject({ name: 'sub', isDirectory: true, path: 'docs/sub' });
    expect(res.entries[1]).toMatchObject({ name: 'report.csv', isDirectory: false, size: 120, path: 'docs/report.csv' });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/drives/d/root:/docs:/children');
  });

  it('uses the user drive path for OneDrive', async () => {
    mockGraph({ value: [] });
    await browseOneDrive({ userId: 'user@contoso.com', prefix: '' });
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/users/user%40contoso.com/drive/root/children');
  });
});

describe('reachability test', () => {
  it('passes when Graph returns the folder children', async () => {
    mockGraph({ value: [] });
    await expect(testGraphTarget(buildSharePointUri('s', 'd', 'f'))).resolves.toBeUndefined();
  });

  it('maps a 403 to an auth-failure ShortcutSourceError', async () => {
    mockGraph({ error: { message: 'denied' } }, 403);
    await expect(testGraphTarget(buildOneDriveUri('u', ''))).rejects.toMatchObject({
      code: 'sharepoint_auth_failure',
      status: 403,
    });
  });
});
