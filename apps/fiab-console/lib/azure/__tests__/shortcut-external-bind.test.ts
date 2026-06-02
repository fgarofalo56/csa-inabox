/**
 * Unit tests for the external-source read-through binding (S3 / GCS / Dataverse)
 * in shortcut-engines.ts. These lock in the real DDL / UC REST wiring and the
 * honest-gate boundaries (credential absent, engine not configured).
 *
 * Backends (Key Vault, UC REST, Synapse TDS, Databricks SQL, ADLS listPaths)
 * are mocked — these assert the SQL/REST we emit, not live Azure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
  ensureUcAwsStorageCredential: vi.fn(async () => ({ name: 'cred' })),
  ensureUcGcpStorageCredential: vi.fn(async () => ({ name: 'cred' })),
  ensureUcExternalLocation: vi.fn(async () => ({ name: 'loc' })),
  deleteUcExternalLocation: vi.fn(async () => {}),
  deleteUcStorageCredential: vi.fn(async () => {}),
}));
vi.mock('../adls-client', () => ({ listPaths: vi.fn(async () => []) }));
vi.mock('../synapse-sql-client', () => ({
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'master', cacheKey: 'k' })),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
}));
vi.mock('../databricks-client', () => ({
  listWarehouses: vi.fn(async () => [{ id: 'wh1', name: 'wh', state: 'RUNNING' }]),
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
  databricksConfigGate: vi.fn(() => null),
}));

import { bindExternalSource, externalSourceGate } from '../shortcut-engines';
import {
  getKeyVaultSecret,
  keyVaultConfigGate,
  ensureUcAwsStorageCredential,
  ensureUcGcpStorageCredential,
  ensureUcExternalLocation,
} from '../shortcut-credentials';
import { executeQuery } from '../synapse-sql-client';

const baseEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...baseEnv };
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  (keyVaultConfigGate as any).mockReturnValue(null);
});

describe('externalSourceGate', () => {
  it('returns null for adls/internal', () => {
    expect(externalSourceGate('adls', false)).toBeNull();
    expect(externalSourceGate('internal', false)).toBeNull();
  });
  it('gates needs_credential when no credentialRef', () => {
    expect(externalSourceGate('s3', false)?.code).toBe('needs_credential');
  });
  it('gates key_vault_not_configured when vault missing but ref present', () => {
    (keyVaultConfigGate as any).mockReturnValue({ missing: 'LOOM_KEY_VAULT_URI' });
    expect(externalSourceGate('gcs', true)?.code).toBe('key_vault_not_configured');
  });
  it('returns null when ref present and vault configured', () => {
    expect(externalSourceGate('s3', true)).toBeNull();
  });
});

describe('bindExternalSource — S3 via Databricks UC (IAM role)', () => {
  it('resolves IAM role ARN, creates UC storage credential + external location', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    (getKeyVaultSecret as any).mockResolvedValue('arn:aws:iam::123456789012:role/loom-reader');
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'partner', targetType: 's3',
      targetUri: 's3://acme-bucket/data/partner', credentialRef: { kind: 'awsKeys', keyVaultSecret: 's3-role' },
    });
    expect('gated' in res).toBe(false);
    expect((res as any).readUri).toBe('s3://acme-bucket/data/partner');
    expect((res as any).ucExternalLocation).toContain('loom_sc_');
    expect(ensureUcAwsStorageCredential).toHaveBeenCalledWith(
      expect.objectContaining({ roleArn: 'arn:aws:iam::123456789012:role/loom-reader', readOnly: true }),
    );
    expect(ensureUcExternalLocation).toHaveBeenCalledWith(
      expect.objectContaining({ url: 's3://acme-bucket', readOnly: true }),
    );
  });
  it('rejects a non-ARN secret for the UC engine', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    (getKeyVaultSecret as any).mockResolvedValue('AKIA:secret');
    await expect(bindExternalSource({
      lakehouseId: 'lh1', name: 'p', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 's' },
    })).rejects.toMatchObject({ code: 'bad_s3_secret' });
  });
});

describe('bindExternalSource — S3 via Synapse (access keys)', () => {
  it('emits DATABASE SCOPED CREDENTIAL + EXTERNAL DATA SOURCE DDL', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
    (getKeyVaultSecret as any).mockResolvedValue('AKIAEXAMPLE:supersecretkey');
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'sales', targetType: 's3',
      targetUri: 's3://acme/sales', credentialRef: { kind: 'awsKeys', keyVaultSecret: 's3-keys' },
    });
    expect((res as any).synapse?.dataSource).toContain('loom_s3_sales');
    const ddl = (executeQuery as any).mock.calls[0][1] as string;
    expect(ddl).toContain("CREATE DATABASE SCOPED CREDENTIAL");
    expect(ddl).toContain("IDENTITY = 'S3 Access Key'");
    expect(ddl).toContain("SECRET = 'AKIAEXAMPLE:supersecretkey'");
    expect(ddl).toContain("CREATE EXTERNAL DATA SOURCE");
    expect(ddl).toContain("LOCATION = 's3://acme'");
  });
});

describe('bindExternalSource — GCS', () => {
  it('creates a UC GCP storage credential from the service-account JSON', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify({
      client_email: 'svc@proj.iam.gserviceaccount.com', private_key_id: 'kid', private_key: '-----BEGIN-----',
    }));
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'gcsdata', targetType: 'gcs',
      targetUri: 'gs://gbucket/path', credentialRef: { kind: 'gcsServiceAccount', keyVaultSecret: 'gcs-sa' },
    });
    expect((res as any).ucExternalLocation).toContain('loom_sc_');
    expect(ensureUcGcpStorageCredential).toHaveBeenCalledWith(
      expect.objectContaining({ serviceAccountJson: expect.objectContaining({ client_email: 'svc@proj.iam.gserviceaccount.com' }) }),
    );
    expect(ensureUcExternalLocation).toHaveBeenCalledWith(expect.objectContaining({ url: 'gs://gbucket' }));
  });
  it('honest-gates GCS when Databricks engine is not configured', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1'; // Synapse only — no GCS connector
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'g', targetType: 'gcs', targetUri: 'gs://b/k',
      credentialRef: { kind: 'gcsServiceAccount', keyVaultSecret: 'gcs-sa' },
    });
    expect((res as any).gated).toBe(true);
    expect((res as any).code).toBe('gcs_needs_databricks');
  });
});

describe('bindExternalSource — Dataverse', () => {
  it('resolves the Synapse-Link linked ADLS path and returns its abfss', async () => {
    (getKeyVaultSecret as any).mockResolvedValue('abfss://dataverse@dvlake.dfs.core.windows.net/account');
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'dv', targetType: 'dataverse',
      targetUri: 'dataverse://org/account', credentialRef: { kind: 'servicePrincipal', keyVaultSecret: 'dv-path' },
    });
    expect((res as any).readUri).toBe('abfss://dataverse@dvlake.dfs.core.windows.net/account');
  });
  it('rejects a Dataverse secret that is not an ADLS path', async () => {
    (getKeyVaultSecret as any).mockResolvedValue('not-a-path');
    await expect(bindExternalSource({
      lakehouseId: 'lh1', name: 'dv', targetType: 'dataverse', targetUri: 'dataverse://o/a',
      credentialRef: { kind: 'servicePrincipal', keyVaultSecret: 'dv-path' },
    })).rejects.toMatchObject({ code: 'bad_dataverse_secret' });
  });
});
