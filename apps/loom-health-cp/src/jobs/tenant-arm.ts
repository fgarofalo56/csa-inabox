// The Azure seam for tenant.create / tenant.destroy (W1-2).
//
// `TenantArm` is the port the job handlers talk to; tests inject a fake. The
// shipped adapter, `RestTenantArm`, speaks ARM (deployments, resource reads and
// deletes) and the Key Vault data plane (key state, disable, delete) over fetch
// with an injected token provider, so nothing here holds a credential.
//
// Names are derived deterministically from the stamp and tenant slug and MUST
// equal the names modules/health/tenant.bicep declares (test/tenant-jobs.test.ts
// lifts the bicep literals and compares them, so a rename in one place fails).

import { JobFailure } from './types.js';

export interface TenantNames {
  keyNames: string[]; // order: st-pixel, st-audit, pg, backup
  eventHubName: string;
  databaseName: string;
  identityName: string;
  alertName: string;
}

export const KEY_SUFFIXES = ['st-pixel', 'st-audit', 'pg', 'backup'] as const;

export function tenantNames(stampName: string, slug: string): TenantNames {
  return {
    keyNames: KEY_SUFFIXES.map((k) => `t-${slug}-${k}`),
    eventHubName: `eh-t-${slug}`,
    databaseName: `lhds_${slug.replaceAll('-', '_')}`,
    identityName: `id-lhds-${stampName}-${slug}`,
    alertName: `alert-lhds-${stampName}-${slug}-capacity`,
  };
}

/** `rg-csa-loom-health-<stamp>-<region>`: the name health.bicep gives the stamp resource group. */
export function stampResourceGroup(stampId: string, region: string): string {
  return `rg-csa-loom-health-${stampId}-${region}`;
}

export function tenantDeploymentName(slug: string): string {
  return `lhds-tenant-${slug}`;
}

export function stampDeploymentName(stampId: string): string {
  return `lhds-stamp-${stampId}`;
}

/** The `tenant` output of tenant.bicep. */
export interface TenantManifest {
  tenantSlug: string;
  stampName: string;
  pixelAccountId: string;
  pixelAccountName: string;
  auditAccountId: string;
  auditAccountName: string;
  databaseId: string;
  databaseName: string;
  eventHubId: string;
  eventHubName: string;
  identityId: string;
  identityPrincipalId: string;
  capacityAlertId: string;
  maxStorageGiB: number;
  keyIds: string[];
  keyNames: string[];
}

export interface ResourceReadback {
  id: string;
  exists: boolean;
  /** Last path segment of the id as ARM reports it (`name`). */
  name?: string;
}

export interface KeyReadback {
  name: string;
  /** Live key exists in the vault. */
  exists: boolean;
  enabled?: boolean;
  /** Soft-deleted key present: deletedDate and scheduledPurgeDate (ISO) from the vault. */
  deletedDate?: string;
  scheduledPurgeDate?: string;
}

/**
 * Three-way answer for "read the outputs of deployment X". `absent` = ARM said 404.
 * `no_outputs` = the deployment record EXISTS but carries no usable outputs (for example a
 * failed incremental re-run overwrote the record). Callers must not conflate them.
 */
export type Lookup<T> = { state: 'absent' } | { state: 'no_outputs' } | { state: 'found'; value: T };

export interface TenantArm {
  /** Outputs of the stamp deployment (`stamp` object). */
  getStampManifest(resourceGroup: string, stampId: string): Promise<Lookup<Record<string, unknown>>>;
  /** Outputs of the tenant deployment record. */
  getTenantManifest(resourceGroup: string, slug: string): Promise<Lookup<TenantManifest>>;
  /** `/subscriptions/<id>/resourceGroups/<rg>`, so derived resource ids need no manifest. */
  scopeFor(resourceGroup: string): string;
  /** Ids of storage accounts tagged lhds-tenant=<slug> in the resource group (their names embed a hash, so they cannot be derived). */
  findTenantStorage(resourceGroup: string, slug: string): Promise<string[]>;
  /** Run tenant.bicep (incremental, idempotent) and return its outputs once provisioning succeeded. */
  deployTenant(input: {
    resourceGroup: string;
    slug: string;
    displayName: string;
    maxStorageGiB: number;
    stamp: Record<string, unknown>;
  }): Promise<TenantManifest>;
  readResource(id: string): Promise<ResourceReadback>;
  /** Delete and wait until a read says it is gone. */
  deleteResource(id: string): Promise<void>;
  readKey(vaultUri: string, keyName: string): Promise<KeyReadback>;
  disableKey(vaultUri: string, keyName: string): Promise<void>;
  deleteKey(vaultUri: string, keyName: string): Promise<void>;
}

