/**
 * BFF route tests for the MCP browse-catalog + deploy wizard
 * (POST /api/admin/mcp-servers/deploy with a `catalogId`).
 *
 * Pins the per-field secret routing the task requires:
 *   - a `secret: true` field → written to Key Vault + surfaced as an ACA
 *     secretRef env var (never a plain value), and only its KV NAME persists.
 *   - a non-secret field → a plain Container App env var + persisted to
 *     configValues.
 *   - the persisted Cosmos doc carries source='catalog' + deployment metadata,
 *     secretRefs (names only), and NEVER the secret value.
 *   - an ARM failure rolls back every KV secret it wrote (no orphaned secrets).
 *
 * All Azure SDK / Cosmos / KV / ARM calls are mocked; the test exercises the
 * route's wiring logic only (no network). Azure-native — no Fabric dependency.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'tenant-1', upn: 'admin@contoso.com' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

// Capability check passes (returns null = allowed).
vi.mock('@/lib/auth/feature-gate', () => ({
  enforceCapability: vi.fn(async () => null),
}));

// Audit log is best-effort.
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create: async () => ({}) } }),
}));

// Record everything saveMcpServer persists so we can assert on the Cosmos doc.
const savedDocs: any[] = [];
vi.mock('@/lib/azure/mcp-config-store', () => ({
  saveMcpServer: vi.fn(async (tenantId: string, _id: any, who: string, config: any) => {
    const doc = { ...config, id: 'srv-1', serverId: 'srv-1', tenantId, createdAt: 'now', updatedAt: 'now', updatedBy: who };
    savedDocs.push(doc);
    return doc;
  }),
}));

// Key Vault: record writes + deletes (for the rollback assertion).
const kvWrites: Array<{ name: string; value: string }> = [];
const kvDeletes: string[] = [];
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  putKeyVaultSecret: vi.fn(async (name: string, value: string) => { kvWrites.push({ name, value }); return { name }; }),
  deleteKeyVaultSecret: vi.fn(async (name: string) => { kvDeletes.push(name); }),
  vaultUrl: vi.fn(() => 'https://vault.example.vault.azure.net'),
  sanitizeSecretName: (raw: string) => raw.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
}));

// Container Apps ARM client — record createMcpContainerApp opts; controllable failure.
let armShouldFail = false;
const createCalls: any[] = [];
vi.mock('@/lib/azure/container-apps-arm-client', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readAcaConfig: () => ({ subscriptionId: 'sub', resourceGroup: 'rg' }),
    createMcpContainerApp: vi.fn(async (opts: any) => {
      createCalls.push(opts);
      if (armShouldFail) throw new actual.AcaArmError(403, 'forbidden', 'ARM 403');
      return { id: opts.name, name: opts.name, location: opts.location, provisioningState: 'Succeeded' };
    }),
  };
});

vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal() as any),
  isGovCloud: () => false,
  cloudBoundaryLabel: () => 'Commercial',
}));

const ENV_SNAPSHOT = { ...process.env };
beforeEach(() => {
  process.env = {
    ...ENV_SNAPSHOT,
    LOOM_ACA_ENV_ID: '/subscriptions/sub/.../managedEnvironments/cae',
    LOOM_ACA_ENV_DOMAIN: 'cae.eastus2.azurecontainerapps.io',
    LOOM_MCP_CATALOG_UAMI_ID: '/subscriptions/sub/.../uami-loom-mcp',
    LOOM_LOCATION: 'eastus2',
  };
  savedDocs.length = 0;
  kvWrites.length = 0;
  kvDeletes.length = 0;
  createCalls.length = 0;
  armShouldFail = false;
});

async function postDeploy(body: any) {
  const { POST } = await import('../route');
  const req = new NextRequest('http://localhost/api/admin/mcp-servers/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: await res.json() };
}

describe('POST /api/admin/mcp-servers/deploy (catalog wizard)', () => {
  it('routes a secret field to Key Vault + secretRef and a non-secret to a plain env var', async () => {
    // github: pat (secret→KV), toolsets (non-secret enum→env).
    const { status, json } = await postDeploy({
      catalogId: 'github',
      name: 'My GitHub',
      values: { pat: 'ghp_supersecret', toolsets: 'repos' },
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);

    // KV got the secret value (under a sanitized name).
    expect(kvWrites.length).toBe(1);
    expect(kvWrites[0].value).toBe('ghp_supersecret');

    // ARM create got: env secretRef for the PAT, plain value for toolsets.
    expect(createCalls.length).toBe(1);
    const env = createCalls[0].env as Array<any>;
    const patEnv = env.find((e) => e.name === 'GITHUB_PERSONAL_ACCESS_TOKEN');
    const toolsetsEnv = env.find((e) => e.name === 'GITHUB_TOOLSETS');
    expect(patEnv.secretRef).toBeTruthy();
    expect(patEnv.value).toBeUndefined();
    expect(toolsetsEnv.value).toBe('repos');
    // The ACA secret references the KV url + the catalog UAMI.
    expect(createCalls[0].secrets.length).toBe(1);
    expect(createCalls[0].secrets[0].keyVaultUrl).toContain('/secrets/');
    expect(createCalls[0].secrets[0].identity).toContain('uami-loom-mcp');
  });

  it('persists source=catalog + deployment + secretRefs (names only) and NEVER the secret value', async () => {
    await postDeploy({ catalogId: 'github', values: { pat: 'ghp_supersecret', toolsets: 'all' } });

    expect(savedDocs.length).toBe(1);
    const doc = savedDocs[0];
    expect(doc.source).toBe('catalog');
    expect(doc.catalogId).toBe('github');
    expect(doc.deployment.containerAppName).toMatch(/^loom-mcp-github-/);
    expect(doc.deployment.provisioningState).toBe('Succeeded');
    // configValues holds only the non-secret field.
    expect(doc.configValues).toEqual({ toolsets: 'all' });
    // secretRefs holds the KV NAME for the secret, not the value.
    expect(Object.keys(doc.secretRefs)).toEqual(['pat']);
    expect(doc.secretRefs.pat).toBeTruthy();
    // The secret value appears nowhere in the persisted doc.
    expect(JSON.stringify(doc)).not.toContain('ghp_supersecret');
  });

  it('rolls back written Key Vault secrets when the ARM create fails', async () => {
    armShouldFail = true;
    const { status, json } = await postDeploy({
      catalogId: 'github',
      values: { pat: 'ghp_supersecret', toolsets: 'all' },
    });

    expect(json.ok).toBe(false);
    expect(status).toBe(502); // AcaArmError → 502
    // Every secret written before the failure was deleted (no orphans).
    expect(kvWrites.length).toBe(1);
    expect(kvDeletes).toEqual([kvWrites[0].name]);
    // No connection doc persisted on a failed deploy.
    expect(savedDocs.length).toBe(0);
  });

  it('honest-gates (503) when the Container Apps environment is not wired', async () => {
    delete process.env.LOOM_ACA_ENV_ID;
    delete process.env.LOOM_ACA_ENV_DOMAIN;
    const { status, json } = await postDeploy({ catalogId: 'time', values: {} });
    expect(status).toBe(503);
    expect(json.gate.missing).toContain('LOOM_ACA_ENV_ID');
  });
});
