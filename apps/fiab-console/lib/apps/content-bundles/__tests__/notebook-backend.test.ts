/**
 * Unit tests for the backend-aware notebook utility-API adapter
 * (lib/apps/content-bundles/notebook-backend.ts).
 *
 * Pins the contract the bundles rely on:
 *   • resolveNotebookBackend mirrors notebook.ts install-time precedence.
 *   • renderUtil emits the CORRECT utility API per backend — mssparkutils for
 *     Synapse, dbutils for Databricks, notebookutils for Fabric, and a pure
 *     abfss://-direct / Key-Vault-SDK path (NO mount, NO dbutils) for Azure ML.
 *   • The runtime shim + intent emitters produce the guarded, self-detecting
 *     helpers every bundle now calls instead of a raw dbutils.*.
 */
import { describe, it, expect } from 'vitest';

import {
  resolveNotebookBackend,
  renderUtil,
  abfssUri,
  pyLit,
  NOTEBOOK_BACKEND_SHIM,
  SHIM_MARKER_BEGIN,
  SHIM_MARKER_END,
  backendUtilShimCell,
  loomSecret,
  loomArg,
  loomAdlsPath,
  loomMountAdls,
  loomFsLs,
  type NotebookBackend,
} from '../notebook-backend';

describe('resolveNotebookBackend — mirrors notebook.ts precedence', () => {
  it('defaults to fabric when nothing is configured (bound-ws last resort)', () => {
    expect(resolveNotebookBackend({})).toBe('fabric');
  });

  it('picks Synapse when only Synapse is configured (Azure-native default)', () => {
    expect(resolveNotebookBackend({ LOOM_SYNAPSE_WORKSPACE: 'ws' })).toBe('synapse');
  });

  it('picks Databricks when only Databricks is configured', () => {
    expect(resolveNotebookBackend({ LOOM_DATABRICKS_HOSTNAME: 'adb.example.net' })).toBe('databricks');
  });

  it('Synapse WINS when BOTH Synapse and Databricks are configured', () => {
    expect(
      resolveNotebookBackend({ LOOM_SYNAPSE_WORKSPACE: 'ws', LOOM_DATABRICKS_HOSTNAME: 'adb' }),
    ).toBe('synapse');
  });

  it('LOOM_NOTEBOOK_BACKEND=databricks overrides the Synapse default when DBX is configured', () => {
    expect(
      resolveNotebookBackend({
        LOOM_NOTEBOOK_BACKEND: 'databricks',
        LOOM_SYNAPSE_WORKSPACE: 'ws',
        LOOM_DATABRICKS_HOSTNAME: 'adb',
      }),
    ).toBe('databricks');
  });

  it('honours explicit fabric / aml opt-in', () => {
    expect(resolveNotebookBackend({ LOOM_NOTEBOOK_BACKEND: 'fabric' })).toBe('fabric');
    expect(resolveNotebookBackend({ LOOM_NOTEBOOK_BACKEND: 'aml' })).toBe('aml');
  });
});

describe('renderUtil — correct utility API per backend', () => {
  it('get-secret: mssparkutils on Synapse, dbutils on Databricks, notebookutils on Fabric', () => {
    const args = { scope: 'kv-secrets', key: 'sp-client-id', vaultUrl: 'https://v.vault.azure.net' };
    expect(renderUtil('get-secret', 'synapse', args)).toContain('mssparkutils.credentials.getSecret');
    expect(renderUtil('get-secret', 'synapse', args)).not.toContain('dbutils');
    expect(renderUtil('get-secret', 'databricks', args)).toContain('dbutils.secrets.get');
    expect(renderUtil('get-secret', 'fabric', args)).toContain('notebookutils.credentials.getSecret');
  });

  it('get-secret: AML uses the Key Vault SDK with a managed identity — NO util surface', () => {
    const aml = renderUtil('get-secret', 'aml', { key: 'sp-client-id', vaultUrl: 'https://v.vault.azure.net' });
    expect(aml).toContain('SecretClient');
    expect(aml).toContain('DefaultAzureCredential');
    expect(aml).not.toContain('dbutils');
    expect(aml).not.toContain('mssparkutils');
    expect(aml).not.toContain('notebookutils');
  });

  it('get-arg: dbutils.widgets on Databricks, getArgument on Synapse/Fabric, os.environ on AML', () => {
    const args = { name: 'adls_account', default: '' };
    expect(renderUtil('get-arg', 'databricks', args)).toContain('dbutils.widgets.get');
    expect(renderUtil('get-arg', 'synapse', args)).toContain('mssparkutils.notebook.getArgument');
    expect(renderUtil('get-arg', 'fabric', args)).toContain('notebookutils.notebook.getArgument');
    const aml = renderUtil('get-arg', 'aml', args);
    expect(aml).toContain('os.environ.get');
    expect(aml).toContain("'ADLS_ACCOUNT'"); // upper-cased env var name
    expect(aml).not.toContain('dbutils');
  });

  it('mount-adls: mount API per engine, but ABFSS-DIRECT (no mount) on AML', () => {
    const args = { container: 'landing', account: 'acct', mountPoint: '/mnt/data' };
    expect(renderUtil('mount-adls', 'databricks', args)).toContain('dbutils.fs.mount');
    expect(renderUtil('mount-adls', 'synapse', args)).toContain('mssparkutils.fs.mount');
    expect(renderUtil('mount-adls', 'fabric', args)).toContain('notebookutils.fs.mount');
    const aml = renderUtil('mount-adls', 'aml', args);
    expect(aml).toContain('abfss://landing@acct.dfs.core.windows.net/');
    expect(aml).not.toContain('.mount(');
    expect(aml).not.toContain('dbutils');
    expect(aml).not.toContain('mssparkutils');
  });

  it('list-path: fs.ls per engine, JVM Hadoop FS on AML (no util fs)', () => {
    const args = { path: '/mnt/data' };
    expect(renderUtil('list-path', 'databricks', args)).toContain('dbutils.fs.ls');
    expect(renderUtil('list-path', 'synapse', args)).toContain('mssparkutils.fs.ls');
    expect(renderUtil('list-path', 'fabric', args)).toContain('notebookutils.fs.ls');
    const aml = renderUtil('list-path', 'aml', args);
    expect(aml).toContain('org.apache.hadoop.fs.Path');
    expect(aml).not.toContain('dbutils');
  });

  it('adls-path: identical canonical abfss:// URI on every backend', () => {
    const args = { container: 'bronze', account: 'acct', path: 'events' };
    for (const b of ['synapse', 'databricks', 'fabric', 'aml'] as NotebookBackend[]) {
      expect(renderUtil('adls-path', b, args)).toBe("'abfss://bronze@acct.dfs.core.windows.net/events'");
    }
  });
});

