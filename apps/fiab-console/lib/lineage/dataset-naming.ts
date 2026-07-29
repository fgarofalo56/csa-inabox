/**
 * LU-8 — CANONICAL OpenLineage dataset naming for Loom's Azure-native estate.
 *
 * Dataset naming is where lineage graphs silently fail to join. The SAME ADLS
 * Gen2 folder is spelled at least four different ways across the producers
 * Loom already runs:
 *
 *   openlineage-spark listener   abfss://bronze@stloom.dfs.core.windows.net + /sales
 *   Synapse/ADF dataset          linkedService url https://stloom.dfs.core.windows.net
 *                                + fileSystem 'bronze' + folderPath 'sales'
 *   Lakehouse provisioner state  abfss://bronze@stloom.dfs.core.windows.net/sales
 *   Databricks UC storage_loc.   abfss://bronze@stloom.dfs.core.windows.net/sales/
 *
 * Emitted verbatim these produce FOUR disconnected nodes on the lineage canvas
 * that each look perfectly fine. This module is the ONE place that reduces every
 * spelling to a single canonical dataset identity, so a Spark-emitted edge and a
 * pipeline-emitted edge over the same folder land on ONE node.
 *
 * ## Canonical form (grounded in the OpenLineage naming spec)
 *
 * OpenLineage "Naming" spec (openlineage.io/docs/spec/naming, docs release
 * 1.52.0; RunEvent pinned to schema 1-0-5 — see `OL_RUNEVENT_SCHEMA_URL`):
 *
 *   Azure Data Lake Gen2   namespace `abfss://{container}@{account}.dfs.{suffix}`
 *                          name      `{path}`
 *   Azure Blob (wasbs)     namespace `wasbs://{container}@{account}.blob.{suffix}`
 *                          name      `{object key}`
 *   Azure Synapse          namespace `sqlserver://{host}:{port}`
 *                          name      `{schema}.{table}`
 *
 * Two deliberate, documented choices on top of the spec:
 *
 *  1. **wasbs/https/abfs all normalize to the `abfss://` namespace.** The spec
 *     gives blob its own scheme, but ADLS Gen2 (hierarchical namespace) exposes
 *     the SAME bytes over both the `blob` and `dfs` endpoints — Spark reads
 *     `abfss://`, ADF writes through the blob/dfs REST endpoint, and a graph
 *     that splits them is wrong about physical reality. One storage account +
 *     container + path ⇒ one dataset.
 *  2. **Synapse/SQL names are `{database}.{schema}.{table}`**, not the spec's
 *     bare `{schema}.{table}`. `canonicalDatasetIdentity()` persists that bare
 *     3-part form as the thread-edge endpoint, and it is the ONLY spelling
 *     `normalizeIdentity()` turns into a `uc:` join key — so a pipeline's SQL
 *     sink collapses onto the same node the Unity Catalog overlay and the dbt
 *     manifest parser (L6 `physicalRelation()`, which emits the identical
 *     3-part relation) contribute. A 2-part name would be ambiguous across
 *     databases on the same server anyway.
 *
 * SECURITY: every identity produced here is PERSISTED (Cosmos thread edge,
 * graph node id) and RENDERED (canvas node label). `stripUriCredentials()`
 * removes SAS query strings and URI userinfo at the door — see its doc.
 *
 * The canonical URI (`canonicalStorageUri`) is exactly what
 * `unified-lineage.normalizeIdentity()` turns into a `path:` key, which is the
 * key the Purview/ADLS and Unity-Catalog `storage_location` overlays already
 * collapse on. That is the whole join.
 *
 * PURE — no I/O, no SDK, no env reads. Sovereign-cloud-safe: the storage suffix
 * (`core.windows.net` / `core.usgovcloudapi.net` / any future sovereign suffix)
 * is carried through from the input, never assumed.
 */

import type { OpenLineageDatasetRef } from '@/lib/azure/openlineage-ingest';

// ---------------------------------------------------------------------------
// Storage URIs
// ---------------------------------------------------------------------------