/**
 * What ARM said it refused, lifted out of a 4xx/5xx response (#5380). Every field
 * is an identifier (error codes, an action name, an ARM scope path, a request id,
 * header tokens), each sanitised to a closed character class and length-bounded.
 * Free text (the service `message`, the body) is never kept: the denied action and
 * scope are matched out of the message and only the match survives.
 */
export interface ArmDiagnostics {
  /** Nested `error.details[].code`, in order, at most 5. */
  details?: string[];
  /** Denied action from an AuthorizationFailed-shaped message, e.g. `Microsoft.Resources/deployments/write`. A LinkedAuthorizationFailed list is comma-joined, at most 5. */
  action?: string;
  /** Scope the action was denied over, an ARM path; comma-joined (at most 5) for a linked list, positionally matching `action`. */
  scope?: string;
  /** `x-ms-failure-cause` (`gateway`, `service`, ...): who refused it. */
  failureCause?: string;
  /** `x-ms-correlation-request-id`, to join the refusal to ARM's own records. */
  correlationId?: string;
  /** Set when no error code was found: how the body looked instead (`empty-or-non-json`, `empty`, `keys:a,b`). */
  bodyShape?: string;
  /** Set with `bodyShape`: media type only, lower-cased, parameters stripped (`text/html`). */
  contentType?: string;
  /** Set with `bodyShape`: the `content-length` header if numeric, else the measured body bytes. */
  contentLength?: number;
  /** Set with `bodyShape`: the `server` header, token-validated, so an intermediary can be named. */
  server?: string;
  /** Set with `bodyShape`: `x-ms-request-id`, token-validated. */
  requestId?: string;
  /** Set with `bodyShape`: class of the first non-whitespace char: `<`, `{`, `[`, `empty` or `other`. */
  firstByte?: string;
  /** Set with `bodyShape` for an HTML-looking body: its `<title>`, tags/entities stripped, closed char class, ≤ 80 chars (`htmlTitle`). */
  title?: string;
  /** Set with `bodyShape`: Azure Front Door / Microsoft edge `x-azure-ref`, allowlist-validated. */
  azureRef?: string;
  /** Set with `bodyShape`: Microsoft edge `x-msedge-ref` (`Ref A: ... Ref B: ... Ref C: ...`), allowlist-validated. */
  msedgeRef?: string;
  /** Set with `bodyShape`: `x-cache` of a caching proxy (`TCP_DENIED from proxy`), allowlist-validated. */
  cache?: string;
  /** Set with `bodyShape`: `via` of an intermediary (`1.1 squid`), allowlist-validated. */
  via?: string;
}

const ID_CHARS = /[^A-Za-z0-9._-]/g;
const code60 = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(ID_CHARS, '').slice(0, 60);
  return s || undefined;
};
// AuthorizationFailed: "...perform action 'Microsoft.X/y/write' over scope '/subscriptions/...'".
// LinkedAuthorizationFailed: "...HAS permission to perform action 'A' on scope 'S'; however, it does not have
// permission to perform action(s) 'B' on the linked scope(s) 'L'". The first quoted action there is the one
// that was ALLOWED. The "(s)" forms carry a comma-joined LIST ("(respectively)"), so they accept one,
// and a Linked message never falls back to the plain forms: no match there reports nothing rather
// than naming the allowed action as the denied one (deploy-integrity R7).
const ACTION_ONE = '[A-Za-z0-9.]+(?:/[A-Za-z0-9._*-]+)+';
const SCOPE_ONE = '/[A-Za-z0-9./_()-]{1,400}';
const list = (one: string): string => `'(${one}(?:\\s*,\\s*${one}){0,9})'`;
const LINKED_ACTION = new RegExp(`action\\(s\\)\\s+${list(ACTION_ONE)}`, 'i');
const LINKED_SCOPE = new RegExp(`linked scope\\(s\\)\\s+${list(SCOPE_ONE)}`, 'i');
const PLAIN_ACTION = new RegExp(`action\\s+'(${ACTION_ONE})'`, 'i');
const PLAIN_SCOPE = new RegExp(`scope\\s+'(${SCOPE_ONE})'`, 'i');
const LINKED_SHAPE = /linked scope|action\(s\)/i;
/** At most 5 entries of a comma list, re-joined with "," and no spaces. */
const entries = (m: string | undefined, max: number): string | undefined =>
  m
    ?.split(/\s*,\s*/)
    .slice(0, 5)
    .map((x) => x.slice(0, max))
    .join(',');
