/**
 * /api/onelake/lifecycle — OneLake Lifecycle Management rules for a workspace.
 *
 * GET  ?workspaceId=…  → the live ADLS Gen2 lifecycle policy (managementPolicies/
 *                        default) for the workspace's bound (or default DLZ)
 *                        storage account, as a flat LifecycleRule[].
 * PUT  { workspaceId, rules } → replaces the lifecycle policy in FULL (ARM does
 *                        not support partial updates). Enforces the Fabric-parity
 *                        ceiling of ≤10 rules per workspace and validates every
 *                        rule before calling ARM.
 *
 * Azure-native backend (no Fabric dependency): the policy is written straight to
 * the storage account via ARM. A missing Storage Account Contributor role (403)
 * surfaces as an honest gate naming the role + bicep module — never a raw 5xx.
 *
 * Authorization (#4619). A PUT replaces the WHOLE management policy of ONE
 * storage account, and a workspace's `storageAccountId` does not yet establish
 * that the account belongs to that workspace alone. So PUT is TENANT-ADMIN for
 * every account (`withTenantAdmin`, before the body is read), with a 403
 * `admin_only` envelope that names this surface. It can become owner-scoped
 * once a server-verified per-workspace account binding exists.
 *
 * Both verbs resolve the workspace through the canonical `resolveAdminWorkspace`
 * ladder: the creator resolves on their own partition, a tenant admin resolves
 * a workspace of the same tenant, and anyone else is a 404 before any ARM call
 * (no ACL-member widening). GET is read-only; it also reports `accountScope`
 * (`dedicated` | `shared`) as information about the binding. That field does
 * not change who may write.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';
import type { TenantAdminRefusal } from '@/lib/auth/feature-gate';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace } from '@/lib/types/workspace';
import {
  getAccountName,
  getLifecyclePolicy,
  setLifecyclePolicy,
  LifecyclePolicyError,
  STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID,
  type LifecycleAccountRef,
  type LifecycleRule,
  type ConditionField,
  type LifecycleAction,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The Fabric-parity ceiling — at most 10 lifecycle rules per workspace. */
const MAX_RULES = 10;

const CONDITION_FIELDS: ConditionField[] = [
  'daysAfterModificationGreaterThan',
  'daysAfterLastAccessTimeGreaterThan',
  'daysAfterCreationGreaterThan',
];
const LIFECYCLE_ACTIONS: LifecycleAction[] = [
  'tierToCool', 'tierToCold', 'tierToArchive', 'enableAutoTierToHotFromCool', 'delete',
];
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

function accountRefFromArmId(armId?: string): LifecycleAccountRef | undefined {
  if (!armId) return undefined;
  const account = armId.split('/').pop();
  const resourceGroup = /\/resourceGroups\/([^/]+)\//i.exec(armId)?.[1];
  const subscriptionId = /\/subscriptions\/([^/]+)\//i.exec(armId)?.[1];
  if (!account) return undefined;
  return { account, resourceGroup, subscriptionId };
}

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * A storage-account ARM id, whole-string anchored, so a suffix, query, fragment
 * or nested path can never stand in for the account segment when GET reports
 * `accountScope`.
 */
const STORAGE_ACCOUNT_ARM_ID_RE = new RegExp(
  `^/subscriptions/(${GUID})/resourceGroups/([-\\w.()]{1,90})/providers/Microsoft\\.Storage/storageAccounts/([a-z0-9]{3,24})$`,
  'i',
);

/** Keep in step with `LIFECYCLE_ADMIN_ONLY` in lib/util/admin-only-copy.ts. */
const LIFECYCLE_REFUSAL: TenantAdminRefusal = {
  reason:
    'Lifecycle rules replace the whole management policy of a storage account, and Loom cannot yet '
    + 'confirm that the account is used by this workspace alone, so only a tenant admin can change them.',
  remediation: 'Ask a tenant admin to change these rules. You can still review them here.',
};

type AccountScope = 'dedicated' | 'shared';

/**
 * Classify the account a workspace's lifecycle policy lands on, for GET's
 * `accountScope`. `dedicated` only when every check positively passes; any
 * doubt — no binding, an id that does not parse, the deployment's shared
 * account, another workspace binding the same account, or a failed lookup — is
 * `shared`. `dedicated` means "not shared", not "owned by this workspace", so
 * it grants nothing: PUT is tenant-admin either way.
 */
async function classifyAccount(ws: Workspace): Promise<AccountScope> {
  const m = STORAGE_ACCOUNT_ARM_ID_RE.exec(ws.storageAccountId ?? '');
  if (!m) return 'shared';
  const account = m[3].toLowerCase();
  try {
    if (account === getAccountName().toLowerCase()) return 'shared';
    const c = await workspacesContainer();
    const { resources } = await c.items
      .query<{ id: string; storageAccountId?: string }>({
        query:
          'SELECT c.id, c.storageAccountId FROM c WHERE c.id != @id '
          + 'AND IS_STRING(c.storageAccountId) AND CONTAINS(LOWER(c.storageAccountId), @needle)',
        parameters: [
          { name: '@id', value: ws.id },
          { name: '@needle', value: `/storageaccounts/${account}` },
        ],
      })
      .fetchAll();
    const alsoBound = resources.some(
      (o) => accountRefFromArmId(o.storageAccountId)?.account?.toLowerCase() === account,
    );
    if (alsoBound) return 'shared';
  } catch {
    return 'shared';
  }
  return 'dedicated';
}