/** The parts of an Azure storage location, however it was originally spelled. */
export interface StorageUriParts {
  /** Storage account name (lowercased), e.g. `stloom`. */
  account: string;
  /** Container / filesystem name (lowercased), e.g. `bronze`. */
  container: string;
  /** Endpoint suffix, e.g. `core.windows.net` / `core.usgovcloudapi.net`. */
  suffix: string;
  /** Path within the container, no leading/trailing slash. May be ''. */
  path: string;
}

// ---------------------------------------------------------------------------
// Credential stripping — a lineage identity is PERSISTED and RENDERED
// ---------------------------------------------------------------------------

/**
 * Storage account / container charsets (Azure: lowercase alphanumerics, plus
 * inner dashes for containers). Enforced so nothing that is not genuinely an
 * account/container name can occupy those slots — in particular a `user:pass@`
 * userinfo pair, which `[^./]+` would otherwise happily capture as the account
 * and carry a credential into the persisted identity. Length is deliberately
 * NOT enforced (Azure's 3-char minimum is not a security property, and test /
 * fixture names are shorter).
 *
 * Declared ABOVE {@link stripUriCredentials} because that function now uses
 * CONTAINER_RE as its abfss/wasbs userinfo oracle — see its doc.
 */
const ACCOUNT_RE = /^[a-z0-9]{1,24}$/;
const CONTAINER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Strip anything credential-bearing off a storage location BEFORE it is parsed,
 * canonicalized, persisted as a thread-edge endpoint, or rendered as a node
 * label.
 *
 * This is a SECURITY boundary, not a tidiness pass. A dataset identity produced
 * here becomes: the thread-edge `fromItemId`/`toItemId`, part of the Cosmos
 * document id, the merged-graph node id, and the label on the lineage canvas —
 * all long-lived and readable by every member of the workspace. A SAS-bearing
 * URL reaches this module through Spark `--input`/`--output` argv, the
 * `spark.loom.lineage.inputs/outputs` conf, an ADF linked-service url, and item
 * state strings, so the signature MUST be removed at the door.
 *
 * Removed:
 *   - the query string (`?sv=…&sig=…` — SAS) and the fragment;
 *   - URI userinfo (`https://user:password@acct.dfs…`);
 *   - abfss/wasbs authority userinfo that is NOT a legal container name;
 *   - a malformed `host:<non-numeric>` tail in the authority.
 *
 * The last two are the round-3 fixes, and both are load-bearing. `container@
 * account` is legitimate abfss/wasbs syntax, so the first cut preserved ANY
 * colon-free userinfo there. But a query-string-free SAS smuggles in exactly
 * that shape:
 *
 *     abfss://sv=2024-01-01&sig=SUPERSECRET@stloom.dfs.core.windows.net/silver
 *
 * `parseStorageUri` then rejected it (CONTAINER_RE fails on `=`/`&`) and
 * `canonicalStorageUri` fell through to its non-Azure passthrough — which
 * returns the whole string, signature included, as the PERSISTED identity. The
 * charset check moved the leak, it did not stop it. Applying CONTAINER_RE here
 * stops it: userinfo that cannot be a container is credential material and is
 * dropped, so the fallback can never carry one either.
 *
 * The HOST slot had the identical defect one field over —
 * `abfss://data@st:secret.dfs.core.windows.net/x` kept `secret` verbatim,
 * because ACCOUNT_RE likewise only *rejected the parse* and handed the raw
 * string to the same passthrough. An authority is `host[:port]` and a port is
 * numeric, so a non-numeric `:tail` is not a host and is dropped. (Bracketed
 * IPv6 literals are left alone; a real numeric port — `sqlserver://host:1433`,
 * `https://acct…:443` — survives.)
 */
