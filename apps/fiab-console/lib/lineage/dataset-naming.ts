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
 *     `normalizeIdentity()` turns into a `uc:` join key — so a `sqlserver://`
 *     dataset named by ANY OpenLineage producer collapses onto the same node
 *     the Unity Catalog overlay and the dbt manifest parser (L6
 *     `physicalRelation()`, which emits the identical 3-part relation)
 *     contribute. A 2-part name would be ambiguous across databases on the
 *     same server anyway.
 *
 * SCOPE: this module is the READ/IDENTITY half — it canonicalizes a dataset
 * name that ALREADY exists (arriving on the OpenLineage ingest route, or stored
 * on a Loom item's state) into the one join key. The OpenLineage dataset
 * *builders* a Loom-side emitter needs (`storageDataset`, `sqlDataset`,
 * `adfLocationToStorageUri`) belong to the emitter PR that produces events and
 * are added there, not parked here without a caller.
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
/**
 * Strip leading/trailing `/` by index.
 *
 * Deliberately NOT `.replace(/^\/+/, '').replace(/\/+$/, '')`: CodeQL
 * `js/polynomial-redos` flags that shape here and is right to — every function
 * in this module runs on attacker-controlled dataset names arriving in a 5 MB
 * OpenLineage POST body, and `/\/+$/` is quadratic on a long run of slashes.
 * Index arithmetic is linear and unconditionally safe.
 */
export function trimSlashes(p: string): string {
  const s = String(p || '');
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 47) a += 1;
  while (b > a && s.charCodeAt(b - 1) === 47) b -= 1;
  return s.slice(a, b);
}

/**
 * Trailing-slash trim only (same ReDoS reasoning as {@link trimSlashes}).
 *
 * Exported because `openlineage-ingest.datasetUri()` — the FIRST function every
 * attacker-supplied dataset name in a 5 MB `POST /api/lineage/openlineage` body
 * passes through — needs exactly this, and its `.replace(/\/+$/, '')` was the
 * one instance of the quadratic shape that survived the first ReDoS sweep.
 * There is no local copy anywhere: the ONLY way to trim a slash on this path is
 * to call one of these two functions.
 */
export function trimTrailingSlashes(p: string): string {
  const s = String(p || '');
  let b = s.length;
  while (b > 0 && s.charCodeAt(b - 1) === 47) b -= 1;
  return s.slice(0, b);
}

/** Leading-slash trim only (same ReDoS reasoning as {@link trimSlashes}). */
export function trimLeadingSlashes(p: string): string {
  const s = String(p || '');
  let a = 0;
  while (a < s.length && s.charCodeAt(a) === 47) a += 1;
  return s.slice(a);
}

/** Scheme charset, applied to a LENGTH-BOUNDED slice — never to the whole URI. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/i;

/**
 * Does this string start with a `scheme://`? Index-based: the regex form
 * `/^[a-z][a-z0-9+.-]*:\/\//i` is a polynomial-ReDoS vector on a long run of
 * `.`/`-`/`+` and this is called on attacker-controlled identities.
 */
export function hasUriScheme(v: string): boolean {
  const i = String(v || '').indexOf('://');
  return i > 0 && i <= 32 && SCHEME_RE.test(v.slice(0, i));
}


/**
 * Split `scheme://authority/path` by INDEX.
 *
 * The single anchored regex this replaces
 * (`/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/`) is a polynomial-ReDoS
 * vector on the ingest path. Splitting on the first `://` and the next `/` is
 * linear, and the only regex left runs on a scheme slice capped at 32 chars.
 */
function splitUri(v: string): { scheme: string; authority: string; rest: string } | null {
  const i = v.indexOf('://');
  if (i <= 0 || i > 32) return null;
  const scheme = v.slice(0, i);
  if (!SCHEME_RE.test(scheme)) return null;
  const after = v.slice(i + 3);
  const slash = after.indexOf('/');
  // `rest` keeps its LEADING slash (and any trailing one) so a caller can
  // reassemble the URI byte-for-byte apart from the authority it rewrote.
  if (slash < 0) return { scheme: scheme.toLowerCase(), authority: after, rest: '' };
  return { scheme: scheme.toLowerCase(), authority: after.slice(0, slash), rest: after.slice(slash) };
}

/** Drop a malformed `host:<non-numeric>` tail — an authority is `host[:port]`
 *  and a port is numeric. Index-based for the same ReDoS reason. */
function stripMalformedPort(host: string): string {
  if (host.startsWith('[')) return host; // bracketed IPv6 literal
  const c = host.lastIndexOf(':');
  if (c < 0) return host;
  const tail = host.slice(c + 1);
  if (tail.length > 0 && tail.length <= 5 && /^[0-9]+$/.test(tail)) return host; // real port
  return host.slice(0, c);
}

