/**
 * uploadFile and downloadFile go through the storage account they are given.
 *
 * The upload, download and history routes pass the lakehouse item's bound
 * account to these functions (pinned in their route tests, which mock this
 * module). This file pins the other half: each function builds its client for
 * that account, not for the account the container env vars name.
 *
 * The DataLake SDK is replaced by a recorder, so the assertions read the URL
 * each service client was constructed with and which client the upload went to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rec = vi.hoisted(() => ({
  constructed: [] as string[],
  uploads: [] as { url: string; container: string; path: string }[],
  reads: [] as { url: string; container: string; path: string }[],
}));

vi.mock('@/lib/azure/workspace-credential-factory', () => ({
  workspaceScopedCredential: () => ({ getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 60_000 }) }),
}));

vi.mock('@azure/storage-file-datalake', () => {
  class DataLakeServiceClient {
    url: string;
    constructor(url: string) { this.url = url; rec.constructed.push(url); }
    getFileSystemClient(container: string) {
      const url = this.url;
      return {
        getFileClient: (path: string) => ({
          upload: async () => { rec.uploads.push({ url, container, path }); },
          readToBuffer: async () => { rec.reads.push({ url, container, path }); return Buffer.from('abc'); },
          getProperties: async () => ({ etag: '"e1"', contentType: 'text/csv' }),
        }),
      };
    }
  }
  return { DataLakeServiceClient };
});

const PRIMARY = 'primaryacct';
const BOUND = 'boundacct';
const saved = process.env.LOOM_BRONZE_URL;

beforeEach(() => {
  vi.resetModules();
  rec.constructed.length = 0;
  rec.uploads.length = 0;
  rec.reads.length = 0;
  process.env.LOOM_BRONZE_URL = `https://${PRIMARY}.dfs.core.windows.net/bronze`;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_BRONZE_URL; else process.env.LOOM_BRONZE_URL = saved;
});

describe('uploadFile account', () => {
  it('writes to the account it is given, not the configured one', async () => {
    const { uploadFile } = await import('../adls-client');
    const res = await uploadFile('bronze', 'Files/a.csv', Buffer.from('abc'), 'text/csv', BOUND);
    expect(res).toEqual({ ok: true, size: 3, etag: '"e1"' });
    // Breaks if uploadFile stops forwarding `account` to getFileSystem: the
    // upload would then go through the client built for PRIMARY.
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0].url).toContain(`//${BOUND}.`);
    expect(rec.uploads[0].url).not.toContain(PRIMARY);
    expect(rec.uploads[0]).toMatchObject({ container: 'bronze', path: 'Files/a.csv' });
  });

  it('uses the configured account when none is given', async () => {
    // The control for the case above: without it, a recorder that never saw
    // the env account could not tell "forwarded" from "always BOUND".
    const { uploadFile } = await import('../adls-client');
    await uploadFile('bronze', 'Files/b.csv', Buffer.from('x'), 'text/csv');
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0].url).toContain(`//${PRIMARY}.`);
  });
});

describe('downloadFile account', () => {
  it('reads from the account it is given, not the configured one', async () => {
    const { downloadFile } = await import('../adls-client');
    const res = await downloadFile('bronze', 'Files/a.csv', BOUND);
    expect([res.body.toString(), res.size, res.contentType]).toEqual(['abc', 3, 'text/csv']);
    // Breaks if downloadFile stops forwarding `account` to getFileSystem: the
    // read would then go through the client built for PRIMARY.
    expect(rec.reads).toHaveLength(1);
    expect(rec.reads[0].url).toContain(`//${BOUND}.`);
    expect(rec.reads[0].url).not.toContain(PRIMARY);
    expect(rec.reads[0]).toMatchObject({ container: 'bronze', path: 'Files/a.csv' });
  });

  it('uses the configured account when none is given', async () => {
    // Control for the case above, as for uploadFile.
    const { downloadFile } = await import('../adls-client');
    await downloadFile('bronze', 'Files/b.csv');
    expect(rec.reads).toHaveLength(1);
    expect(rec.reads[0].url).toContain(`//${PRIMARY}.`);
  });
});