/** Map a LifecyclePolicyError into the honest-gate JSON payload (HTTP 200). */
function gateResponse(e: LifecyclePolicyError) {
  if (e.code === 'forbidden') {
    return NextResponse.json({
      ok: false,
      gate: true,
      missing: `Storage Account Contributor (${STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID})`,
      hint: 'Grant the Console UAMI "Storage Account Contributor" on the DLZ storage account. Deploy platform/fiab/bicep/modules/landing-zone/storage-lifecycle-rbac.bicep with consolePrincipalNeedsLifecycleWrite=true.',
      bicepModule: 'platform/fiab/bicep/modules/landing-zone/storage-lifecycle-rbac.bicep',
    });
  }
  // missing_config — env not wired
  return NextResponse.json({
    ok: false,
    gate: true,
    missing: 'LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG',
    hint: 'Set LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG on the loom-console container app so the BFF can resolve the storage account scope for lifecycle policies.',
  });
}

export const GET = withSession(async (req: NextRequest) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const resolved = await resolveAdminWorkspace(workspaceId);
    if (resolved.resp) return resolved.resp;
    const ref = accountRefFromArmId(resolved.ws.storageAccountId);
    const rules = await getLifecyclePolicy(ref);
    // Information about the binding; it does not change who may write.
    const scope = await classifyAccount(resolved.ws);
    return NextResponse.json({
      ok: true,
      rules,
      ruleCount: rules.length,
      maxRules: MAX_RULES,
      account: ref?.account,
      accountScope: scope,
    });
  } catch (e: any) {
    if (e instanceof LifecyclePolicyError) return gateResponse(e);
    return NextResponse.json({ ok: false, error: e?.message || 'Failed to read lifecycle policy' }, { status: 502 });
  }
});

/** Validate one rule; returns an error string or null when valid. */
function validateRule(r: any, index: number): string | null {
  if (!r || typeof r !== 'object') return `Rule #${index + 1} is malformed`;
  if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) {
    return `Rule #${index + 1}: name must be 1–63 alphanumeric/dash chars starting with a letter or digit`;
  }
  if (typeof r.enabled !== 'boolean') return `Rule "${r.name}": enabled must be a boolean`;
  if (!CONDITION_FIELDS.includes(r.conditionField)) return `Rule "${r.name}": invalid condition field`;
  if (typeof r.conditionDays !== 'number' || !Number.isFinite(r.conditionDays) || r.conditionDays < 1) {
    return `Rule "${r.name}": condition days must be a whole number ≥ 1`;
  }
  if (!Array.isArray(r.actions) || r.actions.length < 1) return `Rule "${r.name}": at least one action is required`;
  for (const a of r.actions) {
    if (!LIFECYCLE_ACTIONS.includes(a)) return `Rule "${r.name}": invalid action "${a}"`;
  }
  if (r.actions.includes('enableAutoTierToHotFromCool')) {
    if (!r.actions.includes('tierToCool')) {
      return `Rule "${r.name}": "Auto-tier Hot from Cool" requires "Tier to Cool"`;
    }
    if (r.conditionField !== 'daysAfterLastAccessTimeGreaterThan') {
      return `Rule "${r.name}": "Auto-tier Hot from Cool" requires the "days since last access" condition`;
    }
  }
  if (r.prefixMatch != null && !Array.isArray(r.prefixMatch)) {
    return `Rule "${r.name}": prefixMatch must be an array of path prefixes`;
  }
  return null;
}

// 401 without a session; 403 `admin_only` for a non-admin before the body is
// read; then the body is validated and the workspace resolved before ARM.
export const PUT = withTenantAdmin(async (req: NextRequest) => {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }

  const workspaceId: string | undefined = body?.workspaceId;
  const rules: any[] = Array.isArray(body?.rules) ? body.rules : [];
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Fabric-parity ceiling: at most 10 rules per workspace.
  if (rules.length > MAX_RULES) {
    return NextResponse.json({
      ok: false,
      code: 'rule_limit_exceeded',
      error: `Maximum ${MAX_RULES} lifecycle rules per workspace. Delete or replace an existing rule.`,
    }, { status: 422 });
  }

  // Unique rule names (ARM is case-sensitive; reject dup names up front).
  const seen = new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    const v = validateRule(rules[i], i);
    if (v) return NextResponse.json({ ok: false, code: 'invalid_rule', error: v }, { status: 422 });
    const name = rules[i].name as string;
    if (seen.has(name)) {
      return NextResponse.json({ ok: false, code: 'duplicate_name', error: `Duplicate rule name "${name}"` }, { status: 422 });
    }
    seen.add(name);
  }

  try {
    const resolved = await resolveAdminWorkspace(workspaceId);
    if (resolved.resp) return resolved.resp;
    // The workspace's binding, or the deployment default when it has none.
    const ref = accountRefFromArmId(resolved.ws.storageAccountId);
    const clean: LifecycleRule[] = rules.map((r) => ({
      name: r.name,
      enabled: r.enabled,
      prefixMatch: Array.isArray(r.prefixMatch) && r.prefixMatch.length
        ? r.prefixMatch.map((p: string) => String(p).trim()).filter(Boolean)
        : undefined,
      conditionField: r.conditionField,
      conditionDays: Math.floor(r.conditionDays),
      actions: r.actions,
    }));
    const saved = await setLifecyclePolicy(clean, ref);
    return NextResponse.json({ ok: true, rules: saved, ruleCount: saved.length, account: ref?.account });
  } catch (e: any) {
    if (e instanceof LifecyclePolicyError) return gateResponse(e);
    return NextResponse.json({ ok: false, error: e?.message || 'Failed to write lifecycle policy' }, { status: 502 });
  }
}, LIFECYCLE_REFUSAL);
