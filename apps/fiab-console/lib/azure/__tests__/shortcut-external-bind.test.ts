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
// The REAL shortcut-secret-resolver runs here (policy + ownership); only its
// registry lookup is stubbed. [] = no other row has bound the name, so the
// principal below owns every `loom-sc-` fixture name.
vi.mock('../lakehouse-shortcuts', () => ({ listShortcutSecretBindings: vi.fn(async () => []) }));
// The mint record for every `loom-sc-` fixture: saved by the OWNER below.
vi.mock('../kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(async () => ({ exists: true, owner: { oid: 'oid-u', upn: 'u@contoso.com' } })),
  getShortcutSecretValue: vi.fn(),
}));
vi.mock('../synapse-sql-client', () => ({
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'master', cacheKey: 'k' })),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
}));
vi.mock('../databricks-client', () => ({
  listWarehouses: vi.fn(async () => [{ id: 'wh1', name: 'wh', state: 'RUNNING' }]),
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
  databricksConfigGate: vi.fn(() => null),
  writeUcVolumesFile: vi.fn(async () => {}),
  deleteUcVolumesFile: vi.fn(async () => {}),
}));

import { bindExternalSource, createTablesShortcut, externalSourceGate, SECRET_SHAPE_MISMATCH, sqlLiteralAt } from '../shortcut-engines';
import {
  getKeyVaultSecret,
  keyVaultConfigGate,
  ensureUcAwsStorageCredential,
  ensureUcGcpStorageCredential,
  ensureUcExternalLocation,
} from '../shortcut-credentials';
import { executeQuery } from '../synapse-sql-client';

const OWNER = { kind: 'principal' as const, via: 'request' as const, oid: 'oid-u', upn: 'u@contoso.com' };

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
    expect(externalSourceGate('delta_sharing', false)?.code).toBe('needs_credential');
  });
  it('gates key_vault_not_configured when vault missing but ref present', () => {
    (keyVaultConfigGate as any).mockReturnValue({ missing: 'LOOM_KEY_VAULT_URI' });
    expect(externalSourceGate('gcs', true)?.code).toBe('key_vault_not_configured');
  });
  it('returns null when ref present and vault configured', () => {
    expect(externalSourceGate('s3', true)).toBeNull();
    expect(externalSourceGate('delta_sharing', true)).toBeNull();
  });
});

describe('bindExternalSource — Delta Sharing', () => {
  const profile = {
    shareCredentialsVersion: 1,
    endpoint: 'https://sharing.example.com/api/2.0/delta-sharing/metastores/m1/',
    bearerToken: 'tok-123',
    expirationTime: '2026-12-08T00:00:00.000Z',
  };
  const goodArgs = {
    lakehouseId: 'lh1', name: 'agency_a', targetType: 'delta_sharing' as const,
    targetUri: 'delta-sharing://agency_a/analytics/metrics',
    credentialRef: { kind: 'deltaSharing' as const, keyVaultSecret: 'loom-sc-ds-cred' }, owner: OWNER,
  };

  it('validates the credential file, lists shares, and returns parsed coordinates', async () => {
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify(profile));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }) as any,
    );
    const res = await bindExternalSource(goodArgs);
    expect('gated' in res).toBe(false);
    expect((res as any).readUri).toBe('delta-sharing://agency_a/analytics/metrics');
    expect((res as any).deltaSharing).toMatchObject({ share: 'agency_a', schema: 'analytics', table: 'metrics' });
    // Real HTTP test hit <endpoint>/shares with the bearer token.
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://sharing.example.com/api/2.0/delta-sharing/metastores/m1/shares');
    expect((init as any).headers.Authorization).toBe('Bearer tok-123');
    fetchSpy.mockRestore();
  });

  it('throws delta_sharing_auth_failure on a 401 from the share server', async () => {
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify(profile));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }) as any);
    await expect(bindExternalSource(goodArgs)).rejects.toMatchObject({ code: 'delta_sharing_auth_failure' });
    fetchSpy.mockRestore();
  });

  it('throws bad_delta_sharing_secret for non-JSON secret', async () => {
    (getKeyVaultSecret as any).mockResolvedValue('not json');
    await expect(bindExternalSource(goodArgs)).rejects.toMatchObject({ code: 'bad_delta_sharing_secret' });
  });

  it('throws bad_delta_sharing_secret when endpoint/bearerToken missing', async () => {
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify({ shareCredentialsVersion: 1 }));
    await expect(bindExternalSource(goodArgs)).rejects.toMatchObject({ code: 'bad_delta_sharing_secret' });
  });

  it('throws bad_target when targetUri is not delta-sharing://share/schema/table', async () => {
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify(profile));
    await expect(bindExternalSource({ ...goodArgs, targetUri: 'delta-sharing://onlyshare' }))
      .rejects.toMatchObject({ code: 'bad_target' });
  });
});

