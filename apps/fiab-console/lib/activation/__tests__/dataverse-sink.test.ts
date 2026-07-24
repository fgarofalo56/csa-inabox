import { describe, it, expect, vi } from 'vitest';
import { formatKeyValue, writeToDataverse, type DataverseWriteRow } from '../dataverse-sink';

describe('dataverse-sink — formatKeyValue', () => {
  it('quotes strings and URL-encodes, leaves numbers bare, doubles quotes', () => {
    expect(formatKeyValue('a@b.com')).toBe("'a%40b.com'");
    expect(formatKeyValue(42)).toBe('42');
    expect(formatKeyValue("O'Brien")).toBe("'O''Brien'");
  });
});

describe('dataverse-sink — writeToDataverse (idempotent upsert)', () => {
  const config = { environmentId: 'env', entitySetName: 'contacts', keyAttribute: 'emailaddress1', instanceUrl: 'https://org.crm.dynamics.com' };
  const rows: DataverseWriteRow[] = [
    { keyValue: 'a@b.com', fields: { firstname: 'A' }, op: 'upsert' },
    { keyValue: 'c@d.com', fields: { firstname: 'C' }, op: 'delete' },
  ];

  it('PATCHes upserts by alternate key and DELETEs deletes on the same key URL', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => {
      calls.push({ method: init.method, url: String(url), body: init.body });
      return { ok: true, status: init.method === 'DELETE' ? 204 : 204, text: async () => '' } as any;
    });
    const res = await writeToDataverse(config, rows, { fetchImpl: fetchImpl as any, getToken: async () => 'tok', resolveInstanceUrl: async () => config.instanceUrl });
    expect(res.upserts).toBe(1);
    expect(res.deletes).toBe(1);
    expect(res.errors).toBe(0);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe("https://org.crm.dynamics.com/api/data/v9.2/contacts(emailaddress1='a%40b.com')");
    expect(calls[1].method).toBe('DELETE');
  });

  it('is idempotent — re-running the same batch converges (same PATCH URLs)', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => {
      urls.push(String(url));
      return { ok: true, status: 204, text: async () => '' } as any;
    });
    const deps = { fetchImpl: fetchImpl as any, getToken: async () => 'tok', resolveInstanceUrl: async () => config.instanceUrl };
    await writeToDataverse(config, [rows[0]], deps);
    await writeToDataverse(config, [rows[0]], deps);
    expect(urls[0]).toBe(urls[1]); // same key URL ⇒ create-or-update converges
  });

  it('tolerates a 404 on delete (already gone) as success', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'Not Found' } as any));
    const res = await writeToDataverse(config, [rows[1]], { fetchImpl: fetchImpl as any, getToken: async () => 'tok', resolveInstanceUrl: async () => config.instanceUrl });
    expect(res.deletes).toBe(1);
    expect(res.errors).toBe(0);
  });

  it('counts a non-auth failure as a row error without aborting the batch', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1
        ? ({ ok: false, status: 400, text: async () => 'bad row' } as any)
        : ({ ok: true, status: 204, text: async () => '' } as any);
    });
    const res = await writeToDataverse(config, [
      { keyValue: 'x', fields: {}, op: 'upsert' },
      { keyValue: 'y', fields: {}, op: 'upsert' },
    ], { fetchImpl: fetchImpl as any, getToken: async () => 'tok', resolveInstanceUrl: async () => config.instanceUrl });
    expect(res.errors).toBe(1);
    expect(res.upserts).toBe(1);
    expect(res.firstError).toContain('bad row');
  });
});
