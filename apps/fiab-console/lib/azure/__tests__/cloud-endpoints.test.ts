import { describe, it, expect, afterEach } from 'vitest';
import {
  powerPlatformEndpoints,
  assertPowerPlatformAvailable,
  detectLoomCloud,
  getDfsSuffix,
  getArmEndpoint,
  getKustoSuffix,
  getArmHost,
  getCosmosSuffix,
  getSearchSuffix,
  searchAadScope,
  getGraphHost,
  getGraphScope,
  getSqlSuffix,
  synapseSqlSuffix,
  getAasSuffix,
  getLogAnalyticsHost,
  getBlobSuffix,
  getOpenAiSuffix,
  getPbiGovHost,
  getPbiScope,
  getPbiEmbedHostname,
  getCostManagementBase,
  getCostManagementScope,
  getMonitorBase,
  getMonitorScope,
  getDevOpsBase,
  getAppConfigSuffix,
  getAppConfigScope,
  appConfigSuffixFromEndpoint,
  appConfigEndpointFromName,
  aasSuffix,
} from '../cloud-endpoints';

const ORIG_LOOM = process.env.LOOM_CLOUD;
const ORIG_AZURE = process.env.AZURE_CLOUD;

afterEach(() => {
  if (ORIG_LOOM === undefined) delete process.env.LOOM_CLOUD;
  else process.env.LOOM_CLOUD = ORIG_LOOM;
  if (ORIG_AZURE === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = ORIG_AZURE;
});

/** Pin LOOM_CLOUD and clear the legacy AZURE_CLOUD fallback for the case. */
function withCloud(loomCloud: string) {
  process.env.LOOM_CLOUD = loomCloud;
  delete process.env.AZURE_CLOUD;
}

const CLOUDS = ['Commercial', 'GCC', 'GCC-High', 'DoD'] as const;

describe('detectLoomCloud — 4-way boundary discriminator', () => {
  it('defaults to Commercial when neither env var is set', () => {
    delete process.env.LOOM_CLOUD;
    delete process.env.AZURE_CLOUD;
    expect(detectLoomCloud()).toBe('Commercial');
  });

  it.each(CLOUDS)('maps LOOM_CLOUD=%s to itself', (c) => {
    withCloud(c);
    expect(detectLoomCloud()).toBe(c);
  });

  it('treats LOOM_CLOUD=IL5 as GCC-High', () => {
    withCloud('IL5');
    expect(detectLoomCloud()).toBe('GCC-High');
  });

  it('is case-insensitive', () => {
    withCloud('gcc-high');
    expect(detectLoomCloud()).toBe('GCC-High');
  });

  it('falls back to AZURE_CLOUD when LOOM_CLOUD is unset', () => {
    delete process.env.LOOM_CLOUD;
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(detectLoomCloud()).toBe('GCC-High');
    process.env.AZURE_CLOUD = 'AzureDOD';
    expect(detectLoomCloud()).toBe('DoD');
  });

  it('defaults unknown LOOM_CLOUD values to Commercial', () => {
    withCloud('Narnia');
    expect(detectLoomCloud()).toBe('Commercial');
  });
});

// Per-getter expected value for each of the 4 clouds.
const TABLE: Record<string, Record<(typeof CLOUDS)[number], string>> = {
  getArmHost: {
    Commercial: 'management.azure.com',
    GCC: 'management.azure.com',
    'GCC-High': 'management.usgovcloudapi.net',
    DoD: 'management.azure.microsoft.scloud',
  },
  getArmEndpoint: {
    Commercial: 'https://management.azure.com',
    GCC: 'https://management.azure.com',
    'GCC-High': 'https://management.usgovcloudapi.net',
    DoD: 'https://management.azure.microsoft.scloud',
  },
  getCosmosSuffix: {
    Commercial: 'documents.azure.com',
    GCC: 'documents.azure.com',
    'GCC-High': 'documents.azure.us',
    DoD: 'documents.azure.us',
  },
  getSearchSuffix: {
    Commercial: 'search.windows.net',
    GCC: 'search.windows.net',
    'GCC-High': 'search.azure.us',
    DoD: 'search.azure.us',
  },
  searchAadScope: {
    Commercial: 'https://search.azure.com/.default',
    GCC: 'https://search.azure.com/.default',
    'GCC-High': 'https://search.azure.us/.default',
    DoD: 'https://search.azure.us/.default',
  },
  getGraphHost: {
    Commercial: 'https://graph.microsoft.com',
    GCC: 'https://graph.microsoft.com',
    'GCC-High': 'https://graph.microsoft.us',
    DoD: 'https://dod-graph.microsoft.us',
  },
  getGraphScope: {
    Commercial: 'https://graph.microsoft.com/.default',
    GCC: 'https://graph.microsoft.com/.default',
    'GCC-High': 'https://graph.microsoft.us/.default',
    DoD: 'https://dod-graph.microsoft.us/.default',
  },
  getSqlSuffix: {
    Commercial: 'database.windows.net',
    GCC: 'database.windows.net',
    'GCC-High': 'database.usgovcloudapi.net',
    DoD: 'database.usgovcloudapi.net',
  },
  synapseSqlSuffix: {
    Commercial: 'sql.azuresynapse.net',
    GCC: 'sql.azuresynapse.net',
    'GCC-High': 'sql.azuresynapse.usgovcloudapi.net',
    DoD: 'sql.azuresynapse.usgovcloudapi.net',
  },
  getAasSuffix: {
    Commercial: 'asazure.windows.net',
    GCC: 'asazure.windows.net',
    'GCC-High': 'asazure.usgovcloudapi.net',
    DoD: 'asazure.usgovcloudapi.net',
  },
  aasSuffix: {
    Commercial: 'asazure.windows.net',
    GCC: 'asazure.windows.net',
    'GCC-High': 'asazure.usgovcloudapi.net',
    DoD: 'asazure.usgovcloudapi.net',
  },
  getLogAnalyticsHost: {
    Commercial: 'https://api.loganalytics.azure.com',
    GCC: 'https://api.loganalytics.azure.com',
    'GCC-High': 'https://api.loganalytics.us',
    DoD: 'https://api.loganalytics.us',
  },
  getBlobSuffix: {
    Commercial: 'blob.core.windows.net',
    GCC: 'blob.core.windows.net',
    'GCC-High': 'blob.core.usgovcloudapi.net',
    DoD: 'blob.core.usgovcloudapi.net',
  },
  getOpenAiSuffix: {
    Commercial: 'openai.azure.com',
    GCC: 'openai.azure.com',
    'GCC-High': 'openai.azure.us',
    DoD: 'openai.azure.us',
  },
  getPbiGovHost: {
    Commercial: 'https://api.powerbi.com',
    GCC: 'https://api.powerbi.com',
    'GCC-High': 'https://api.powerbigov.us',
    DoD: 'https://api.powerbigov.us',
  },
  getPbiScope: {
    Commercial: 'https://analysis.windows.net/powerbi/api/.default',
    GCC: 'https://analysis.usgovcloudapi.net/powerbi/api/.default',
    'GCC-High': 'https://high.analysis.usgovcloudapi.net/powerbi/api/.default',
    DoD: 'https://mil.analysis.usgovcloudapi.net/powerbi/api/.default',
  },
  getPbiEmbedHostname: {
    Commercial: 'https://app.powerbi.com',
    GCC: 'https://app.powerbi.com',
    'GCC-High': 'https://app.powerbigov.us',
    DoD: 'https://app.mil.powerbigov.us',
  },
  getDfsSuffix: {
    Commercial: 'dfs.core.windows.net',
    GCC: 'dfs.core.windows.net',
    'GCC-High': 'dfs.core.usgovcloudapi.net',
    DoD: 'dfs.core.usgovcloudapi.net',
  },
  getKustoSuffix: {
    Commercial: 'kusto.windows.net',
    GCC: 'kusto.windows.net',
    'GCC-High': 'kusto.usgovcloudapi.net',
    DoD: 'kusto.usgovcloudapi.net',
  },
  getCostManagementBase: {
    Commercial: 'https://management.azure.com',
    GCC: 'https://management.azure.com',
    'GCC-High': 'https://management.usgovcloudapi.net',
    DoD: 'https://management.azure.microsoft.scloud',
  },
  getCostManagementScope: {
    Commercial: 'https://management.azure.com/.default',
    GCC: 'https://management.azure.com/.default',
    'GCC-High': 'https://management.usgovcloudapi.net/.default',
    DoD: 'https://management.azure.microsoft.scloud/.default',
  },
  getMonitorBase: {
    Commercial: 'https://management.azure.com',
    GCC: 'https://management.azure.com',
    'GCC-High': 'https://management.usgovcloudapi.net',
    DoD: 'https://management.azure.microsoft.scloud',
  },
  getMonitorScope: {
    Commercial: 'https://management.azure.com/.default',
    GCC: 'https://management.azure.com/.default',
    'GCC-High': 'https://management.usgovcloudapi.net/.default',
    DoD: 'https://management.azure.microsoft.scloud/.default',
  },
  getDevOpsBase: {
    Commercial: 'https://dev.azure.com',
    GCC: 'https://dev.azure.com',
    'GCC-High': 'https://dev.azure.com',
    DoD: 'https://dev.azure.com',
  },
  getAppConfigSuffix: {
    Commercial: 'azconfig.io',
    GCC: 'azconfig.io',
    'GCC-High': 'azconfig.azure.us',
    DoD: 'azconfig.azure.us',
  },
  getAppConfigScope: {
    Commercial: 'https://azconfig.io/.default',
    GCC: 'https://azconfig.io/.default',
    'GCC-High': 'https://azconfig.azure.us/.default',
    DoD: 'https://azconfig.azure.us/.default',
  },
};

const FNS: Record<string, () => string> = {
  getArmHost,
  getArmEndpoint,
  getCosmosSuffix,
  getSearchSuffix,
  searchAadScope,
  getGraphHost,
  getGraphScope,
  getSqlSuffix,
  synapseSqlSuffix,
  getAasSuffix,
  aasSuffix,
  getLogAnalyticsHost,
  getBlobSuffix,
  getOpenAiSuffix,
  getPbiGovHost,
  getPbiScope,
  getPbiEmbedHostname,
  getDfsSuffix,
  getKustoSuffix,
  getCostManagementBase,
  getCostManagementScope,
  getMonitorBase,
  getMonitorScope,
  getDevOpsBase,
  getAppConfigSuffix,
  getAppConfigScope,
};

describe('cloud-endpoints getters — all 4 clouds via LOOM_CLOUD', () => {
  for (const [name, fn] of Object.entries(FNS)) {
    describe(name, () => {
      it.each(CLOUDS)('%s', (cloud) => {
        withCloud(cloud);
        expect(fn()).toBe(TABLE[name][cloud]);
      });
    });
  }
});

describe('AAS data-plane helpers — suffix', () => {
  it('returns the Commercial suffix', () => {
    withCloud('Commercial');
    expect(aasSuffix()).toBe('asazure.windows.net');
  });
  it('returns the gov suffix for GCC-High', () => {
    withCloud('GCC-High');
    expect(aasSuffix()).toBe('asazure.usgovcloudapi.net');
  });
});

describe('legacy AZURE_CLOUD signal still resolves (back-compat)', () => {
  it('returns Commercial suffixes when AZURE_CLOUD is unset', () => {
    delete process.env.LOOM_CLOUD;
    delete process.env.AZURE_CLOUD;
    expect(getDfsSuffix()).toBe('dfs.core.windows.net');
    expect(getArmEndpoint()).toBe('https://management.azure.com');
    expect(getKustoSuffix()).toBe('kusto.windows.net');
  });

  it('returns US Gov suffixes for AZURE_CLOUD=AzureUSGovernment', () => {
    delete process.env.LOOM_CLOUD;
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(getDfsSuffix()).toBe('dfs.core.usgovcloudapi.net');
    expect(getArmEndpoint()).toBe('https://management.usgovcloudapi.net');
    expect(getCosmosSuffix()).toBe('documents.azure.us');
    expect(getGraphHost()).toBe('https://graph.microsoft.us');
  });
});

describe('getDevOpsBase — cloud-invariant SaaS + LOOM_DEVOPS_BASE override', () => {
  const ORIG = process.env.LOOM_DEVOPS_BASE;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.LOOM_DEVOPS_BASE;
    else process.env.LOOM_DEVOPS_BASE = ORIG;
  });

  it('is dev.azure.com in every cloud (no LOOM_DEVOPS_BASE)', () => {
    delete process.env.LOOM_DEVOPS_BASE;
    for (const cloud of CLOUDS) {
      withCloud(cloud);
      expect(getDevOpsBase()).toBe('https://dev.azure.com');
    }
  });

  it('passes LOOM_DEVOPS_BASE through verbatim, stripping trailing slashes', () => {
    process.env.LOOM_DEVOPS_BASE = 'https://devops.my-gov.agency/';
    expect(getDevOpsBase()).toBe('https://devops.my-gov.agency');
  });
});