describe('bindExternalSource — S3 via Databricks UC (IAM role)', () => {
  it('resolves IAM role ARN, creates UC storage credential + external location', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    (getKeyVaultSecret as any).mockResolvedValue('arn:aws:iam::123456789012:role/loom-reader');
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'partner', targetType: 's3',
      targetUri: 's3://acme-bucket/data/partner', credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-s3-role' }, owner: OWNER,
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
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-s' }, owner: OWNER,
    })).rejects.toMatchObject({ code: 'bad_s3_secret' });
  });
});

describe('bindExternalSource — S3 via Synapse (access keys)', () => {
  it('emits DATABASE SCOPED CREDENTIAL + EXTERNAL DATA SOURCE DDL', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
    (getKeyVaultSecret as any).mockResolvedValue('AKIAEXAMPLE:supersecretkey');
    const res = await bindExternalSource({
      lakehouseId: 'lh1', name: 'sales', targetType: 's3',
      targetUri: 's3://acme/sales', credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-s3-keys' }, owner: OWNER,
    });
    expect((res as any).synapse?.dataSource).toContain('loom_s3_sales');
    // The S3 binding first ensures a user database exists (the scoped-credential
    // DDL is forbidden in `master`), so the binding DDL is the LAST executeQuery
    // call, not the first.
    const calls = (executeQuery as any).mock.calls as any[][];
    const ddl = calls.map((c) => c[1] as string).find((s) => s.includes('CREATE DATABASE SCOPED CREDENTIAL'))!;
    expect(ddl).toContain("CREATE DATABASE SCOPED CREDENTIAL");
    expect(ddl).toContain("IDENTITY = 'S3 Access Key'");
    expect(ddl).toContain("SECRET = 'AKIAEXAMPLE:supersecretkey'");
    expect(ddl).toContain("CREATE EXTERNAL DATA SOURCE");
    expect(ddl).toContain("LOCATION = 's3://acme'");
  });

  it('escapes a quote in the bucket inside LOCATION = \'…\' (the same quoting as the rest of the DDL)', async () => {
    // WHAT BREAKS IT: interpolating `obj.prefix` raw — the literal then closes at
    // the bucket's quote, and the expected doubled-quote form is absent.
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
    (getKeyVaultSecret as any).mockResolvedValue('AKIAEXAMPLE:supersecretkey');
    await bindExternalSource({
      lakehouseId: 'lh1', name: 'q', targetType: 's3',
      targetUri: "s3://ac'me/x", credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-s3-keys' }, owner: OWNER,
    });
    const ddl = ((executeQuery as any).mock.calls as any[][]).map((c) => c[1] as string)
      .find((s) => s.includes('CREATE EXTERNAL DATA SOURCE'))!;
    expect(ddl).toContain("LOCATION = 's3://ac''me'");
    expect(ddl).not.toContain("LOCATION = 's3://ac'me'");
  });

  it('escapes a quote in the container inside the SAS data source LOCATION = \'…\'', async () => {
    // WHAT BREAKS IT: interpolating `location` raw in the external-ADLS SAS
    // Tables path — the doubled-quote form is then absent and the raw one present.
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 'sasq', abfssUri: 'abfss://x@acct.dfs.core.windows.net/p',
      external: { objectUri: '', adlsSas: { sas: 'sv=2024&sig=x', account: 'acct', container: "da'ta", path: 'p' } } as any,
    });
    const ddl = ((executeQuery as any).mock.calls as any[][]).map((c) => c[1] as string)
      .find((s) => s.includes('CREATE EXTERNAL DATA SOURCE'))!;
    expect(ddl).toMatch(/LOCATION = 'https:\/\/acct\.[a-z0-9.]+\/da''ta'/);
    expect(ddl).not.toMatch(/LOCATION = 'https:\/\/acct\.[a-z0-9.]+\/da'ta'/);
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
      targetUri: 'gs://gbucket/path', credentialRef: { kind: 'gcsServiceAccount', keyVaultSecret: 'loom-sc-gcs-sa' }, owner: OWNER,
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
      credentialRef: { kind: 'gcsServiceAccount', keyVaultSecret: 'loom-sc-gcs-sa' }, owner: OWNER,
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
      targetUri: 'dataverse://org/account', credentialRef: { kind: 'servicePrincipal', keyVaultSecret: 'loom-sc-dv-path' }, owner: OWNER,
    });
    expect((res as any).readUri).toBe('abfss://dataverse@dvlake.dfs.core.windows.net/account');
  });
  it('rejects a Dataverse secret that is not an ADLS path', async () => {
    (getKeyVaultSecret as any).mockResolvedValue('not-a-path');
    await expect(bindExternalSource({
      lakehouseId: 'lh1', name: 'dv', targetType: 'dataverse', targetUri: 'dataverse://o/a',
      credentialRef: { kind: 'servicePrincipal', keyVaultSecret: 'loom-sc-dv-path' }, owner: OWNER,
    })).rejects.toMatchObject({ code: 'bad_dataverse_secret' });
  });
});

