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
 *   (c) list warehouses and adopt the one named `loom-default` (the bootstrap's
 *       name — pinned against the workflow by a test, not transcribed);
 *   (d) create it — serverless PRO 2X-Small, 1..1 clusters, auto-stop 10 min,
 *       the bootstrap's exact spec — then persist.
 *
 * CONCURRENCY. One process-level in-flight promise (held on globalThis so
 * every Next.js route chunk shares it): N simultaneous first calls issue ONE
 * create. Across replicas, a create that conflicts re-lists and adopts; and
 * after any create we re-list and, when more than one `loom-default` exists,
 * every replica converges on the lexicographically smallest id so they all
 * bind the SAME warehouse. The surplus is left in place (never auto-deleted —
 * deleting compute is not a call this resolver gets to make) and named in the
 * resolution detail.
 *
 * FAILURES CLASSIFY TRUTHFULLY (deploy-integrity.md R6/R7). Every failed call
 * becomes a `WarehouseResolutionError` whose `kind` is derived from what the
 * API returned: permission (naming the entitlement — measured via SCIM `Me`
 * when the create is refused), network, quota, or unknown. "Not configured" is
 * reserved for the one case where no call was made: no workspace is bound
 * (LOOM_DATABRICKS_HOSTNAME unset). Transient transport / 5xx failures retry
 * with bounded backoff and fail closed.
 *
 * The outcome is PUBLISHED to `runtime-produced-env` so the synchronous gate
 * evaluation (`svc-databricks-sql` on /admin/readiness) reads green on a
 * resolver-produced id and shows the classified cause on a failure.
 */
import {
  databricksConfigGate,
  listWarehouses,
  getWarehouse,
  createWarehouse,
  getCurrentIdentity,
  type Warehouse,
  type WarehouseCreateSpec,
} from '@/lib/azure/databricks-client';
import { envConfigContainer } from '@/lib/azure/cosmos-client';
import { readPlatformSettings, type PlatformSettingsDoc } from '@/lib/admin/platform-settings';
import { publishRuntimeValue, publishRuntimeFailure } from '@/lib/azure/runtime-produced-env';

export const WAREHOUSE_ENV_VAR = 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID';

/** The bootstrap's warehouse name (csa-loom-post-deploy-bootstrap.yml). */
export const LOOM_DEFAULT_WAREHOUSE_NAME = 'loom-default';

/**
 * The bootstrap's exact create body. `warehouse-resolver.test.ts` parses the
 * workflow's POST payload and asserts equality, so the two cannot drift.
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

export type WarehouseFailureKind = 'not-configured' | 'permission' | 'network' | 'quota' | 'unknown';
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
  constructor(init: {
    kind: WarehouseFailureKind;
    step: WarehouseStep;
    message: string;
    remediation: string;
    status?: number;
    entitlement?: string;
    missing?: string;
  }) {
    super(init.message);
    this.name = 'WarehouseResolutionError';
    this.kind = init.kind;
    this.step = init.step;
    this.status = init.status;
    this.remediation = init.remediation;
    this.entitlement = init.entitlement;
    this.missing = init.missing;
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
 * Classify a failed call from what the API RETURNED. Pure — exported for tests.
 * Does not claim a cause the response does not carry (R7): an unrecognised
 * status is 'unknown' and says so.
 */
