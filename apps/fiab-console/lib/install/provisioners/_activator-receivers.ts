/**
 * Activator notification receivers — can an installed alert reach a human?
 *
 * #4097. The live Commercial estate carried a scheduled query rule
 * `High-Roller-Alert-High-Roller-Net-` (enabled) pointing at an action group
 * `High-Roller-Alert-ag` (enabled) with ZERO receivers of every kind. The rule
 * evaluated, fired, routed, and notified nobody, while the install reported
 * `rulesCreated: 1, rulesPersisted: true` — every one of which was true.
 *
 * The cause is a MISSING BIND, not a bad status. `createMonitorActivatorRule`
 * derives its action-group receivers from a fixed set of fields on the rule's
 * `action` (see the mirrored lists below). Every shipped bundle activator
 * expresses its destination in a shape those fields do not carry:
 *
 *   | bundle action                                   | derives |
 *   |-------------------------------------------------|---------|
 *   | `teams` + `{channel, title, body}`              | nothing |
 *   | `teams` + `{webhookSecretName: 'TEAMS_…'}`      | nothing (a KV secret NAME, not a URL) |
 *   | `teams` + `{recipients: [...]}` INSIDE config   | nothing (`ruleEmails` reads action.recipients, not config.recipients) |
 *   | `webhook` + `{url: 'https://${sentinelWs}.…'}`  | a receiver pointed at a LITERAL `${sentinelWs}` host |
 *
 * The last row is the worse failure: a receiver that COUNTS as one and can
 * never deliver. Counting receivers alone is therefore not a control — the
 * value has to be deliverable.
 *
 * Per `.claude/rules/auto-bind-by-default.md` a remediation the platform could
 * have performed is a defect, not a helpful gap. So this module does the bind:
 *
 *   1. SCRUB every destination the derivation reads of values that can never
 *      deliver — unexpanded `${…}` / `{{…}}` / `%VAR%` templates and the
 *      RFC 2606 / RFC 6761 domains reserved for documentation (`example.com`,
 *      `.invalid`, `.test`, `.localhost`).
 *   2. LIFT destinations the bundle DID supply into the field the derivation
 *      actually reads (`config.recipients` → `action.recipients`).
 *   3. FALL BACK to an address the platform always has — the installing user's
 *      own — so a freshly installed activator has a live receiver with zero
 *      user steps.
 *
 * The field lists below MIRROR private helpers in `lib/azure/activator-monitor.ts`.
 * A mirror can drift, so it is not trusted: the provisioner VERIFIES reachability
 * from the record `createMonitorActivatorRule` returned ({@link receiverTotal}),
 * and `__tests__/activator-receiver-reachability.test.ts` runs the REAL
 * derivation over every shipped bundle action. A drift fails a test instead of
 * silently shipping an alert that notifies nobody.
 */
import type { MonitorRuleRecord } from '@/lib/azure/activator-monitor';

// ── deliverability ──────────────────────────────────────────────────────────

/**
 * Domains that are reserved and can NEVER receive mail or an HTTP callback:
 * RFC 2606 (`example.com|net|org`, `.test`, `.invalid`, `.localhost`) and
 * RFC 6761 (`.example`). Matching the reserved SHAPE, not a list of the
 * placeholder addresses our bundles happen to use today.
 */
const RESERVED_DOMAIN_RE = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost)$/i;

/**
 * An unsubstituted template marker. Bundle content carries `${sentinelWorkspace}`
 * and `${SENTINEL_DCR_IMMUTABLE_ID}` in destination URLs; those reach ARM as a
 * literal hostname and produce a receiver that can never deliver.
 */
const PLACEHOLDER_RE = /\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Za-z0-9_]+%/;

export function hasUnexpandedPlaceholder(v: string): boolean {
  return PLACEHOLDER_RE.test(v);
}

/** A syntactically valid address at a domain that can actually receive mail. */
export function isDeliverableEmail(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s)) return false;
  if (hasUnexpandedPlaceholder(s)) return false;
  return !RESERVED_DOMAIN_RE.test(s.slice(s.lastIndexOf('@') + 1).toLowerCase());
}

/** An http(s) URL with a real, fully substituted host ARM can POST to. */
export function isDeliverableWebhookUrl(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (hasUnexpandedPlaceholder(s)) return false;
  let host: string;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || !host.includes('.')) return false;
  return !RESERVED_DOMAIN_RE.test(host);
}

// ── the fields the Azure Monitor derivation actually reads ──────────────────
// Mirrors lib/azure/activator-monitor.ts: ruleEmails / ruleWebhooks /
// ruleSmsReceivers / ruleLogicAppReceivers (module-private there).

