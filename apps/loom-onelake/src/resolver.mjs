// CSA Loom — Loom OneLake resolver core (PURE, zero-dependency).
//
// The heart of the unified-namespace service (HYP-1): turn a logical
//   loom://<tenant>/<workspace>/<item>/<path>
// address into the REAL physical ADLS Gen2 location every Loom engine
// (Synapse / Databricks / ADX / AAS) already speaks —
//   abfss://<container>@<account>.dfs.<suffix>/<root>/<path>
// plus SAS-less, managed-identity passthrough auth metadata.
//
// This module is DELIBERATELY dependency-free so it (a) is the core path that
// EXECUTES at skeleton stage with no npm install (no-vaporware — real mapping,
// no mock), and (b) is exhaustively unit-testable with `node --test`.
//
// The resolution SEMANTICS are ported 1:1 from the shipped, live-verified
// apps/fiab-console/lib/azure/lakehouse-abfss.ts priority ladder so the service
// and the in-process console fallback resolve a lakehouse to the SAME abfss:
//   1. a stamped full abfss root (most accurate, already sovereign-correct)
//   2. a recorded { container, rootPath } (+ optional explicit account)
//   3. a shortcut target (metadata-only symbolic link — internal or external)
//   4. the deterministic convention fallback `lakehouses/<safeSeg(item)>`
// Returns an honest, machine-readable gate ({ ok:false, code:'not_configured' })
// when NO real storage is configured — never a guessed host.
//
// No Microsoft Fabric / OneLake / Power BI dependency: the substrate is the
// customer's own DLZ ADLS Gen2 account. This never emits an onelake.dfs.fabric
// host (see .claude/rules/no-fabric-dependency.md).

/**
 * Sanitise a logical path into safe forward-slash segments — the SAME
 * sanitiser the lakehouse provisioner + lakehouse-abfss.ts use to build a
 * `root`, so a convention-fallback path here matches the provisioned one.
 * Drops empty / `.` / `..` segments (also the anti-traversal guard).
 * @param {unknown} p
 * @returns {string}
 */
export function safeRelPath(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** A single path segment (workspace / item / tenant), sanitised + collapsed. */
export function safeSeg(s) {
  return safeRelPath(s).replace(/\//g, '-');
}

/**
 * Parse a loom:// address into its components.
 *
 * Canonical form (this task):   loom://<tenant>/<workspace>/<item>/<path...>
 * The `<item>` may optionally carry a Fabric-style `.<type>` suffix
 * (loom://t/ws/sales.lakehouse/Tables/orders) — mirrors OneLake's
 * `<item>.<type>` shape; the suffix is parsed out into `itemType`.
 * `<path>` is optional (an item root resolves with an empty path).
 *
 * @param {string} uri
 * @returns {{ ok:true, tenant:string, workspace:string, item:string, itemType:(string|null), path:string, raw:string }
 *          | { ok:false, error:string }}
 */
export function parseLoomUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { ok: false, error: 'loom uri is required' };
  }
  const raw = uri.trim();
  const m = raw.match(/^loom:\/\/(.+)$/i);
  if (!m) return { ok: false, error: `not a loom:// uri: ${raw}` };

  // Split the authority+path on '/', dropping empties from a trailing slash.
  const parts = m[1].split('/').filter((s) => s.length > 0);
  if (parts.length < 3) {
    return {
      ok: false,
      error: 'loom uri must be loom://<tenant>/<workspace>/<item>/<path>',
    };
  }
  const tenant = decodeURIComponent(parts[0]);
  const workspace = decodeURIComponent(parts[1]);
  const itemRaw = decodeURIComponent(parts[2]);
  const path = parts.slice(3).map((s) => decodeURIComponent(s)).join('/');

  // Optional `<item>.<type>` suffix — only treat a trailing dotted token as a
  // type when it looks like a Fabric item type (letters/dash), never a filename.
  let item = itemRaw;
  let itemType = null;
  const dot = itemRaw.lastIndexOf('.');
  if (dot > 0 && dot < itemRaw.length - 1) {
    const suffix = itemRaw.slice(dot + 1);
    if (/^[A-Za-z][A-Za-z-]*$/.test(suffix)) {
      item = itemRaw.slice(0, dot);
      itemType = suffix.toLowerCase();
    }
  }

  if (!tenant || !workspace || !item) {
    return { ok: false, error: 'loom uri has an empty tenant, workspace, or item segment' };
  }
  return { ok: true, tenant, workspace, item, itemType, path: safeRelPath(path), raw };
}

/**
 * Build a canonical loom:// address from components (inverse of parseLoomUri).
 * @param {{tenant:string, workspace:string, item:string, itemType?:string|null, path?:string}} c
 * @returns {string}
 */
