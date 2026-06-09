import { describe, it, expect, afterEach } from 'vitest';
import { assertFabricFamilyAvailable } from '../cloud-endpoints';

const ORIG_LOOM = process.env.LOOM_CLOUD;
const ORIG_AZURE = process.env.AZURE_CLOUD;
const ORIG_PBI = process.env.LOOM_POWERBI_BASE;

afterEach(() => {
  if (ORIG_LOOM === undefined) delete process.env.LOOM_CLOUD;
  else process.env.LOOM_CLOUD = ORIG_LOOM;
  if (ORIG_AZURE === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = ORIG_AZURE;
  if (ORIG_PBI === undefined) delete process.env.LOOM_POWERBI_BASE;
  else process.env.LOOM_POWERBI_BASE = ORIG_PBI;
});

function withCloud(loomCloud: string) {
  process.env.LOOM_CLOUD = loomCloud;
  delete process.env.AZURE_CLOUD;
}

// Backs the cross-item Copilot Fabric/Power BI/Activator tool gate
// (assertFabricFamilyAvailable is called at the top of those tool handlers in
// copilot-orchestrator.ts). Kept here because the gate lives in the pure
// cloud-endpoints module so it is testable without the Azure-SDK chain.
describe('assertFabricFamilyAvailable — Copilot Fabric-family sovereign gate', () => {
  it.each(['fabric', 'powerbi', 'activator'] as const)(
    'allows %s in Commercial',
    (kind) => {
      withCloud('Commercial');
      expect(() => assertFabricFamilyAvailable(kind)).not.toThrow();
    },
  );

  it.each(['fabric', 'powerbi', 'activator'] as const)(
    'allows %s in GCC (worldwide Power BI/Fabric tenant)',
    (kind) => {
      withCloud('GCC');
      expect(() => assertFabricFamilyAvailable(kind)).not.toThrow();
    },
  );

  it.each(['GCC-High', 'DoD'] as const)('gates Fabric in %s with an Azure-native pointer', (cloud) => {
    withCloud(cloud);
    expect(() => assertFabricFamilyAvailable('fabric')).toThrow(/no .* endpoint/i);
    expect(() => assertFabricFamilyAvailable('fabric')).toThrow(/Synapse|ADLS|Data Explorer|Event Hubs/);
  });

  it.each(['GCC-High', 'DoD'] as const)('gates Activator in %s', (cloud) => {
    withCloud(cloud);
    expect(() => assertFabricFamilyAvailable('activator')).toThrow(/Fabric \/ Activator/i);
  });

  it('gates Power BI in GCC-High when no sovereign host is wired', () => {
    withCloud('GCC-High');
    delete process.env.LOOM_POWERBI_BASE;
    expect(() => assertFabricFamilyAvailable('powerbi')).toThrow(/LOOM_POWERBI_BASE/);
  });

  it('allows Power BI in GCC-High when LOOM_POWERBI_BASE points at the sovereign host', () => {
    withCloud('GCC-High');
    process.env.LOOM_POWERBI_BASE = 'https://api.powerbigov.us/v1.0/myorg';
    expect(() => assertFabricFamilyAvailable('powerbi')).not.toThrow();
  });

  it('treats IL5 as GCC-High (gated)', () => {
    withCloud('IL5');
    delete process.env.LOOM_POWERBI_BASE;
    expect(() => assertFabricFamilyAvailable('fabric')).toThrow();
    expect(() => assertFabricFamilyAvailable('powerbi')).toThrow(/LOOM_POWERBI_BASE/);
  });
});