/** Top-level `action.*` fields `ruleEmails` unions. */
export const MONITOR_ACTION_EMAIL_FIELDS = ['target', 'actTarget', 'email', 'to', 'recipients'] as const;
/** `action.config.*` fields `ruleEmails` unions. */
export const MONITOR_CONFIG_EMAIL_FIELDS = ['to'] as const;
/** `action.config.*` fields `ruleWebhooks` reads. */
export const MONITOR_CONFIG_WEBHOOK_FIELDS = ['webhookUrl', 'url', 'triggerUrl', 'serviceUri'] as const;
/** `action.config.*` fields `ruleSmsReceivers` reads. */
export const MONITOR_CONFIG_SMS_FIELDS = ['phoneNumber', 'phone'] as const;

/**
 * `action.config.*` fields a BUNDLE author naturally uses for recipients that
 * the derivation does NOT read. Lifting them is a real bind of a real address
 * the bundle already supplied (app-data-governance ships
 * `config.recipients: [...]`, which reached ARM as nothing at all).
 */
const LIFTABLE_CONFIG_EMAIL_FIELDS = ['recipients', 'emails', 'email', 'recipient', 'notify', 'notifyEmails'] as const;

function splitAddresses(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(splitAddresses);
  if (typeof v === 'string') return v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// ── normalization ───────────────────────────────────────────────────────────

export interface NormalizedActivatorAction {
  /** The action to hand to createMonitorActivatorRule. */
  action: any;
  /** Destinations that will be wired, described for the step log. */
  bound: string[];
  /** Destinations the bundle asked for that could not be wired, verbatim. */
  unbound: string[];
  /** True when the ONLY receiver is the platform's fallback address. */
  usedFallback: boolean;
}

/**
 * Turn a bundle rule's `action` into one that actually yields an Azure Monitor
 * receiver — scrubbing undeliverable values, lifting bundle-supplied recipients
 * into the field the derivation reads, and falling back to an address the
 * platform always has.
 *
 * Pure: never mutates `rawAction`.
 */
export function normalizeActivatorAction(rawAction: any, fallbackEmails: string[]): NormalizedActivatorAction {
  const action: any = { ...(rawAction && typeof rawAction === 'object' ? rawAction : {}) };
  const rawConfig = action.config && typeof action.config === 'object' ? action.config : {};
  const config: any = { ...rawConfig };
  action.config = config;

  const bound: string[] = [];
  const unbound: string[] = [];

  // ── emails: union every field the derivation reads PLUS the liftable ones ──
  const emails = new Set<string>();
  const considerEmails = (values: unknown, where: string) => {
    for (const candidate of splitAddresses(values)) {
      if (isDeliverableEmail(candidate)) emails.add(candidate);
      else unbound.push(`${where}: '${candidate}' is not a deliverable address`);
    }
  };
  for (const f of MONITOR_ACTION_EMAIL_FIELDS) {
    if (action[f] !== undefined) {
      considerEmails(action[f], `action.${f}`);
      delete action[f]; // rebuilt canonically below — no rejected value survives
    }
  }
  for (const f of MONITOR_CONFIG_EMAIL_FIELDS) {
    if (config[f] !== undefined) {
      considerEmails(config[f], `action.config.${f}`);
      delete config[f];
    }
  }
  for (const f of LIFTABLE_CONFIG_EMAIL_FIELDS) {
    if (config[f] !== undefined) {
      considerEmails(config[f], `action.config.${f}`);
      delete config[f];
    }
  }

  // ── webhooks: drop any URI carrying an unsubstituted template ──
  let webhooks = 0;
  for (const f of MONITOR_CONFIG_WEBHOOK_FIELDS) {
    const v = config[f];
    if (v === undefined) continue;
    if (isDeliverableWebhookUrl(v)) {
      webhooks += 1;
      bound.push(`webhook ${String(v).trim()}`);
    } else if (typeof v === 'string' && v.trim()) {
      unbound.push(`action.config.${f}: '${v.trim()}' is not a URL Azure Monitor can POST to`);
      delete config[f];
    }
  }

  // ── SMS ──
  let sms = 0;
  for (const f of MONITOR_CONFIG_SMS_FIELDS) {
    const v = config[f];
    if (v === undefined) continue;
    const raw = String(v);
    if (!hasUnexpandedPlaceholder(raw) && raw.replace(/[^0-9]/g, '')) {
      sms += 1;
      bound.push(`SMS ${raw.replace(/[^0-9]/g, '')}`);
    } else {
      unbound.push(`action.config.${f}: '${raw}' is not a dialable number`);
      delete config[f];
    }
  }

  // ── Logic App: BOTH halves are required, and neither may be a template ──
  let logicApps = 0;
  const laId = config.logicAppResourceId;
  const laCb = config.callbackUrl;
  if (laId !== undefined || laCb !== undefined) {
    const idOk = typeof laId === 'string' && !!laId.trim() && !hasUnexpandedPlaceholder(laId);
    const cbOk = typeof laCb === 'string' && !!laCb.trim() && !hasUnexpandedPlaceholder(laCb);
    if (idOk && cbOk) {
      logicApps += 1;
      bound.push(`Logic App ${String(laId).trim()}`);
    } else {
      unbound.push(
        `action.config.logicAppResourceId/callbackUrl: incomplete or unsubstituted (${idOk ? 'callbackUrl' : 'logicAppResourceId'} missing)`,
      );
      delete config.logicAppResourceId;
      delete config.callbackUrl;
    }
  }

  // A `teams` action whose only destination is a channel NAME or a Key Vault
  // secret NAME names a binding the platform cannot mint: an incoming-webhook
  // URL is created by a channel owner in Teams. Say so verbatim.
  if (String(action.kind || '').toLowerCase() === 'teams' && webhooks === 0) {
    const named = [config.channel, config.channelId, config.webhookSecretName, config.teamsWebhookSecretRef]
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => String(v).trim());
    if (named.length) unbound.push(`Teams channel '${named[0]}' has no incoming-webhook URL bound`);
  }

  let usedFallback = false;
  if (emails.size === 0 && webhooks === 0 && sms === 0 && logicApps === 0) {
    for (const f of fallbackEmails) if (isDeliverableEmail(f)) emails.add(f.trim());
    usedFallback = emails.size > 0;
  }

  if (emails.size > 0) {
    // `recipients` is the canonical field `ruleEmails` unions — one field, one
    // meaning, rebuilt from only the values that survived scrubbing.
    action.recipients = Array.from(emails);
    for (const e of emails) bound.push(`email ${e}`);
  }

  return { action, bound, unbound, usedFallback };
}

