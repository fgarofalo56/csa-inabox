/**
 * Unit tests for the SAS-authenticated EXTERNAL ADLS Gen2 connector
 * (shortcut-client.ts). This is the regression guard for the "failed to fetch"
 * defect: the wizard's "External (URI + SAS/key)" mode must build a real
 * `https://…dfs…` List-Path URL with the SAS appended EXACTLY ONCE — the
 * `abfss://` scheme must NEVER reach fetch(). All SAS values here are obviously
 * fake placeholders, never real tokens.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  appendSasToken,
  buildAdlsSasListUrl,
  listAdlsWithSas,
  probeAdlsSas,
  ShortcutSourceError,
} from '../shortcut-client';

// A deliberately fake SAS query string (no real signature material).
const FAKE_SAS = 'sv=2024-11-04&ss=b&srt=co&sp=rl&se=2030-01-01T00:00:00Z&sig=FAKE_SIGNATURE_NOT_REAL';

const DFS_JSON = JSON.stringify({
  paths: [
    { name: 'raw/2026', isDirectory: 'true' },
    { name: 'raw/events.parquet', contentLength: '512', lastModified: 'Mon, 01 Jun 2026 00:00:00 GMT', etag: 'e1' },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LOOM_CLOUD_BOUNDARY;
  delete process.env.AZURE_GOV_CLOUD;
});

describe('appendSasToken', () => {
  it('appends with & when the URL already has a query string, stripping a leading ?', () => {
    expect(appendSasToken('https://x/y?a=1', '?' + FAKE_SAS)).toBe(`https://x/y?a=1&${FAKE_SAS}`);
  });
  it('appends with ? when the URL has no query string', () => {
    expect(appendSasToken('https://x/y', FAKE_SAS)).toBe(`https://x/y?${FAKE_SAS}`);
  });
  it('never produces a double-?', () => {
    const out = appendSasToken('https://x/y?resource=filesystem', '??' + FAKE_SAS);
    expect((out.match(/\?/g) || []).length).toBe(1);
  });
});

describe('buildAdlsSasListUrl', () => {
  it('builds an https DFS List-Path URL — never abfss — with the SAS appended once', () => {
    const url = buildAdlsSasListUrl('contosolake', 'raw', 'partner/exports', '?' + FAKE_SAS, 1);
    expect(url.startsWith('https://contosolake.dfs.core.windows.net/raw?')).toBe(true);
    expect(url).not.toContain('abfss://');
    expect(url).toContain('resource=filesystem');
    expect(url).toContain('recursive=false');
    expect(url).toContain('directory=partner');
    // SAS appended exactly once (one signature occurrence, no leading ?-of-SAS).
    expect((url.match(/sig=FAKE_SIGNATURE_NOT_REAL/g) || []).length).toBe(1);
    expect(url).not.toContain('?sv=2024'); // SAS joined with & not a 2nd ?
  });

  it('accepts a full dfs/blob host and normalises to the account name', () => {
    const url = buildAdlsSasListUrl('contosolake.dfs.core.windows.net', 'raw', '', FAKE_SAS, 5);
    expect(url.startsWith('https://contosolake.dfs.core.windows.net/raw?')).toBe(true);
  });
});

describe('listAdlsWithSas', () => {
  it('does a signed https GET and parses folders + files', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(DFS_JSON, { status: 200 }) as any);
    const res = await listAdlsWithSas({ account: 'contosolake', container: 'raw', path: 'raw', sasToken: FAKE_SAS });
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url.startsWith('https://contosolake.dfs.core.windows.net/raw?')).toBe(true);
    expect(url).not.toContain('abfss://');
    expect(res.entries[0]).toMatchObject({ name: '2026', isDirectory: true });
    expect(res.entries[1]).toMatchObject({ name: 'events.parquet', isDirectory: false, size: 512 });
    fetchSpy.mockRestore();
  });

  it('maps a 403 to adls_sas_auth_failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('AuthenticationFailed', { status: 403 }) as any);
    await expect(listAdlsWithSas({ account: 'a', container: 'c', sasToken: FAKE_SAS }))
      .rejects.toMatchObject({ code: 'adls_sas_auth_failure' });
    fetchSpy.mockRestore();
  });

  it('rejects when the SAS is missing', async () => {
    await expect(listAdlsWithSas({ account: 'a', container: 'c', sasToken: '' }))
      .rejects.toMatchObject({ code: 'adls_sas_missing' });
  });
});

describe('probeAdlsSas', () => {
  it('parses an abfss target, lists via SAS, and returns the abfss read address', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(DFS_JSON, { status: 200 }) as any);
    const out = await probeAdlsSas('abfss://raw@contosolake.dfs.core.windows.net/partner', FAKE_SAS);
    // Probe hits the https endpoint, not abfss.
    expect(String(fetchSpy.mock.calls[0][0])).toContain('https://contosolake.dfs.core.windows.net/raw?');
    expect(out.abfssUri).toBe('abfss://raw@contosolake.dfs.core.windows.net/partner');
    fetchSpy.mockRestore();
  });

  it('throws a typed error on a bad target URI', async () => {
    await expect(probeAdlsSas('https://not-abfss', FAKE_SAS)).rejects.toBeInstanceOf(ShortcutSourceError);
  });
});