/**
 * Malformed-credential errors describe the EXPECTED SHAPE and never echo the
 * resolved value. These messages reach the create/test responses and the
 * registry row's `statusDetail` verbatim (after HTML stripping).
 *
 * WHAT BREAKS THEM: the pre-change messages appended `got: ${value.slice(0, N)}`
 * (N=80 Dataverse, N=60 S3). The sentinel is 32 characters with no `abfss://`
 * or `arn:aws` shape, so it fails both parsers, fits inside either slice, and
 * every 6-character window of it would appear in the old message — so the
 * absence loop goes red. The positive assertion (the shape message is present)
 * goes red if the throw is removed or reworded, so the absence check cannot pass
 * by deleting the error.
 */
describe('malformed credential errors never echo the resolved value', () => {
  const SENTINEL = 'Zq9Xv7Kp3Wm5Jt1Rb8Ny4Hc6Lf2Gd0Ue';
  const WINDOW = 6;
  function expectNoFragment(message: string) {
    expect(SENTINEL.length).toBe(32);
    const hay = message.toLowerCase();
    for (let i = 0; i + WINDOW <= SENTINEL.length; i += 1) {
      const frag = SENTINEL.slice(i, i + WINDOW).toLowerCase();
      expect(hay.includes(frag), `message contains value fragment "${frag}": ${message}`).toBe(false);
    }
  }

  it('Dataverse: a non-path value is refused with the shape message only', async () => {
    (getKeyVaultSecret as any).mockResolvedValue(SENTINEL);
    const err = await bindExternalSource({
      lakehouseId: 'lh1', name: 'dv', targetType: 'dataverse', targetUri: 'dataverse://o/a',
      credentialRef: { kind: 'servicePrincipal', keyVaultSecret: 'loom-sc-dv-path' }, owner: OWNER,
    }).catch((e) => e);
    expect(err.code).toBe('bad_dataverse_secret');
    expect(err.message).toContain(SECRET_SHAPE_MISMATCH);
    expect(err.message).toContain("'loom-sc-dv-path'");
    expectNoFragment(err.message);
  });

  it('S3 (Databricks UC): a non-ARN value is refused with the shape message only', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    (getKeyVaultSecret as any).mockResolvedValue(SENTINEL);
    const err = await bindExternalSource({
      lakehouseId: 'lh1', name: 'p', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-s3-role' }, owner: OWNER,
    }).catch((e) => e);
    expect(err.code).toBe('bad_s3_secret');
    expect(err.message).toContain(SECRET_SHAPE_MISMATCH);
    expectNoFragment(err.message);
    expect(ensureUcAwsStorageCredential).not.toHaveBeenCalled();
  });

  it('Delta Sharing: an unreachable endpoint from the credential file is not echoed', async () => {
    // The endpoint host IS part of the stored value. The fetch rejection carries
    // the URL in its message, so echoing either the URL or `netErr.message`
    // would put the sentinel in the error.
    const endpoint = `https://${SENTINEL.toLowerCase()}.example.net/delta-sharing/`;
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify({ shareCredentialsVersion: 1, endpoint, bearerToken: 'tok' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError(`fetch failed for ${endpoint}shares`), { cause: { code: 'ENOTFOUND' } }),
    );
    const err = await bindExternalSource({
      lakehouseId: 'lh1', name: 'agency_a', targetType: 'delta_sharing', targetUri: 'delta-sharing://a/b/c',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'loom-sc-ds-cred' }, owner: OWNER,
    }).catch((e) => e);
    fetchSpy.mockRestore();
    expect(err.code).toBe('delta_sharing_unreachable');
    expect(err.message).toContain('(ENOTFOUND)');
    expectNoFragment(err.message);
  });

  it('Delta Sharing: a non-OK status names the status, not the endpoint', async () => {
    const endpoint = `https://${SENTINEL.toLowerCase()}.example.net/delta-sharing/`;
    (getKeyVaultSecret as any).mockResolvedValue(JSON.stringify({ shareCredentialsVersion: 1, endpoint, bearerToken: 'tok' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }) as any);
    const err = await bindExternalSource({
      lakehouseId: 'lh1', name: 'agency_a', targetType: 'delta_sharing', targetUri: 'delta-sharing://a/b/c',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'loom-sc-ds-cred' }, owner: OWNER,
    }).catch((e) => e);
    fetchSpy.mockRestore();
    expect(err.code).toBe('delta_sharing_unreachable');
    expect(err.message).toContain('HTTP 500');
    expectNoFragment(err.message);
  });
});

