/**
 * Backend-aware notebook utility-API adapter (shared by every content bundle).
 *
 * WHY THIS EXISTS
 * ───────────────
 * A Loom notebook is authored ONCE in a content bundle but can run on FOUR
 * different Spark engines, chosen by two independent precedence chains:
 *   • INSTALL-time (notebook import / storage dialect), lib/install/provisioners/
 *     notebook.ts — Synapse Spark (Hive) is the Azure-native DEFAULT, Databricks
 *     is opt-in, a bound Fabric workspace is a last resort.
 *   • RUN-time (%%pyspark cell execution), app/api/items/notebook/[id]/
 *     execute-spark + run routes — the SAME notebook can additionally be
 *     dispatched to Azure ML Spark (serverless standalone job / AML compute
 *     instance) which is selected at RUN time, independent of the storage backend.
 *
 * Each engine exposes a DIFFERENT notebook utility surface:
 *   • Databricks           → `dbutils.*`  (secrets / widgets / fs.mount / fs.ls)
 *   • Synapse Spark        → `mssparkutils.*`
 *   • Fabric               → `notebookutils.*`  (mssparkutils is the legacy alias)
 *   • Azure ML Spark       → NONE. No dbutils, no mssparkutils, no notebookutils.
 *                            AML reads ADLS via direct `abfss://` paths (managed
 *                            identity passthrough or a `spark.conf` OAuth block)
 *                            and reads secrets via the Key Vault SDK.
 *
 * Bundles that hard-coded `dbutils.*` therefore threw `NameError: name 'dbutils'
 * is not defined` the moment their notebook ran on the Synapse default (the live
 * bug this module fixes) — and would fail identically on AML.
 *
 * WHAT THIS MODULE PROVIDES
 * ─────────────────────────
 * 1. `resolveNotebookBackend()` — the install-time engine, mirroring notebook.ts
 *    precedence exactly, so a bundle can pick the storage DIALECT deterministically.
 * 2. `renderUtil(intent, backend, args)` — a pure per-backend code emitter (the
 *    "author intent, not raw dbutils" helper). Given a logical intent
 *    (get-secret / get-arg / mount-adls / list-path / adls-path) and a backend it
 *    returns the backend-correct Python snippet. Used to BUILD the runtime shim's
 *    branches and asserted per-backend by the unit tests.
 * 3. `NOTEBOOK_BACKEND_SHIM` + `backendUtilShimCell()` — a RUNTIME-detecting Python
 *    preamble (extends the try/except cascade already proven in
 *    `_notebook-preamble.ts`) that defines `loom_get_secret` / `loom_get_arg` /
 *    `loom_mount_adls` / `loom_fs_ls` / `loom_adls_path`. Because the engine is
 *    only known at run time (AML is chosen then), the shim self-detects rather
 *    than baking a single install-time choice — a notebook copied between
 *    backends, or run once on Synapse Livy and once on AML, keeps working.
 * 4. `loomSecret` / `loomArg` / `loomMountAdls` / `loomFsLs` / `loomAdlsPath` —
 *    thin emitters returning a Python CALL to the shim helper, so bundle cell
 *    bodies contain `loom_get_secret('kv','k')` instead of a raw `dbutils.*`
 *    (keeps every bundle free of un-guarded utility-API calls).
 *
 * Grounded in Microsoft Learn: "Introduction to Microsoft Spark utilities"
 * (mssparkutils/notebookutils fs.mount / credentials.getSecret / notebook.
 * getArgument), Databricks `dbutils` reference, and "Configure Apache Spark jobs
 * in Azure Machine Learning" / "Interactive data wrangling with Apache Spark"
 * (AML reads `abfss://…` directly with identity passthrough or SP OAuth — no
 * mount API exists).
 */

/** The Spark engine a notebook cell targets. AML is a RUN-time-only target. */
export type NotebookBackend = 'synapse' | 'databricks' | 'aml' | 'fabric';

/** A logical utility-API intent a bundle authors instead of a raw API call. */
export type NotebookUtilIntent =
  | 'get-secret'
  | 'get-arg'
  | 'mount-adls'
  | 'list-path'
  | 'adls-path';

