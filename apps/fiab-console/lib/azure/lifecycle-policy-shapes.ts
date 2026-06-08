/**
 * lifecycle-policy-shapes — pure, dependency-free types and (de)serialisation
 * for ADLS Gen2 blob lifecycle management policies (managementPolicies/default).
 *
 * Kept separate from adls-client.ts so the ARM <-> Loom rule mapping can be unit
 * tested WITHOUT importing the Azure SDK (adls-client constructs credentials at
 * module load). No Azure/Fabric imports here by design.
 *
 * Parity: Fabric "OneLake — Manage lifecycle" / Azure portal storage "Lifecycle
 * management". Docs:
 * https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview
 */

/** The day-threshold field that anchors a rule. */
export type ConditionField =
  | 'daysAfterModificationGreaterThan'
  | 'daysAfterLastAccessTimeGreaterThan'
  | 'daysAfterCreationGreaterThan';

/** The lifecycle action(s) a matched blob is subjected to. */
export type LifecycleAction =
  | 'tierToCool'
  | 'tierToCold'
  | 'tierToArchive'
  | 'enableAutoTierToHotFromCool'
  | 'delete';

/** A single lifecycle rule in the flat Loom shape (no raw ARM JSON in the UI). */
export interface LifecycleRule {
  /** Rule name — unique within the policy, case-sensitive, alphanumeric + dash. */
  name: string;
  /** Active (true) maps to Fabric "Active"; false maps to "Inactive"/Disabled. */
  enabled: boolean;
  /** Path prefixes (`container/folder/`) the rule scopes to. Absent/empty = whole account. */
  prefixMatch?: string[];
  /** Which day-threshold field drives the rule. */
  conditionField: ConditionField;
  /** Day threshold (>= 1). */
  conditionDays: number;
  /** Actions to apply once the condition is met (at least one required). */
  actions: LifecycleAction[];
}

const CONDITION_FIELDS: ConditionField[] = [
  'daysAfterModificationGreaterThan',
  'daysAfterLastAccessTimeGreaterThan',
  'daysAfterCreationGreaterThan',
];

const TIER_ACTIONS: Array<Exclude<LifecycleAction, 'enableAutoTierToHotFromCool'>> = [
  'tierToCool', 'tierToCold', 'tierToArchive', 'delete',
];

/** ARM ManagementPolicyRule → flat Loom rule (null when no actionable action). */
export function deserialiseRule(raw: any): LifecycleRule | null {
  const baseBlob = raw?.definition?.actions?.baseBlob || {};
  const actions: LifecycleAction[] = [];
  let conditionField: ConditionField | undefined;
  let conditionDays = 0;
  for (const key of TIER_ACTIONS) {
    const fn = baseBlob[key];
    if (!fn || typeof fn !== 'object') continue;
    actions.push(key);
    // Pull the first day-threshold field present (one condition drives the rule).
    if (!conditionField) {
      for (const cf of CONDITION_FIELDS) {
        if (typeof fn[cf] === 'number') { conditionField = cf; conditionDays = fn[cf]; break; }
      }
    }
  }
  if (baseBlob.enableAutoTierToHotFromCool === true) actions.push('enableAutoTierToHotFromCool');
  if (actions.length === 0) return null;
  if (!conditionField) { conditionField = 'daysAfterModificationGreaterThan'; conditionDays = 0; }
  const prefixMatch: string[] | undefined = Array.isArray(raw?.definition?.filters?.prefixMatch)
    ? raw.definition.filters.prefixMatch.filter((p: any) => typeof p === 'string')
    : undefined;
  return {
    name: String(raw?.name ?? ''),
    enabled: raw?.enabled !== false,
    prefixMatch: prefixMatch && prefixMatch.length ? prefixMatch : undefined,
    conditionField,
    conditionDays,
    actions,
  };
}

/** Flat Loom rule → ARM ManagementPolicyRule. */
export function serialiseRule(rule: LifecycleRule): any {
  const baseBlob: Record<string, any> = {};
  for (const a of rule.actions) {
    if (a === 'enableAutoTierToHotFromCool') { baseBlob.enableAutoTierToHotFromCool = true; continue; }
    baseBlob[a] = { [rule.conditionField]: rule.conditionDays };
  }
  const filters: Record<string, any> = { blobTypes: ['blockBlob'] };
  if (rule.prefixMatch && rule.prefixMatch.length) {
    filters.prefixMatch = rule.prefixMatch.map((p) => p.replace(/^\/+/, ''));
  }
  return {
    enabled: rule.enabled,
    name: rule.name,
    type: 'Lifecycle',
    definition: { actions: { baseBlob }, filters },
  };
}
