/**
 * Databricks SQL warehouse RESOLVER — the Console-side producer of
 * LOOM_DATABRICKS_SQL_WAREHOUSE_ID (#3744, auto-bind-by-default.md §5).
 *
 * WHY THE CONSOLE PRODUCES IT. The post-deploy bootstrap tried to create the
 * `loom-default` warehouse from a GitHub-hosted runner, and the workspace
 * refused the runner at the network layer (HTTP 403 "Unauthorized network
 * access to workspace", measured in full-app-deploy-commercial run 36526911340
 * — why it refuses while ARM reports public access Enabled is NOT established).
 * The Console reaches the workspace over its private endpoint, so the Console
 * ensure-creates the warehouse on first use and persists the id. A value the
 * platform can produce must never be a terminal "set LOOM_X" gate.
 *
 * RESOLUTION ORDER
 *   (a) LOOM_DATABRICKS_SQL_WAREHOUSE_ID env — an operator pin always wins;
 *   (b) the persisted binding on the platform-settings singleton doc
 *       (`env-config` Cosmos container, id '__platform__' — the SAME store
 *       lib/admin/platform-settings.ts uses), validated with a GET: a 404 /
 *       DELETED warehouse, or a binding recorded against a different workspace
 *       host, is discarded and resolution continues (self-healing);
 *   (c) list warehouses and adopt one by NAME, in a fixed preference order:
 *       `loom-default` (the post-deploy bootstrap's name), else
 *       `loom-governance` (the name BOTH Azure Government producers create —
 *       gov-provision-dbx-sql.yml and apps/loom-dbx-init/init.sh). Same names,
 *       same order as the deploy-time discover script (#4769). Each name is
 *       pinned against its producer by a test, not transcribed;
 *   (d) create `loom-default` — serverless PRO 2X-Small, 1..1 clusters,
 *       auto-stop 10 min, the bootstrap's exact spec — then persist.
 *
 * CONCURRENCY. One process-level in-flight promise (held on globalThis so
 * every Next.js route chunk shares it): N simultaneous first calls issue ONE
 * create. Across replicas: a create that conflicts re-lists and adopts; after
 * any create the replica re-lists and binds the lowest id IT LISTED; and the
 * persist is compare-and-adopt — a replica that finds another replica's live
 * binding for the same workspace already stored ADOPTS it instead of
 * overwriting, so replicas converge on the first binding persisted. The
 * surplus is left in place (never auto-deleted — deleting compute is not a
 * call this resolver gets to make) and named in the resolution detail.
 *
 * FAILURES CLASSIFY TRUTHFULLY (deploy-integrity.md R6/R7). Every failed call
 * becomes a `WarehouseResolutionError` whose `kind` is derived from what the
 * API returned: authentication (a 401 — no entitlement named), permission (a
 * 403 — the entitlement is named only after SCIM `Me` shows the identity is
 * not an admin and does not already hold it; otherwise 'unknown'), network,
 * quota, or unknown. "Not configured" is
 * reserved for the one case where no call was made: no workspace is bound
 * (LOOM_DATABRICKS_HOSTNAME unset). Transient transport / 5xx failures retry
 * with bounded backoff and fail closed; a create is retried only after a
 * re-list shows `loom-default` still absent, so a POST whose response was lost
 * is adopted, not duplicated.
 *
 * The outcome is PUBLISHED to `runtime-produced-env` so the synchronous gate
 * evaluation (`svc-databricks-sql` on /admin/readiness) reads green on a
 * resolver-produced id and shows the classified cause on a failure.
 */
import {
  databricksConfigGate,
  dbxFetch,
  listWarehouses,
  getWarehouse,
  createWarehouse,
  type Warehouse,
  type WarehouseCreateSpec,
} from '@/lib/azure/databricks-client';
import { envConfigContainer } from '@/lib/azure/cosmos-client';
import { readPlatformSettings, type PlatformSettingsDoc } from '@/lib/admin/platform-settings';
import { publishRuntimeValue, publishRuntimeFailure } from '@/lib/azure/runtime-produced-env';
import { privateDnsZoneNameForGroupId } from '@/lib/azure/pe-subresource-groups';

/** The calling identity as the workspace sees it (SCIM `Me`). */
export interface DbxCurrentIdentity {
  id?: string;
  displayName?: string;
  /** Service principals carry their Entra application (client) id here. */
  applicationId?: string;
  /** DIRECTLY-assigned entitlements only — group-inherited ones are not listed on this object. */
  entitlements: string[];
  /**
   * Group display names the identity is a direct member of (e.g. 'admins').
   * UNDEFINED when SCIM Me returned no `groups` field at all — admin membership
   * is then NOT ESTABLISHED, which is different from a measured empty list (R7).
   */
  groups?: string[];
}

/**
 * Read the caller's own workspace identity: GET /api/2.0/preview/scim/v2/Me.
 * Used to MEASURE which entitlements the Console identity holds when the
 * workspace refuses a warehouse create, so the failure names what is actually
 * absent rather than guessing (deploy-integrity.md R7). Lives here, not in
 * databricks-client.ts, because that module is at its file-size ceiling.
 */
export async function getCurrentIdentity(): Promise<DbxCurrentIdentity> {
  const res = await dbxFetch('/api/2.0/preview/scim/v2/Me');
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`getCurrentIdentity failed ${res.status}: ${text}`) as Error & { status: number; body: string };
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const b = JSON.parse(text || '{}') as {
    id?: string;
    displayName?: string;
    applicationId?: string;
    entitlements?: Array<{ value?: string }>;
    groups?: Array<{ display?: string; value?: string }>;
  };
  return {
    id: b.id,
    displayName: b.displayName,
    applicationId: b.applicationId,
    entitlements: (b.entitlements || []).map((e) => String(e?.value || '')).filter(Boolean),
    groups: Array.isArray(b.groups)
      ? b.groups.map((g) => String(g?.display || g?.value || '')).filter(Boolean)
      : undefined,
  };
}