/**
 * Resolve the install-time notebook engine using the SAME precedence as
 * lib/install/provisioners/notebook.ts (`provisionAzureNative`):
 *   1. `LOOM_NOTEBOOK_BACKEND=fabric`                          → fabric (opt-in).
 *   2. `LOOM_NOTEBOOK_BACKEND=aml`                             → aml (explicit).
 *   3. `LOOM_NOTEBOOK_BACKEND=databricks` AND Databricks set   → databricks.
 *   4. `LOOM_SYNAPSE_WORKSPACE` set                            → synapse (DEFAULT;
 *      Synapse wins when BOTH Synapse + Databricks are configured, matching
 *      notebook.ts).
 *   5. `LOOM_DATABRICKS_HOSTNAME` set                          → databricks.
 *   6. otherwise                                               → fabric (the
 *      bound-workspace last resort).
 *
 * On the client (no LOOM_* env) this returns 'fabric' only when nothing is set;
 * server-side install is where the executable dialect that matters is built.
 * The Python cell bodies bundles emit are RUNTIME-detecting (see the shim), so
 * they are correct on every engine regardless of what this returns — this is
 * used only for the SQL-dialect / display-name choices that must be fixed at
 * install time.
 */
export function resolveNotebookBackend(
  env: Record<string, string | undefined> = (typeof process !== 'undefined' && process.env) || {},
): NotebookBackend {
  const forced = (env.LOOM_NOTEBOOK_BACKEND || '').toLowerCase();
  const hasSynapse = !!env.LOOM_SYNAPSE_WORKSPACE;
  const hasDatabricks = !!env.LOOM_DATABRICKS_HOSTNAME;
  if (forced === 'fabric') return 'fabric';
  if (forced === 'aml') return 'aml';
  if (forced === 'databricks' && hasDatabricks) return 'databricks';
  if (forced === 'synapse' && hasSynapse) return 'synapse';
  if (hasSynapse) return 'synapse';
  if (hasDatabricks) return 'databricks';
  return 'fabric';
}

/**
 * Escape a string for safe embedding inside a Python single-quoted literal.
 * NOT a SQL literal — no SQL/KQL escaping applies here (these strings never reach
 * a SQL/KQL parser); only backslash + single-quote need escaping for a Python
 * `'…'` string, matching lib/notebook/lakehouse-mount-preamble.ts `pyStr`.
 */
