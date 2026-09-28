/**
 * Azure Function notification receiver — resolve a function's invocable HTTPS
 * trigger URL (and its key) SERVER-SIDE from the Function App resource id —
 * #4740.
 *
 * The health-check editor used to take a hand-typed trigger URL whose hint told
 * the operator to "include the function key" — a credential in a plain field,
 * persisted on the item and rendered back into the DOM on every open. The
 * Logic App receiver beside it already stored only a resource id and resolved
 * the secret-bearing URL at save (`getLogicAppCallbackUrl`); this is the same
 * treatment for Functions. The key is read from ARM at save time, handed to the
 * action group, and never stored on the item or returned to the browser.
 *
 * ARM calls (Microsoft.Web, grounded in the App Service REST reference —
 * "Web Apps - List Functions", "Get Function", "List Function Keys",
 * "List Host Keys"):
 *
 *   GET  {siteId}/functions?api-version=…              → FunctionEnvelope[]
 *   GET  {siteId}/functions/{fn}?api-version=…         → properties.invoke_url_template,
 *                                                        properties.config.bindings[],
 *                                                        properties.isDisabled
 *   POST {siteId}/functions/{fn}/listkeys?api-version=… → StringDictionary (function keys)
 *   POST {siteId}/host/default/listkeys?api-version=…  → HostKeys.functionKeys (fallback)
 *
 * RBAC: the two `listkeys` actions are `Microsoft.Web/sites/functions/listkeys/action`
 * and `Microsoft.Web/sites/host/listkeys/action` — held by Website Contributor
 * or Contributor on the Function App, NOT by Reader. A 401/403 is surfaced as a
 * gate naming that role, never degraded into "no key".
 *
 * The MASTER key is never used: an `admin`-level function is refused, because
 * placing the host master key into an action group would hand every reader of
 * that group full control of the Function App.
 *
 * Delivery stays a `webhookReceivers` entry (what the health-check route has
 * always emitted for Functions), so the managed/unmanaged receiver-kind split in
 * `action-group-body.ts` is unchanged by this fix.
 */
import { armGet, armPagedList, armPost, MonitorError } from './monitor-arm';
import { armIdPath } from './logic-app-trigger';

export const WEB_API = '2024-04-01';

// Anchored whole-id match with a STRICT allowlist — the id comes from the
// browser and becomes an ARM path a management-plane token is sent to (shared
// reasoning and the canonical-path gate live in `logic-app-trigger.ts`).
// GHSA-66f6-7xvq-8qxw.
const SEG = '[A-Za-z0-9._()-]+';
const SITE_ID_RE = new RegExp(`^/subscriptions/(${SEG})/resourceGroups/(${SEG})/providers/Microsoft\\.Web/sites/(${SEG})$`, 'i');
/** A function name is a single ARM child segment: the same strict allowlist. */
const FUNCTION_NAME_RE = /^[A-Za-z0-9._()-]+$/;

export function assertFunctionAppId(siteId: string): string {
  const m = SITE_ID_RE.exec(armIdPath(siteId));
  if (!m) throw new MonitorError('A Function App (Microsoft.Web/sites) resource id is required', 400);
  return m[3];
}

export interface FunctionTriggerInfo {
  /** Function name inside the app (the envelope's `app/fn` name, last segment). */
  name: string;
  /** True when a binding is an `httpTrigger` — the only kind Azure Monitor can POST to. */
  httpTrigger: boolean;
  /** `function` (default when unset), `anonymous`, or `admin`, lower-cased. */
  authLevel: string;
  isDisabled: boolean;
  /** Whether this function can back a notification receiver, and if not, why. */
  usable: boolean;
  reason?: string;
}