const HEADER_TOKEN = /^[A-Za-z0-9._:-]{1,80}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;
// `Microsoft-HTTPAPI/2.0` style. RFC 9110 lets `server` be a LIST of products separated by single
// spaces (`Microsoft-HTTPAPI/2.0 Microsoft-IIS/10.0`), and an intermediary that answered instead of
// ARM may send one, so up to 4 products are admitted. Each product keeps the old class and 60-char
// cap; `;`, `=`, parentheses (RFC comments, free text) and control chars are still refused.
const SERVER_TOKEN = /^[A-Za-z0-9._:/-]{1,60}(?: [A-Za-z0-9._:/-]{1,60}){0,3}$/;
// Edge-identifying headers (#5380): which intermediary answered. Closed classes, no `;` (the
// describeDiagnostics separator), no quotes, no control chars, so none can forge a log line.
const AZURE_REF = /^[A-Za-z0-9+/=._:-]{1,120}$/; // `20251120T101500Z-abc...` or the older base64 form
const MSEDGE_REF = /^[A-Za-z0-9 .:_-]{1,160}$/; // `Ref A: 0A1B Ref B: BL2EDGE0108 Ref C: 2025-11-20T10:15:00Z`
const X_CACHE = /^[A-Za-z0-9 ._:/-]{1,80}$/; // `TCP_DENIED from proxy:3128`
const VIA = /^[A-Za-z0-9 ._:/(),-]{1,120}$/; // `1.1 squid (squid/4.10)`
const edgeHeader = (headers: Headers | undefined, name: string, re: RegExp): string | undefined => {
  const v = headers?.get(name)?.trim().replace(/ {2,}/g, ' ');
  return v && re.test(v) ? v : undefined;
};

/** Longest title kept; also the bound the #5380 sanitisation test pins. */
export const TITLE_MAX = 80;
// Only the head of the body is searched, so a huge page costs a bounded regex scan.
const TITLE_SCAN = 8192;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title\s*>/i;
const TITLE_CHARS = /[^A-Za-z0-9 .,:_()-]+/g;
/**
 * The `<title>` of an HTML body, reduced to a closed character class: tags and entities are
 * removed, anything outside `[A-Za-z0-9 .,:_()-]` becomes a space, whitespace collapses, and the
 * result is cut to TITLE_MAX. A word that is token-shaped (longer than 24 chars) or id-shaped (6+
 * digits: an MRN, SSN, phone or account number) is dropped whole, so a title cannot carry a bearer
 * token, a key or a patient identifier into the job message. Returns undefined when nothing is left.
 */
export function htmlTitle(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const m = TITLE_RE.exec(body.slice(0, TITLE_SCAN));
  if (!m?.[1]) return undefined;
  const words = m[1]
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?[A-Za-z0-9]{1,10};?/g, ' ')
    .replace(TITLE_CHARS, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length <= 24 && (w.match(/\d/g)?.length ?? 0) < 6);
  const out = words.join(' ').slice(0, TITLE_MAX).trim();
  return out || undefined;
}