export const WAREHOUSE_ENV_VAR = 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID';

/** The bootstrap's warehouse name (csa-loom-post-deploy-bootstrap.yml) — the one the resolver CREATES. */
export const LOOM_DEFAULT_WAREHOUSE_NAME = 'loom-default';

/** The name both Azure Government producers create (gov-provision-dbx-sql.yml, apps/loom-dbx-init/init.sh). */
export const LOOM_GOV_WAREHOUSE_NAME = 'loom-governance';

/**
 * Names the resolver ADOPTS, in preference order — identical to the deploy-time
 * discover script (#4769): `loom-default` wins because the bootstrap re-wires
 * the Console to it on every run. A Gov workspace whose producers made
 * `loom-governance` is adopted, never duplicated with a second `loom-default`.
 */
export const LOOM_ADOPTABLE_WAREHOUSE_NAMES: readonly string[] = [LOOM_DEFAULT_WAREHOUSE_NAME, LOOM_GOV_WAREHOUSE_NAME];

/**
 * The bootstrap's exact create body. `__tests__/databricks-sql-warehouse.test.ts`
 * parses the workflow's POST payload and asserts equality, so the two cannot drift.
 */
export const LOOM_DEFAULT_WAREHOUSE_SPEC: Required<
  Pick<WarehouseCreateSpec, 'name' | 'cluster_size' | 'min_num_clusters' | 'max_num_clusters' | 'auto_stop_mins' | 'enable_serverless_compute' | 'warehouse_type'>
> = {
  name: LOOM_DEFAULT_WAREHOUSE_NAME,
  cluster_size: '2X-Small',
  min_num_clusters: 1,
  max_num_clusters: 1,
  auto_stop_mins: 10,
  enable_serverless_compute: true,
  warehouse_type: 'PRO',
};

/** Documented requirement to CREATE a SQL warehouse (Learn: compute/sql-warehouse/create). */
export const CREATE_ENTITLEMENT = 'allow-cluster-create';
/** Documented requirement to USE Databricks SQL (Learn: security/auth/entitlements). */
export const SQL_ACCESS_ENTITLEMENT = 'databricks-sql-access';

export type WarehouseResolutionSource = 'env' | 'persisted' | 'listed' | 'created';

export interface WarehouseResolution {
  id: string;
  source: WarehouseResolutionSource;
  name?: string;
  /** Human-readable account of how the id was produced (surfaced on the gate). */
  detail: string;
}

export type WarehouseFailureKind = 'not-configured' | 'authentication' | 'permission' | 'network' | 'quota' | 'unknown';
export type WarehouseStep = 'config' | 'get' | 'list' | 'create';

/**
 * A classified resolution failure. `kind` is derived from the API's response,
 * `message` quotes what the failed call returned, `remediation` is the concrete
 * next action for THIS cause. `entitlement` is set only for a permission
 * failure where a specific workspace entitlement is the documented fix.
 */
export class WarehouseResolutionError extends Error {
  readonly kind: WarehouseFailureKind;
  readonly step: WarehouseStep;
  readonly status?: number;
  readonly remediation: string;
  readonly entitlement?: string;
  /** Only for kind 'not-configured': the env var that was genuinely unset. */
  readonly missing?: string;
  /**
   * What SCIM Me measured about the Console identity (display name, application
   * id, direct entitlements, groups). Kept OUT of `message` and out of
   * {@link warehouseErrorBody}, which reach any signed-in caller. It is
   * published as the runtime failure's separate `diagnostic` field, which
   * `evalEnv` never reads, so it does not reach the self-audit check detail;
   * only the admin-capability routes attach it (via `gateAdminDiagnostic`).
   */
  readonly diagnostic?: string;
  constructor(init: {
    kind: WarehouseFailureKind;
    step: WarehouseStep;
    message: string;
    remediation: string;
    status?: number;
    entitlement?: string;
    missing?: string;
    diagnostic?: string;
  }) {
    super(init.message);
    this.name = 'WarehouseResolutionError';
    this.kind = init.kind;
    this.step = init.step;
    this.status = init.status;
    this.remediation = init.remediation;
    this.entitlement = init.entitlement;
    this.missing = init.missing;
    this.diagnostic = init.diagnostic;
  }
}

// ── process-level state (globalThis: shared by every route chunk) ───────────

interface ResolverState {
  inflight?: Promise<WarehouseResolution>;
  /** Last good resolution + when it was last verified against the workspace. */
  cached?: { res: WarehouseResolution; host: string; verifiedAt: number };
  /** Last failure + when — rethrown for FAILURE_HOLD_MS instead of re-hammering. */
  failure?: { err: WarehouseResolutionError; host: string; at: number };
}

const STATE_KEY = '__loomDbxWarehouseResolver';
function state(): ResolverState {
  const g = globalThis as unknown as Record<string, ResolverState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = {};
  return g[STATE_KEY]!;
}

/** A cached id is re-verified (GET) after this long — the self-heal for an out-of-band delete. */
const REVERIFY_MS = 5 * 60_000;
/** A failure is re-served (no new calls) for this long, so a render loop cannot hammer the workspace. */
const FAILURE_HOLD_MS = 30_000;
/** Transient-retry backoff (bounded; fails closed on exhaustion). */
const RETRY_BACKOFF_MS = [500, 1500];