export function pyLit(s: string): string {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Canonical, mount-free ADLS Gen2 URI — read directly by every Spark engine. */
export function abfssUri(container: string, account: string, path = ''): string {
  const base = `abfss://${container}@${account}.dfs.core.windows.net/`;
  return path ? base + String(path).replace(/^\/+/, '') : base;
}

export interface UtilArgs {
  /** get-secret: the Databricks secret scope / (Synapse/Fabric) Key Vault URI. */
  scope?: string;
  /** get-secret: secret name/key. */
  key?: string;
  /** get-secret: explicit Key Vault URI (Synapse/Fabric/AML). */
  vaultUrl?: string;
  /** get-arg: parameter/widget name. */
  name?: string;
  /** get-arg: default when unset. */
  default?: string;
  /** mount-adls / list-path / adls-path: storage container. */
  container?: string;
  /** mount-adls / list-path / adls-path: storage account name. */
  account?: string;
  /** mount-adls: local mount point (Databricks/Synapse/Fabric). */
  mountPoint?: string;
  /** list-path / adls-path: sub-path under the container root. */
  path?: string;
}

function q(v: string | undefined, fallback = ''): string {
  return pyLit(v ?? fallback);
}

/**
 * Emit the backend-correct Python snippet for a single utility intent. Pure —
 * no env read — so the unit tests can assert each backend's output directly and
 * the shim can compose all four branches from one source of truth.
 *
 * Contract per backend (the test pins these):
 *   • databricks → `dbutils.*`
 *   • synapse    → `mssparkutils.*`
 *   • fabric     → `notebookutils.*`
 *   • aml        → NO dbutils/mssparkutils/notebookutils, NO mount — direct
 *                  `abfss://…`, Key Vault SDK, os.environ, JVM Hadoop listing.
 */
export function renderUtil(intent: NotebookUtilIntent, backend: NotebookBackend, args: UtilArgs = {}): string {
  switch (intent) {
    case 'get-secret': {
      const key = q(args.key);
      const vault = q(args.vaultUrl || args.scope);
      if (backend === 'databricks') return `dbutils.secrets.get(${q(args.scope)}, ${key})`;
      if (backend === 'synapse') return `mssparkutils.credentials.getSecret(${vault}, ${key})`;
      if (backend === 'fabric') return `notebookutils.credentials.getSecret(${vault}, ${key})`;
      // AML: no util surface — Key Vault SDK with the job's managed identity.
      return (
        `SecretClient(vault_url=${vault}, credential=DefaultAzureCredential())` +
        `.get_secret(${key}).value`
      );
    }
    case 'get-arg': {
      const name = q(args.name);
      const dflt = args.default !== undefined ? q(args.default) : 'None';
      const envName = q((args.name || '').toUpperCase());
      if (backend === 'databricks') return `dbutils.widgets.get(${name})`;
      if (backend === 'synapse') return `mssparkutils.notebook.getArgument(${name}, ${dflt})`;
      if (backend === 'fabric') return `notebookutils.notebook.getArgument(${name}, ${dflt})`;
      return `os.environ.get(${envName}, ${dflt})`;
    }
    case 'adls-path': {
      return q(abfssUri(args.container || '', args.account || '', args.path || ''));
    }
    case 'list-path': {
      const path = q(args.path);
      if (backend === 'databricks') return `dbutils.fs.ls(${path})`;
      if (backend === 'synapse') return `mssparkutils.fs.ls(${path})`;
      if (backend === 'fabric') return `notebookutils.fs.ls(${path})`;
      // AML: list via the Hadoop FileSystem through the JVM (no util fs surface).
      return (
        `[f.getPath().toString() for f in ` +
        `spark._jvm.org.apache.hadoop.fs.Path(${path})` +
        `.getFileSystem(spark._jsc.hadoopConfiguration())` +
        `.listStatus(spark._jvm.org.apache.hadoop.fs.Path(${path}))]`
      );
    }
    case 'mount-adls': {
      const src = q(abfssUri(args.container || '', args.account || ''));
      const mnt = q(args.mountPoint || '/mnt/data');
      if (backend === 'databricks') {
        return (
          `dbutils.fs.mount(source=${src}, mount_point=${mnt}, extra_configs=configs)`
        );
      }
      if (backend === 'synapse') return `mssparkutils.fs.mount(${src}, ${mnt}, {})`;
      if (backend === 'fabric') return `notebookutils.fs.mount(${src}, ${mnt}, {})`;
      // AML: NO mount API — use the direct abfss path (returned as-is).
      return src;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RUNTIME-DETECTING SHIM
//  Defines backend-agnostic helpers a bundle cell can call unconditionally. Each
//  helper self-detects the engine at run time via the SAME cascade proven in
//  _notebook-preamble.ts (notebookutils → mssparkutils → dbutils → plain), so a
//  single authored cell is correct on Synapse, Databricks, Fabric, AND AML.
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel comments delimiting the shim block (used by the bundle-lint test to
 * exclude the one guarded location where `dbutils` legitimately appears). */
export const SHIM_MARKER_BEGIN = '# === CSA Loom backend-util shim (guarded; Synapse/Databricks/Fabric/AML) ===';
export const SHIM_MARKER_END = '# === end CSA Loom backend-util shim ===';

export const NOTEBOOK_BACKEND_SHIM: string = [
  SHIM_MARKER_BEGIN,
  '# Backend-agnostic notebook utility helpers. A Loom notebook can run on Synapse',
  '# Spark (mssparkutils), Databricks (dbutils), Fabric (notebookutils) or Azure ML',
  '# Spark (no util surface at all). These helpers self-detect the engine so a cell',
  "# never calls a utility API that doesn't exist on the runtime it lands on.",
  'import os',
  '',
  '',
  'def _loom_runtime():',
  '    """Return the notebook utility surface available on THIS engine."""',
  '    try:',
  '        import notebookutils  # Fabric / newer Synapse',
  "        return 'notebookutils'",
  '    except ImportError:',
  '        pass',
  '    try:',
  '        import mssparkutils  # legacy Synapse / Fabric',
  "        return 'mssparkutils'",
  '    except ImportError:',
  '        pass',
  '    try:',
  '        dbutils  # Databricks injects this as a global',
  "        return 'dbutils'",
  '    except NameError:',
  "        return 'none'  # Azure ML Spark / plain python — no notebook util surface",
  '',
  '',
  'def loom_get_arg(name, default=None):',
  '    """Read a notebook parameter/widget on any engine (env fallback on AML)."""',
  '    rt = _loom_runtime()',
  "    if rt == 'dbutils':",
  '        try:',
  '            return dbutils.widgets.get(name)',
  '        except Exception:',
  '            return os.environ.get(name.upper(), default)',
  "    if rt in ('notebookutils', 'mssparkutils'):",
  '        mod = __import__(rt)',
  '        try:',
  '            return mod.notebook.getArgument(name, default)',
  '        except Exception:',
  '            return os.environ.get(name.upper(), default)',
  '    return os.environ.get(name.upper(), default)',
  '',
  '',
  'def loom_get_secret(scope, key, vault_url=None):',
  '    """Read a secret on any engine. `scope` is the Databricks secret scope; on',
  '    Synapse/Fabric it is a Key Vault linked-service name or vault URI; on AML the',
  '    job\'s managed identity reads Key Vault directly via the SDK."""',
  '    rt = _loom_runtime()',
  "    if rt == 'dbutils':",
  '        return dbutils.secrets.get(scope, key)',
  "    if rt in ('notebookutils', 'mssparkutils'):",
  '        return __import__(rt).credentials.getSecret(vault_url or scope, key)',
  '    # Azure ML / plain: Key Vault SDK with DefaultAzureCredential (managed identity).',
  '    from azure.identity import DefaultAzureCredential',
  '    from azure.keyvault.secrets import SecretClient',
  "    vu = vault_url or os.environ.get('LOOM_KEY_VAULT_URL') or ('https://%s.vault.azure.net' % scope)",
  '    return SecretClient(vault_url=vu, credential=DefaultAzureCredential()).get_secret(key).value',
  '',
  '',
  'def loom_adls_path(container, account, path=""):',
  '    """Canonical mount-free abfss:// URI — read directly by every Spark engine."""',
  "    base = 'abfss://%s@%s.dfs.core.windows.net/' % (container, account)",
  "    return base + path.lstrip('/') if path else base",
  '',
  '',
  'def loom_configure_oauth(account, client_id=None, client_secret=None, tenant_id=None):',
  '    """Configure per-account SP OAuth for direct abfss reads (needed on AML, which',
  '    has no mount; harmless elsewhere). No-op when creds are absent so managed-',
  '    identity passthrough is used instead."""',
  '    if not (client_id and client_secret and tenant_id):',
  '        return',
  "    host = '%s.dfs.core.windows.net' % account",
  "    spark.conf.set('fs.azure.account.auth.type.' + host, 'OAuth')",
  "    spark.conf.set('fs.azure.account.oauth.provider.type.' + host,",
  "                   'org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider')",
  "    spark.conf.set('fs.azure.account.oauth2.client.id.' + host, client_id)",
  "    spark.conf.set('fs.azure.account.oauth2.client.secret.' + host, client_secret)",
  "    spark.conf.set('fs.azure.account.oauth2.client.endpoint.' + host,",
  "                   'https://login.microsoftonline.com/%s/oauth2/token' % tenant_id)",
  '',
  '',
  'def loom_mount_adls(container, account, mount_point, extra_configs=None):',
  '    """Mount ADLS where the engine supports it (Databricks/Synapse/Fabric); on AML',
  '    there is NO mount surface, so return the direct abfss:// path instead. Callers',
  '    use the returned value uniformly as the data root."""',
  '    rt = _loom_runtime()',
  "    src = 'abfss://%s@%s.dfs.core.windows.net/' % (container, account)",
  "    if rt == 'dbutils':",
  '        if not any(m.mountPoint == mount_point for m in dbutils.fs.mounts()):',
  '            dbutils.fs.mount(source=src, mount_point=mount_point, extra_configs=extra_configs or {})',
  '        return mount_point',
  "    if rt in ('notebookutils', 'mssparkutils'):",
  '        mod = __import__(rt)',
  '        try:',
  '            existing = [m.mountPoint for m in mod.fs.mounts()]',
  '            if mount_point not in existing:',
  '                mod.fs.mount(src, mount_point, extra_configs or {})',
  '        except Exception:',
  '            pass  # already mounted, or the pool disallows mounts',
  '        return mount_point',
  '    # Azure ML / none — no mount; use the direct abfss path.',
  '    return src',
  '',
  '',
  'def loom_fs_ls(path):',
  '    """List a path on any engine (JVM Hadoop FS fallback on AML)."""',
  '    rt = _loom_runtime()',
  "    if rt == 'dbutils':",
  '        return dbutils.fs.ls(path)',
  "    if rt in ('notebookutils', 'mssparkutils'):",
  '        return __import__(rt).fs.ls(path)',
  '    _p = spark._jvm.org.apache.hadoop.fs.Path(path)',
  '    _fs = _p.getFileSystem(spark._jsc.hadoopConfiguration())',
  '    return [f.getPath().toString() for f in _fs.listStatus(_p)]',
  SHIM_MARKER_END,
].join('\n');

/**
 * The shim as a ready-to-insert notebook cell. Bundles put this as their FIRST
 * code cell; every later cell can then call `loom_get_secret` / `loom_get_arg` /
 * `loom_mount_adls` / `loom_fs_ls` / `loom_adls_path` without a raw utility call.
 */
export function backendUtilShimCell(id = 'loom-backend-util-shim') {
  return {
    id,
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Backend-aware utility shim (Loom) — makes the cells below run correctly on\n' +
      '# Synapse Spark (default), Databricks, Fabric, or Azure ML Spark. Do not edit.\n' +
      NOTEBOOK_BACKEND_SHIM,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTENT EMITTERS  — bundles author these calls; the shim resolves them.
// ─────────────────────────────────────────────────────────────────────────────

/** Python expression: read a secret on any engine. */
export function loomSecret(scope: string, key: string, vaultUrl?: string): string {
  return vaultUrl
    ? `loom_get_secret(${pyLit(scope)}, ${pyLit(key)}, ${pyLit(vaultUrl)})`
    : `loom_get_secret(${pyLit(scope)}, ${pyLit(key)})`;
}

/** Python expression: read a notebook parameter/widget on any engine. */
export function loomArg(name: string, dflt?: string): string {
  return dflt !== undefined
    ? `loom_get_arg(${pyLit(name)}, ${pyLit(dflt)})`
    : `loom_get_arg(${pyLit(name)})`;
}

/** Python expression: canonical abfss:// path for a container/account. */
export function loomAdlsPath(container: string, account: string, path = ''): string {
  return path
    ? `loom_adls_path(${pyLit(container)}, ${pyLit(account)}, ${pyLit(path)})`
    : `loom_adls_path(${pyLit(container)}, ${pyLit(account)})`;
}

/** Python expression: mount ADLS where supported, else the abfss path (AML). */
export function loomMountAdls(container: string, account: string, mountPoint: string): string {
  return `loom_mount_adls(${pyLit(container)}, ${pyLit(account)}, ${pyLit(mountPoint)})`;
}

/** Python expression: list a filesystem path on any engine. */
export function loomFsLs(path: string): string {
  return `loom_fs_ls(${pyLit(path)})`;
}