/** Extract an ARM error code and identifier-only diagnostics; never returns free text. */
export function armDiagnostics(json: Json | undefined, parsed: boolean, headers?: Headers, bodyText?: string): { code: string; diag: ArmDiagnostics } {
  const diag: ArmDiagnostics = {};
  // ARM's usual shape is { error: { code, message, details } }; some RPs and the gateway answer
  // with a capitalised { Code, Message } or a bare top-level { code, message }.
  const errObj = (json?.error ?? json?.Error) as Json | undefined;
  const src: Json | undefined = errObj && typeof errObj === 'object' ? errObj : json;
  const code = code60(src?.code) ?? code60(src?.Code);
  const message = typeof src?.message === 'string' ? src.message : typeof src?.Message === 'string' ? src.Message : '';
  const details = Array.isArray(src?.details) ? (src.details as unknown[]) : [];
  const detailCodes = details.map((d) => code60((d as Json | null)?.code)).filter((c): c is string => !!c).slice(0, 5);
  if (detailCodes.length) diag.details = detailCodes;
  // The denied action/scope may sit on the outer message or on a nested detail's message. Both are
  // taken from the SAME text: the first text that names an action owns the pair, and its scope is
  // left unset if that text has none, so "denied A over S" never splices A and S from two errors.
  const texts = [message, ...details.map((d) => String((d as Json | null)?.message ?? ''))];
  let scopeOnly: string | undefined;
  for (const t of texts) {
    const linked = LINKED_SHAPE.test(t);
    const a = entries((linked ? LINKED_ACTION : PLAIN_ACTION).exec(t)?.[1], 200);
    const s = entries((linked ? LINKED_SCOPE : PLAIN_SCOPE).exec(t)?.[1], 400);
    if (a) {
      diag.action = a;
      if (s) diag.scope = s;
      break;
    }
    scopeOnly ??= s;
  }
  // No text named an action: a scope alone is still a fact ARM stated, reported as "scope", not "denied".
  if (!diag.action && scopeOnly) diag.scope = scopeOnly;
  const cause = headers?.get('x-ms-failure-cause');
  if (cause && HEADER_TOKEN.test(cause)) diag.failureCause = cause;
  const corr = headers?.get('x-ms-correlation-request-id');
  if (corr && HEADER_TOKEN.test(corr)) diag.correlationId = corr;
  if (!code) {
    // res.json() throws on an empty body too, so an unparsed body is "empty or not JSON", no finer.
    diag.bodyShape = !parsed
      ? 'empty-or-non-json'
      : !json || Object.keys(json).length === 0
        ? 'empty'
        : `keys:${Object.keys(json)
            .slice(0, 5)
            .map((k) => k.replace(ID_CHARS, '').slice(0, 30))
            .join(',')}`;
    // Identifiers only: the body text itself is never kept, just what kind of thing it was.
    const ct = headers?.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (ct && MEDIA_TYPE.test(ct)) diag.contentType = ct;
    const cl = headers?.get('content-length')?.trim();
    if (cl && /^\d{1,12}$/.test(cl)) diag.contentLength = Number(cl);
    else if (bodyText !== undefined) diag.contentLength = Buffer.byteLength(bodyText, 'utf8');
    const server = headers?.get('server');
    if (server && SERVER_TOKEN.test(server)) diag.server = server;
    const rid = headers?.get('x-ms-request-id');
    if (rid && HEADER_TOKEN.test(rid)) diag.requestId = rid;
    if (bodyText !== undefined) {
      const c = bodyText.trimStart()[0];
      diag.firstByte = c === undefined ? 'empty' : c === '<' || c === '{' || c === '[' ? c : 'other';
    }
    if (diag.firstByte === '<' || diag.contentType === 'text/html') {
      const title = htmlTitle(bodyText);
      if (title) diag.title = title;
    }
    const azureRef = edgeHeader(headers, 'x-azure-ref', AZURE_REF);
    if (azureRef) diag.azureRef = azureRef;
    const msedgeRef = edgeHeader(headers, 'x-msedge-ref', MSEDGE_REF);
    if (msedgeRef) diag.msedgeRef = msedgeRef;
    const cache = edgeHeader(headers, 'x-cache', X_CACHE);
    if (cache) diag.cache = cache;
    const via = edgeHeader(headers, 'via', VIA);
    if (via) diag.via = via;
  }
  return { code: code ?? 'Unknown', diag };
}