let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test seam — reset process state and (optionally) replace the backoff sleep. */
export const __testing = {
  reset(): void {
    const g = globalThis as unknown as Record<string, ResolverState | undefined>;
    g[STATE_KEY] = {};
  },
  setSleep(fn: (ms: number) => Promise<void>): void {
    sleep = fn;
  },
};

function hostKey(): string {
  return (process.env.LOOM_DATABRICKS_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

// ── classification ───────────────────────────────────────────────────────────

interface ErrShape {
  status?: number;
  body?: string;
  message?: string;
  name?: string;
  code?: string;
  cause?: { code?: string };
}

function errorCode(e: ErrShape): string {
  const raw = e.body || '';
  try {
    const j = JSON.parse(raw) as { error_code?: string };
    if (j?.error_code) return String(j.error_code);
  } catch {
    /* not JSON — fall through */
  }
  const m = /"error_code"\s*:\s*"([A-Z_]+)"/.exec(raw || e.message || '');
  return m ? m[1] : '';
}

/** Transport-level failure: the request never got an HTTP answer. */
const TRANSPORT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function isTransport(e: ErrShape): boolean {
  if (typeof e.status === 'number') return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const code = e.code || e.cause?.code || '';
  if (TRANSPORT_CODES.has(code)) return true;
  return /fetch failed|network|socket hang up/i.test(e.message || '');
}

/** The exact Databricks body the workspace returns for a network-layer refusal (measured, #3744 comment). */
const NETWORK_REFUSAL = /unauthorized network access to workspace/i;
const QUOTA_CODES = new Set(['QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED', 'RESOURCE_LIMIT_EXCEEDED']);

function quoteOf(e: ErrShape): string {
  const s = (e.message || String(e)).replace(/\s+/g, ' ').trim();
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

/**
 * #4776 (round 5) — identifier-shaped tokens in a QUOTED Databricks or SCIM
 * response are replaced before the quote enters `message`, because `message`
 * reaches non-admin readers: the route bodies, and (through the published
 * failure → evalEnv detail) GET /api/admin/self-audit and the Copilot
 * self-audit tool. Replaced: a GUID (e.g. a service principal's application
 * id), an e-mail / UPN, and a 12+ digit numeric id. The UNREDACTED quote goes to
 * the admin-only `diagnostic`. Pattern-based: whether a real Databricks refusal
 * names the principal has NOT been measured, so this errs toward redacting.
 */
const IDENTIFIER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<principal>'],
  [/\b\d{12,}\b/g, '<id>'],
];

export function redactIdentifiers(text: string): string {
  return IDENTIFIER_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

function joinDiagnostics(...parts: Array<string | undefined>): string | undefined {
  const d = parts.filter(Boolean).join(' ');
  return d || undefined;
}

/**
 * Classify a failed call from what the API RETURNED. Pure — exported for tests.
 * Does not claim a cause the response does not carry (R7): an unrecognised
 * status is 'unknown' and says so.
 */
export function classifyWarehouseFailure(step: WarehouseStep, err: unknown): WarehouseResolutionError {
  const e = (err || {}) as ErrShape;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = errorCode(e);
  const raw = quoteOf(e);
  const said = redactIdentifiers(raw);
  // The unredacted quote is admin-only (see redactIdentifiers).
  const rawDiagnostic = said !== raw ? `Unredacted ${step} response: ${raw}` : undefined;
  const classified = (init: ConstructorParameters<typeof WarehouseResolutionError>[0]) =>
    new WarehouseResolutionError(rawDiagnostic ? { ...init, diagnostic: rawDiagnostic } : init);
  const host = hostKey() || '(workspace)';
  const text = `${e.body || ''} ${e.message || ''}`;

  const networkRemediation =
    `The Console reaches ${host} over the workspace's private endpoint (${privateDnsZoneNameForGroupId('databricks_ui_api')}). ` +
    'Verify the databricks_ui_api private endpoint is Approved, the private DNS zone resolves the workspace host to it from the Container Apps environment VNet, ' +
    'and — if the workspace has an IP access list enabled — that it does not exclude the Console egress. Then re-run the readiness check.';
  if (isTransport(e)) {
    // No HTTP answer at all — "could not reach" is exactly what was measured.
    return classified({
      kind: 'network',
      step,
      status,
      message: `The Console could not reach the Databricks workspace ${host} to ${step} SQL warehouses: ${said}`,
      remediation: networkRemediation,
    });
  }
  if (status === 403 && NETWORK_REFUSAL.test(text)) {
    // The workspace ANSWERED — it was reached, and refused the request at its network layer.
    return classified({
      kind: 'network',
      step,
      status,
      message: `The Console's ${step} call on the Databricks workspace ${host} was refused at the network layer (HTTP 403): ${said}`,
      remediation: networkRemediation,
    });
  }
  if (status === 401 || code === 'UNAUTHENTICATED') {
    // 401 = the token was not accepted. That is authentication, not a missing
    // entitlement, so no entitlement is named and no grant is offered.
    return classified({
      kind: 'authentication',
      step,
      status,
      message: `Databricks did not accept the Console identity's token for the ${step} call on ${host} (HTTP ${status ?? '?'}${code ? ` ${code}` : ''}): ${said}`,
      remediation:
        'This is an authentication failure, not a missing entitlement — granting an entitlement will not fix it. ' +
        `Verify the Console managed identity has been added to the workspace ${host} as a service principal (Admin settings → Identity and access → Service principals), ` +
        'that its token is issued for the Azure Databricks resource (audience 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d), ' +
        'and that LOOM_DATABRICKS_HOSTNAME names the workspace the identity was added to.',
    });
  }
  if (status === 403 || code === 'PERMISSION_DENIED') {
    const entitlement = step === 'create' ? CREATE_ENTITLEMENT : SQL_ACCESS_ENTITLEMENT;
    const need = step === 'create'
      ? `Creating a SQL warehouse requires workspace admin or the "${CREATE_ENTITLEMENT}" (Allow unrestricted cluster creation) entitlement.`
      : `Listing / reading SQL warehouses requires the Console identity to be a workspace member with the "${SQL_ACCESS_ENTITLEMENT}" entitlement.`;
    return classified({
      kind: 'permission',
      step,
      status,
      entitlement,
      message: `Databricks refused the Console identity's ${step} call on ${host} (HTTP ${status ?? '?'}${code ? ` ${code}` : ''}): ${said}`,
      remediation:
        `${need} If the identity lacks it, a workspace admin grants it to the Console managed identity ` +
        `(SCIM PATCH /api/2.0/preview/scim/v2/ServicePrincipals/<id> add entitlements "${entitlement}", or Admin settings → Identity and access → Service principals). ` +
        'The Console cannot grant this to itself.',
    });
  }
  if (QUOTA_CODES.has(code) || /quota/i.test(text)) {
    return classified({
      kind: 'quota',
      step,
      status,
      message: `Databricks refused the ${step} call on ${host} for capacity/quota (HTTP ${status ?? '?'}${code ? ` ${code}` : ''}): ${said}`,
      remediation:
        'Raise the workspace / subscription compute quota (Azure portal → Subscriptions → Usage + quotas for classic vCPU; serverless SQL limits are per-workspace — contact the Databricks account team), ' +
        `or stop an unused SQL warehouse, then re-run.`,
    });
  }
  return classified({
    kind: 'unknown',
    step,
    status,
    message: `The ${step} call on ${host} failed and the response does not identify a permission, network, or quota cause (HTTP ${status ?? 'none'}${code ? ` ${code}` : ''}): ${said}`,
    remediation: 'The cause is not established from the response. Inspect the quoted Databricks error; re-run once it is addressed.',
  });
}

/** 5xx / 429 / transport — the only failures worth retrying. */
function isRetryable(err: unknown): boolean {
  const e = (err || {}) as ErrShape;
  if (isTransport(e)) return true;
  return typeof e.status === 'number' && (e.status >= 500 || e.status === 429);
}

async function withRetry<T>(step: WarehouseStep, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw classifyWarehouseFailure(step, lastErr);
}

// ── persistence (the platform-settings singleton — not a new store) ──────────

export interface PersistedWarehouseBinding {
  id: string;
  name: string;
  /** The workspace host the id belongs to — a binding for another host is ignored. */
  hostname: string;
  source: 'listed' | 'created';
  boundAt: string;
}

type DocWithBinding = PlatformSettingsDoc & { databricksSqlWarehouse?: PersistedWarehouseBinding; _etag?: string };

const PLATFORM_ID = '__platform__';

/** A stored binding is usable only with BOTH a non-blank id and a hostname (an admin write can leave either malformed). */
function validBinding(b: unknown): PersistedWarehouseBinding | null {
  const x = b as Partial<PersistedWarehouseBinding> | undefined;
  return x && typeof x.id === 'string' && x.id.trim() && typeof x.hostname === 'string' && x.hostname.trim()
    ? (x as PersistedWarehouseBinding)
    : null;
}

async function readBinding(): Promise<PersistedWarehouseBinding | null> {
  try {
    const doc = (await readPlatformSettings()) as DocWithBinding | null;
    return validBinding(doc?.databricksSqlWarehouse);
  } catch {
    // A store outage must not block resolution — (c) re-finds `loom-default`
    // by name, so no duplicate warehouse results from skipping this layer.
    return null;
  }
}

interface PersistOutcome {
  /** Why the write did not land, or null. */
  err: string | null;
  /** Set when ANOTHER replica's live binding for this workspace was already stored and was adopted instead. */
  adopted?: PersistedWarehouseBinding;
}

/** True only when a GET shows the warehouse exists and is not DELETED/DELETING. Any failure → false. */
async function isLiveWarehouse(id: string): Promise<boolean> {
  try {
    const w = await withRetryRaw(() => getWarehouse(id));
    return !GONE_STATES.has(String(w?.state || '').toUpperCase());
  } catch {
    return false;
  }
}

/**
 * Merge the binding into the singleton doc — COMPARE-AND-ADOPT. The doc is
 * re-read first: if it already holds a DIFFERENT binding for the same workspace
 * host (another replica bound first) and a GET shows that warehouse live, it is
 * adopted and nothing is written, so replicas converge on the first binding
 * persisted rather than on the last writer. `discardedId` is a binding THIS
 * resolution already found dead and is never adopted back. If the stored
 * binding cannot be verified live, it is overwritten (last-writer-wins only
 * then).
 *
 * The write is a replace with IfMatch on the doc's etag, so this resolver
 * never clobbers a concurrent admin setting (BI backend, Maps account, Spark
 * binding); bounded retry on a lost race. The OTHER direction is not protected:
 * the admin writers in platform-settings.ts upsert the doc without an etag and
 * can drop `databricksSqlWarehouse` — the next resolution re-adopts by name.
 */
async function persistBinding(b: PersistedWarehouseBinding, discardedId?: string): Promise<PersistOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const c = await envConfigContainer();
      const existing = (await readPlatformSettings()) as DocWithBinding | null;
      const stored = validBinding(existing?.databricksSqlWarehouse);
      if (
        stored && stored.id !== b.id && stored.id !== discardedId &&
        stored.hostname.toLowerCase() === b.hostname.toLowerCase() &&
        (await isLiveWarehouse(stored.id))
      ) {
        return { err: null, adopted: stored };
      }
      const doc: DocWithBinding = {
        ...(existing ?? {}),
        id: PLATFORM_ID,
        tenantId: PLATFORM_ID,
        databricksSqlWarehouse: b,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system:databricks-sql-warehouse-resolver',
      };
      if (existing?._etag) {
        await c.item(PLATFORM_ID, PLATFORM_ID).replace(doc, {
          accessCondition: { type: 'IfMatch', condition: existing._etag },
        });
      } else {
        await c.items.create(doc);
      }
      return { err: null };
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code === 412 || code === 409) continue; // lost a race — re-read and retry
      return { err: (e as Error)?.message || String(e) };
    }
  }
  return { err: 'lost the concurrent-write race 3 times' };
}

