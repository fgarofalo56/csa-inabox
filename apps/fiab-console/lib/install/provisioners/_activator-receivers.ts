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
/** `action.config.*` fields `ruleLogicAppReceivers` reads. Both are required. */
export const MONITOR_CONFIG_LOGIC_APP_FIELDS = ['logicAppResourceId', 'callbackUrl'] as const;

/**
 * `action.config.*` fields a BUNDLE author naturally uses for recipients that
 * the derivation does NOT read. Lifting them is a real bind of a real address
 * the bundle already supplied (app-data-governance ships
 * `config.recipients: [...]`, which reached ARM as nothing at all).
 */
const LIFTABLE_CONFIG_EMAIL_FIELDS = ['recipients', 'emails', 'email', 'recipient', 'notify', 'notifyEmails'] as const;

/**
 * THE DESTINATION SURFACE — every field on a rule's `action` whose value, if
 * present, is a place an alert is supposed to arrive. This is the single table
 * the classifier below drives off, so a field can never be READ without being
 * ACCOUNTED FOR: {@link normalizeActivatorAction} emits exactly one
 * {@link DestinationOutcome} per present entry.
 *
 * Fields that merely NAME an intent (`config.channel`, `config.webhookSecretName`,
 * `config.title`) are deliberately absent: they yield no Azure Monitor receiver
 * by construction, so there is nothing to deliver to and nothing to account.
 * Bundles are generic and cannot know a tenant's Teams webhook or ops mailbox —
 * declaring the INTENT and letting the platform bind the installing operator is
 * correct. Putting a VALUE in one of the fields below and having it be
 * undeliverable is not: that is a destination the bundle asserted and the
 * platform cannot honour.
 */
export const DESTINATION_FIELDS: ReadonlyArray<{
  /** `action.<field>` or `action.config.<field>`. */
  at: 'action' | 'config';
  field: string;
  kind: 'email' | 'webhook' | 'sms' | 'logicApp';
  /** True for a config alias this module LIFTS; the ARM derivation does not read it. */
  lifted?: boolean;
}> = [
  ...MONITOR_ACTION_EMAIL_FIELDS.map((field) => ({ at: 'action' as const, field, kind: 'email' as const })),
  ...MONITOR_CONFIG_EMAIL_FIELDS.map((field) => ({ at: 'config' as const, field, kind: 'email' as const })),
  ...LIFTABLE_CONFIG_EMAIL_FIELDS.map((field) => ({ at: 'config' as const, field, kind: 'email' as const, lifted: true })),
  ...MONITOR_CONFIG_WEBHOOK_FIELDS.map((field) => ({ at: 'config' as const, field, kind: 'webhook' as const })),
  ...MONITOR_CONFIG_SMS_FIELDS.map((field) => ({ at: 'config' as const, field, kind: 'sms' as const })),
  ...MONITOR_CONFIG_LOGIC_APP_FIELDS.map((field) => ({ at: 'config' as const, field, kind: 'logicApp' as const })),
];

/** Dotted path of a destination field, as it reads in a step log / test failure. */
export function destinationPath(at: 'action' | 'config', field: string): string {
  return at === 'action' ? `action.${field}` : `action.config.${field}`;
}

/**
 * Every destination field a rule's action ACTUALLY carries — computed from the
 * raw action, independently of whether the binder managed to do anything with
 * it. The conservation control compares this against the binder's outcomes: a
 * field present here and missing from `destinations` was dropped in silence,
 * which is the failure mode this whole module exists to prevent.
 */
export function declaredDestinationFields(rawAction: any): string[] {
  const action = rawAction && typeof rawAction === 'object' ? rawAction : {};
  const config = action.config && typeof action.config === 'object' ? action.config : {};
  const out: string[] = [];
  for (const d of DESTINATION_FIELDS) {
    const bag = d.at === 'action' ? action : config;
    if (bag[d.field] !== undefined) out.push(destinationPath(d.at, d.field));
  }
  return Array.from(new Set(out));
}