export function buildLoomUri(c) {
  const enc = (s) => encodeURIComponent(String(s));
  const itemSeg = c.itemType ? `${enc(c.item)}.${enc(c.itemType)}` : enc(c.item);
  const tail = c.path ? '/' + safeRelPath(c.path).split('/').map(enc).join('/') : '';
  return `loom://${enc(c.tenant)}/${enc(c.workspace)}/${itemSeg}${tail}`;
}

/**
 * @typedef {Object} RegistryEntry  A namespace registration for one item.
 * @property {string=} container    DLZ container the managed folder lives in.
 * @property {string=} rootPath     Managed-folder root inside the container.
 * @property {string=} account      Explicit storage account (external-bound item).
 * @property {string=} abfssRoot    Full stamped abfss root (highest priority).
 * @property {{target:string, kind:string, credentialRef?:string}=} shortcut
 *           A metadata-only symbolic link to an internal/external target.
 */

/**
 * @typedef {Object} StorageConfig  The DLZ substrate the service resolves onto.
 * @property {string} defaultAccount   Storage account for convention/relative paths.
 * @property {string} dfsSuffix        e.g. dfs.core.windows.net | dfs.core.usgovcloudapi.net
 * @property {string} defaultContainer Container for the convention fallback.
 * @property {string=} tokenScope      AAD scope for the passthrough token.
 */

/** Strip leading/trailing slashes. */
function trimSlashes(s) {
  return String(s || '').replace(/^\/+|\/+$/g, '');
}

/** Join a root + optional sub-path into one clean, traversal-safe path. */
function joinRoot(root, path) {
  const a = trimSlashes(root);
  const b = safeRelPath(path);
  return [a, b].filter(Boolean).join('/');
}

/** Managed-identity passthrough auth block — SAS-less by design. */
function miAuth(config, extra) {
  return {
    mode: 'managed-identity',
    passthrough: true,
    // No SAS is ever minted: the calling engine authenticates to ADLS with its
    // own managed identity (Storage Blob Data Reader/Contributor on the lake).
    sas: null,
    scope: config.tokenScope || 'https://storage.azure.com/.default',
    note:
      'Engine authenticates to ADLS Gen2 with its own managed identity; the ' +
      'OneLake service never mints a SAS token.',
    ...(extra || {}),
  };
}

/**
 * Resolve a parsed loom:// address to a physical ADLS Gen2 pointer, given the
 * (optional) registry entry for the item and the DLZ storage config. PURE.
 *
 * @param {ReturnType<typeof parseLoomUri>} parsed  a successful parseLoomUri result
 * @param {RegistryEntry|null} entry  registration for this item (or null → convention)
 * @param {StorageConfig|null} config the DLZ substrate (null/no account ⇒ honest gate)
 * @returns {{ok:true, loomUri:string, tenant:string, workspace:string, item:string,
 *            itemType:(string|null), path:string, source:string, physical:object,
 *            auth:object, shortcut:(object|null)}
 *          | {ok:false, code:string, error:string}}
 */