/** One line, identifiers only: ` [denied Microsoft.X/y/write over /subscriptions/...; details A,B; cause gateway; correlation c]`. */
export function describeDiagnostics(d: ArmDiagnostics | undefined): string {
  if (!d) return '';
  const parts: string[] = [];
  if (d.action) parts.push(`denied ${d.action}${d.scope ? ` over ${d.scope}` : ''}`);
  else if (d.scope) parts.push(`scope ${d.scope}`);
  if (d.details?.length) parts.push(`details ${d.details.join(',')}`);
  if (d.bodyShape) parts.push(`body ${d.bodyShape}`);
  if (d.contentType) parts.push(`type ${d.contentType}`);
  if (d.contentLength !== undefined) parts.push(`len ${d.contentLength}`);
  if (d.server) parts.push(`server ${d.server}`);
  if (d.requestId) parts.push(`request ${d.requestId}`);
  if (d.firstByte) parts.push(`first ${d.firstByte}`);
  if (d.title) parts.push(`title ${d.title}`);
  if (d.azureRef) parts.push(`x-azure-ref ${d.azureRef}`);
  if (d.msedgeRef) parts.push(`x-msedge-ref ${d.msedgeRef}`);
  if (d.cache) parts.push(`x-cache ${d.cache}`);
  if (d.via) parts.push(`via ${d.via}`);
  if (d.failureCause) parts.push(`cause ${d.failureCause}`);
  if (d.correlationId) parts.push(`correlation ${d.correlationId}`);
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

/** ARM / Key Vault HTTP failure. Carries status, the service error CODE and identifier-only diagnostics, never the body. */
export class ArmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly op: string,
    readonly diag?: ArmDiagnostics,
    /** How many requests were made before giving up (> 1 only after a non-ARM 403 retry). */
    readonly attempts = 1,
    /** The refusal carried no ARM error code AND no `x-ms-request-id`: ARM itself never answered. */
    readonly nonArm = false,
  ) {
    super(`${op} failed: HTTP ${status} ${code}${describeDiagnostics(diag)}`);
  }
}

/** Turn an ArmError into an operator-actionable JobFailure; anything else passes through unchanged. */
export function classifyArm(e: unknown): unknown {
  if (!(e instanceof ArmError)) return e;
  const said = describeDiagnostics(e.diag);
  if (e.status === 403 && e.nonArm) {
    // R7: what is established is the ABSENCE of ARM's markers, not who refused, so no role is named.
    const html = e.diag?.contentType === 'text/html' || e.diag?.firstByte === '<' ? 'HTML ' : '';
    return new JobFailure(
      'permission',
      `${e.op}: refused by a non-ARM ${html}403 (origin unidentified; no ARM error code, no x-ms-request-id) on all ${e.attempts} attempt(s) (HTTP ${e.status} ${e.code})${said}. No ARM authorization error was returned, so no missing role is established; the type, title and edge headers above identify the intermediary that answered.`,
    );
  }
  if (e.status === 401 || e.status === 403) {
    return new JobFailure(
      'permission',
      `${e.op}: the control-plane identity is not authorised (HTTP ${e.status} ${e.code})${said}. Grant it the role that covers this operation on the stamp resource group or vault, then retry.`,
    );
  }
  if (e.status === 429 || e.status >= 500 || e.status === 408) {
    return new JobFailure('transient', `${e.op}: Azure returned HTTP ${e.status} ${e.code}${said}; retry the job.`);
  }
  return new JobFailure('arm_error', `${e.op}: Azure rejected the request (HTTP ${e.status} ${e.code})${said}.`);
}

// ── REST adapter ──────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export interface RestTenantArmOptions {
  /** `https://management.azure.com` or `https://management.usgovcloudapi.net`. */
  armEndpoint: string;
  subscriptionId: string;
  /** Returns a bearer token for a resource scope, for example `${armEndpoint}/.default`. */
  token: (scope: string) => Promise<string>;
  /** Key Vault data-plane scope: `https://vault.azure.net/.default` or `https://vault.usgovcloudapi.net/.default`. */
  vaultScope: string;
  /** Compiled tenant.bicep (az bicep build). */
  loadTemplate: () => Promise<Json>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  /** Structured event logger; defaults to the same one-JSON-line-per-event stdout format main.ts uses. */
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/**
 * Non-ARM 403 retry policy (#5380). Total attempts, and the sleep before attempt n+1. Bounded:
 * at most 3 requests and 6 s of waiting per call, then fail closed with the last refusal.
 */
export const NON_ARM_403_ATTEMPTS = 3;
export const NON_ARM_403_BACKOFF_MS = [2000, 4000] as const;

function stdoutLog(event: string, fields: Record<string, string | number>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}

