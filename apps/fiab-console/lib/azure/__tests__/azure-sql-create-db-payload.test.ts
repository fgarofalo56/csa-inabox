/**
 * Cloud-matrix + ARM PUT payload test for createDatabase() — exercises the
 * azure-sql-client directly (no BFF layer), spying on global.fetch to capture
 * the exact URL + body sent to ARM. Verifies:
 *
 *   1. The advanced create options (collation, requestedBackupStorageRedundancy,
 *      maintenanceConfigurationId) land inside `properties` of the PUT body.
 *   2. zoneRedundant is passed through as a boolean.
 *   3. The ARM host switches per sovereign cloud:
 *        Commercial  → management.azure.com
 *        GCC-High    → management.usgovcloudapi.net
 *   4. The api-version on the PUT is ≥ 2022-05-01-preview.
 *
 * @azure/identity is mocked so credential.getToken() returns a fake token and
 * no real MI/AAD call is made.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// azure-sql-client imports the `mssql` TDS driver at module top for the query
// path. createDatabase() (the unit under test) never touches it — it is pure
// ARM REST — so stub the driver to keep the import graph lean and avoid loading
// the tedious/identity native stack for an ARM-only test.
vi.mock('mssql', () => ({ default: {}, ConnectionPool: class {} }));

// Mock the token credential so module-load construction + getToken() never
// touch a real identity endpoint, regardless of which credential path the
// client picks (ChainedTokenCredential when LOOM_UAMI_CLIENT_ID is set,
// DefaultAzureCredential otherwise).
vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-arm-token', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return {
    ChainedTokenCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ManagedIdentityCredential: FakeCred,
  };
});

const ORIG_CLOUD = process.env.LOOM_CLOUD;
const ORIG_ARM = process.env.LOOM_ARM_ENDPOINT;

afterEach(() => {
  if (ORIG_CLOUD === undefined) delete process.env.LOOM_CLOUD; else process.env.LOOM_CLOUD = ORIG_CLOUD;
  if (ORIG_ARM === undefined) delete process.env.LOOM_ARM_ENDPOINT; else process.env.LOOM_ARM_ENDPOINT = ORIG_ARM;
  vi.restoreAllMocks();
});

// Full ARM server id so createDatabase resolves the scope directly and never
// calls listServers (location is passed explicitly) — the only fetch is the PUT.
const SERVER_ID = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Sql/servers/srv';

describe('createDatabase — ARM PUT payload (no BFF layer)', () => {
  it('Commercial: PUT goes to management.azure.com with collation + backupRedundancy + maintenanceConfigId in properties', async () => {
    delete process.env.LOOM_CLOUD;        // default → Commercial
    delete process.env.LOOM_ARM_ENDPOINT; // no override

    const captured: { url: string; body: any }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      captured.push({ url, body });
      return new Response(JSON.stringify({ id: `${SERVER_ID}/databases/testdb`, properties: { status: 'Creating' } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    });

    const { createDatabase } = await import('../azure-sql-client');
    const result = await createDatabase({
      server: SERVER_ID,
      name: 'testdb',
      location: 'eastus2',
      collation: 'Latin1_General_100_CI_AS_SC_UTF8',
      zoneRedundant: true,
      requestedBackupStorageRedundancy: 'Zone',
      maintenanceConfigurationId: '/subscriptions/sub-1/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_1',
    });

    expect(result.ok).toBe(true);
    const put = captured.find((r) => r.url.includes('/databases/testdb'));
    expect(put).toBeTruthy();
    expect(put!.url).toContain('https://management.azure.com');
    // api-version must be >= 2022-05-01-preview for these properties.
    const m = put!.url.match(/api-version=(\d{4})-(\d{2})/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2022);
    expect(put!.body.properties.collation).toBe('Latin1_General_100_CI_AS_SC_UTF8');
    expect(put!.body.properties.zoneRedundant).toBe(true);
    expect(put!.body.properties.requestedBackupStorageRedundancy).toBe('Zone');
    expect(put!.body.properties.maintenanceConfigurationId).toContain('SQL_EastUS2_DB_1');
  });

  it('GCC-High: PUT host switches to management.usgovcloudapi.net', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    delete process.env.LOOM_ARM_ENDPOINT;

    const urls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      urls.push(typeof input === 'string' ? input : input.url);
      return new Response(JSON.stringify({ id: `${SERVER_ID}/databases/govdb`, properties: { status: 'Creating' } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    });

    const { createDatabase } = await import('../azure-sql-client');
    const result = await createDatabase({
      server: SERVER_ID, name: 'govdb', location: 'usgovvirginia',
      collation: 'SQL_Latin1_General_CP1_CI_AS',
    });

    expect(result.ok).toBe(true);
    expect(urls.some((u) => u.includes('management.usgovcloudapi.net'))).toBe(true);
    expect(urls.some((u) => u.includes('management.azure.com'))).toBe(false);
  });
});