export function resolvePhysical(parsed, entry, config) {
  if (!parsed || parsed.ok !== true) {
    return { ok: false, code: 'invalid_uri', error: 'parsed loom uri required' };
  }
  const base = {
    loomUri: parsed.raw,
    tenant: parsed.tenant,
    workspace: parsed.workspace,
    item: parsed.item,
    itemType: parsed.itemType,
    path: parsed.path,
  };

  // ── 3. Shortcut target (metadata-only symbolic link) ────────────────────
  // A shortcut short-circuits the storage-account ladder: it points at an
  // internal OR external target and carries its own auth mode (passthrough for
  // internal / same-tenant; stored-connection credentialRef for external).
  if (entry && entry.shortcut && entry.shortcut.target) {
    const sc = entry.shortcut;
    const kind = String(sc.kind || 'internal').toLowerCase();
    const external = kind !== 'internal';
    const target = joinRoot(sc.target, parsed.path);
    return {
      ok: true,
      ...base,
      source: 'shortcut',
      physical: { scheme: 'shortcut', target, kind },
      auth: external
        ? {
            mode: 'stored-connection',
            passthrough: false,
            sas: null,
            credentialRef: sc.credentialRef || null,
            note:
              'External shortcut target resolves via a stored connection ' +
              '(credentialRef); document egress for Gov review.',
          }
        : miAuth(config || {}, { note: 'Internal-passthrough shortcut — in-tenant MI auth.' }),
      shortcut: { target: sc.target, kind, credentialRef: sc.credentialRef || null },
    };
  }

  // ── 1. Stamped full abfss root — most accurate, already sovereign-correct ─
  const stamped = entry && typeof entry.abfssRoot === 'string' ? entry.abfssRoot.trim() : '';
  if (stamped.startsWith('abfss://')) {
    const m = stamped.match(/^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i);
    const container = m ? m[1] : entry.container || '';
    const host = m ? m[2] : '';
    const account = host ? host.split('.')[0] : entry.account || '';
    const root = joinRoot(m ? m[3] : entry.rootPath || '', parsed.path);
    const abfss = `abfss://${container}@${host}/${root}`;
    return {
      ok: true,
      ...base,
      source: 'stamped-abfss',
      physical: {
        scheme: 'abfss',
        abfss,
        dfsUrl: `https://${host}/${container}/${root}`,
        account,
        container,
        root,
      },
      auth: miAuth(config || {}),
      shortcut: null,
    };
  }

  // Everything below needs a real storage account.
  const account =
    (entry && entry.account && String(entry.account).trim()) ||
    (config && config.defaultAccount && String(config.defaultAccount).trim()) ||
    '';
  const suffix = (config && config.dfsSuffix) || 'dfs.core.windows.net';
  if (!account) {
    // Honest gate — no real storage configured (mirrors lakehouse-abfss.ts
    // returning null). Names the exact env the service needs.
    return {
      ok: false,
      code: 'not_configured',
      error:
        'No DLZ ADLS Gen2 storage account configured for the OneLake namespace ' +
        'service. Set LOOM_ONELAKE_DEFAULT_ACCOUNT (or LOOM_BRONZE_URL / ' +
        'LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL) so loom:// paths ' +
        'resolve to a real abfss host. No Microsoft Fabric required.',
    };
  }

  // ── 2. Recorded { container, rootPath } ──────────────────────────────────
  const recContainer = entry && entry.container ? String(entry.container).trim() : '';
  const recRoot = entry && entry.rootPath ? String(entry.rootPath).trim() : '';
  let container;
  let root;
  let source;
  if (recContainer && recRoot) {
    container = recContainer;
    root = joinRoot(recRoot, parsed.path);
    source = 'registry';
  } else {
    // ── 4. Deterministic convention fallback ───────────────────────────────
    container = (config && config.defaultContainer) || 'bronze';
    root = joinRoot(`lakehouses/${safeSeg(parsed.item)}`, parsed.path);
    source = 'convention';
  }

  const abfss = `abfss://${container}@${account}.${suffix}/${root}`;
  return {
    ok: true,
    ...base,
    source,
    physical: {
      scheme: 'abfss',
      abfss,
      dfsUrl: `https://${account}.${suffix}/${container}/${root}`,
      account,
      container,
      root,
    },
    auth: miAuth(config || {}),
    shortcut: null,
  };
}

/**
 * Derive the DLZ StorageConfig from a process-env-shaped object. Sovereign-
 * cloud aware (Gov flips the dfs suffix from AZURE_CLOUD). Reuses the
 * account-from-container-URL parsing of adls-client.ts so a deploy that only
 * sets LOOM_BRONZE_URL still resolves.
 * @param {Record<string,string|undefined>} env
 * @returns {StorageConfig|null}  null when no storage account can be derived.
 */
export function deriveStorageConfig(env) {
  const e = env || {};
  const gov =
    String(e.AZURE_CLOUD || '').toLowerCase().includes('usgov') ||
    String(e.LOOM_CLOUD || '').toLowerCase().includes('gov');
  const dfsSuffix =
    (e.LOOM_ONELAKE_DFS_SUFFIX && String(e.LOOM_ONELAKE_DFS_SUFFIX).trim()) ||
    (gov ? 'dfs.core.usgovcloudapi.net' : 'dfs.core.windows.net');

  const CONTAINER_URL_ENV = {
    bronze: 'LOOM_BRONZE_URL',
    silver: 'LOOM_SILVER_URL',
    gold: 'LOOM_GOLD_URL',
    landing: 'LOOM_LANDING_URL',
    'csv-imports': 'LOOM_CSV_IMPORTS_URL',
  };

  // Explicit account wins; else parse the first configured container URL's host.
  let defaultAccount = (e.LOOM_ONELAKE_DEFAULT_ACCOUNT || '').trim();
  let firstConfigured = '';
  for (const [name, key] of Object.entries(CONTAINER_URL_ENV)) {
    const url = e[key];
    if (!url) continue;
    if (!firstConfigured) firstConfigured = name;
    if (!defaultAccount) {
      const m = String(url).match(/^https:\/\/([^.]+)\./i);
      if (m) defaultAccount = m[1];
    }
  }
  if (!defaultAccount) return null;

  const defaultContainer =
    (e.LOOM_ONELAKE_DEFAULT_CONTAINER || '').trim() || firstConfigured || 'bronze';

  return {
    defaultAccount,
    dfsSuffix,
    defaultContainer,
    tokenScope: 'https://storage.azure.com/.default',
  };
}
