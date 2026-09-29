/**
 * Logic App (Consumption) HTTP-request trigger resolution — #4748.
 *
 * ARM's `listCallbackUrl` is addressed BY TRIGGER NAME
 * (`…/workflows/{wf}/triggers/{trigger}/listCallbackUrl`), and the name is
 * whatever the workflow author called it. `manual` is only the name the
 * Consumption designer gives a fresh "When a HTTP request is received"
 * trigger; a renamed trigger, a second request trigger, or a workflow whose
 * only trigger is a Recurrence all exist on real estates. Assuming `manual`
 * produced the live G1 failure recorded on #4748 ("The workflow
 * 'WeathForeCast' trigger 'manual' could not be found.") — a choice the picker
 * offered and the product could not honour.
 *
 * So the trigger is READ from the workflow definition, not assumed:
 *
 *   GET …/providers/Microsoft.Logic/workflows/{wf}?api-version=2016-06-01
 *       → properties.definition.triggers: { <name>: { type, kind, … } }
 *
 * The definition is used rather than `GET …/workflows/{wf}/triggers`, because
 * the trigger-list response (WorkflowTrigger) carries no trigger TYPE — only
 * state/provisioning — so it cannot tell a Request trigger from a Recurrence.
 * Only a `type: "Request"` trigger has an invocable callback URL, which is what
 * an action group's `logicAppReceivers[].callbackUrl` must hold.
 *
 * This module depends on the ARM transport only (never on `monitor-client`),
 * so `monitor-client` can import it without a cycle.
 */
import { armGet, armPost, MonitorError } from './monitor-arm';

export const LOGIC_API = '2016-06-01';

export interface LogicAppTriggerInfo {
  name: string;
  /** Workflow Definition Language trigger type, verbatim (`Request`, `Recurrence`, `ApiConnection`, …). */
  type: string;
  kind?: string;
  /** A Request trigger's `inputs.method`, upper-cased, when the definition restricts it. */
  method?: string;
  /** True only for a `Request` trigger that accepts POST — the one Azure Monitor can invoke. */
  callbackCapable: boolean;
}

/**
 * How the request trigger was chosen — reported to the user so a choice made on
 * their behalf is never silent.
 *   explicit        the caller named it and it is a request trigger
 *   only            the workflow has exactly one request trigger
 *   designer-default several request triggers; the one named `manual` (the designer's default) wins
 *   first-by-name   several request triggers, none named `manual`; the first in ordinal name order wins
 */
export type TriggerChoice = 'explicit' | 'only' | 'designer-default' | 'first-by-name';

export interface ResolvedLogicAppTrigger {
  workflowName: string;
  triggerName: string;
  chosenBy: TriggerChoice;
  /** Every trigger the definition declares, request or not. */
  triggers: LogicAppTriggerInfo[];
}

/**
 * Validate the resource id strictly: an anchored, whole-id match where each
 * segment admits only the characters an ARM resource name can carry (a strict
 * allowlist). `armIdPath` adds a second check that accepts a path only when it
 * is already in canonical form.
 */
const SEG = "[A-Za-z0-9._()-]+";
const WORKFLOW_ID_RE = new RegExp(`^/subscriptions/(${SEG})/resourceGroups/(${SEG})/providers/Microsoft\\.Logic/workflows/(${SEG})$`, 'i');

export function assertLogicAppId(workflowResourceId: string): string {
  const m = WORKFLOW_ID_RE.exec(armIdPath(workflowResourceId));
  if (!m) throw new MonitorError('A Logic App (Microsoft.Logic/workflows) resource id is required', 400);
  return m[3];
}

/**
 * The ARM path for a validated id: trimmed, trailing slashes removed, and
 * accepted only when the value is already the canonical path — i.e. it parses to
 * exactly itself, with no query and no fragment.
 */
export function armIdPath(id: string): string {
  const trimmed = (id || '').trim().replace(/\/+$/, '');
  if (!trimmed.startsWith('/')) throw new MonitorError('A valid Azure resource id is required', 400);
  let u: URL;
  try { u = new URL(`https://arm.invalid${trimmed}`); } catch { throw new MonitorError('A valid Azure resource id is required', 400); }
  if (u.pathname !== trimmed || u.search || u.hash) {
    throw new MonitorError('A valid Azure resource id is required', 400);
  }
  return trimmed;
}

/**
 * The triggers a workflow definition declares. Pure.
 *
 * A trigger is callback-capable only when it is a `Request` trigger whose HTTP
 * method is unset or POST: Azure Monitor invokes the receiver with a POST, so a
 * Request trigger restricted to another method (e.g. GET) would bind and then
 * reject the alert.
 */
export function triggersOfDefinition(definition: unknown): LogicAppTriggerInfo[] {
  const t = (definition as { triggers?: unknown } | null | undefined)?.triggers;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return [];
  return Object.entries(t as Record<string, any>).map(([name, v]) => {
    const type = typeof v?.type === 'string' ? v.type : '';
    const kind = typeof v?.kind === 'string' ? v.kind : undefined;
    const method = typeof v?.inputs?.method === 'string' ? v.inputs.method.toUpperCase() : '';
    const callbackCapable = type.toLowerCase() === 'request' && (method === '' || method === 'POST');
    return { name, type, kind, ...(method ? { method } : {}), callbackCapable };
  });
}