function splitAddresses(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(splitAddresses);
  if (typeof v === 'string') return v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** A value rendered for a human, without ever throwing on an exotic shape. */
function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

// ── normalization ───────────────────────────────────────────────────────────

export interface DestinationOutcome {
  /** Dotted path, e.g. `action.config.url`. */
  path: string;
  kind: 'email' | 'webhook' | 'sms' | 'logicApp';
  /** `bound` — a receiver was produced. `rejected` — the value cannot deliver. */
  verdict: 'bound' | 'rejected';
  /** The value the bundle declared, verbatim (stringified), for the message. */
  value: string;
  /** Why, when rejected. */
  why?: string;
}

export interface NormalizedActivatorAction {
  /** The action to hand to createMonitorActivatorRule. */
  action: any;
  /** Destinations that will be wired, described for the step log. */
  bound: string[];
  /** Destinations the bundle asked for that could not be wired, verbatim. */
  unbound: string[];
  /**
   * One entry per DESTINATION FIELD the action actually carried — the
   * machine-readable form of `bound`/`unbound`. Exactly one outcome per present
   * field of {@link DESTINATION_FIELDS}, so a caller can ask "did anything the
   * bundle declared get dropped?" without parsing prose. `unbound` may ALSO
   * carry non-field notes (an unbindable Teams channel intent); those are not
   * destinations and deliberately produce no outcome here.
   */
  destinations: DestinationOutcome[];
  /** True when the ONLY receiver is the platform's fallback address. */
  usedFallback: boolean;
}

/** The destinations a bundle asserted that the platform cannot deliver to.
 *  A non-empty result is a CONTENT defect: the bundle named a place, and that
 *  place does not exist. Distinct from naming no place at all, which is fine. */
export function rejectedDestinations(norm: Pick<NormalizedActivatorAction, 'destinations'>): DestinationOutcome[] {
  return norm.destinations.filter((d) => d.verdict === 'rejected');
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
  const destinations: DestinationOutcome[] = [];
  const record = (
    at: 'action' | 'config',
    field: string,
    kind: DestinationOutcome['kind'],
    verdict: DestinationOutcome['verdict'],
    value: unknown,
    why?: string,
  ) => {
    destinations.push({ path: destinationPath(at, field), kind, verdict, value: stringifyValue(value), ...(why ? { why } : {}) });
  };

  // ── emails: union every field the derivation reads PLUS the liftable ones ──
  const emails = new Set<string>();
  const considerEmails = (at: 'action' | 'config', field: string, values: unknown) => {
    const where = destinationPath(at, field);
    const candidates = splitAddresses(values);
    if (!candidates.length) {
      // Present but carrying nothing addressable at all (an empty string, an
      // empty array, an object). Still a declared destination that yields no
      // receiver — account for it rather than dropping it in silence.
      record(at, field, 'email', 'rejected', values, 'carries no address at all');
      unbound.push(`${where}: carries no address at all`);
      return;
    }
    for (const candidate of candidates) {
      if (isDeliverableEmail(candidate)) {
        emails.add(candidate);
        record(at, field, 'email', 'bound', candidate);
      } else {
        record(at, field, 'email', 'rejected', candidate, 'is not a deliverable address');
        unbound.push(`${where}: '${candidate}' is not a deliverable address`);
      }
    }
  };
  for (const f of MONITOR_ACTION_EMAIL_FIELDS) {
    if (action[f] !== undefined) {
      considerEmails('action', f, action[f]);
      delete action[f]; // rebuilt canonically below — no rejected value survives
    }
  }
  for (const f of MONITOR_CONFIG_EMAIL_FIELDS) {
    if (config[f] !== undefined) {
      considerEmails('config', f, config[f]);
      delete config[f];
    }
  }
  for (const f of LIFTABLE_CONFIG_EMAIL_FIELDS) {
    if (config[f] !== undefined) {
      considerEmails('config', f, config[f]);
      delete config[f];
    }
  }

  // ── webhooks: drop any URI that is not one ARM can POST to ──
  let webhooks = 0;
  for (const f of MONITOR_CONFIG_WEBHOOK_FIELDS) {
    const v = config[f];
    if (v === undefined) continue;
    if (isDeliverableWebhookUrl(v)) {
      webhooks += 1;
      bound.push(`webhook ${String(v).trim()}`);
      record('config', f, 'webhook', 'bound', v);
    } else {
      // EVERY present-but-unusable value, whatever its type. A non-string here
      // used to fall through both branches and stay in `config` undisclosed —
      // no receiver, no message, no record that the bundle had asked for one.
      const why = 'is not a URL Azure Monitor can POST to';
      record('config', f, 'webhook', 'rejected', v, why);
      unbound.push(`${destinationPath('config', f)}: '${stringifyValue(v)}' ${why}`);
      delete config[f];
    }
  }

  // ── SMS ──
  let sms = 0;
  for (const f of MONITOR_CONFIG_SMS_FIELDS) {
    const v = config[f];
    if (v === undefined) continue;
    const raw = stringifyValue(v);
    const digits = raw.replace(/[^0-9]/g, '');
    // E.164 subscriber numbers are 4–15 digits. A placeholder that happens to
    // contain a digit ('ext-1') would otherwise be wired as a real SMS receiver
    // — the same "counts as one, can never deliver" failure as the ${…} URL.
    if (!hasUnexpandedPlaceholder(raw) && digits.length >= 4 && digits.length <= 15) {
      sms += 1;
      bound.push(`SMS ${digits}`);
      record('config', f, 'sms', 'bound', digits);
    } else {
      const why = 'is not a dialable number';
      record('config', f, 'sms', 'rejected', v, why);
      unbound.push(`${destinationPath('config', f)}: '${raw}' ${why}`);
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
    const verdict: DestinationOutcome['verdict'] = idOk && cbOk ? 'bound' : 'rejected';
    const why = verdict === 'rejected' ? `incomplete or unsubstituted (${idOk ? 'callbackUrl' : 'logicAppResourceId'} missing)` : undefined;
    if (verdict === 'bound') {
      logicApps += 1;
      bound.push(`Logic App ${String(laId).trim()}`);
    } else {
      unbound.push(`action.config.logicAppResourceId/callbackUrl: ${why}`);
      delete config.logicAppResourceId;
      delete config.callbackUrl;
    }
    // One outcome per PRESENT half, so the conservation check sees both.
    if (laId !== undefined) record('config', 'logicAppResourceId', 'logicApp', verdict, laId, why);
    if (laCb !== undefined) record('config', 'callbackUrl', 'logicApp', verdict, laCb, why);
  }

  // A destination the bundle NAMED as an intent rather than as a value — a
  // Teams channel, a Key Vault secret holding the real webhook URL. The
  // platform cannot mint those (an incoming-webhook URL is created by a channel
  // owner; a secret is supplied by the operator), so the fallback will bind
  // instead. Say WHOSE destination was not honoured, verbatim, rather than
  // silently substituting.
  //
  // Deliberately NOT keyed to `action.kind === 'teams'`: it was, and the two
  // Sentinel activators declare `kind: 'webhook'` with a secret reference, so
  // the intent they named would have been substituted in silence. The condition
  // that matters is "no destination bound AND the config names one", whatever
  // the action calls itself.
  if (webhooks === 0) {
    const named = [config.channel, config.channelId, config.webhookSecretName, config.teamsWebhookSecretRef]
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => String(v).trim());
    if (named.length) unbound.push(`'${named[0]}' names a notification destination the platform cannot mint (no webhook URL is bound to it)`);
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

  return { action, bound, unbound, destinations, usedFallback };
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