// ── resolution ───────────────────────────────────────────────────────────────

const GONE_STATES = new Set(['DELETED', 'DELETING']);

function isNotFound(e: unknown): boolean {
  const x = (e || {}) as ErrShape;
  return x.status === 404 || errorCode(x) === 'RESOURCE_DOES_NOT_EXIST';
}

/**
 * Pick the adoptable warehouse: the FIRST name in {@link LOOM_ADOPTABLE_WAREHOUSE_NAMES}
 * that the list carries wins (`loom-default` over `loom-governance`, whatever
 * the list order); within that name the lowest id, with the rest reported as
 * surplus. Unlike the deploy-time discover script, two warehouses of the chosen
 * name do NOT adopt none: the Console binds the lowest and names the surplus,
 * because refusing would leave every replica unbound.
 */
function pickLoomDefault(whs: Warehouse[]): { pick: Warehouse | undefined; surplus: string[]; name: string } {
  for (const name of LOOM_ADOPTABLE_WAREHOUSE_NAMES) {
    const matches = whs
      .filter((w) => w?.name === name && !GONE_STATES.has(String(w.state || '').toUpperCase()))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (matches.length) return { pick: matches[0], surplus: matches.slice(1).map((w) => w.id), name };
  }
  return { pick: undefined, surplus: [], name: LOOM_DEFAULT_WAREHOUSE_NAME };
}