/**
 * The address the platform falls back to when a rule's action names no
 * deliverable destination: the INSTALLING USER's own (`email`, else `upn`).
 *
 * Deliberately NOT an env var. `auto-bind-by-default.md` §5 is explicit that
 * "set `LOOM_X`" as the terminal user-facing state is a violation — the value
 * must be one the platform already has, and for an interactive install the
 * signed-in operator's address always is. (A deployment-wide ops-address
 * override would need a bicep emission + an entry in
 * `scripts/ci/check-env-sync.mjs`; it is a separate change, not a prerequisite
 * for an installed alert reaching a human.)
 */
export function resolveFallbackAlertEmails(session: unknown): string[] {
  const claims = (session as any)?.claims || {};
  for (const v of [claims.email, claims.upn, claims.preferred_username]) {
    if (isDeliverableEmail(v)) return [String(v).trim()];
  }
  return [];
}

// ── verification (the control) ──────────────────────────────────────────────

/**
 * How many receivers the action group on a CREATED rule actually carries, read
 * off the record `createMonitorActivatorRule` returned — the same record the
 * provisioner persists, so this cannot drift from what shipped.
 *
 * Returns `null`, never a number, when the answer is UNKNOWN (an action group
 * is attached but its receiver counts were not reported). Per
 * `deploy-integrity.md` R7 an unknown is not a zero and is not a pass — the
 * caller must say it could not confirm rather than assert either way.
 */
export function receiverTotal(rec: Pick<MonitorRuleRecord, 'actionGroupId' | 'actionGroupReceivers'>): number | null {
  const r = rec?.actionGroupReceivers;
  if (r) {
    return (r.emails || 0) + (r.sms || 0) + (r.webhooks || 0) + (r.logicApps || 0);
  }
  // No receiver summary. An attached action group whose contents we never saw is
  // UNKNOWN; no action group at all is demonstrably nobody.
  return rec?.actionGroupId ? null : 0;
}

/** A created rule that is not PROVEN to reach anyone — zero receivers, or an
 *  attached action group whose receivers could not be confirmed. */
export function isUnreachable(rec: Pick<MonitorRuleRecord, 'actionGroupId' | 'actionGroupReceivers'>): boolean {
  const n = receiverTotal(rec);
  return n === null || n < 1;
}

/** Why a rule is unreachable, in words that assert only what was established. */
export function unreachableReason(rec: Pick<MonitorRuleRecord, 'actionGroupId' | 'actionGroupReceivers'>): string {
  return receiverTotal(rec) === null
    ? 'an action group is attached but its receivers could not be confirmed'
    : 'its action group has no receivers of any kind';
}