export function stripUriCredentials(raw: string | null | undefined): string {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  // 1. query + fragment (SAS tokens, signed URLs, `?code=` function keys…)
  const q = v.indexOf('?');
  const h = v.indexOf('#');
  const cut = q < 0 ? h : h < 0 ? q : Math.min(q, h);
  if (cut >= 0) v = v.slice(0, cut);
  // 2. userinfo in the authority (`scheme://user:pass@host/…`)
  const u = splitUri(v);
  if (u) {
    let host = u.authority;
    const at = u.authority.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = u.authority.slice(0, at);
      // https/http storage URLs never carry a container in the authority, so
      // ANY userinfo there is a credential. On abfss/wasbs the slot is the
      // CONTAINER — keep it only when it can actually be one.
      const isHttp = u.scheme === 'http' || u.scheme === 'https';
      host = isHttp || !CONTAINER_RE.test(userinfo.toLowerCase())
        ? u.authority.slice(at + 1)
        : u.authority;
    }
    // 3. malformed `host:<non-numeric>` — not a port, therefore not a host.
    host = stripMalformedPort(host);
    // Reassemble with the ORIGINAL scheme spelling preserved (the previous
    // regex form kept it verbatim; lowercasing here would change identities).
    v = `${v.slice(0, v.indexOf('://'))}://${host}${u.rest}`;
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
  let p = trimSlashes(rawPath || '');
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

  // Parsed by INDEX, not by one mega-regex. The two patterns this replaces —
  //   /^(abfss?|wasbs?):\/\/([^@/]+)@([^./]+)\.(?:dfs|blob)\.([^/]+?)(?:\/(.*))?$/
  //   /^https?:\/\/([^./]+)\.(?:dfs|blob)\.([^/]+?)(?::\d+)?\/([^/]+)(?:\/(.*))?$/
  // — pair a lazy `([^/]+?)` with an optional trailing `(?:\/(.*))?$`, which is
  // a polynomial-ReDoS vector (CodeQL js/polynomial-redos, HIGH). This function
  // runs on dataset names lifted straight out of a 5 MB OpenLineage POST body,
  // so that is a reachable denial of service, not a theoretical one. Splitting
  // on `://`, `@` and `.` is linear and the remaining regexes only ever see a
  // single bounded label.
  const u = splitUri(v);
  if (!u) return null;
  const isAbfs = u.scheme === 'abfss' || u.scheme === 'abfs' || u.scheme === 'wasbs' || u.scheme === 'wasb';
  const isHttp = u.scheme === 'https' || u.scheme === 'http';
  if (!isAbfs && !isHttp) return null;

  // Authority: `[container@]account.<dfs|blob>.<suffix>`.
  let authority = u.authority;
  let container = '';
  if (isAbfs) {
    const at = authority.indexOf('@');
    if (at < 0) return null;
    container = authority.slice(0, at).toLowerCase();
    authority = authority.slice(at + 1);
    if (authority.includes('@')) return null;
  } else {
    // The https storage form is `account.<dfs|blob>.<suffix>[:port]/container/…`
    // and the regex this replaced consumed the port with `(?::\d+)?` — i.e. a
    // port is NOT part of the identity. Dropping any trailing `:<digits>` keeps
    // `https://acct.dfs…:443/c/p` on the same node as `https://acct.dfs…/c/p`.
    const c = authority.lastIndexOf(':');
    if (c >= 0 && !authority.startsWith('[')) {
      const port = authority.slice(c + 1);
      authority = port.length > 0 && port.length <= 5 && /^[0-9]+$/.test(port)
        ? authority.slice(0, c)
        : stripMalformedPort(authority);
    }
  }

  const labels = authority.split('.');
  if (labels.length < 3) return null;
  const account = labels[0].toLowerCase();
  const endpoint = labels[1].toLowerCase();
  if (endpoint !== 'dfs' && endpoint !== 'blob') return null;
  const suffix = trimTrailingSlashes(labels.slice(2).join('.').toLowerCase());
  if (!suffix) return null;

  // https puts the container in the FIRST path segment; abfss already has it.
  let rel = trimSlashes(u.rest);
  if (isHttp) {
    const slash = rel.indexOf('/');
    if (slash < 0) {
      container = rel.toLowerCase();
      rel = '';
    } else {
      container = rel.slice(0, slash).toLowerCase();
      rel = rel.slice(slash + 1);
    }
  }

  if (!ACCOUNT_RE.test(account) || !CONTAINER_RE.test(container)) return null;
  return { account, container, suffix, path: path(rel) };
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
  if (!parts) return trimTrailingSlashes(stripUriCredentials(raw)).toLowerCase();
  return storagePartsToUri(parts).toLowerCase();
}

/** Assemble canonical parts back into the canonical URI (case-faithful path). */
export function storagePartsToUri(p: StorageUriParts): string {
  const base = `abfss://${p.container}@${p.account}.dfs.${p.suffix}`;
  return p.path ? `${base}/${p.path}` : base;
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
  if (sql) return trimTrailingSlashes(sql[1]).toLowerCase();
  return canonicalStorageUri(v);
}