describe('bindExternalSource resolves through the shortcut-secret policy', () => {
  // WHAT BREAKS THEM: bindExternalSource calling getKeyVaultSecret directly
  // (the pre-change shape) reads the vault for both refused names below.
  it('refuses a platform secret name before any vault read', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    await expect(bindExternalSource({
      lakehouseId: 'lh1', name: 'p', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-msal-client-secret' }, owner: OWNER,
    })).rejects.toMatchObject({ name: 'KeyVaultSecretPolicyError', status: 403 });
    expect(getKeyVaultSecret).not.toHaveBeenCalled();
  });

  it('an item owner resolves only its own minted name', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-x.azuredatabricks.net';
    (getKeyVaultSecret as any).mockResolvedValue('arn:aws:iam::123456789012:role/loom-reader');
    await expect(bindExternalSource({
      lakehouseId: 'sc_item-1', name: 'p', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-shortcut-item-2' }, owner: { kind: 'item', itemId: 'item-1' },
    })).rejects.toMatchObject({ name: 'ShortcutSecretOwnershipError', status: 403 });
    expect(getKeyVaultSecret).not.toHaveBeenCalled();
    const ok = await bindExternalSource({
      lakehouseId: 'sc_item-1', name: 'p', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-shortcut-item-1' }, owner: { kind: 'item', itemId: 'item-1' },
    });
    expect((ok as any).readUri).toBe('s3://b/k');
    expect(getKeyVaultSecret).toHaveBeenCalledWith('loom-shortcut-item-1');
  });
});

/**
 * Values in nested dynamic SQL are escaped for each literal level.
 *
 * `EXEC('CREATE VIEW … OPENROWSET(BULK ''<value>'', …)')` puts <value> inside a
 * literal that is itself inside a literal, so a quote in it must be doubled
 * twice. These tests DECODE the statement the way T-SQL does — the EXEC
 * literal first, then the inner literal — and assert the decoded value is the
 * intended one, and that the EXEC literal closes exactly at `')`.
 *
 * WHAT BREAKS EACH ONE: escaping the value for one level only (or not at all).
 * The EXEC literal then closes at the value's quote, so it no longer ends at
 * `');` and the decoded BULK / DATA_SOURCE value is cut short.
 */