describe('getAppConfigSuffix — LOOM_APPCONFIG_SUFFIX override', () => {
  const ORIG = process.env.LOOM_APPCONFIG_SUFFIX;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.LOOM_APPCONFIG_SUFFIX;
    else process.env.LOOM_APPCONFIG_SUFFIX = ORIG;
  });

  it('honors LOOM_APPCONFIG_SUFFIX, stripping leading dots and trailing slashes', () => {
    withCloud('Commercial');
    process.env.LOOM_APPCONFIG_SUFFIX = '.appconfig.sovereign.example/';
    expect(getAppConfigSuffix()).toBe('appconfig.sovereign.example');
    expect(getAppConfigScope()).toBe('https://appconfig.sovereign.example/.default');
  });
});

describe('appConfigEndpointFromName', () => {
  it('builds an azconfig.io URL in Commercial', () => {
    withCloud('Commercial');
    expect(appConfigEndpointFromName('ac-loom')).toBe('https://ac-loom.azconfig.io');
  });
  it('builds an azconfig.azure.us URL in GCC-High', () => {
    withCloud('GCC-High');
    expect(appConfigEndpointFromName('ac-loom')).toBe('https://ac-loom.azconfig.azure.us');
  });
});

describe('App Config scope — endpoint-aware (issue #1531)', () => {
  const ORIG_SUFFIX = process.env.LOOM_APPCONFIG_SUFFIX;
  afterEach(() => {
    if (ORIG_SUFFIX === undefined) delete process.env.LOOM_APPCONFIG_SUFFIX;
    else process.env.LOOM_APPCONFIG_SUFFIX = ORIG_SUFFIX;
  });

  it('derives the gov suffix from an azconfig.azure.us endpoint even in a Commercial boundary', () => {
    withCloud('Commercial');
    delete process.env.LOOM_APPCONFIG_SUFFIX;
    expect(appConfigSuffixFromEndpoint('https://ac-loom.azconfig.azure.us')).toBe('azconfig.azure.us');
    expect(getAppConfigScope('https://ac-loom.azconfig.azure.us')).toBe('https://azconfig.azure.us/.default');
  });

  it('derives the commercial suffix from an azconfig.io endpoint even in a Gov boundary', () => {
    withCloud('GCC-High');
    delete process.env.LOOM_APPCONFIG_SUFFIX;
    expect(appConfigSuffixFromEndpoint('https://ac-loom.azconfig.io')).toBe('azconfig.io');
    expect(getAppConfigScope('https://ac-loom.azconfig.io')).toBe('https://azconfig.io/.default');
  });

  it('accepts a bare host (no scheme) and is case-insensitive', () => {
    withCloud('Commercial');
    delete process.env.LOOM_APPCONFIG_SUFFIX;
    expect(appConfigSuffixFromEndpoint('AC-LOOM.AZCONFIG.AZURE.US')).toBe('azconfig.azure.us');
    expect(appConfigSuffixFromEndpoint('https://ac-loom.azconfig.azure.us/kv/x?api-version=1')).toBe('azconfig.azure.us');
  });

  it('honours LOOM_APPCONFIG_SUFFIX when the host matches a sovereign suffix the matrix does not enumerate', () => {
    withCloud('Commercial');
    process.env.LOOM_APPCONFIG_SUFFIX = 'appconfig.sovereign.example';
    expect(appConfigSuffixFromEndpoint('https://ac-loom.appconfig.sovereign.example')).toBe('appconfig.sovereign.example');
    expect(getAppConfigScope('https://ac-loom.appconfig.sovereign.example')).toBe('https://appconfig.sovereign.example/.default');
  });

  it('falls back to the cloud-derived suffix for an unrecognised host (no fabricated host)', () => {
    withCloud('GCC-High');
    delete process.env.LOOM_APPCONFIG_SUFFIX;
    expect(appConfigSuffixFromEndpoint('https://ac-loom.example.invalid')).toBe('azconfig.azure.us');
  });

  it('no-arg form stays cloud-derived (back-compat)', () => {
    withCloud('GCC-High');
    delete process.env.LOOM_APPCONFIG_SUFFIX;
    expect(getAppConfigScope()).toBe('https://azconfig.azure.us/.default');
    withCloud('Commercial');
    expect(getAppConfigScope()).toBe('https://azconfig.io/.default');
  });
});