/**
 * "'Recurrence' (Recurrence), 'hook' (Request, GET only)" — or "none". A
 * Request trigger's method is printed when it is set and is not POST, so a
 * message never names a Request trigger while calling it absent.
 */
export function describeTriggers(triggers: LogicAppTriggerInfo[]): string {
  if (!triggers.length) return 'none';
  return triggers.map((t) => {
    const methodNote = t.method && t.method !== 'POST' ? `, ${t.method} only` : '';
    return `'${t.name}' (${t.type || 'unknown type'}${methodNote})`;
  }).join(', ');
}

/** True when the definition has a Request trigger, but none of them accepts POST. */
function onlyNonPostRequests(triggers: LogicAppTriggerInfo[]): boolean {
  const reqs = triggers.filter((t) => t.type.toLowerCase() === 'request');
  return reqs.length > 0 && reqs.every((t) => !t.callbackCapable);
}

/**
 * Pick the request trigger. Pure — the ARM read is in
 * {@link resolveLogicAppTrigger}. Throws a 422 naming the workflow and the
 * triggers actually found when the choice cannot be honoured.
 */
export function chooseRequestTrigger(
  workflowName: string,
  triggers: LogicAppTriggerInfo[],
  preferred?: string,
): { triggerName: string; chosenBy: TriggerChoice } {
  const requests = triggers.filter((t) => t.callbackCapable);
  const wanted = (preferred || '').trim();
  if (wanted) {
    const hit = requests.find((t) => t.name === wanted);
    if (hit) return { triggerName: hit.name, chosenBy: 'explicit' };
    throw new MonitorError(
      `Logic App '${workflowName}' has no HTTP-request trigger named '${wanted}' that accepts POST. `
      + `Triggers found: ${describeTriggers(triggers)}. `
      + (requests.length
        ? `Pick one of its HTTP-request triggers: ${requests.map((t) => `'${t.name}'`).join(', ')}.`
        : 'An HTTP-request trigger ("When a HTTP request is received") that accepts POST is required for Azure Monitor to invoke it.'),
      422,
    );
  }
  if (!requests.length) {
    const reason = onlyNonPostRequests(triggers)
      ? 'no Request trigger accepts POST (Azure Monitor invokes receivers with POST)'
      : 'it has no HTTP-request trigger';
    throw new MonitorError(
      `Logic App '${workflowName}' cannot be notified by Azure Monitor: ${reason}. `
      + `Triggers found: ${describeTriggers(triggers)}. `
      + 'Add (or change to POST) a "When a HTTP request is received" trigger, or pick a different Logic App.',
      422,
    );
  }
  if (requests.length === 1) return { triggerName: requests[0].name, chosenBy: 'only' };
  const manual = requests.find((t) => t.name === 'manual');
  if (manual) return { triggerName: manual.name, chosenBy: 'designer-default' };
  // Ordinal (not locale) order, so the choice is identical on every host.
  const first = [...requests].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  return { triggerName: first.name, chosenBy: 'first-by-name' };
}

/**
 * GET the workflow and resolve its request trigger (see the module header).
 * `authToken` (optional) runs the read under the caller's own ARM RBAC.
 */
export async function resolveLogicAppTrigger(
  workflowResourceId: string,
  preferred?: string,
  authToken?: string,
): Promise<ResolvedLogicAppTrigger> {
  const workflowName = assertLogicAppId(workflowResourceId);
  const wf = await armGet(`${armIdPath(workflowResourceId)}?api-version=${LOGIC_API}`, undefined, authToken);
  const triggers = triggersOfDefinition(wf?.properties?.definition);
  const { triggerName, chosenBy } = chooseRequestTrigger(wf?.name || workflowName, triggers, preferred);
  return { workflowName: wf?.name || workflowName, triggerName, chosenBy, triggers };
}

/**
 * Resolve the request trigger, then ARM `listCallbackUrl` on it:
 *   POST …/workflows/{wf}/triggers/{trigger}/listCallbackUrl?api-version=2016-06-01
 * `callbackUrl` IS A SECRET (it carries the SAS `sig`) — hand it to ARM, never
 * persist or echo it. The rest of the result is safe to show. `authToken`
 * (required in practice) runs the privileged call under the caller's RBAC.
 */
export async function resolveLogicAppCallback(
  workflowResourceId: string,
  preferred?: string,
  authToken?: string,
): Promise<ResolvedLogicAppTrigger & { callbackUrl: string }> {
  const resolved = await resolveLogicAppTrigger(workflowResourceId, preferred, authToken);
  const path =
    `${armIdPath(workflowResourceId)}/triggers/${encodeURIComponent(resolved.triggerName)}/listCallbackUrl?api-version=${LOGIC_API}`;
  const { json } = await armPost(path, {}, undefined, authToken);
  const callbackUrl = json?.value || json?.basePath;
  if (!callbackUrl) throw new MonitorError('Logic App trigger callback URL not returned by ARM', 502, json);
  return { ...resolved, callbackUrl };
}
