/**
 * Unit tests for the APPS-W2 attachable-resource registry — the PURE parts:
 * per-kind honest availability gates (exact missing env named) and the
 * apps-UAMI name derivation. No Azure I/O.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listAppResourceKinds, appsUamiName } from '../app-resources';

const KEYS = [
  'LOOM_ADLS_ACCOUNT', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_KUSTO_CLUSTER_URI',
  'LOOM_EVENTHUB_NAMESPACE', 'LOOM_KEY_VAULT_URI', 'LOOM_APPS_KEY_VAULT_URI',
  'LOOM_AI_SEARCH_SERVICE', 'LOOM_AOAI_ENDPOINT', 'LOOM_COSMOS_ENDPOINT',
  'LOOM_APPS_UAMI_ID', 'LOOM_MCP_UAMI_ID',
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
});

describe('appsUamiName', () => {
  it('derives the UAMI name from the resource id (fallback placeholder when unset)', () => {
    process.env.LOOM_APPS_UAMI_ID = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-apps';
    expect(appsUamiName()).toBe('uami-loom-apps');
    delete process.env.LOOM_APPS_UAMI_ID;
    expect(appsUamiName()).toBe('<apps-uami-name>');
  });
});
