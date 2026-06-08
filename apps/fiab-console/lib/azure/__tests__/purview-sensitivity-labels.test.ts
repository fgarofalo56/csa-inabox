/**
 * Unit tests for purview-client.listSensitivityLabels — the CLASSIC Data Map
 * source of MIP sensitivity labels (Atlas classification typedefs named
 * `MICROSOFT.GOVERNANCE.LABELS.<guid>`).
 *
 * Asserts:
 *  - throws when LOOM_PURVIEW_ACCOUNT is unset (honest gate)
 *  - parses only the label typedefs, extracting the GUID as the id
 *  - returns [] honestly when no label typedefs exist (no mock list)
 *  - CLOUD MATRIX: the Data Map host uses the `.purview.azure.com` suffix in
 *    Commercial and `.purview.azure.us` in the US Government clouds.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

let gov = false;
vi.mock('../cloud-endpoints', () => ({ isGovCloud: () => gov }));

import { listSensitivityLabels, PurviewNotConfiguredError, SENSITIVITY_LABEL_TYPEDEF_PREFIX } from '../purview-client';

const realFetch = global.fetch;
const HEADERS = [
  { name: 'MICROSOFT.GOVERNANCE.LABELS.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', category: 'CLASSIFICATION', guid: 'g1' },
  { name: 'MICROSOFT.GOVERNANCE.LABELS.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', category: 'CLASSIFICATION', guid: 'g2' },
  { name: 'MICROSOFT.PII.SSN', category: 'CLASSIFICATION', guid: 'g3' }, // NOT a label — must be filtered out
];

afterEach(() => {
  delete process.env.LOOM_PURVIEW_ACCOUNT;
  gov = false;
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('listSensitivityLabels', () => {
  it('throws PurviewNotConfiguredError when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    await expect(listSensitivityLabels()).rejects.toBeInstanceOf(PurviewNotConfiguredError);
  });

  it('keeps only label typedefs and extracts the GUID as the id', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    global.fetch = vi.fn(async () => new Response(JSON.stringify(HEADERS), { status: 200 })) as any;
    const out = await listSensitivityLabels();
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.typedefName.startsWith(SENSITIVITY_LABEL_TYPEDEF_PREFIX))).toBe(true);
    expect(out[0].id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('returns [] honestly when no label typedefs exist', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    global.fetch = vi.fn(async () => new Response('[]', { status: 200 })) as any;
    expect(await listSensitivityLabels()).toEqual([]);
  });

  it('CLOUD MATRIX — Commercial uses the .purview.azure.com host', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    gov = false;
    let url = '';
    global.fetch = vi.fn(async (u: any) => { url = String(u); return new Response('[]', { status: 200 }); }) as any;
    await listSensitivityLabels();
    expect(url).toContain('purview-test.purview.azure.com');
    expect(url).not.toContain('.purview.azure.us');
    expect(url).toContain('/datamap/api/atlas/v2/types/typedefs/headers');
  });

  it('CLOUD MATRIX — US Government uses the .purview.azure.us host', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    gov = true;
    let url = '';
    global.fetch = vi.fn(async (u: any) => { url = String(u); return new Response('[]', { status: 200 }); }) as any;
    await listSensitivityLabels();
    expect(url).toContain('purview-test.purview.azure.us');
    expect(url).not.toContain('.purview.azure.com');
  });
});
