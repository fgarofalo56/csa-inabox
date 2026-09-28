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
  /** True only for `type: Request` — the one trigger type with a callback URL. */
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
 * ANCHORED, whole-id match. The id arrives from the browser and becomes an ARM
 * path the Console UAMI's token is sent to, so a loose "contains
 * /Microsoft.Logic/workflows/" test would let `…/vaults/v/secrets/s?x=/providers/Microsoft.Logic/workflows/a`
 * or a `..` segment steer that token at some other resource. Segments exclude
 * `/ ? # %` and may not be dot-only.
 */
const SEG = '(?!\\.{1,2}(?:/|$))[^/?#%]+';
const WORKFLOW_ID_RE = new RegExp(`^/subscriptions/${SEG}/resourceGroups/${SEG}/providers/Microsoft\\.Logic/workflows/(${SEG})$`, 'i');

export function assertLogicAppId(workflowResourceId: string): string {
  const m = WORKFLOW_ID_RE.exec(armIdPath(workflowResourceId));
  if (!m) throw new MonitorError('A Logic App (Microsoft.Logic/workflows) resource id is required', 400);
  return m[1];
}

/** The ARM path for a validated id: trimmed, trailing slashes removed. */
export function armIdPath(id: string): string {
  return (id || '').trim().replace(/\/+$/, '');
}

/** The triggers a workflow definition declares. Pure. */
export function triggersOfDefinition(definition: unknown): LogicAppTriggerInfo[] {
  const t = (definition as { triggers?: unknown } | null | undefined)?.triggers;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return [];
  return Object.entries(t as Record<string, any>).map(([name, v]) => {
    const type = typeof v?.type === 'string' ? v.type : '';
    const kind = typeof v?.kind === 'string' ? v.kind : undefined;
    return { name, type, kind, callbackCapable: type.toLowerCase() === 'request' };
  });
}

/** "Recurrence (Recurrence), foo (ApiConnection)" — or "none". */
export function describeTriggers(triggers: LogicAppTriggerInfo[]): string {
  if (!triggers.length) return 'none';
  return triggers.map((t) => `'${t.name}' (${t.type || 'unknown type'})`).join(', ');
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
      `Logic App '${workflowName}' has no HTTP-request trigger named '${wanted}'. `
      + `Triggers found: ${describeTriggers(triggers)}. `
      + (requests.length
        ? `Pick one of its HTTP-request triggers: ${requests.map((t) => `'${t.name}'`).join(', ')}.`
        : 'An HTTP-request trigger ("When a HTTP request is received") is required for Azure Monitor to invoke it.'),
      422,
    );
  }
  if (!requests.length) {
    throw new MonitorError(
      `Logic App '${workflowName}' cannot be notified by Azure Monitor: it has no HTTP-request trigger. `
      + `Triggers found: ${describeTriggers(triggers)}. `
      + 'Add a "When a HTTP request is received" trigger to the workflow, or pick a different Logic App.',
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

/** GET the workflow and resolve its request trigger (see the module header). */
export async function resolveLogicAppTrigger(
  workflowResourceId: string,
  preferred?: string,
): Promise<ResolvedLogicAppTrigger> {
  const workflowName = assertLogicAppId(workflowResourceId);
  const wf = await armGet(`${armIdPath(workflowResourceId)}?api-version=${LOGIC_API}`);
  const triggers = triggersOfDefinition(wf?.properties?.definition);
  const { triggerName, chosenBy } = chooseRequestTrigger(wf?.name || workflowName, triggers, preferred);
  return { workflowName: wf?.name || workflowName, triggerName, chosenBy, triggers };
}

/**
 * Resolve the request trigger, then ARM `listCallbackUrl` on it:
 *   POST …/workflows/{wf}/triggers/{trigger}/listCallbackUrl?api-version=2016-06-01
 * `callbackUrl` IS A SECRET (it carries the SAS `sig`) — hand it to ARM, never
 * persist or echo it. The rest of the result is safe to show.
 */
export async function resolveLogicAppCallback(
  workflowResourceId: string,
  preferred?: string,
): Promise<ResolvedLogicAppTrigger & { callbackUrl: string }> {
  const resolved = await resolveLogicAppTrigger(workflowResourceId, preferred);
  const path =
    `${armIdPath(workflowResourceId)}/triggers/${encodeURIComponent(resolved.triggerName)}/listCallbackUrl?api-version=${LOGIC_API}`;
  const { json } = await armPost(path, {});
  const callbackUrl = json?.value || json?.basePath;
  if (!callbackUrl) throw new MonitorError('Logic App trigger callback URL not returned by ARM', 502, json);
  return { ...resolved, callbackUrl };
}