export function classifyWarehouseFailure(step: WarehouseStep, err: unknown): WarehouseResolutionError {
  const e = (err || {}) as ErrShape;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = errorCode(e);
  const said = quoteOf(e);
  const host = hostKey() || '(workspace)';
  const text = `${e.body || ''} ${e.message || ''}`;

  if (isTransport(e) || (status === 403 && NETWORK_REFUSAL.test(text))) {
    return new WarehouseResolutionError({
      kind: 'network',
      step,
      status,
      message: `The Console could not reach the Databricks workspace ${host} to ${step} SQL warehouses: ${said}`,
      remediation:
        `The Console reaches ${host} over the workspace's private endpoint (privatelink.azuredatabricks.net). ` +
        'Verify the databricks_ui_api private endpoint is Approved, the private DNS zone resolves the workspace host to it from the Container Apps environment VNet, ' +
        'and — if the workspace has an IP access list enabled — that it does not exclude the Console egress. Then re-run the readiness check.',
    });
  }
  if (status === 401 || status === 403 || code === 'PERMISSION_DENIED' || code === 'UNAUTHENTICATED') {
    const entitlement = step === 'create' ? CREATE_ENTITLEMENT : SQL_ACCESS_ENTITLEMENT;
    const need = step === 'create'
      ? `Creating a SQL warehouse requires workspace admin or the "${CREATE_ENTITLEMENT}" (Allow unrestricted cluster creation) entitlement.`
      : `Listing / reading SQL warehouses requires the Console identity to be a workspace member with the "${SQL_ACCESS_ENTITLEMENT}" entitlement.`;
    return new WarehouseResolutionError({
      kind: 'permission',
      step,
      status,
      entitlement,
      message: `Databricks refused the Console identity's ${step} call on ${host} (HTTP ${status ?? '?'}${code ? ` ${code}` : ''}): ${said}`,
      remediation:
        `${need} A workspace admin grants it to the Console managed identity ` +
        `(SCIM PATCH /api/2.0/preview/scim/v2/ServicePrincipals/<id> add entitlements "${entitlement}", or Admin settings → Identity and access → Service principals). ` +
        'The Console cannot grant this to itself.',
    });
  }
  if (QUOTA_CODES.has(code) || /quota/i.test(text)) {
    return new WarehouseResolutionError({
      kind: 'quota',
      step,
      status,
      message: `Databricks refused the ${step} call on ${host} for capacity/quota (HTTP ${status ?? '?'}${code ? ` ${code}` : ''}): ${said}`,
      remediation:
        'Raise the workspace / subscription compute quota (Azure portal → Subscriptions → Usage + quotas for classic vCPU; serverless SQL limits are per-workspace — contact the Databricks account team), ' +
        `or stop an unused SQL warehouse, then re-run.`,
    });
  }
  return new WarehouseResolutionError({
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

async function readBinding(): Promise<PersistedWarehouseBinding | null> {
  try {
    const doc = (await readPlatformSettings()) as DocWithBinding | null;
    const b = doc?.databricksSqlWarehouse;
    return b && typeof b.id === 'string' && b.id.trim() ? b : null;
  } catch {
    // A store outage must not block resolution — (c) re-finds `loom-default`
    // by name, so no duplicate warehouse results from skipping this layer.
    return null;
  }
}

/**
 * Merge the binding into the singleton doc. IfMatch on the doc's etag so a
 * concurrent admin write (BI backend, Maps account, Spark binding) is never
 * clobbered; bounded retry on a lost race. Returns an error string, or null.
 */
async function persistBinding(b: PersistedWarehouseBinding): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const c = await envConfigContainer();
      const existing = (await readPlatformSettings()) as DocWithBinding | null;
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
      return null;
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code === 412 || code === 409) continue; // lost a race — re-read and retry
      return (e as Error)?.message || String(e);
    }
  }
  return 'lost the concurrent-write race 3 times';
}

// ── resolution ───────────────────────────────────────────────────────────────

const GONE_STATES = new Set(['DELETED', 'DELETING']);

function isNotFound(e: unknown): boolean {
  const x = (e || {}) as ErrShape;
  return x.status === 404 || errorCode(x) === 'RESOURCE_DOES_NOT_EXIST';
}

function pickLoomDefault(whs: Warehouse[]): { pick: Warehouse | undefined; surplus: string[] } {
  const matches = whs
    .filter((w) => w?.name === LOOM_DEFAULT_WAREHOUSE_NAME && !GONE_STATES.has(String(w.state || '').toUpperCase()))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { pick: matches[0], surplus: matches.slice(1).map((w) => w.id) };
}