function lastSegment(name: unknown): string {
  const s = typeof name === 'string' ? name : '';
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Describe one FunctionEnvelope. Pure. */
export function describeFunctionEnvelope(env: any): FunctionTriggerInfo & { invokeUrlTemplate: string } {
  const p = env?.properties || {};
  const bindings: any[] = Array.isArray(p?.config?.bindings) ? p.config.bindings : [];
  const http = bindings.find((b) => String(b?.type || '').toLowerCase() === 'httptrigger');
  const authLevel = String(http?.authLevel || 'function').toLowerCase();
  const isDisabled = p?.isDisabled === true;
  const invokeUrlTemplate = typeof p?.invoke_url_template === 'string' ? p.invoke_url_template : '';
  let reason: string | undefined;
  if (!http) reason = 'not HTTP-triggered';
  else if (isDisabled) reason = 'disabled';
  else if (authLevel === 'admin') reason = 'admin-level auth (would require the host master key)';
  else if (!/^https:\/\//i.test(invokeUrlTemplate)) reason = 'no HTTPS invoke URL reported by ARM';
  else if (invokeUrlTemplate.includes('{')) reason = 'its route has parameters, so there is no single URL to POST to';
  return {
    name: lastSegment(env?.name),
    httpTrigger: !!http,
    authLevel,
    isDisabled,
    usable: !reason,
    ...(reason ? { reason } : {}),
    invokeUrlTemplate,
  };
}

/** List a Function App's functions with receiver-suitability. No secrets.
 *  `authToken` (the caller's ARM bearer) runs the read under the caller's RBAC. */
export async function listFunctionTriggers(siteId: string, authToken?: string): Promise<FunctionTriggerInfo[]> {
  assertFunctionAppId(siteId);
  // FunctionEnvelopeCollection carries a `nextLink`; walk it under the shared budget.
  const envs = await armPagedList<any>('listFunctions', `${armIdPath(siteId)}/functions?api-version=${WEB_API}`, 10, authToken);
  return envs.map((env: any) => {
    // `invokeUrlTemplate` is not secret, but the picker has no use for it.
    const { invokeUrlTemplate: _omit, ...info } = describeFunctionEnvelope(env);
    return info;
  });
}

/** First non-empty string value of a key dictionary, preferring `default`. */
function pickKey(dict: unknown): string {
  if (!dict || typeof dict !== 'object') return '';
  const d = dict as Record<string, unknown>;
  if (typeof d.default === 'string' && d.default) return d.default;
  for (const v of Object.values(d)) if (typeof v === 'string' && v) return v;
  return '';
}

/**
 * The function's invocable URL, key included when its auth level needs one.
 * THE RETURN VALUE IS A SECRET — hand it to ARM, never persist or echo it.
 * `authToken` (the caller's ARM bearer) runs every ARM call — including the
 * privileged `listkeys` — under the caller's own RBAC.
 */
export async function resolveFunctionTriggerUrl(siteId: string, functionName: string, authToken?: string): Promise<string> {
  const appName = assertFunctionAppId(siteId);
  const fn = (functionName || '').trim();
  if (!fn) throw new MonitorError(`Pick the function inside Function App '${appName}' that receives the alert.`, 400);
  if (!FUNCTION_NAME_RE.test(fn)) throw new MonitorError(`'${fn}' is not a valid function name.`, 400);
  const base = armIdPath(siteId);
  const env = await armGet(`${base}/functions/${encodeURIComponent(fn)}?api-version=${WEB_API}`, undefined, authToken);
  const info = describeFunctionEnvelope(env);
  if (!info.usable) {
    throw new MonitorError(
      `Function '${fn}' in Function App '${appName}' cannot receive Azure Monitor notifications: ${info.reason}. `
      + 'Pick an enabled HTTP-triggered function with function- or anonymous-level auth.',
      422,
    );
  }
  if (info.authLevel === 'anonymous') return info.invokeUrlTemplate;

  const fnKeys = await armPost(`${base}/functions/${encodeURIComponent(fn)}/listkeys?api-version=${WEB_API}`, {}, undefined, authToken);
  // StringDictionary puts the keys under `properties`; accept a flat body too.
  let key = pickKey(fnKeys.json?.properties ?? fnKeys.json);
  if (!key) {
    const host = await armPost(`${base}/host/default/listkeys?api-version=${WEB_API}`, {}, undefined, authToken);
    key = pickKey(host.json?.functionKeys);
  }
  if (!key) {
    throw new MonitorError(
      `Function App '${appName}' returned no function key for '${fn}' (checked the function's keys and the host function keys). `
      + 'Create a function key on the function, then save again.',
      422,
    );
  }
  const sep = info.invokeUrlTemplate.includes('?') ? '&' : '?';
  return `${info.invokeUrlTemplate}${sep}code=${encodeURIComponent(key)}`;
}