// ---------------------------------------------------------------------------
// Power Platform control plane (BAP / Power Apps / Flow)
// ---------------------------------------------------------------------------
//
// These pin the resolver that replaced TWO divergent module-level env reads:
// powerplatform-client used `LOOM_BAP_BASE` (the var bicep actually emits) while
// copilot-studio-client used `LOOM_POWER_PLATFORM_BAP_BASE` (which NOTHING in
// the repo sets, yet seven parity docs told operators to set it and
// check-env-sync exempted it as "derived from cloud endpoints"). The Copilot
// Studio family was therefore pinned to the Commercial host in every boundary,
// silently.
describe('powerPlatformEndpoints — BAP host per boundary', () => {
  afterEach(() => {
    delete process.env.LOOM_BAP_BASE;
    delete process.env.LOOM_POWER_PLATFORM_BAP_BASE;
    delete process.env.LOOM_POWERAPPS_BASE;
    delete process.env.LOOM_FLOW_BASE;
  });

  it('derives the documented BAP host for each cloud', () => {
    // Hosts from learn.microsoft.com/power-automate/ip-address-configuration
    // ("Allow users on your network to use Power Automate").
    withCloud('Commercial');
    expect(powerPlatformEndpoints().bapBase).toBe('https://api.bap.microsoft.com');
    withCloud('GCC');
    expect(powerPlatformEndpoints().bapBase).toBe('https://gov.api.bap.microsoft.us');
    withCloud('GCC-High');
    expect(powerPlatformEndpoints().bapBase).toBe('https://high.api.bap.microsoft.us');
    withCloud('DoD');
    expect(powerPlatformEndpoints().bapBase).toBe('https://api.bap.appsplatform.us');
  });

  it('never returns a Commercial host in a sovereign boundary', () => {
    // MUTATION-PROOF for the ACTUAL production defect: a hard-coded Commercial
    // default (what copilot-studio-client had) fails every one of these.
    for (const c of ['GCC', 'GCC-High', 'DoD'] as const) {
      withCloud(c);
      expect(powerPlatformEndpoints().bapBase).not.toContain('microsoft.com');
    }
  });

  it('honors LOOM_BAP_BASE and the legacy LOOM_POWER_PLATFORM_BAP_BASE alias', () => {
    withCloud('Commercial');
    process.env.LOOM_BAP_BASE = 'https://canonical.example.test/';
    expect(powerPlatformEndpoints().bapBase).toBe('https://canonical.example.test');
    delete process.env.LOOM_BAP_BASE;
    process.env.LOOM_POWER_PLATFORM_BAP_BASE = 'https://legacy.example.test';
    expect(powerPlatformEndpoints().bapBase).toBe('https://legacy.example.test');
  });

  it('treats an EMPTY env value as absent (bicep emits "" when the param is unset)', () => {
    // The bicep params default to '' , so a naive `process.env.X ?? default`
    // would pin the empty string and produce "/providers/..." URLs.
    withCloud('GCC-High');
    process.env.LOOM_BAP_BASE = '';
    expect(powerPlatformEndpoints().bapBase).toBe('https://high.api.bap.microsoft.us');
  });

  it('derives the BAP scope from whichever base won', () => {
    withCloud('DoD');
    expect(powerPlatformEndpoints().bapScope).toBe('https://api.bap.appsplatform.us/.default');
  });
});

