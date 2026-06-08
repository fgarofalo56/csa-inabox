/**
 * Unit tests for the shortcut external-source CONNECTORS (shortcut-client.ts).
 * They lock in the real wire format we emit (S3 SigV4 request line + auth header,
 * GCS JWT→token→list, ADLS delegation) and the parsing of each response into
 * RemoteEntry rows. `fetch` and adls-client `listPaths` are mocked — these
 * assert the request we build and the entries we parse, not live cloud calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../adls-client', () => ({
  listPaths: vi.fn(async () => []),
}));

import {
  listS3Objects, listGcsObjects, browseAdls, listDataverseEntities, parseAbfss,
  ShortcutSourceError,
} from '../shortcut-client';
import { listPaths } from '../adls-client';

const S3_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name><Prefix>data/</Prefix><Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes><Prefix>data/2026/</Prefix></CommonPrefixes>
  <Contents><Key>data/readme.txt</Key><Size>42</Size><LastModified>2026-06-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag></Contents>
</ListBucketResult>`;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LOOM_CLOUD_BOUNDARY;
});

describe('listS3Objects — SigV4 request + XML parse', () => {
  it('signs the request and parses folders + files', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(S3_XML, { status: 200 }) as any,
    );
    const res = await listS3Objects({
      bucket: 'my-bucket', region: 'us-east-1', prefix: 'data/',
      accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret123',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    // Path-style endpoint + ListObjectsV2 query.
    expect(String(url)).toContain('https://s3.us-east-1.amazonaws.com/my-bucket?');
    expect(String(url)).toContain('list-type=2');
    expect(String(url)).toContain('delimiter=%2F');
    // AWS SigV4 Authorization header present and well-formed.
    const auth = (init as any).headers.authorization as string;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    // Parsed entries: one folder, one file, folder first.
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ name: '2026', path: 'data/2026/', isDirectory: true });
    expect(res.entries[1]).toMatchObject({ name: 'readme.txt', path: 'data/readme.txt', isDirectory: false, size: 42, etag: 'abc' });
    expect(res.truncated).toBe(false);
    fetchSpy.mockRestore();
  });

  it('uses the GovCloud endpoint for us-gov regions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(S3_XML, { status: 200 }) as any);
    await listS3Objects({ bucket: 'b', region: 'us-gov-west-1', accessKeyId: 'A', secretAccessKey: 'S' });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('https://s3.us-gov-west-1.amazonaws.com/b');
    fetchSpy.mockRestore();
  });

  it('maps 403 to s3_auth_failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<Error/>', { status: 403 }) as any);
    await expect(listS3Objects({ bucket: 'b', region: 'us-east-1', accessKeyId: 'A', secretAccessKey: 'S' }))
      .rejects.toMatchObject({ code: 's3_auth_failure' });
    fetchSpy.mockRestore();
  });

  it('rejects when credentials are missing', async () => {
    await expect(listS3Objects({ bucket: 'b', region: 'us-east-1', accessKeyId: '', secretAccessKey: '' }))
      .rejects.toBeInstanceOf(ShortcutSourceError);
  });
});

describe('listGcsObjects — JWT token + list', () => {
  // A throwaway RSA key so createSign() succeeds in the JWT mint.
  const pk = (() => {
    const { generateKeyPairSync } = require('crypto');
    return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  })();
  const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: pk, private_key_id: 'kid1' };

  it('mints a token then lists prefixes + items', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-xyz' }), { status: 200 }) as any)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        prefixes: ['exports/2026/'],
        items: [{ name: 'exports/file.parquet', size: '128', updated: '2026-06-01T00:00:00Z', etag: 'e1' }],
      }), { status: 200 }) as any);

    const res = await listGcsObjects({ bucket: 'b', prefix: 'exports/', serviceAccount: sa });
    // First call = OAuth2 token endpoint with a JWT assertion.
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
    expect((fetchSpy.mock.calls[0][1] as any).body).toContain('assertion=');
    // Second call = JSON API list with the bearer token.
    expect(String(fetchSpy.mock.calls[1][0])).toContain('https://storage.googleapis.com/storage/v1/b/b/o?');
    expect((fetchSpy.mock.calls[1][1] as any).headers.authorization).toBe('Bearer tok-xyz');
    expect(res.entries[0]).toMatchObject({ name: '2026', isDirectory: true });
    expect(res.entries[1]).toMatchObject({ name: 'file.parquet', isDirectory: false, size: 128 });
    fetchSpy.mockRestore();
  });

  it('honest-gates GCS outside the Commercial cloud boundary', async () => {
    process.env.LOOM_CLOUD_BOUNDARY = 'gcc-high';
    await expect(listGcsObjects({ bucket: 'b', serviceAccount: sa }))
      .rejects.toMatchObject({ code: 'gcs_not_available_in_cloud' });
  });
});

describe('browseAdls — delegates to listPaths', () => {
  it('maps PathEntry rows to RemoteEntry relative to the prefix', async () => {
    (listPaths as any).mockResolvedValue([
      { name: 'silver/orders', isDirectory: true, size: 0 },
      { name: 'silver/orders.csv', isDirectory: false, size: 99, etag: 'x' },
    ]);
    const res = await browseAdls({ account: 'acct', container: 'fs', prefix: 'silver' });
    expect(listPaths).toHaveBeenCalledWith('fs', 'silver', 200, 'acct');
    expect(res.entries[0]).toMatchObject({ name: 'orders', isDirectory: true });
    expect(res.entries[1]).toMatchObject({ name: 'orders.csv', isDirectory: false, size: 99 });
  });

  it('maps a 403 from listPaths to adls_access_denied', async () => {
    (listPaths as any).mockRejectedValue(new Error('AuthorizationPermissionMismatch (403)'));
    await expect(browseAdls({ account: 'a', container: 'c' })).rejects.toMatchObject({ code: 'adls_access_denied' });
  });
});

describe('parseAbfss + listDataverseEntities', () => {
  it('parses account/container/path from an abfss URI', () => {
    const p = parseAbfss('abfss://dv@contoso.dfs.core.windows.net/exports/tables');
    expect(p).toEqual({ account: 'contoso', container: 'dv', path: 'exports/tables' });
  });

  it('lists Synapse-Link export folders via ADLS', async () => {
    (listPaths as any).mockResolvedValue([{ name: 'exports/account', isDirectory: true, size: 0 }]);
    const res = await listDataverseEntities({ exportAbfssUri: 'abfss://dv@contoso.dfs.core.windows.net/exports' });
    expect(listPaths).toHaveBeenCalledWith('dv', 'exports', 200, 'contoso');
    expect(res.entries[0]).toMatchObject({ isDirectory: true });
  });

  it('throws on a non-abfss Dataverse path', async () => {
    await expect(listDataverseEntities({ exportAbfssUri: 'https://nope' })).rejects.toMatchObject({ code: 'dataverse_bad_target' });
  });
});
