/**
 * CMK1 — probe-dr-restore-posture CMK-at-rest assertion (extends the DR0 row).
 * Pins the three honest branches against a mocked ARM edge (per no-vaporware.md
 * only the network client is faked):
 *   1. CMK live (keyVaultKeyUri set)          → pass, key URI reported.
 *   2. CMK mandated but absent
 *      (LOOM_COSMOS_REQUIRE_CMK=true, no key) → warn, posture GAP named with
 *      the two-step existing-account remediation (default-identity → key-uri).
 *   3. CMK not mandated, no key (the default) → pass, service-managed keys
 *      reported honestly (never a fabricated green "CMK on").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const cosmosMock = {
  cosmosConfigGate: vi.fn(() => null as { missing: string } | null),
  getAccountManagement: vi.fn(async (): Promise<any> => ({
    name: 'cosmos-loom-test',
    backupPolicy: { type: 'Continuous', tier: 'Continuous30Days' },
  })),
};
vi.mock('@/lib/azure/cosmos-account-client', () => cosmosMock);
// Keep every other probe's ARM edge inert (env below is unset, so they gate).
vi.mock('@/lib/azure/arm-client', () => ({ armGet: vi.fn(async () => ({ value: [] })) }));

import { runExtraProbes, type ProbeHelpers } from '../health-probes';

const h: ProbeHelpers = {
  ctx: { app: 'loom-console', adminRg: 'rg-admin', dlzRg: 'rg-dlz', sub: 'sub-1', uamiClientId: 'uami-1', tenant: 'tid', cosmosAccount: 'cosmos-loom-test' },
  envVarFix: () => ({ portalSteps: [], fixScript: '' }),
};

const ENV_KEYS = ['LOOM_COSMOS_ACCOUNT', 'LOOM_COSMOS_ACCOUNT_RG', 'LOOM_COSMOS_REQUIRE_CMK', 'LOOM_ADLS_ACCOUNT'] as const;
const saved: Record<string, string | undefined> = {};

async function posture() {
  const results = await runExtraProbes(h);
  const r = results.find((x) => x.id === 'probe-dr-restore-posture');
  expect(r, 'probe-dr-restore-posture must be wired into runExtraProbes').toBeTruthy();
  return r!;
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.LOOM_COSMOS_ACCOUNT = 'cosmos-loom-test';
  // LOOM_ADLS_ACCOUNT stays unset → the lake branch is skipped; the Cosmos
  // branch alone decides the row (isolates the CMK assertion under test).
  cosmosMock.cosmosConfigGate.mockReturnValue(null);
  cosmosMock.getAccountManagement.mockResolvedValue({
    name: 'cosmos-loom-test',
    backupPolicy: { type: 'Continuous', tier: 'Continuous30Days' },
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe('probe-dr-restore-posture — CMK-at-rest (CMK1)', () => {
  it('reports CMK ON (key URI + defaultIdentity) when the live account carries keyVaultKeyUri', async () => {
    cosmosMock.getAccountManagement.mockResolvedValue({
      name: 'cosmos-loom-test',
      backupPolicy: { type: 'Continuous', tier: 'Continuous30Days' },
      keyVaultKeyUri: 'https://kv-loom.vault.azure.net/keys/loom-cmk',
      defaultIdentity: 'UserAssignedIdentity=/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-cmk',
    });
    const r = await posture();
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('CMK-at-rest ON');
    expect(r.detail).toContain('https://kv-loom.vault.azure.net/keys/loom-cmk');
    expect(r.detail).toContain('UserAssignedIdentity=');
  });

  it('flags a posture GAP when LOOM_COSMOS_REQUIRE_CMK=true but the account has no keyVaultKeyUri', async () => {
    process.env.LOOM_COSMOS_REQUIRE_CMK = 'true';
    const r = await posture();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('NO customer-managed key');
    expect(r.detail).toContain('LOOM_COSMOS_REQUIRE_CMK=true');
    // Remediation names the supported existing-account enablement order:
    // default-identity FIRST, then the versionless key URI.
    expect(r.detail).toContain('--default-identity');
    expect(r.detail).toContain('--key-uri');
    expect(r.detail).toContain('drConfig.cosmosRequireCmk');
  });

  it('honestly reports service-managed keys (still pass) when CMK is not mandated', async () => {
    // LOOM_COSMOS_REQUIRE_CMK unset — the shipped default.
    const r = await posture();
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('service-managed keys');
    expect(r.detail).toContain('drConfig.cosmosRequireCmk');
    expect(r.detail).not.toContain('CMK-at-rest ON');
  });

  it('LOOM_COSMOS_REQUIRE_CMK=false behaves as not-mandated (never a false gap)', async () => {
    process.env.LOOM_COSMOS_REQUIRE_CMK = 'false';
    const r = await posture();
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('service-managed keys');
  });
});