function surplusNote(surplus: string[]): string {
  return surplus.length
    ? ` ${surplus.length} other '${LOOM_DEFAULT_WAREHOUSE_NAME}' warehouse(s) exist (${surplus.join(', ')}); left in place — every replica binds the lowest id.`
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

async function createLoomDefault(): Promise<{ id: string; classic: boolean }> {
  try {
    const r = await withRetryRaw(() => createWarehouse({ ...LOOM_DEFAULT_WAREHOUSE_SPEC }));
    return { id: String(r?.id || ''), classic: false };
  } catch (e) {
    if (!isServerlessUnsupported(e)) throw e;
    // The bootstrap's own fallback: a small classic PRO warehouse, same size/auto-stop.
    const r = await withRetryRaw(() => createWarehouse({ ...LOOM_DEFAULT_WAREHOUSE_SPEC, enable_serverless_compute: false }));
    return { id: String(r?.id || ''), classic: true };
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
 * When the create is REFUSED for permission, read the identity's own
 * entitlements (SCIM `Me`) so the failure states what is actually absent —
 * a measurement, not a guess. A failed read is reported as such.
 */
async function measuredPermissionError(base: WarehouseResolutionError): Promise<WarehouseResolutionError> {
  let measured: string;
  try {
    const me = await getCurrentIdentity();
    const admin = me.groups.some((g) => g.toLowerCase() === 'admins');
    const has = me.entitlements.includes(CREATE_ENTITLEMENT);
    measured =
      ` Measured via SCIM Me: identity ${me.displayName || me.applicationId || me.id || '(unnamed)'} has direct entitlements ` +
      `[${me.entitlements.join(', ') || 'none'}], groups [${me.groups.join(', ') || 'none'}] — ` +
      (admin
        ? 'it IS in the admins group, so the refusal is not explained by entitlements.'
        : has
          ? `"${CREATE_ENTITLEMENT}" is present directly, so the refusal is not explained by that entitlement.`
          : `"${CREATE_ENTITLEMENT}" is ABSENT from its direct entitlements and it is not in the admins group (group-inherited entitlements are not visible on this object).`);
  } catch (e: unknown) {
    measured = ` Could not read the identity's entitlements to confirm (SCIM Me failed: ${quoteOf((e || {}) as ErrShape)}).`;
  }
  return new WarehouseResolutionError({
    kind: base.kind,
    step: base.step,
    status: base.status,
    entitlement: base.entitlement,
    message: base.message + measured,
    remediation: base.remediation,
  });
}

async function listOrThrow(): Promise<Warehouse[]> {
  return withRetry('list', () => listWarehouses());
}

async function resolveUncached(host: string): Promise<WarehouseResolution> {
  // (b) persisted binding — validated, self-healing.
  const bound = await readBinding();
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
  }

  // (c) list + adopt `loom-default`.
  const listed = pickLoomDefault(await listOrThrow());
  if (listed.pick) {
    const persistErr = await persistBinding({ id: listed.pick.id, name: listed.pick.name, hostname: host, source: 'listed', boundAt: new Date().toISOString() });
    return {
      id: listed.pick.id,
      source: 'listed',
      name: listed.pick.name,
      detail:
        `Adopted the existing '${LOOM_DEFAULT_WAREHOUSE_NAME}' SQL warehouse (${listed.pick.id}).` +
        surplusNote(listed.surplus) +
        (persistErr ? ` Binding NOT persisted (${persistErr}); the next process re-adopts it by name.` : ''),
    };
  }

  // (d) create, then converge.
  let createdId = '';
  let classic = false;
  try {
    const c = await createLoomDefault();
    createdId = c.id;
    classic = c.classic;
  } catch (e) {
    if (!isCreateConflict(e)) {
      const base = classifyWarehouseFailure('create', e);
      throw base.kind === 'permission' ? await measuredPermissionError(base) : base;
    }
    // Another replica created it between our list and our create — adopt below.
  }
  const after = pickLoomDefault(await listOrThrow());
  const chosen = after.pick?.id || createdId;
  if (!chosen) {
    throw new WarehouseResolutionError({
      kind: 'unknown',
      step: 'create',
      message: `The create call for '${LOOM_DEFAULT_WAREHOUSE_NAME}' returned no warehouse id and no '${LOOM_DEFAULT_WAREHOUSE_NAME}' warehouse is visible to the Console identity afterwards.`,
      remediation: `The cause is not established. Check the workspace's SQL warehouses list and the Console identity's CAN_USE permission on '${LOOM_DEFAULT_WAREHOUSE_NAME}'.`,
    });
  }
  const persistErr = await persistBinding({ id: chosen, name: LOOM_DEFAULT_WAREHOUSE_NAME, hostname: host, source: 'created', boundAt: new Date().toISOString() });
  const created = chosen === createdId;
  return {
    id: chosen,
    source: 'created',
    name: LOOM_DEFAULT_WAREHOUSE_NAME,
    detail:
      (created
        ? `Created the '${LOOM_DEFAULT_WAREHOUSE_NAME}' SQL warehouse (${chosen}; ${classic ? 'classic PRO — serverless was refused by this workspace' : 'serverless PRO'}, 2X-Small, auto-stop 10 min).`
        : `A concurrent create won; bound to '${LOOM_DEFAULT_WAREHOUSE_NAME}' (${chosen}).`) +
      surplusNote(after.surplus) +
      (persistErr ? ` Binding NOT persisted (${persistErr}); the next process re-adopts it by name.` : ''),
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
      const err = e instanceof WarehouseResolutionError ? e : classifyWarehouseFailure('list', e);
      s.cached = undefined;
      s.failure = { err, host, at: Date.now() };
      publishRuntimeFailure(WAREHOUSE_ENV_VAR, {
        kind: err.kind,
        message: err.message,
        remediation: err.remediation,
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

/** Shape a resolution failure for a BFF JSON response. */
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

/** HTTP status for a resolution failure: 503 for config/network/quota, 403 permission, 502 unknown. */
export function warehouseErrorStatus(e: WarehouseResolutionError): number {
  switch (e.kind) {
    case 'permission': return 403;
    case 'unknown': return 502;
    default: return 503;
  }
}
