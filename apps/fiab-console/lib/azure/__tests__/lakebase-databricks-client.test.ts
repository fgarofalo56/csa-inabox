/**
 * DBX-4 — lakebase-databricks-client opt-in gate. The Databricks backend is
 * reachable ONLY when LOOM_LAKEBASE_BACKEND=databricks AND a workspace is bound;
 * otherwise the honest gate keeps the editor on the Azure-native default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class { async getToken() { return null; } } }));

const SAVED = { ...process.env };
beforeEach(() => { delete process.env.LOOM_LAKEBASE_BACKEND; delete process.env.LOOM_DATABRICKS_HOSTNAME; });
afterEach(() => { process.env = { ...SAVED }; vi.clearAllMocks(); });

describe('lakebaseDatabricksGate', () => {
  it('gates on the backend selector by default (Azure-native stays default)', async () => {
    const { lakebaseDatabricksGate, isLakebaseDatabricksSelected } = await import('../lakebase-databricks-client');
    const gate = lakebaseDatabricksGate();
    expect(gate?.missing).toBe('LOOM_LAKEBASE_BACKEND');
    expect(isLakebaseDatabricksSelected()).toBe(false);
  });

  it('gates on a bound workspace once the selector is set', async () => {
    process.env.LOOM_LAKEBASE_BACKEND = 'databricks';
    const { lakebaseDatabricksGate } = await import('../lakebase-databricks-client');
    expect(lakebaseDatabricksGate()?.missing).toBe('LOOM_DATABRICKS_HOSTNAME');
  });

  it('clears the gate when both the selector and workspace are present', async () => {
    process.env.LOOM_LAKEBASE_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.19.azuredatabricks.net';
    const { lakebaseDatabricksGate, isLakebaseDatabricksSelected } = await import('../lakebase-databricks-client');
    expect(lakebaseDatabricksGate()).toBeNull();
    expect(isLakebaseDatabricksSelected()).toBe(true);
  });
});