function surplusNote(surplus: string[], name: string): string {
  return surplus.length
    ? ` ${surplus.length} other '${name}' warehouse(s) exist (${surplus.join(', ')}); left in place — this replica bound the lowest id it listed.`
    : '';
}

/** Serverless-unavailable fallback: ONLY a 400 whose body names serverless (the one field toggled). */
function isServerlessUnsupported(e: unknown): boolean {
  const x = (e || {}) as ErrShape;
  return x.status === 400 && /serverless/i.test(`${x.body || ''} ${x.message || ''}`);
}

function isCreateConflict(e: unknown): boolean {
  const x = (e || {}) as ErrShape;
  return x.status === 409 || errorCode(x) === 'RESOURCE_ALREADY_EXISTS' || /already exists/i.test(`${x.body || ''} ${x.message || ''}`);
}

interface CreateOutcome {
  id: string;
  classic: boolean;
  /** True when a retry's pre-POST re-list found `loom-default` and adopted it instead of POSTing again. */
  adopted: boolean;
}

/**
 * POST one create spec with bounded retry. A transient failure (transport /
 * 5xx / 429) does NOT prove the POST did not land — the response may have been
 * lost after the workspace created the warehouse. So before EVERY retry we
 * re-list, and if `loom-default` now exists we adopt it rather than POST a
 * second one. Rethrows the RAW error (the caller classifies); a failed re-list
 * throws its own classified error.
 */
async function createWithRelist(spec: WarehouseCreateSpec, classic: boolean): Promise<CreateOutcome> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const r = await createWarehouse(spec);
      return { id: String(r?.id || ''), classic, adopted: false };
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
      const again = pickLoomDefault(await listOrThrow());
      if (again.pick) return { id: again.pick.id, classic, adopted: true };
    }
  }
  throw lastErr;
}

async function createLoomDefault(): Promise<CreateOutcome> {
  try {
    return await createWithRelist({ ...LOOM_DEFAULT_WAREHOUSE_SPEC }, false);
  } catch (e) {
    if (e instanceof WarehouseResolutionError || !isServerlessUnsupported(e)) throw e;
    // Classic PRO fallback — same spec with serverless off — taken ONLY when the
    // serverless create was refused with a 400 naming serverless. The bootstrap
    // (since #4767) falls back to classic on ANY definite 4xx rejection; this is
    // deliberately narrower, and not the same rule.
    return createWithRelist({ ...LOOM_DEFAULT_WAREHOUSE_SPEC, enable_serverless_compute: false }, true);
  }
}

/** Retry transient failures but rethrow the RAW error (the caller classifies). */
async function withRetryRaw<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw lastErr;
}

/**
 * When a call is REFUSED for permission, read the identity's own entitlements
 * (SCIM `Me`) so the failure states what was actually measured, not a guess.
 * If the identity is a workspace admin, or already holds the named entitlement
 * directly, a missing entitlement does NOT explain the refusal: the failure is
 * re-classified 'unknown', names no entitlement, and offers no grant (R7). A
 * failed read is reported as such and the permission classification stands.
 */