describe('assertPowerPlatformAvailable — honest gate, never an invented host', () => {
  afterEach(() => {
    delete process.env.LOOM_POWERAPPS_BASE;
    delete process.env.LOOM_FLOW_BASE;
  });

  it('is always available for BAP (documented in every boundary)', () => {
    for (const c of CLOUDS) {
      withCloud(c);
      expect(() => assertPowerPlatformAvailable('bap')).not.toThrow();
    }
  });

  it('resolves Power Apps / Flow on Commercial + GCC', () => {
    for (const c of ['Commercial', 'GCC'] as const) {
      withCloud(c);
      expect(powerPlatformEndpoints().powerAppsBase).toBe('https://api.powerapps.com');
      expect(powerPlatformEndpoints().flowBase).toBe('https://api.flow.microsoft.com');
      expect(() => assertPowerPlatformAvailable('powerapps')).not.toThrow();
      expect(() => assertPowerPlatformAvailable('flow')).not.toThrow();
    }
  });

  it('GATES (rather than guessing) Power Apps / Flow in GCC-High and DoD', () => {
    // Microsoft publishes sovereign MAKER portal URLs but not the management
    // REST bases. Inventing one fails opaquely, so we gate with a named var.
    for (const c of ['GCC-High', 'DoD'] as const) {
      withCloud(c);
      expect(powerPlatformEndpoints().powerAppsBase).toBeNull();
      expect(powerPlatformEndpoints().flowBase).toBeNull();
      expect(() => assertPowerPlatformAvailable('powerapps')).toThrow(/LOOM_POWERAPPS_BASE/);
      expect(() => assertPowerPlatformAvailable('flow')).toThrow(/LOOM_FLOW_BASE/);
    }
  });

  it('the gate names the bicep parameter, so the fix is a redeploy not a manual edit', () => {
    withCloud('DoD');
    expect(() => assertPowerPlatformAvailable('flow')).toThrow(/powerPlatformFlowBase/);
  });

  it('clears once the operator sets the override', () => {
    withCloud('GCC-High');
    process.env.LOOM_FLOW_BASE = 'https://flow.example.us';
    expect(() => assertPowerPlatformAvailable('flow')).not.toThrow();
    expect(powerPlatformEndpoints().flowBase).toBe('https://flow.example.us');
  });
});