describe('abfssUri + pyLit helpers', () => {
  it('abfssUri builds a mount-free root + sub-path', () => {
    expect(abfssUri('c', 'a')).toBe('abfss://c@a.dfs.core.windows.net/');
    expect(abfssUri('c', 'a', '/x/y')).toBe('abfss://c@a.dfs.core.windows.net/x/y');
  });

  it('pyLit escapes backslash and single-quote for a Python literal', () => {
    expect(pyLit("a'b")).toBe("'a\\'b'");
    expect(pyLit('a\\b')).toBe("'a\\\\b'");
  });
});

describe('NOTEBOOK_BACKEND_SHIM — runtime-detecting, guarded', () => {
  it('defines every backend-agnostic helper', () => {
    for (const fn of [
      'def _loom_runtime',
      'def loom_get_secret',
      'def loom_get_arg',
      'def loom_adls_path',
      'def loom_configure_oauth',
      'def loom_mount_adls',
      'def loom_fs_ls',
    ]) {
      expect(NOTEBOOK_BACKEND_SHIM).toContain(fn);
    }
  });

  it('references dbutils ONLY behind a NameError-guarded runtime probe', () => {
    // The single bare `dbutils` reference is the runtime probe, guarded by
    // `except NameError` so it never throws on Synapse/AML.
    expect(NOTEBOOK_BACKEND_SHIM).toContain('except NameError');
    expect(NOTEBOOK_BACKEND_SHIM).toContain(SHIM_MARKER_BEGIN);
    expect(NOTEBOOK_BACKEND_SHIM).toContain(SHIM_MARKER_END);
  });

  it('covers all four engines by name', () => {
    expect(NOTEBOOK_BACKEND_SHIM).toContain('notebookutils');
    expect(NOTEBOOK_BACKEND_SHIM).toContain('mssparkutils');
    expect(NOTEBOOK_BACKEND_SHIM).toContain('SecretClient'); // AML Key Vault SDK
  });

  it('backendUtilShimCell wraps the shim as a runnable pyspark code cell', () => {
    const cell = backendUtilShimCell();
    expect(cell.type).toBe('code');
    expect(cell.lang).toBe('pyspark');
    expect(cell.source).toContain('def loom_get_secret');
    expect(cell.source).toContain(SHIM_MARKER_BEGIN);
  });
});

describe('intent emitters — bundles author intent, not raw dbutils', () => {
  it('loomSecret', () => {
    expect(loomSecret('kv', 'k')).toBe("loom_get_secret('kv', 'k')");
    expect(loomSecret('kv', 'k', 'https://v')).toBe("loom_get_secret('kv', 'k', 'https://v')");
    expect(loomSecret('kv', 'k')).not.toContain('dbutils');
  });

  it('loomArg', () => {
    expect(loomArg('adls_account')).toBe("loom_get_arg('adls_account')");
    expect(loomArg('adls_account', '')).toBe("loom_get_arg('adls_account', '')");
  });

  it('loomAdlsPath / loomMountAdls / loomFsLs', () => {
    expect(loomAdlsPath('c', 'a')).toBe("loom_adls_path('c', 'a')");
    expect(loomAdlsPath('c', 'a', 'p')).toBe("loom_adls_path('c', 'a', 'p')");
    expect(loomMountAdls('c', 'a', '/mnt/data')).toBe("loom_mount_adls('c', 'a', '/mnt/data')");
    expect(loomFsLs('/mnt/data')).toBe("loom_fs_ls('/mnt/data')");
  });
});