async function measuredPermissionError(base: WarehouseResolutionError): Promise<WarehouseResolutionError> {
  const ent = base.entitlement || (base.step === 'create' ? CREATE_ENTITLEMENT : SQL_ACCESS_ENTITLEMENT);
  let me: DbxCurrentIdentity;
  try {
    me = await getCurrentIdentity();
  } catch (e: unknown) {
    const scimRaw = quoteOf((e || {}) as ErrShape);
    const scimSaid = redactIdentifiers(scimRaw);
    return new WarehouseResolutionError({
      kind: base.kind,
      step: base.step,
      status: base.status,
      entitlement: base.entitlement,
      diagnostic: joinDiagnostics(base.diagnostic, scimSaid !== scimRaw ? `Unredacted SCIM Me error: ${scimRaw}` : undefined),
      message: base.message + ` Could not read the identity's entitlements to confirm (SCIM Me failed: ${scimSaid}).`,
      remediation: base.remediation,
    });
  }
  const groupsKnown = Array.isArray(me.groups);
  const admin = groupsKnown && me.groups!.some((g) => g.toLowerCase() === 'admins');
  const has = me.entitlements.includes(ent);
  const who = me.displayName || me.applicationId || me.id || '(unnamed)';
  // Identity detail (name, app id, entitlement + group lists) goes ONLY into
  // `diagnostic`; `message` states the conclusion without naming the identity.
  const scimDiagnostic =
    `SCIM Me: identity ${who}${me.applicationId && me.applicationId !== who ? ` (application ${me.applicationId})` : ''}; ` +
    `direct entitlements [${me.entitlements.join(', ') || 'none'}]; ` +
    `groups ${groupsKnown ? `[${me.groups!.join(', ') || 'none'}]` : 'not reported (no groups field)'}.`;
  // Keeps the classifier's unredacted response quote (if any) alongside it.
  const diagnostic = joinDiagnostics(base.diagnostic, scimDiagnostic);
  if (admin || has) {
    const why = admin ? 'the Console identity IS in the workspace admins group' : `"${ent}" is present directly on the Console identity`;
    return new WarehouseResolutionError({
      kind: 'unknown',
      step: base.step,
      status: base.status,
      diagnostic,
      message: base.message + ` Measured via SCIM Me: ${why}, so the refusal is not explained by a missing entitlement. Its cause is not established.`,
      remediation:
        `Databricks answered the ${base.step} call with HTTP ${base.status ?? '?'}, but ${why}, so granting an entitlement will not fix it. ` +
        'The cause is not established from the response: inspect the quoted Databricks error, the warehouse\'s own permissions (CAN_USE / CAN_MANAGE), ' +
        'the workspace IP access list, and any workspace or account policy restricting SQL warehouses.',
    });
  }
  const adminClause = groupsKnown
    ? 'it is not in the admins group'
    : 'SCIM Me returned no group membership, so whether it is a workspace admin is not established';
  return new WarehouseResolutionError({
    kind: base.kind,
    step: base.step,
    status: base.status,
    entitlement: base.entitlement,
    diagnostic,
    message: base.message +
      ` Measured via SCIM Me: "${ent}" is ABSENT from the Console identity's direct entitlements and ${adminClause} (group-inherited entitlements are not visible on this object).`,
    remediation: base.remediation,
  });
}

async function listOrThrow(): Promise<Warehouse[]> {
  return withRetry('list', () => listWarehouses());
}

/** Compare-and-adopt lost: another replica's live binding was stored first — serve THAT one. */
function adoptedFromReplica(a: PersistedWarehouseBinding): WarehouseResolution {
  return {
    id: a.id,
    source: 'persisted',
    name: a.name,
    detail:
      `Another Console replica had already bound '${a.name}' (${a.id}) for this workspace (${a.source} on ${a.boundAt}); ` +
      'this replica adopted that binding, verified live, instead of overwriting it, so both serve the same warehouse.',
  };
}

function notPersisted(err: string | null): string {
  return err ? ` Binding NOT persisted (${err}); the next process re-adopts it by name.` : '';
}