export function stripUriCredentials(raw: string | null | undefined): string {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  // 1. query + fragment (SAS tokens, signed URLs, `?code=` function keys…)
  const cut = v.search(/[?#]/);
  if (cut >= 0) v = v.slice(0, cut);
  // 2. userinfo in the authority (`scheme://user:pass@host/…`)
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/i.exec(v);
  if (m) {
    const [, scheme, authority, rest] = m;
    let host = authority;
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      // https/http storage URLs never carry a container in the authority, so
      // ANY userinfo there is a credential. On abfss/wasbs the slot is the
      // CONTAINER — keep it only when it can actually be one.
      const isHttp = /^https?:$/i.test(scheme.replace(/\/\/$/, ''));
      host = isHttp || !CONTAINER_RE.test(userinfo.toLowerCase())
        ? authority.slice(at + 1)
        : authority;
    }
    // 3. malformed `host:<non-numeric>` — not a port, therefore not a host.
    if (!host.startsWith('[')) host = host.replace(/:(?!\d+$)[^:]*$/, '');
    v = `${scheme}${host}${rest || ''}`;
  }
  return v;
}


/**
 * OneLake is Fabric's endpoint and is spelled `…/{workspace}/{lakehouse}/…`,
 * NOT `{container}@{account}`. Folding it into the ADLS shape fabricates a
 * container from the workspace GUID and silently re-keys every pre-existing
 * OneLake/mirroring identity. It keeps its raw spelling (see
 * `normalizeIdentity`'s dedicated OneLake branch).
 */
const ONELAKE_HOST_RE = /(^|\/\/|@)[^/]*onelake\.(dfs|blob)\./i;

/**
 * Delta/Parquet writers name the LOG and the PART FILES, not the table folder.
 * Folding them to the owning folder is what makes a Spark `COMPLETE` event over
 * `…/sales/_delta_log` join the pipeline's `…/sales` sink. Ordered longest-first
 * is irrelevant here — each rule strips from the first match onward.
 */
const TABLE_FOLDER_MARKERS = ['_delta_log', '_symlink_format_manifest', '_spark_metadata'];

/** File leaf names an engine writes INSIDE a table folder (never the dataset). */
const PART_FILE_RE = /^(part-|_committed_|_started_|_SUCCESS$|\.part-)/i;

/**
 * Fold a container-relative path onto the DATASET folder: drop a `_delta_log`
 * (or equivalent) segment and everything under it, and drop a trailing engine
 * part-file leaf. Idempotent.
 */
export function foldToTableFolder(rawPath: string): string {
  let p = String(rawPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return '';
  const segs = p.split('/');
  const markerAt = segs.findIndex((s) => TABLE_FOLDER_MARKERS.includes(s.toLowerCase()));
  if (markerAt >= 0) segs.length = markerAt;
  // A trailing part-file leaf belongs to the folder above it.
  const last = segs[segs.length - 1];
  if (last && PART_FILE_RE.test(last)) segs.pop();
  p = segs.filter(Boolean).join('/');
  return p;
}

/**
 * Options shared by the canonicalizers.
 *
 * `fold` (default true) applies {@link foldToTableFolder}. Callers that are
 * canonicalizing an **ownership claim** (an item's stored state path) pass
 * `fold: false` — see {@link canonicalStorageUri} for why folding an ownership
 * claim is an authorization defect, not a convenience.
 */
export interface CanonicalizeOpts {
  fold?: boolean;
}

/**
 * Parse ANY spelling of an Azure storage location into its parts, or null when
 * the string is not an Azure storage location (a REST url, a Cosmos container,
 * an S3 bucket, a OneLake path — callers then leave it alone rather than
 * mangling it).
 *
 * Credentials (SAS query string, userinfo) are stripped FIRST, and the account
 * and container are validated against Azure's naming rules, so nothing that is
 * not genuinely an account/container name can be smuggled into those slots.
 *
 * Accepted spellings:
 *   abfss://c@acct.dfs.core.windows.net/p     (Spark / UC storage_location)
 *   abfs://c@acct.dfs.core.windows.net/p
 *   wasbs://c@acct.blob.core.windows.net/p    (legacy blob mount)
 *   wasb://c@acct.blob.core.windows.net/p
 *   https://acct.dfs.core.windows.net/c/p     (ADF AzureBlobFS linked service)
 *   https://acct.blob.core.windows.net/c/p    (ADF AzureBlobStorage linked service)
 */
export function parseStorageUri(
  raw: string | null | undefined,
  opts: CanonicalizeOpts = {},
): StorageUriParts | null {
  const v = stripUriCredentials(raw);
  if (!v) return null;
  if (ONELAKE_HOST_RE.test(v)) return null; // Fabric OneLake keeps its own spelling
  const fold = opts.fold !== false;
  const path = (p: string | undefined) => (fold ? foldToTableFolder(p || '') : trimSlashes(p || ''));

  // scheme://container@account.<dfs|blob>.<suffix>/path
  const at = /^(abfss?|wasbs?):\/\/([^@/]+)@([^./]+)\.(?:dfs|blob)\.([^/]+?)(?:\/(.*))?$/i.exec(v);
  if (at) {
    const container = at[2].toLowerCase();
    const account = at[3].toLowerCase();
    if (!ACCOUNT_RE.test(account) || !CONTAINER_RE.test(container)) return null;
    return {
      account,
      container,
      suffix: at[4].toLowerCase().replace(/\/+$/, ''),
      path: path(at[5]),
    };
  }

  // https://account.<dfs|blob>.<suffix>/container/path
  const https = /^https?:\/\/([^./]+)\.(?:dfs|blob)\.([^/]+?)(?::\d+)?\/([^/]+)(?:\/(.*))?$/i.exec(v);
  if (https) {
    const account = https[1].toLowerCase();
    const container = https[3].toLowerCase();
    if (!ACCOUNT_RE.test(account) || !CONTAINER_RE.test(container)) return null;
    return {
      account,
      container,
      suffix: https[2].toLowerCase().replace(/\/+$/, ''),
      path: path(https[4]),
    };
  }

  return null;
}

function trimSlashes(p: string): string {
  return String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * The ONE canonical string identity of an Azure storage dataset:
 * `abfss://{container}@{account}.dfs.{suffix}/{path}`, **fully lowercased**,
 * credential-free and without a trailing slash. Non-Azure-storage inputs are
 * returned stripped+lowercased+trimmed so callers can pass anything through
 * safely — including the credential strip, because this value is persisted.
 *
 * Case: blob names are technically case-sensitive, but every Loom lineage
 * identity has always been case-folded (`normalizeIdentity`, the ingest route's
 * path matcher), and a join that breaks because one producer wrote `/Bronze`
 * and another `/bronze` is exactly the failure this module exists to prevent.
 * The case-faithful form is still available via {@link storagePartsToUri} and
 * is what the emitted OpenLineage dataset `name` carries.
 *
 * **`fold`** — {@link foldToTableFolder} rewrites `…/sales/_delta_log` and
 * `…/sales/part-0001` to `…/sales`. That is correct for an OBSERVED dataset URI
 * (what a run read/wrote) and wrong for an OWNERSHIP CLAIM (an item's stored
 * state path): folding an item whose `state.adlsRoot` ends in `part-…` widens
 * its claim to the whole parent folder, so `resolveOwner` hands it every
 * unrelated sibling dataset — and, worse, a resolved local owner suppresses the
 * cross-workspace forgery probe, turning a would-be 403 into an allow. Ownership
 * canonicalization therefore passes `{ fold: false }` (see `statePaths`).
 *
 * This is the string `normalizeIdentity()` turns into the `path:` join key.
 */
export function canonicalStorageUri(raw: string | null | undefined, opts: CanonicalizeOpts = {}): string {
  const parts = parseStorageUri(raw, opts);
  if (!parts) return stripUriCredentials(raw).replace(/\/+$/, '').toLowerCase();
  return storagePartsToUri(parts).toLowerCase();
}

/** Assemble canonical parts back into the canonical URI (case-faithful path). */
export function storagePartsToUri(p: StorageUriParts): string {
  const base = `abfss://${p.container}@${p.account}.dfs.${p.suffix}`;
  return p.path ? `${base}/${p.path}` : base;
}

/**
 * The canonical OpenLineage `{namespace, name}` for a storage dataset, split
 * exactly the way the openlineage-spark integration splits it (namespace =
 * scheme + authority, name = `/path`) so a Loom-emitted event and a
 * listener-emitted event over the same folder are byte-identical, and
 * `openlineage-ingest.datasetUri()` rejoins both to the same canonical URI.
 */
export function storageDataset(raw: string): OpenLineageDatasetRef {
  const parts = parseStorageUri(raw);
  if (!parts) {
    // Not Azure storage — emit it whole in `name` (the OL convention for
    // producers that don't split), credential-stripped and lowercased for a
    // stable, secret-free join key.
    return { namespace: '', name: stripUriCredentials(raw).replace(/\/+$/, '').toLowerCase() };
  }
  return {
    namespace: `abfss://${parts.container}@${parts.account}.dfs.${parts.suffix}`,
    name: `/${parts.path}`,
  };
}

// ---------------------------------------------------------------------------
// ADF / Synapse dataset descriptors → the canonical storage dataset
// ---------------------------------------------------------------------------

/** The location fields an ADF/Synapse file dataset carries (see adf-dataset-builder). */
export interface AdfFileLocation {
  /** `AzureBlobFSLocation` | `AzureBlobStorageLocation` | … */
  type?: string;
  /** AzureBlobFSLocation container key. */
  fileSystem?: string;
  /** AzureBlobStorageLocation container key. */
  container?: string;
  folderPath?: string;
  fileName?: string;
}

/**
 * Build the canonical storage URI for an ADF/Synapse file dataset from its
 * `typeProperties.location` plus the account URL of the linked service it
 * references (`AzureBlobFS.url` = `https://acct.dfs.<suffix>`,
 * `AzureBlobStorage.serviceEndpoint` = `https://acct.blob.<suffix>`).
 *
 * Returns null when the account can't be determined or no container is named —
 * an un-anchored path would produce a node that joins to nothing, which is
 * worse than no node at all (no-vaporware: degrade, never fabricate).
 */
export function adfLocationToStorageUri(
  location: AdfFileLocation | undefined,
  linkedServiceUrl: string | undefined,
): string | null {
  if (!location) return null;
  const container = (location.fileSystem || location.container || '').trim();
  if (!container) return null;
  const acct = parseStorageAccountUrl(linkedServiceUrl);
  if (!acct) return null;
  const rel = [location.folderPath, location.fileName]
    .map((s) => String(s || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return storagePartsToUri({
    account: acct.account,
    container: container.toLowerCase(),
    suffix: acct.suffix,
    path: foldToTableFolder(rel),
  });
}

/** `https://acct.dfs.core.windows.net` (or blob) → { account, suffix }.
 *  Credential-stripped first: an ADF linked-service url frequently carries a
 *  SAS (`?sv=…&sig=…`), which would otherwise be captured INTO the suffix and
 *  ride into the persisted dataset identity. */
export function parseStorageAccountUrl(
  url: string | null | undefined,
): { account: string; suffix: string } | null {
  const clean = stripUriCredentials(url);
  if (ONELAKE_HOST_RE.test(clean)) return null;
  const m = /^https?:\/\/([^./]+)\.(?:dfs|blob)\.([^/:]+)/i.exec(clean);
  if (!m) return null;
  const account = m[1].toLowerCase();
  if (!ACCOUNT_RE.test(account)) return null;
  return { account, suffix: m[2].toLowerCase() };
}

// ---------------------------------------------------------------------------
// SQL (Synapse dedicated / serverless, Azure SQL) datasets
// ---------------------------------------------------------------------------

export interface SqlDatasetParts {
  /** Fully-qualified server host, e.g. `syn-loom.sql.azuresynapse.net`. */
  server?: string;
  port?: number;
  database?: string;
  schema?: string;
  table: string;
}

/** Default TDS port — the OL naming spec wants `{host}:{port}` explicitly. */
export const TDS_PORT = 1433;

/**
 * Canonical OpenLineage dataset for a SQL relation:
 * namespace `sqlserver://{host}:{port}`, name `{database}.{schema}.{table}`
 * (see the header for why the 3-part name, not the spec's 2-part one).
 * When `table` already arrives dotted (e.g. `dbo.orders`) its parts win over
 * the separate `schema` field, matching how ADF `tableName` is authored.
 */
export function sqlDataset(parts: SqlDatasetParts): OpenLineageDatasetRef {
  const dotted = String(parts.table || '').trim().replace(/[[\]"`]/g, '');
  const segs = dotted.split('.').map((s) => s.trim()).filter(Boolean);
  let database = parts.database?.trim() || '';
  let schema = parts.schema?.trim() || '';
  let table = '';
  if (segs.length >= 3) { [database, schema, table] = segs.slice(-3); }
  else if (segs.length === 2) { [schema, table] = segs; }
  else { table = segs[0] || ''; }
  const name = [database, schema, table].filter(Boolean).join('.').toLowerCase();
  const host = (parts.server || '').trim().toLowerCase().replace(/^tcp:/, '').replace(/,\d+$/, '');
  return {
    namespace: host ? `sqlserver://${host}:${parts.port || TDS_PORT}` : '',
    name,
  };
}

/**
 * The string identity Loom stores on a thread edge for a dataset — the value
 * `normalizeIdentity()` must see to produce a `path:` / `uc:` join key.
 *
 *  - storage dataset → the canonical `abfss://…` URI          → `path:…`
 *  - SQL dataset     → the bare `database.schema.table` name   → `uc:…`
 *                      (the SAME convention `dbt-manifest-lineage.
 *                      physicalRelation()` emits, which is what lets a
 *                      pipeline's SQL sink collapse onto the dbt / Unity
 *                      Catalog node for the same relation)
 *
 * SCOPE, honestly: the production write path calls
 * {@link canonicalDatasetIdentity} on an ALREADY-JOINED uri (that is what
 * `mapRunEventToEdges` hands the harvest), so this split-ref overload has no
 * production caller today — only the naming specs, which use it to pin that a
 * `{namespace, name}` pair and the joined uri reduce to the SAME id. Two
 * earlier revisions of this comment claimed it was "what the harvest's endpoint
 * resolver calls"; that was never true and is corrected here rather than
 * quietly deleted. It is kept (not removed) because it is the natural entry
 * point for a producer that has the split ref in hand, and the specs make its
 * agreement with the joined path a standing invariant.
 */
export function datasetEdgeId(ds: OpenLineageDatasetRef): string {
  const ns = stripUriCredentials(ds.namespace).replace(/\/+$/, '');
  const name = stripUriCredentials(ds.name);
  if (/^sqlserver:\/\//i.test(ns)) return name.toLowerCase();
  if (!ns) return canonicalDatasetIdentity(name);
  return canonicalDatasetIdentity(`${ns}/${name.replace(/^\/+/, '')}`);
}

/** `sqlserver://{host}:{port}/` prefix on an already-joined dataset URI. */
const SQLSERVER_URI_RE = /^sqlserver:\/\/[^/]+\/(.+)$/i;

/**
 * Canonicalize an ALREADY-JOINED dataset URI (what `mapRunEventToEdges` hands
 * the harvest as `edge.fromUri` / `edge.toUri`) into the identity Loom persists
 * as a thread-edge endpoint.
 *
 * Storage URIs reduce to the canonical `abfss://…` form. A SQL relation URI
 * (`sqlserver://host:1433/db.schema.table`) reduces to the BARE 3-part
 * `db.schema.table` — that is the only spelling `normalizeIdentity()` turns
 * into a `uc:` key, and therefore the only spelling that actually collapses
 * onto the Unity Catalog overlay's and the dbt parser's node for the same
 * relation. Emitting the full `sqlserver://…` URI would persist a node that
 * normalizes to itself and joins to nothing.
 *
 * Credential-stripping is inherited from `canonicalStorageUri` — this value is
 * persisted and rendered.
 */
export function canonicalDatasetIdentity(uri: string | null | undefined): string {
  const v = stripUriCredentials(uri);
  const sql = SQLSERVER_URI_RE.exec(v);
  if (sql) return sql[1].replace(/\/+$/, '').toLowerCase();
  return canonicalStorageUri(v);
}
