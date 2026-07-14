/**
 * Pure model + helpers for the Azure Monitor rule ACTION builder (G3).
 *
 * An Azure Monitor scheduled-query alert rule fires an ACTION GROUP when its
 * condition is met. This module models the "THEN — action" half of a
 * rule/condition/action surface as structured, typed state (no freeform JSON —
 * loom_no_freeform_config) and maps it to the exact request body the
 * activator-monitor backend reads (email / Teams-webhook / webhook / SMS /
 * Logic App receivers). It is deliberately React-free so it can be unit-tested
 * without rendering.
 *
 * The config shapes below match what `lib/azure/activator-monitor.ts` reads:
 *   - Email        → config.to           (ruleEmails)
 *   - TeamsMessage → config.webhookUrl   (ruleWebhooks)
 *   - Webhook      → config.url          (ruleWebhooks)
 *   - SMS          → config.countryCode + config.phoneNumber (ruleSmsReceivers)
 *   - LogicApp     → config.logicAppResourceId + config.callbackUrl (ruleLogicAppReceivers)
 */

/** The Azure Monitor action-group receiver kinds a rule can fire. */
export type MonitorActionKind = 'Email' | 'TeamsMessage' | 'Webhook' | 'SMS' | 'LogicApp';

export const MONITOR_ACTION_KINDS: { value: MonitorActionKind; label: string }[] = [
  { value: 'Email', label: 'Send email' },
  { value: 'TeamsMessage', label: 'Post to Teams' },
  { value: 'Webhook', label: 'Call a webhook' },
  { value: 'SMS', label: 'Send SMS' },
  { value: 'LogicApp', label: 'Trigger a Logic App' },
];

/** Typed action state — one flat record the builder edits via dropdowns/inputs. */
export interface MonitorActionState {
  /** Attach a pre-existing action group instead of composing a new one. */
  useExisting: boolean;
  existingActionGroupId: string;
  kind: MonitorActionKind;
  /** Email address / Teams webhook URL / webhook URL (per kind). */
  target: string;
  /** Email subject / Teams message text. */
  message: string;
  /** SMS country code (digits). */
  countryCode: string;
  /** SMS phone number. */
  phone: string;
  /** Logic App (Microsoft.Logic/workflows) ARM resource id. */
  logicAppResourceId: string;
  /** Logic App trigger name whose callback URL is invoked (default 'manual'). */
  logicAppTrigger: string;
  /** Resolved listCallbackUrl SAS URL (fetched from ARM or pasted). */
  logicAppCallbackUrl: string;
}

export const DEFAULT_MONITOR_ACTION: MonitorActionState = {
  useExisting: false,
  existingActionGroupId: '',
  kind: 'Email',
  target: '',
  message: 'Loom alert',
  countryCode: '1',
  phone: '',
  logicAppResourceId: '',
  logicAppTrigger: 'manual',
  logicAppCallbackUrl: '',
};

/** A structured action ({ kind, config }) the rule route understands. */
export interface MonitorActionPayload {
  kind: MonitorActionKind;
  config: Record<string, string>;
}

/** What the rule POST body carries for its action half. */
export interface MonitorActionBody {
  action?: MonitorActionPayload;
  existingActionGroupId?: string;
}

/** Build the per-kind action config, dropping empty values. */
function actionConfig(s: MonitorActionState): Record<string, string> {
  switch (s.kind) {
    case 'Email':
      return prune({ to: s.target.trim(), subject: s.message.trim() });
    case 'TeamsMessage':
      return prune({ webhookUrl: s.target.trim(), message: s.message.trim() });
    case 'Webhook':
      return prune({ url: s.target.trim() });
    case 'SMS':
      return prune({ countryCode: (s.countryCode.trim() || '1').replace(/[^0-9]/g, ''), phoneNumber: s.phone.replace(/[^0-9]/g, '') });
    case 'LogicApp':
      return prune({ logicAppResourceId: s.logicAppResourceId.trim(), callbackUrl: s.logicAppCallbackUrl.trim() });
    default:
      return {};
  }
}

function prune(o: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v) out[k] = v;
  return out;
}

/**
 * True when the current action state will actually attach a receiver / action
 * group to the rule (so callers can require an action, or warn on an empty one).
 */
export function monitorActionIsConfigured(s: MonitorActionState): boolean {
  if (s.useExisting) return !!s.existingActionGroupId.trim();
  switch (s.kind) {
    case 'Email':
      return s.target.includes('@');
    case 'TeamsMessage':
    case 'Webhook':
      return /^https?:\/\//i.test(s.target.trim());
    case 'SMS':
      return s.phone.replace(/[^0-9]/g, '').length > 0;
    case 'LogicApp':
      return !!s.logicAppResourceId.trim() && !!s.logicAppCallbackUrl.trim();
    default:
      return false;
  }
}

/**
 * Map the action state to the rule POST body's action half. Returns the
 * pick-existing action-group id, or a composed { action } — or {} when nothing
 * is configured (the rule is created with no action group; the backend allows
 * this and the caller surfaces an honest "no action" note).
 */
export function monitorActionToBody(s: MonitorActionState): MonitorActionBody {
  if (s.useExisting) {
    const id = s.existingActionGroupId.trim();
    return id ? { existingActionGroupId: id } : {};
  }
  // Only emit an action once it will actually attach a receiver — an
  // incomplete/empty action degrades to {} so the rule is created with no
  // action group (the backend requires a real receiver per kind anyway).
  if (!monitorActionIsConfigured(s)) return {};
  return { action: { kind: s.kind, config: actionConfig(s) } };
}

/** A short human summary of the configured action (for the rule preview line). */
export function monitorActionSummary(s: MonitorActionState): string {
  if (s.useExisting) return s.existingActionGroupId ? 'existing action group' : 'no action';
  if (!monitorActionIsConfigured(s)) return 'no action';
  switch (s.kind) {
    case 'Email': return `email → ${s.target.trim()}`;
    case 'TeamsMessage': return 'post to Teams';
    case 'Webhook': return 'call webhook';
    case 'SMS': return `SMS → +${s.countryCode.replace(/[^0-9]/g, '') || '1'} ${s.phone.replace(/[^0-9]/g, '')}`;
    case 'LogicApp': return 'trigger Logic App';
    default: return 'action';
  }
}