async function resolveUncached(host: string): Promise<WarehouseResolution> {
  // (b) persisted binding — validated, self-healing.
  const bound = await readBinding();
  let discardedId: string | undefined;
  if (bound && bound.hostname.toLowerCase() === host) {
    try {
      const w = await withRetryRaw(() => getWarehouse(bound.id));
      if (!GONE_STATES.has(String(w?.state || '').toUpperCase())) {
        return {
          id: bound.id,
          source: 'persisted',
          name: w?.name || bound.name,
          detail: `Bound to SQL warehouse '${w?.name || bound.name}' (${bound.id}) — ${bound.source} by the Console on ${bound.boundAt}, verified live.`,
        };
      }
      // DELETED / DELETING → re-resolve below.
    } catch (e) {
      if (!isNotFound(e)) throw classifyWarehouseFailure('get', e);
      // 404 → the warehouse was deleted out-of-band; re-resolve below.
    }
    discardedId = bound.id;
  }

  // (c) list + adopt by name (`loom-default`, else `loom-governance`).
  const listed = pickLoomDefault(await listOrThrow());
  if (listed.pick) {
    const p = await persistBinding({ id: listed.pick.id, name: listed.name, hostname: host, source: 'listed', boundAt: new Date().toISOString() }, discardedId);
    if (p.adopted) return adoptedFromReplica(p.adopted);
    return {
      id: listed.pick.id,
      source: 'listed',
      name: listed.name,
      detail:
        `Adopted the existing '${listed.name}' SQL warehouse (${listed.pick.id}).` +
        surplusNote(listed.surplus, listed.name) +
        notPersisted(p.err),
    };
  }

  // (d) create, then converge.
  let createdId = '';
  let classic = false;
  let adopted = false;
  let conflicted = false;
  try {
    const c = await createLoomDefault();
    createdId = c.adopted ? '' : c.id;
    classic = c.classic;
    adopted = c.adopted;
  } catch (e) {
    if (e instanceof WarehouseResolutionError) throw e; // a re-list between retries failed — already classified
    if (!isCreateConflict(e)) throw classifyWarehouseFailure('create', e);
    // Another replica created it between our list and our create — adopt below.
    conflicted = true;
  }
  const after = pickLoomDefault(await listOrThrow());
  const chosen = after.pick?.id || createdId;
  if (!chosen) {
    if (conflicted) {
      // The workspace SAID the name exists, yet the list does not show it: the
      // likely cause is a `loom-default` the Console identity cannot see.
      throw new WarehouseResolutionError({
        kind: 'unknown',
        step: 'create',
        message:
          `Databricks refused the create because a '${LOOM_DEFAULT_WAREHOUSE_NAME}' SQL warehouse already exists, ` +
          `but no '${LOOM_DEFAULT_WAREHOUSE_NAME}' is visible to the Console identity when it lists warehouses.`,
        remediation:
          `A '${LOOM_DEFAULT_WAREHOUSE_NAME}' warehouse the Console identity cannot see is the likely cause — for example one the ` +
          'post-deploy bootstrap created under another identity. A workspace admin grants the Console managed identity CAN_USE ' +
          `(or CAN_MANAGE) on that '${LOOM_DEFAULT_WAREHOUSE_NAME}' warehouse (SQL Warehouses → ${LOOM_DEFAULT_WAREHOUSE_NAME} → Permissions); ` +
          'the Console then adopts it on the next attempt.',
      });
    }
    throw new WarehouseResolutionError({
      kind: 'unknown',
      step: 'create',
      message: `The create call for '${LOOM_DEFAULT_WAREHOUSE_NAME}' returned no warehouse id and no '${LOOM_DEFAULT_WAREHOUSE_NAME}' warehouse is visible to the Console identity afterwards.`,
      remediation: `The cause is not established. Check the workspace's SQL warehouses list and the Console identity's CAN_USE permission on '${LOOM_DEFAULT_WAREHOUSE_NAME}'.`,
    });
  }
  const chosenName = after.pick ? after.name : LOOM_DEFAULT_WAREHOUSE_NAME;
  const created = !!createdId && chosen === createdId;
  const source: PersistedWarehouseBinding['source'] = created ? 'created' : 'listed';
  const p = await persistBinding({ id: chosen, name: chosenName, hostname: host, source, boundAt: new Date().toISOString() }, discardedId);
  if (p.adopted) return adoptedFromReplica(p.adopted);
  let how: string;
  if (created) {
    how = `Created the '${LOOM_DEFAULT_WAREHOUSE_NAME}' SQL warehouse (${chosen}; ${classic ? 'classic PRO — serverless was refused by this workspace' : 'serverless PRO'}, 2X-Small, auto-stop 10 min).`;
  } else if (adopted) {
    how = `A create attempt failed in transit; the re-list before retrying found '${chosenName}', so the Console bound it (${chosen}) without POSTing again. Whether this replica's POST or another's produced it is not established.`;
  } else if (conflicted) {
    how = `The create was refused because '${LOOM_DEFAULT_WAREHOUSE_NAME}' already exists; bound to the listed '${chosenName}' (${chosen}).`;
  } else if (!createdId) {
    how = `The create returned no id; bound to the listed '${chosenName}' (${chosen}).`;
  } else {
    how = `This replica's create returned ${createdId}; bound to the lowest-id '${chosenName}' it listed (${chosen}).`;
  }
  return {
    id: chosen,
    source,
    name: chosenName,
    detail: how + surplusNote(after.surplus, chosenName) + notPersisted(p.err),
  };
}

/**
 * Resolve (and if needed produce) the Databricks SQL warehouse id. Throws a
 * classified {@link WarehouseResolutionError} on failure.
 */
