/**
 * Loom-native deployment-pipeline DEPLOY engine — stage-rule application.
 *
 * When content is promoted into a target stage, that stage's deployment rules
 * (parameter / data-source overrides) are applied to the base ProvisionTarget
 * BEFORE the item is re-provisioned, so the same model lands in Test bound to
 * the Test warehouse / ADLS account / Synapse workspace (and Prod to Prod).
 * This is the Azure-native parity for Fabric's "deployment rules".
 *
 * Pure function over ProvisionTarget — no Azure call. The selective-deploy
 * route calls this, then hands the patched target to the real provisioner.
 */
import type { ProvisionTarget } from './provisioners/types';
import type { LoomDeployRule } from '@/lib/types/loom-pipeline';

/** Map of override key → which ProvisionTarget field it patches. */
const TARGET_FIELD: Record<string, keyof ProvisionTarget> = {
  warehouseServer: 'warehouseServer',
  warehouseDatabase: 'warehouseDatabase',
  adlsAccount: 'adlsAccount',
  adlsContainer: 'adlsContainer',
  synapseWorkspace: 'synapseWorkspace',
  kustoClusterUri: 'kustoClusterUri',
  kustoDatabase: 'kustoDatabase',
  aiSearchService: 'aiSearchService',
};

/** Does this rule apply to the given item? */
function ruleMatches(rule: LoomDeployRule, itemType: string, displayName: string): boolean {
  const typeOk = rule.itemType === '*' || rule.itemType === itemType;
  const name = rule.itemDisplayName;
  const nameOk = !name || name === '*' || name.toLowerCase() === (displayName || '').toLowerCase();
  return typeOk && nameOk;
}

/**
 * Return a NEW ProvisionTarget with every matching stage rule applied. The
 * input target is never mutated. Rules are applied in order, so a later
 * more-specific rule (same key) wins.
 */
export function applyStageRules(
  base: ProvisionTarget,
  rules: LoomDeployRule[],
  itemType: string,
  displayName: string,
): { target: ProvisionTarget; applied: string[] } {
  const target: ProvisionTarget = { ...base };
  const applied: string[] = [];
  for (const rule of rules || []) {
    if (!ruleMatches(rule, itemType, displayName)) continue;
    const field = TARGET_FIELD[rule.key];
    if (!field) continue;
    if (typeof rule.value !== 'string' || rule.value.length === 0) continue;
    (target as any)[field] = rule.value;
    applied.push(`${rule.kind} rule: ${rule.key} → ${rule.value}`);
  }
  return { target, applied };
}
