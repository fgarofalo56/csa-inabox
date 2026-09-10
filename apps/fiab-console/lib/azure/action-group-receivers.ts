/**
 * lib/azure/action-group-receivers.ts — the `Microsoft.Insights/actionGroups`
 * receiver taxonomy (#4113).
 *
 * Extracted from `monitor-client.ts`, which the monolith-creep ratchet caught
 * growing past its frozen ceiling when the read-modify-write fix landed. This
 * module is deliberately DEPENDENCY-FREE — it holds the kind list, the derived
 * type, the managed subset and the empty map, and nothing that needs an ARM
 * client. `readActionGroupReceivers` stays in `monitor-client.ts` because it
 * needs `armGet`; pulling it here would make the two modules circular.
 *
 * `monitor-client.ts` re-exports everything below, so every existing importer
 * keeps working unchanged.
 */

/**
 * EVERY receiver array `Microsoft.Insights/actionGroups` carries on the
 * 2023-01-01 API surface. An action-group PUT is a FULL REPLACE of
 * `properties`, so any array missing from the body is DELETED from the live
 * resource — which is why this list has to be exhaustive rather than "the ones
 * we happen to use".
 */
export const ACTION_GROUP_RECEIVER_KINDS = [
  'emailReceivers',
  'smsReceivers',
  'webhookReceivers',
  'logicAppReceivers',
  'armRoleReceivers',
  'azureFunctionReceivers',
  'automationRunbookReceivers',
  'voiceReceivers',
  'azureAppPushReceivers',
  'eventHubReceivers',
  'itsmReceivers',
] as const;

export type ActionGroupReceiverKind = (typeof ACTION_GROUP_RECEIVER_KINDS)[number];

/**
 * The four kinds `upsertActionGroup` COMPOSES from its input. Everything else
 * in {@link ACTION_GROUP_RECEIVER_KINDS} is owned by somebody other than the
 * Loom activator (a bicep module, an operator, `alert-dispatch`'s armRole
 * escalation) and is carried through untouched.
 */
export const LOOM_MANAGED_RECEIVER_KINDS: readonly ActionGroupReceiverKind[] = [
  'emailReceivers',
  'smsReceivers',
  'webhookReceivers',
  'logicAppReceivers',
];

export interface ActionGroupReceiverRead {
  /** Whether the action group exists at all (a 404 read is not an error here). */
  exists: boolean;
  /** ARM id, when the group exists. */
  id?: string;
  shortName?: string;
  /** Every kind, always present — an absent array reads as empty, not missing. */
  byKind: Record<ActionGroupReceiverKind, any[]>;
  /** Sum across ALL kinds. Zero means the group genuinely reaches nobody. */
  total: number;
}

export function emptyReceiverMap(): Record<ActionGroupReceiverKind, any[]> {
  const out = {} as Record<ActionGroupReceiverKind, any[]>;
  for (const k of ACTION_GROUP_RECEIVER_KINDS) out[k] = [];
  return out;
}