describe('nested dynamic SQL: values are escaped for each literal level', () => {
  /** Read the T-SQL literal whose opening quote is at `open`; `''` is one quote. */
  function readLiteral(s: string, open: number): { value: string; end: number } {
    expect(s[open]).toBe("'");
    let out = '';
    for (let i = open + 1; i < s.length; i++) {
      if (s[i] !== "'") { out += s[i]; continue; }
      if (s[i + 1] === "'") { out += "'"; i++; continue; }
      return { value: out, end: i + 1 };
    }
    throw new Error('unterminated literal');
  }

  /** Decode EXEC('…') in `ddl`, then the literal after each `marker` in the result. */
  function decodeView(ddl: string) {
    const at = ddl.indexOf("EXEC('CREATE VIEW");
    expect(at).toBeGreaterThanOrEqual(0);
    const outer = readLiteral(ddl, at + 'EXEC('.length);
    // The EXEC literal must close exactly at the end of the statement.
    expect(ddl.slice(outer.end)).toBe(');');
    const inner = outer.value;
    const lit = (marker: string) => {
      const i = inner.indexOf(marker);
      expect(i, `marker ${marker} in ${inner}`).toBeGreaterThanOrEqual(0);
      return readLiteral(inner, i + marker.length).value;
    };
    return { inner, lit };
  }

  const viewDdl = () => ((executeQuery as any).mock.calls as any[][]).map((c) => c[1] as string)
    .find((s) => s.includes("EXEC('CREATE VIEW"))!;

  beforeEach(() => { process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1'; });

  it('sqlLiteralAt doubles each quote once per level', () => {
    // WHAT BREAKS IT: a helper that ignores `levels`.
    expect(sqlLiteralAt("o'k", 1)).toBe("o''k");
    expect(sqlLiteralAt("o'k", 2)).toBe("o''''k");
    expect(() => sqlLiteralAt('x', 3 as any)).toThrow(/literal depth/);
  });

  it('SAS Tables path: the object key inside BULK', async () => {
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 'sasv', abfssUri: 'abfss://x@acct.dfs.core.windows.net/p', format: 'parquet',
      external: { objectUri: '', adlsSas: { sas: 'sv=2024&sig=x', account: 'acct', container: 'data', path: "exports/o'neil.parquet" } } as any,
    });
    const ddl = viewDdl();
    expect(ddl).toContain("BULK ''exports/o''''neil.parquet''");
    const { lit } = decodeView(ddl);
    expect(lit('BULK ')).toBe("exports/o'neil.parquet");
    expect(lit('DATA_SOURCE = ')).toBe('loom_adls_sas_sasv_ds');
    expect(lit('FORMAT = ')).toBe('PARQUET');
  });

  it('S3 over a Synapse data source: the object key inside BULK', async () => {
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 's3v', abfssUri: '', format: 'parquet',
      external: { objectUri: 's3://b/k', synapseDataSource: 'loom_s3_x_ds', objectKey: "in/o'k.parquet" } as any,
    });
    const ddl = viewDdl();
    expect(ddl).toContain("BULK ''in/o''''k.parquet''");
    const { lit } = decodeView(ddl);
    expect(lit('BULK ')).toBe("in/o'k.parquet");
    expect(lit('FORMAT = ')).toBe('PARQUET');
  });

  it('S3 over a Synapse data source: the data source name inside DATA_SOURCE', async () => {
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 's3d', abfssUri: '', format: 'parquet',
      external: { objectUri: 's3://b/k', synapseDataSource: "ds'x", objectKey: 'in/k.parquet' } as any,
    });
    const ddl = viewDdl();
    expect(ddl).toContain("DATA_SOURCE = ''ds''''x''");
    const { lit } = decodeView(ddl);
    expect(lit('DATA_SOURCE = ')).toBe("ds'x");
    expect(lit('BULK ')).toBe('in/k.parquet');
  });

  it('in-tenant ADLS: the https URL inside BULK', async () => {
    await createTablesShortcut({
      lakehouseId: 'lh1', name: 'adlsv', abfssUri: "abfss://c@acct.dfs.core.windows.net/dir/o'neil", format: 'delta',
    } as any);
    const ddl = viewDdl();
    expect(ddl).toContain("BULK ''https://acct.dfs.core.windows.net/c/dir/o''''neil''");
    const { lit } = decodeView(ddl);
    expect(lit('BULK ')).toBe("https://acct.dfs.core.windows.net/c/dir/o'neil");
    expect(lit('FORMAT = ')).toBe('DELTA');
  });
});
