/**
 * Unit tests for the APPS-W2 attachable-resource registry — the PURE parts:
 * per-kind honest availability gates (exact missing env named) and the
 * apps-UAMI name derivation. No Azure I/O.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listAppResourceKinds, appsUamiName, attachOntologyItemResource } from '../app-resources';

// attachOntologyItemResource dynamic-imports these — mock both so the attach
// path is unit-testable without Azure I/O.
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({
      read: async () => ({
        resource: {
          itemType: 'ontology',
          state: { objectTypes: [{ name: 'Customer' }, { name: 'Order' }, { name: '' }] },
        },
      }),
    }),
  }),
}));
vi.mock('@/lib/azure/postgres-flex-client', () => ({
  // rowCount 0 → the apps principal is NOT yet a PG role → pending-grants.
  executePostgresQuery: async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1 }),
  postgresQueryGate: () => null,
  PostgresError: class PostgresError extends Error {},
}));

const KEYS = [
  'LOOM_ADLS_ACCOUNT', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_KUSTO_CLUSTER_URI',
  'LOOM_EVENTHUB_NAMESPACE', 'LOOM_KEY_VAULT_URI', 'LOOM_APPS_KEY_VAULT_URI',
  'LOOM_AI_SEARCH_SERVICE', 'LOOM_AOAI_ENDPOINT', 'LOOM_COSMOS_ENDPOINT',
  'LOOM_APPS_UAMI_ID', 'LOOM_MCP_UAMI_ID',
  'LOOM_WEAVE_PG_FQDN', 'LOOM_WEAVE_PG_DATABASE', 'LOOM_WEAVE_GRAPH',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('listAppResourceKinds', () => {
  it('reports every kind unavailable with the exact missing env when nothing is configured', () => {
    const kinds = listAppResourceKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(8);
    for (const k of kinds) {
      expect(k.available).toBe(false);
      expect(k.missing).toBeTruthy();
    }
    expect(kinds.find((k) => k.kind === 'lakehouse')?.missing).toBe('LOOM_ADLS_ACCOUNT');
    expect(kinds.find((k) => k.kind === 'adx')?.missing).toBe('LOOM_KUSTO_CLUSTER_URI');
  });

  it('flips a kind available when its backing env is set', () => {
    process.env.LOOM_ADLS_ACCOUNT = 'salake123';
    process.env.LOOM_AOAI_ENDPOINT = 'https://aoai.cognitiveservices.azure.com';
    const kinds = listAppResourceKinds();
    expect(kinds.find((k) => k.kind === 'lakehouse')?.available).toBe(true);
    expect(kinds.find((k) => k.kind === 'aoai')?.available).toBe(true);
    expect(kinds.find((k) => k.kind === 'eventhubs')?.available).toBe(false);
  });

  it('keyvault accepts either LOOM_APPS_KEY_VAULT_URI or LOOM_KEY_VAULT_URI', () => {
    process.env.LOOM_APPS_KEY_VAULT_URI = 'https://kv-apps.vault.azure.net';
    expect(listAppResourceKinds().find((k) => k.kind === 'keyvault')?.available).toBe(true);
  });

  it('weave-ontology gates on LOOM_WEAVE_PG_FQDN', () => {
    expect(listAppResourceKinds().find((k) => k.kind === 'weave-ontology')?.missing).toBe('LOOM_WEAVE_PG_FQDN');
    process.env.LOOM_WEAVE_PG_FQDN = 'psql-loom-weave.postgres.database.azure.com';
    expect(listAppResourceKinds().find((k) => k.kind === 'weave-ontology')?.available).toBe(true);
  });
});

describe('attachOntologyItemResource', () => {
  it('injects APP_ONT_* coordinates + a pre-filled PG grant script (pending-grants)', async () => {
    process.env.LOOM_WEAVE_PG_FQDN = 'psql-loom-weave.postgres.database.azure.com';
    process.env.LOOM_APPS_UAMI_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-apps';
    const { resource, envVars } = await attachOntologyItemResource('11112222-3333-4444-5555-666677778888', 'ws1', 'Enterprise Ontology', 'tester');
    const names = envVars.map((e) => e.name);
    expect(names).toEqual([
      'APP_ONT_ENTERPRISE_ONTOLOGY_ID',
      'APP_ONT_ENTERPRISE_ONTOLOGY_PG_HOST',
      'APP_ONT_ENTERPRISE_ONTOLOGY_PG_DB',
      'APP_ONT_ENTERPRISE_ONTOLOGY_GRAPH',
      'APP_ONT_ENTERPRISE_ONTOLOGY_PG_USER',
      'APP_ONT_ENTERPRISE_ONTOLOGY_TYPES',
    ]);
    expect(envVars.find((e) => e.name.endsWith('_TYPES'))?.value).toBe('Customer,Order');
    expect(envVars.find((e) => e.name.endsWith('_GRAPH'))?.value).toBe('loom_ontology');
    expect(resource.id).toBe('ont-item-11112222');
    expect(resource.kind).toBe('weave-ontology');
    expect(resource.grant.status).toBe('pending-grants');
    expect(resource.grant.grantScript).toContain("pgaadauth_create_principal('uami-loom-apps'");
    expect(resource.grant.grantScript).toContain('GRANT USAGE ON SCHEMA "loom_ontology"');
  });

  it('gates honestly when the Weave PG server is not configured', async () => {
    await expect(attachOntologyItemResource('x', 'ws1', 'O')).rejects.toThrow(/LOOM_WEAVE_PG_FQDN/);
  });
});

describe('appsUamiName', () => {
  it('derives the UAMI name from the resource id (fallback placeholder when unset)', () => {
    process.env.LOOM_APPS_UAMI_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-apps';
    expect(appsUamiName()).toBe('uami-loom-apps');
    delete process.env.LOOM_APPS_UAMI_ID;
    expect(appsUamiName()).toBe('<apps-uami-name>');
  });
});