/** The sanitised fingerprint of a refusal: identifiers only (every value already allowlist-validated). */
function fingerprint(e: ArmError): Record<string, string | number> {
  const d = e.diag ?? {};
  const out: Record<string, string | number> = { status: e.status, code: e.code };
  const keys = ['bodyShape', 'contentType', 'contentLength', 'firstByte', 'title', 'server', 'azureRef', 'msedgeRef', 'cache', 'via', 'correlationId'] as const;
  for (const k of keys) {
    const v = d[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const API_BY_TYPE: Record<string, string> = {
  'microsoft.storage/storageaccounts': '2024-01-01',
  'microsoft.eventhub/namespaces/eventhubs': '2024-05-01-preview',
  'microsoft.dbforpostgresql/flexibleservers/databases': '2024-08-01',
  'microsoft.managedidentity/userassignedidentities': '2023-01-31',
  'microsoft.insights/metricalerts': '2018-03-01',
  'microsoft.keyvault/vaults/keys': '2024-11-01',
};
const DEPLOYMENT_API = '2024-03-01';
const KV_API = '7.5';
const ARM_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/[A-Za-z0-9.]+(?:\/[A-Za-z0-9._-]+){2,}$/i;

/** Resource type of an ARM id, lower-cased: `Microsoft.EventHub/namespaces/eventhubs`. */
export function resourceTypeOf(id: string): string {
  const after = id.split('/providers/')[1] ?? '';
  const seg = after.split('/');
  const out = [seg[0] ?? ''];
  for (let i = 1; i < seg.length; i += 2) out.push(seg[i] ?? '');
  return out.join('/').toLowerCase();
}

export class RestTenantArm implements TenantArm {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;
  private readonly log: (event: string, fields: Record<string, string | number>) => void;

  constructor(private readonly o: RestTenantArmOptions) {
    this.f = o.fetchFn ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = o.pollMs ?? 5000;
    this.maxPolls = o.maxPolls ?? 360; // 30 min at the default
    this.log = o.log ?? stdoutLog;
  }

  /**
   * One ARM / Key Vault request, with a bounded retry for ONE failure shape only (#5380): a 403
   * carrying neither an ARM error code nor an `x-ms-request-id`, i.e. a refusal ARM itself never
   * authored (live: an 875-byte HTML page, intermittent per request, while 20/20 requests from the
   * same environment got ARM JSON). Every refused attempt logs its sanitised fingerprint; after
   * NON_ARM_403_ATTEMPTS it fails closed with the last refusal (classifyArm -> `permission`). A
   * genuine ARM 403 (AuthorizationFailed etc.) carries a code and is thrown on the first attempt.
   *
   * Retry safety per verb: GET is read-only. The tenant deployment PUT is idempotent: same
   * deterministic deployment name, same template and parameters, Incremental mode, so a repeat
   * converges on the same resources and cannot duplicate one. PATCH (key enabled:false) and DELETE
   * are idempotent too, and a DELETE whose target is already gone answers 404, which call() accepts.
   */
  private async call(method: string, url: string, scope: string, op: string, body?: Json): Promise<{ status: number; json?: Json }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce(method, url, scope, op, attempt, body);
      } catch (e) {
        if (!(e instanceof ArmError) || !e.nonArm) throw e;
        const last = attempt >= NON_ARM_403_ATTEMPTS;
        this.log('arm.non_arm_403', { op, method, attempt, of: NON_ARM_403_ATTEMPTS, outcome: last ? 'exhausted' : 'retrying', ...fingerprint(e) });
        if (last) throw e;
        await this.sleep(NON_ARM_403_BACKOFF_MS[attempt - 1] ?? 4000);
      }
    }
  }

  private async callOnce(method: string, url: string, scope: string, op: string, attempt: number, body?: Json): Promise<{ status: number; json?: Json }> {
    const res = await this.f(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.o.token(scope)}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json: Json | undefined;
    let parsed = true;
    // Read once as text so a non-JSON body can still be classified; JSON.parse keeps the old semantics.
    let text: string | undefined;
    try {
      text = await res.text();
    } catch {
      text = undefined;
    }
    try {
      const v = JSON.parse(text ?? '') as unknown;
      json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
    } catch {
      json = undefined;
      parsed = false;
    }
    if (res.status >= 400 && res.status !== 404) {
      const { code, diag } = armDiagnostics(json, parsed, res.headers, text);
      // Raw presence, not the validated value: a malformed-but-present request id still means ARM answered.
      const nonArm = res.status === 403 && code === 'Unknown' && !res.headers?.get('x-ms-request-id');
      throw new ArmError(res.status, code, op, diag, attempt, nonArm);
    }
    return { status: res.status, ...(json ? { json } : {}) };
  }

  private arm(path: string, q = DEPLOYMENT_API): string {
    return `${this.o.armEndpoint}${path}${path.includes('?') ? '&' : '?'}api-version=${q}`;
  }
  private get armScope(): string {
    return `${this.o.armEndpoint}/.default`;
  }
  private deploymentPath(rg: string, name: string): string {
    return `/subscriptions/${this.o.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Resources/deployments/${name}`;
  }

  scopeFor(rg: string): string {
    return `/subscriptions/${this.o.subscriptionId}/resourceGroups/${rg}`;
  }

  async findTenantStorage(rg: string, slug: string): Promise<string[]> {
    const filter = encodeURIComponent(`tagName eq 'lhds-tenant' and tagValue eq '${slug.replace(/[^a-z0-9-]/g, '')}'`);
    const r = await this.call('GET', this.arm(`${this.scopeFor(rg)}/resources?$filter=${filter}`, '2021-04-01'), this.armScope, 'list tenant resources');
    const value = Array.isArray(r.json?.value) ? (r.json?.value as Json[]) : [];
    return value.map((v) => String(v.id ?? '')).filter((id) => resourceTypeOf(id) === 'microsoft.storage/storageaccounts');
  }

  async getStampManifest(rg: string, stampId: string): Promise<Lookup<Json>> {
    const r = await this.call('GET', this.arm(this.deploymentPath(rg, stampDeploymentName(stampId))), this.armScope, 'read stamp deployment');
    if (r.status === 404) return { state: 'absent' };
    const out = ((r.json?.properties as Json | undefined)?.outputs as Json | undefined)?.stamp as Json | undefined;
    const value = out?.value as Json | undefined;
    return value ? { state: 'found', value } : { state: 'no_outputs' };
  }

  async getTenantManifest(rg: string, slug: string): Promise<Lookup<TenantManifest>> {
    const r = await this.call('GET', this.arm(this.deploymentPath(rg, tenantDeploymentName(slug))), this.armScope, 'read tenant deployment');
    if (r.status === 404) return { state: 'absent' };
    const m = manifestFromOutputs((r.json?.properties as Json | undefined)?.outputs as Json | undefined);
    return m ? { state: 'found', value: m } : { state: 'no_outputs' };
  }

  async deployTenant(i: { resourceGroup: string; slug: string; displayName: string; maxStorageGiB: number; stamp: Json }): Promise<TenantManifest> {
    const path = this.deploymentPath(i.resourceGroup, tenantDeploymentName(i.slug));
    await this.call('PUT', this.arm(path), this.armScope, 'start tenant deployment', {
      properties: {
        mode: 'Incremental',
        template: await this.o.loadTemplate(),
        parameters: {
          stamp: { value: i.stamp },
          tenantSlug: { value: i.slug },
          displayName: { value: i.displayName },
          maxStorageGiB: { value: i.maxStorageGiB },
        },
      },
    });
    for (let n = 0; n < this.maxPolls; n++) {
      const r = await this.call('GET', this.arm(path), this.armScope, 'poll tenant deployment');
      const p = r.json?.properties as Json | undefined;
      const state = String(p?.provisioningState ?? '');
      if (state === 'Succeeded') {
        const m = manifestFromOutputs(p?.outputs as Json | undefined);
        if (!m) throw new JobFailure('no_outputs', 'the tenant deployment succeeded but returned no tenant manifest; check the deployed template version');
        return m;
      }
      if (state === 'Failed' || state === 'Canceled') {
        const code = String(((p?.error as Json | undefined)?.code as string | undefined) ?? 'Unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
        throw new JobFailure('deployment_failed', `tenant deployment ${state}: ${code}. Read the deployment operations for ${tenantDeploymentName(i.slug)} in the stamp resource group.`);
      }
      await this.sleep(this.pollMs);
    }
    throw new JobFailure('deployment_timeout', 'the tenant deployment did not finish in time; it may still be running. Retry the job to resume reading it.');
  }

  private apiFor(id: string, op: string): string {
    if (!ARM_ID.test(id)) throw new JobFailure('bad_resource_id', `${op}: refusing a malformed resource id`);
    const api = API_BY_TYPE[resourceTypeOf(id)];
    if (!api) throw new JobFailure('unsupported_resource', `${op}: no API version is known for ${resourceTypeOf(id)}`);
    return api;
  }

  async readResource(id: string): Promise<ResourceReadback> {
    const r = await this.call('GET', this.arm(id, this.apiFor(id, 'read resource')), this.armScope, 'read resource');
    if (r.status === 404) return { id, exists: false };
    const name = typeof r.json?.name === 'string' ? r.json.name : undefined;
    return { id: typeof r.json?.id === 'string' ? r.json.id : id, exists: true, ...(name ? { name } : {}) };
  }

  async deleteResource(id: string): Promise<void> {
    await this.call('DELETE', this.arm(id, this.apiFor(id, 'delete resource')), this.armScope, 'delete resource');
    for (let n = 0; n < this.maxPolls; n++) {
      if (!(await this.readResource(id)).exists) return;
      await this.sleep(this.pollMs);
    }
    throw new JobFailure('delete_timeout', `a resource was still present after the delete wait: ${id}`);
  }

  private keyUrl(vaultUri: string, name: string, deleted = false): string {
    const base = vaultUri.replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9-]{3,24}\.[a-z0-9.-]+$/i.test(base)) throw new JobFailure('bad_vault_uri', 'the stamp manifest carries a malformed vault URI');
    return `${base}/${deleted ? 'deletedkeys' : 'keys'}/${encodeURIComponent(name)}?api-version=${KV_API}`;
  }

  async readKey(vaultUri: string, name: string): Promise<KeyReadback> {
    const live = await this.call('GET', this.keyUrl(vaultUri, name), this.o.vaultScope, 'read key');
    if (live.status !== 404) {
      return { name, exists: true, enabled: (live.json?.attributes as Json | undefined)?.enabled === true };
    }
    const del = await this.call('GET', this.keyUrl(vaultUri, name, true), this.o.vaultScope, 'read deleted key');
    if (del.status === 404) return { name, exists: false };
    const iso = (s: unknown): string | undefined => (typeof s === 'number' ? new Date(s * 1000).toISOString() : undefined);
    const deletedDate = iso(del.json?.deletedDate);
    const scheduledPurgeDate = iso(del.json?.scheduledPurgeDate);
    return {
      name,
      exists: false,
      ...(deletedDate ? { deletedDate } : {}),
      ...(scheduledPurgeDate ? { scheduledPurgeDate } : {}),
    };
  }

  async disableKey(vaultUri: string, name: string): Promise<void> {
    await this.call('PATCH', this.keyUrl(vaultUri, name), this.o.vaultScope, 'disable key', { attributes: { enabled: false } });
  }

  async deleteKey(vaultUri: string, name: string): Promise<void> {
    await this.call('DELETE', this.keyUrl(vaultUri, name), this.o.vaultScope, 'delete key');
  }
}

function manifestFromOutputs(outputs: Json | undefined): TenantManifest | undefined {
  const t = (outputs?.tenant as Json | undefined)?.value as Json | undefined;
  const ids = (outputs?.keyIds as Json | undefined)?.value;
  const names = (outputs?.keyNames as Json | undefined)?.value;
  if (!t || !Array.isArray(ids) || !Array.isArray(names)) return undefined;
  const s = (k: string): string => String(t[k] ?? '');
  return {
    tenantSlug: s('tenantSlug'),
    stampName: s('stampName'),
    pixelAccountId: s('pixelAccountId'),
    pixelAccountName: s('pixelAccountName'),
    auditAccountId: s('auditAccountId'),
    auditAccountName: s('auditAccountName'),
    databaseId: s('databaseId'),
    databaseName: s('databaseName'),
    eventHubId: s('eventHubId'),
    eventHubName: s('eventHubName'),
    identityId: s('identityId'),
    identityPrincipalId: s('identityPrincipalId'),
    capacityAlertId: s('capacityAlertId'),
    maxStorageGiB: Number(t.maxStorageGiB ?? 0),
    keyIds: ids.map(String),
    keyNames: names.map(String),
  };
}