export async function resolveDatabricksSqlWarehouseId(): Promise<WarehouseResolution> {
  // (a) an operator pin always wins, with no network call.
  const pinned = (process.env[WAREHOUSE_ENV_VAR] || '').trim();
  if (pinned) return { id: pinned, source: 'env', detail: `Pinned by ${WAREHOUSE_ENV_VAR}.` };

  const gate = databricksConfigGate();
  if (gate) {
    // The ONE genuinely not-configured case: no workspace is bound, no call was made.
    const err = new WarehouseResolutionError({
      kind: 'not-configured',
      step: 'config',
      missing: gate.missing,
      message: `No Databricks workspace is bound (${gate.missing} is unset), so there is no workspace to create or find a SQL warehouse in.`,
      remediation: `Set ${gate.missing} (the landing-zone Databricks workspace host). The Console then creates or adopts the '${LOOM_DEFAULT_WAREHOUSE_NAME}' warehouse itself.`,
    });
    publishRuntimeFailure(WAREHOUSE_ENV_VAR, { kind: err.kind, message: err.message, remediation: err.remediation });
    throw err;
  }

  const host = hostKey();
  const s = state();
  const now = Date.now();
  if (s.cached && s.cached.host === host && now - s.cached.verifiedAt < REVERIFY_MS) return s.cached.res;
  if (s.failure && s.failure.host === host && now - s.failure.at < FAILURE_HOLD_MS) throw s.failure.err;
  if (s.inflight) return s.inflight;

  const p = (async () => {
    try {
      const res = await resolveUncached(host);
      s.cached = { res, host, verifiedAt: Date.now() };
      s.failure = undefined;
      publishRuntimeValue(WAREHOUSE_ENV_VAR, { value: res.id, source: res.source, detail: res.detail });
      return res;
    } catch (e) {
      let err = e instanceof WarehouseResolutionError ? e : classifyWarehouseFailure('list', e);
      // Every permission refusal (get / list / create) is checked against what
      // SCIM Me says the identity holds before an entitlement is named.
      if (err.kind === 'permission') err = await measuredPermissionError(err);
      s.cached = undefined;
      s.failure = { err, host, at: Date.now() };
      // `message` feeds evalEnv's check detail, which NON-admin readers get
      // (GET /api/admin/self-audit, the Copilot self-audit tool), so it never
      // carries the SCIM identity detail. That goes in the separate
      // `diagnostic` field, read only by the admin-capability routes.
      publishRuntimeFailure(WAREHOUSE_ENV_VAR, {
        kind: err.kind,
        message: err.message,
        remediation: err.remediation,
        ...(err.diagnostic ? { diagnostic: err.diagnostic } : {}),
      });
      throw err;
    } finally {
      s.inflight = undefined;
    }
  })();
  s.inflight = p;
  return p;
}

/**
 * The id or a classified throw — for consumers that accept an optional
 * caller-supplied id (`explicit`) and otherwise need the platform warehouse.
 */
export async function resolveWarehouseIdOrThrow(explicit?: string | null): Promise<string> {
  const e = (explicit || '').trim();
  if (e) return e;
  return (await resolveDatabricksSqlWarehouseId()).id;
}

/**
 * Non-throwing probe for sync-shaped decisions (e.g. "is a Databricks SQL
 * backend available?"). Returns null on ANY failure — callers that need the
 * cause must use {@link resolveDatabricksSqlWarehouseId}.
 */
export async function tryResolveWarehouseId(): Promise<string | null> {
  try {
    return (await resolveDatabricksSqlWarehouseId()).id;
  } catch {
    return null;
  }
}

/**
 * Drop the in-process cache when it holds `id` — the self-heal for a warehouse
 * deleted out-of-band while cached (auto-bind-by-default.md §3). The next
 * resolve re-verifies the persisted binding with a GET instead of serving the
 * dead id for up to REVERIFY_MS.
 */
export function invalidateResolvedWarehouse(id: string): void {
  const s = state();
  if (s.cached && s.cached.res.id === id) s.cached = undefined;
}

/**
 * True when a statement failed because the WAREHOUSE is gone: the submit was
 * answered 404, or Databricks says RESOURCE_DOES_NOT_EXIST about a warehouse.
 * What the Statement Execution API returns for a deleted warehouse is NOT
 * measured on a live workspace — this keys only on those two documented shapes.
 */
export function isWarehouseGoneError(e: unknown): boolean {
  const x = (e || {}) as ErrShape;
  const text = `${x.message || ''} ${x.body || ''}`;
  if (x.status === 404 || /submit failed 404\b/.test(text)) return true;
  return (x.code === 'RESOURCE_DOES_NOT_EXIST' || /RESOURCE_DOES_NOT_EXIST/.test(text)) && /warehouse/i.test(text);
}

/**
 * Run `fn` against the resolver's warehouse. If the warehouse turns out to be
 * gone, the cached id is invalidated and `fn` is retried ONCE on a fresh
 * resolution. An operator pin (source 'env') is never second-guessed: its
 * failure is rethrown as-is.
 */
export async function withResolvedWarehouse<T>(fn: (warehouseId: string) => Promise<T>): Promise<T> {
  const first = await resolveDatabricksSqlWarehouseId();
  try {
    return await fn(first.id);
  } catch (e) {
    if (first.source === 'env' || !isWarehouseGoneError(e)) throw e;
    invalidateResolvedWarehouse(first.id);
    return fn((await resolveDatabricksSqlWarehouseId()).id);
  }
}

/**
 * Shape a resolution failure for a BFF JSON response. Deliberately carries NO
 * `diagnostic`: the routes that return it are open to any signed-in caller, so
 * what SCIM Me measured about the Console identity (name, application id,
 * entitlements, groups) is attached only by the admin-capability routes
 * (/api/admin/gates, /api/admin/readiness, the diagnostics bundle) from the
 * runtime failure's separate `diagnostic` field.
 */
export function warehouseErrorBody(e: WarehouseResolutionError): {
  ok: false;
  code: string;
  gateId: string;
  kind: WarehouseFailureKind;
  error: string;
  remediation: string;
  missing?: string;
  entitlement?: string;
} {
  return {
    ok: false,
    code: e.kind === 'not-configured' ? 'not_configured' : `warehouse_${e.kind}`,
    gateId: 'svc-databricks-sql',
    kind: e.kind,
    error: e.message,
    remediation: e.remediation,
    ...(e.missing ? { missing: e.missing } : {}),
    ...(e.entitlement ? { entitlement: e.entitlement } : {}),
  };
}

/** HTTP status for a resolution failure: 503 for config/authentication/network/quota, 403 permission, 502 unknown. */
export function warehouseErrorStatus(e: WarehouseResolutionError): number {
  switch (e.kind) {
    case 'permission': return 403;
    case 'unknown': return 502;
    default: return 503;
  }
}
