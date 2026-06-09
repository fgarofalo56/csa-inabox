import { describe, it, expect, afterEach } from 'vitest';
import { httpsToAbfss } from '../cloud-endpoints';

const ORIG_LOOM = process.env.LOOM_CLOUD;
const ORIG_AZURE = process.env.AZURE_CLOUD;

afterEach(() => {
  if (ORIG_LOOM === undefined) delete process.env.LOOM_CLOUD;
  else process.env.LOOM_CLOUD = ORIG_LOOM;
  if (ORIG_AZURE === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = ORIG_AZURE;
});

function withCloud(loomCloud: string) {
  process.env.LOOM_CLOUD = loomCloud;
  delete process.env.AZURE_CLOUD;
}

describe('httpsToAbfss — sovereign-cloud aware dfs URL → abfss conversion', () => {
  it('converts a Commercial dfs https URL to abfss', () => {
    withCloud('Commercial');
    expect(
      httpsToAbfss('https://saloom.dfs.core.windows.net/bronze/mirrors/ws1/m1/dbo.T/'),
    ).toBe('abfss://bronze@saloom.dfs.core.windows.net/mirrors/ws1/m1/dbo.T/');
  });

  it('GCC uses Commercial endpoints — converts the windows.net dfs URL', () => {
    withCloud('GCC');
    expect(
      httpsToAbfss('https://saloom.dfs.core.windows.net/bronze/path/'),
    ).toBe('abfss://bronze@saloom.dfs.core.windows.net/path/');
  });

  it('REGRESSION (BUG-3): GCC-High converts the usgovcloudapi dfs URL (not passed through)', () => {
    withCloud('GCC-High');
    const gov = 'https://saloom.dfs.core.usgovcloudapi.net/bronze/mirrors/ws1/m1/dbo.T/';
    const out = httpsToAbfss(gov);
    expect(out).toBe('abfss://bronze@saloom.dfs.core.usgovcloudapi.net/mirrors/ws1/m1/dbo.T/');
    // It must NOT return the https URL unchanged (the pre-fix bug).
    expect(out).not.toBe(gov);
    expect(out.startsWith('abfss://')).toBe(true);
  });

  it('IL5 (alias of GCC-High) converts the usgovcloudapi dfs URL', () => {
    withCloud('IL5');
    expect(
      httpsToAbfss('https://saloom.dfs.core.usgovcloudapi.net/bronze/p/'),
    ).toBe('abfss://bronze@saloom.dfs.core.usgovcloudapi.net/p/');
  });

  it('returns a non-dfs URL unchanged', () => {
    withCloud('Commercial');
    expect(httpsToAbfss('https://example.com/not-a-dfs-url')).toBe('https://example.com/not-a-dfs-url');
  });

  it('returns the empty string unchanged', () => {
    expect(httpsToAbfss('')).toBe('');
  });
});
