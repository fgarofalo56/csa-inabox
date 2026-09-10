/**
 * Action-group PUT-body composition — the input shapes, the short-name
 * precedence rule, and the receiver merge.
 *
 * Split out of `monitor-client.ts` for the same reason `action-group-receivers`
 * was: this module is DEPENDENCY-FREE (no ARM transport, no credential, no env
 * read), so the two are not circular and `monitor-client` re-exports everything
 * an existing importer used to get from it. The split also keeps
 * `monitor-client.ts` under the monolith-creep ceiling that
 * `scripts/ci/check-file-size.mjs` freezes — the #4354 review fixes pushed it
 * from 1880 to 1945 LOC against a 1900 ceiling, and reducing is the right
 * answer there rather than bumping the baseline.
 *
 * Nothing here talks to Azure. `upsertActionGroup` still owns the READ, the
 * PUT, and the decision that only a clean 404 may be treated as absence.
 */

import {
  ACTION_GROUP_RECEIVER_KINDS,
  emptyReceiverMap,
  type ActionGroupReceiverKind,
  type ActionGroupReceiverRead,
} from './action-group-receivers';

export interface SmsReceiverInput {
  /** Numeric country/dialing code, e.g. '1' for US. */
  countryCode: string;
  /** Phone number (digits only). */
  phoneNumber: string;
}

export interface WebhookReceiverInput {
  /** HTTPS endpoint the alert POSTs the Common Alert Schema payload to. */
  serviceUri: string;
  useCommonAlertSchema?: boolean;
}

export interface LogicAppReceiverInput {
  /** ARM resource id of the Logic App (Consumption) workflow. */
  resourceId: string;
  /** The workflow trigger's listCallbackUrl (SAS). Fetch via getLogicAppCallbackUrl(). */
  callbackUrl: string;
  useCommonAlertSchema?: boolean;
}

export interface ActionGroupInput {
  /** Resource name e.g. 'loom-activator-ag', OR a full action-group ARM id (the
   *  repair path, which must write back to the group it read). */
  name: string;
  /**
   * 1-12 char short name shown in notifications, supplied EXPLICITLY by a
   * caller that has one to say — the health-check editor's "Short name" field
   * and `/api/monitor/action-groups`. An explicit value is an INSTRUCTION and
   * is applied even to a group that already exists, exactly like the receiver
   * arrays below: absent means "leave it alone", present means "make it this".
   *
   * Omit it (and pass {@link ActionGroupInput.shortNameIfNew} instead) when the
   * value is DERIVED rather than chosen — see below.
   */
  shortName?: string;
  /**
   * Create-only fallback short name. Used when the group does not already carry
   * one, and ignored otherwise.
   *
   * This is what the activator bind/repair paths pass: they derive a short name
   * from the activator's display name, so it is a default, never a rename
   * request. Sending it as `shortName` would rename `loom-default-alerts` (and
   * every operator-named group a repair touches) to whatever activator happened
   * to reconcile last.
   */
  shortNameIfNew?: string;
  /** Email receivers; each becomes an emailReceiver. */
  emails?: string[];
  /** SMS receivers (Teams/pager-style escalation). */
  smsReceivers?: SmsReceiverInput[];
  /** Webhook receivers (Teams incoming webhook, PagerDuty, custom HTTPS sink). */
  webhookReceivers?: WebhookReceiverInput[];
  /** Logic App receivers (Teams adaptive-card / pipeline-trigger workflows). */
  logicAppReceivers?: LogicAppReceiverInput[];
}

/**
 * `groupShortName` for the PUT body, in the same precedence order the receiver
 * arrays use (#4354 review):
 *
 *   1. an EXPLICIT `shortName` — a caller that has one to say is instructing;
 *   2. the short name the group already carries — so a derived-name caller
 *      cannot rename a group somebody else named;
 *   3. `shortNameIfNew` — the derived default, which only lands on create;
 *   4. `'loom'` — ARM requires 1-12 chars, so the field is never empty.
 *
 * Empty/whitespace at any level falls through to the next: ARM rejects an empty
 * `groupShortName`, and `''` is not an instruction.
 */
export function resolveGroupShortName(
  input: Pick<ActionGroupInput, 'shortName' | 'shortNameIfNew'>,
  existingShortName: string | undefined,
): string {
  for (const candidate of [input.shortName, existingShortName, input.shortNameIfNew]) {
    const trimmed = String(candidate ?? '').trim();
    if (trimmed) return trimmed.slice(0, 12);
  }
  return 'loom';
}

/**
 * The full `properties` body for the action-group PUT, merged over what the
 * group already carries.
 *
 * `existing` MUST be a genuine read (or a clean 404 — `exists:false` with every
 * array empty). Passing a degraded "I could not read it" here writes the
 * degradation back as a deletion, which is the #4113 defect; the caller is
 * responsible for throwing instead.
 *
 *   1. A kind Loom does not manage is written back EXACTLY as it was read.
 *   2. A managed kind the caller did not supply (`undefined`, as opposed to an
 *      explicitly empty array) is ALSO preserved. Passing `emails: []` still
 *      clears the email receivers — an explicit empty is an instruction; an
 *      absent field is not.
 *   3. `groupShortName` obeys the SAME rule — see {@link resolveGroupShortName}.
 */
export function composeActionGroupBody(
  input: ActionGroupInput,
  existing: ActionGroupReceiverRead,
): { location: 'Global'; properties: Record<string, unknown> } {
  const emailReceivers = (input.emails || [])
    .filter((e) => e && e.includes('@'))
    .map((e, i) => ({ name: `email${i}`, emailAddress: e.trim(), useCommonAlertSchema: true }));
  const smsReceivers = (input.smsReceivers || [])
    .filter((r) => r && r.phoneNumber)
    .map((r, i) => ({
      name: `sms${i}`,
      countryCode: String(r.countryCode || '1').replace(/[^0-9]/g, '') || '1',
      phoneNumber: String(r.phoneNumber).replace(/[^0-9]/g, ''),
    }));
  const webhookReceivers = (input.webhookReceivers || [])
    .filter((r) => r && r.serviceUri && /^https?:\/\//i.test(r.serviceUri))
    .map((r, i) => ({
      name: `webhook${i}`,
      serviceUri: r.serviceUri.trim(),
      useCommonAlertSchema: r.useCommonAlertSchema ?? true,
    }));
  const logicAppReceivers = (input.logicAppReceivers || [])
    .filter((r) => r && r.resourceId && r.callbackUrl)
    .map((r, i) => ({
      name: `logicapp${i}`,
      resourceId: r.resourceId.trim(),
      callbackUrl: r.callbackUrl.trim(),
      useCommonAlertSchema: r.useCommonAlertSchema ?? true,
    }));

  const supplied: Partial<Record<ActionGroupReceiverKind, unknown[]>> = {
    ...(input.emails !== undefined ? { emailReceivers } : {}),
    ...(input.smsReceivers !== undefined ? { smsReceivers } : {}),
    ...(input.webhookReceivers !== undefined ? { webhookReceivers } : {}),
    ...(input.logicAppReceivers !== undefined ? { logicAppReceivers } : {}),
  };
  const receivers = emptyReceiverMap();
  for (const kind of ACTION_GROUP_RECEIVER_KINDS) {
    receivers[kind] = (supplied[kind] ?? existing.byKind[kind]) as any[];
  }

  return {
    location: 'Global',
    properties: {
      groupShortName: resolveGroupShortName(input, existing.shortName),
      enabled: true,
      ...receivers,
    },
  };
}
