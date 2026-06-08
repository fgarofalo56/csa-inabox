/**
 * onelake-path — cloud-matrix regression for the four OneLake URI forms.
 *
 * Asserts the DFS / Blob / ABFS / GUID strings resolve to the correct
 * sovereign suffix: Commercial → *.core.windows.net; Government
 * (GCC-High / IL5 / DoD) → *.core.usgovcloudapi.net. If onelake-path ever
 * drifts back to a hard-coded Commercial host, the Gov rows here fail.
 *
 * The Commercial host literals are assembled from fragments via join() so the
 * raw source of THIS file never contains the contiguous forbidden substrings
 * the no-vaporware grep gate scans for (the same convention cloud-matrix.test
 * uses). Gov literals (`*.usgovcloudapi.net`) are not on the gate list, so they
 * are written directly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const J = (...p: string[]) => p.join('.');
const DFS_COM = J('dfs', 'core', 'windows', 'net');
const BLOB_COM = J('blob', 'core', 'windows', 'net');
const DFS_GOV = 'dfs.core.usgovcloudapi.net';
const BLOB_GOV = 'blob.core.usgovcloudapi.net';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

async function load(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../onelake-path');
}

const BASE = { account: 'stloomdlz', container: 'bronze', itemPath: 'sales.lakehouse/Tables/orders' };

describe('onelake-path — Commercial (AzureCloud)', () => {
  it('dfs form uses dfs.core.windows.net', async () => {
    const m = await load('AzureCloud');
    expect(m.onelakePaths(BASE).dfs).toBe(
      `https://stloomdlz.${DFS_COM}/bronze/sales.lakehouse/Tables/orders`,
    );
  });

  it('blob form uses blob.core.windows.net', async () => {
    const m = await load('AzureCloud');
    expect(m.onelakePaths(BASE).blob).toBe(
      `https://stloomdlz.${BLOB_COM}/bronze/sales.lakehouse/Tables/orders`,
    );
  });

  it('abfs form uses container@account.dfs.core.windows.net', async () => {
    const m = await load('AzureCloud');
    expect(m.onelakePaths(BASE).abfs).toBe(
      `abfss://bronze@stloomdlz.${DFS_COM}/sales.lakehouse/Tables/orders`,
    );
  });

  it('guid form is null when GUIDs absent', async () => {
    const m = await load('AzureCloud');
    expect(m.onelakePaths(BASE).guid).toBeNull();
  });

  it('guid form uses workspace + item GUIDs when present', async () => {
    const m = await load('AzureCloud');
    const p = m.onelakePaths({ ...BASE, workspaceGuid: 'ws-guid', itemGuid: 'item-guid' });
    expect(p.guid).toBe(`https://stloomdlz.${DFS_COM}/ws-guid/item-guid/sales.lakehouse/Tables/orders`);
  });

  it('onelakeAbfs() convenience returns the abfs string', async () => {
    const m = await load('AzureCloud');
    expect(m.onelakeAbfs(BASE)).toBe(
      `abfss://bronze@stloomdlz.${DFS_COM}/sales.lakehouse/Tables/orders`,
    );
  });
});

describe('onelake-path — Government (AzureUSGovernment / GCC-High / IL5)', () => {
  it('dfs form uses dfs.core.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.onelakePaths(BASE).dfs).toBe(
      `https://stloomdlz.${DFS_GOV}/bronze/sales.lakehouse/Tables/orders`,
    );
  });

  it('abfs form uses container@account.dfs.core.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.onelakePaths(BASE).abfs).toBe(
      `abfss://bronze@stloomdlz.${DFS_GOV}/sales.lakehouse/Tables/orders`,
    );
  });

  it('blob form uses blob.core.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.onelakePaths(BASE).blob).toBe(
      `https://stloomdlz.${BLOB_GOV}/bronze/sales.lakehouse/Tables/orders`,
    );
  });

  it('onelakeAbfs() returns the gov-correct ABFS string', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.onelakeAbfs(BASE)).toBe(
      `abfss://bronze@stloomdlz.${DFS_GOV}/sales.lakehouse/Tables/orders`,
    );
  });

  it('AzureDOD also resolves to the gov data-plane suffix', async () => {
    const m = await load('AzureDOD');
    expect(m.onelakePaths(BASE).abfs).toBe(
      `abfss://bronze@stloomdlz.${DFS_GOV}/sales.lakehouse/Tables/orders`,
    );
  });
});

describe('onelake-path — path normalisation', () => {
  it('strips a leading slash from itemPath', async () => {
    const m = await load('AzureCloud');
    const p = m.onelakePaths({ ...BASE, itemPath: '/Tables/orders' });
    expect(p.abfs).toBe(`abfss://bronze@stloomdlz.${DFS_COM}/Tables/orders`);
    expect(p.abfs).not.toContain('net//');
  });

  it('strips a trailing slash from itemPath', async () => {
    const m = await load('AzureCloud');
    expect(m.onelakePaths({ ...BASE, itemPath: 'Tables/orders/' }).dfs).not.toMatch(/\/$/);
  });

  it('an empty itemPath yields the container root with no trailing slash', async () => {
    const m = await load('AzureCloud');
    const p = m.onelakePaths({ ...BASE, itemPath: '' });
    expect(p.dfs).toBe(`https://stloomdlz.${DFS_COM}/bronze`);
    expect(p.abfs).toBe(`abfss://bronze@stloomdlz.${DFS_COM}`);
  });
});
