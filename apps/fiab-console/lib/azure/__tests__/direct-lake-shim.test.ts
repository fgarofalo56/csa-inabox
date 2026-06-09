import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { pbiRestScope, xmlaEndpointFromWorkspace } from '../cloud-endpoints';
import { parseDeltaSource, toAbfss, toHttps } from '../delta-source-uri';
import { aasApiBase, shimEnabled, SHIM_DISABLED_HINT } from '../aas-client';
import { SHIM_REFRESH_POLICIES } from '../direct-lake-config-store';

const ENV_KEYS = [
  'LOOM_CLOUD', 'AZURE_CLOUD', 'LOOM_AAS_SCOPE',
  'LOOM_DIRECT_LAKE_SHIM_ENABLED', 'LOOM_POWERBI_BASE',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

function withCloud(c: string) {
  process.env.LOOM_CLOUD = c;
  delete process.env.AZURE_CLOUD;
}

describe('pbiRestScope — sovereign Power BI / AAS XMLA audience (4-way split)', () => {
  it('Commercial → analysis.windows.net', () => {
    withCloud('Commercial');
    expect(pbiRestScope()).toBe('https://analysis.windows.net/powerbi/api/.default');
  });
  it('GCC → analysis.usgovcloudapi.net', () => {
    withCloud('GCC');
    expect(pbiRestScope()).toBe('https://analysis.usgovcloudapi.net/powerbi/api/.default');
  });
  it('GCC-High → high.analysis.usgovcloudapi.net', () => {
    withCloud('GCC-High');
    expect(pbiRestScope()).toBe('https://high.analysis.usgovcloudapi.net/powerbi/api/.default');
  });
  it('DoD → mil.analysis.usgovcloudapi.net', () => {
    withCloud('DoD');
    expect(pbiRestScope()).toBe('https://mil.analysis.usgovcloudapi.net/powerbi/api/.default');
  });
  it('LOOM_AAS_SCOPE overrides outright (e.g. China)', () => {
    withCloud('Commercial');
    process.env.LOOM_AAS_SCOPE = 'https://analysis.chinacloudapi.cn/powerbi/api/.default';
    expect(pbiRestScope()).toBe('https://analysis.chinacloudapi.cn/powerbi/api/.default');
  });
});

describe('xmlaEndpointFromWorkspace', () => {
  it('Commercial uses the api.powerbi.com host', () => {
    withCloud('Commercial');
    expect(xmlaEndpointFromWorkspace('ws-123')).toBe('powerbi://api.powerbi.com/v1.0/myorg/ws-123');
  });
  it('Gov uses the api.powerbigov.us host', () => {
    withCloud('GCC-High');
    expect(xmlaEndpointFromWorkspace('ws-9')).toBe('powerbi://api.powerbigov.us/v1.0/myorg/ws-9');
  });
});

describe('parseDeltaSource', () => {
  it('parses abfss://container@account.dfs.suffix/path', () => {
    const r = parseDeltaSource('abfss://gold@lakeacct.dfs.core.windows.net/fact_sales/v1');
    expect(r).toEqual({ account: 'lakeacct', container: 'gold', path: 'fact_sales/v1' });
  });
  it('parses https dfs URL', () => {
    const r = parseDeltaSource('https://lakeacct.dfs.core.windows.net/gold/fact_sales');
    expect(r).toEqual({ account: 'lakeacct', container: 'gold', path: 'fact_sales' });
  });
  it('parses https blob URL', () => {
    const r = parseDeltaSource('https://lakeacct.blob.core.usgovcloudapi.net/silver/dim_date/');
    expect(r).toEqual({ account: 'lakeacct', container: 'silver', path: 'dim_date' });
  });
  it('returns null for a non-ADLS URI', () => {
    expect(parseDeltaSource('s3://bucket/key')).toBeNull();
    expect(parseDeltaSource('')).toBeNull();
  });
});

describe('toAbfss / toHttps round-trip', () => {
  it('rebuilds an abfss URI (sovereign dfs suffix)', () => {
    withCloud('Commercial');
    const ref = { account: 'acct', container: 'gold', path: 'fact' };
    expect(toAbfss(ref)).toBe('abfss://gold@acct.dfs.core.windows.net/fact');
  });
  it('rebuilds a Gov https blob URL', () => {
    withCloud('GCC-High');
    const ref = { account: 'acct', container: 'gold', path: 'fact' };
    expect(toHttps(ref)).toBe('https://acct.blob.core.usgovcloudapi.net/gold/fact');
  });
});

describe('aasApiBase', () => {
  it('builds from the sovereign Power BI host', () => {
    withCloud('Commercial');
    expect(aasApiBase()).toBe('https://api.powerbi.com/v1.0/myorg');
    withCloud('GCC-High');
    expect(aasApiBase()).toBe('https://api.powerbigov.us/v1.0/myorg');
  });
  it('honours LOOM_POWERBI_BASE override (trailing slash trimmed)', () => {
    process.env.LOOM_POWERBI_BASE = 'https://custom.example/v1.0/myorg/';
    expect(aasApiBase()).toBe('https://custom.example/v1.0/myorg');
  });
});

describe('shimEnabled gate', () => {
  it('false when unset', () => {
    delete process.env.LOOM_DIRECT_LAKE_SHIM_ENABLED;
    expect(shimEnabled()).toBe(false);
  });
  it('true only for "true" (case-insensitive)', () => {
    process.env.LOOM_DIRECT_LAKE_SHIM_ENABLED = 'TRUE';
    expect(shimEnabled()).toBe(true);
    process.env.LOOM_DIRECT_LAKE_SHIM_ENABLED = '1';
    expect(shimEnabled()).toBe(false);
  });
  it('the disabled hint names the env var + the honest 5–30 s claim', () => {
    expect(SHIM_DISABLED_HINT).toContain('LOOM_DIRECT_LAKE_SHIM_ENABLED=true');
    expect(SHIM_DISABLED_HINT).toContain('Fabric F-SKU');
    expect(SHIM_DISABLED_HINT).toContain('5–30 s');
  });
});

describe('SHIM_REFRESH_POLICIES mirrors the C# RefreshPolicyKind enum', () => {
  it('has the four policy kinds', () => {
    expect(SHIM_REFRESH_POLICIES).toEqual(['Partition', 'Full', 'DirectQueryFallback', 'Composite']);
  });
});
