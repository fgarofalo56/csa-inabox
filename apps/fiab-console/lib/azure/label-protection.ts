/**
 * Label protection — F19 (export protection), F20 (label-change rights gate),
 * F21 (protected label → real Azure RBAC on the backing store).
 *
 * Azure-native, no Microsoft Fabric / Power BI dependency (per
 * `.claude/rules/no-fabric-dependency.md`). Grounded in real behavior:
 *
 *   - Graph beta `sensitivityLabel.hasProtection` (Boolean) — true when the
 *     label carries an AIP/RMS encryption template.
 *   - Graph beta `sensitivityLabels?$filter=(id eq … and ownerEmail eq …)`
 *     returns a `usageRightsInfo` object (allowView/allowEdit/allowExport/…)
 *     describing what a given user may do with content protected by the label.
 *   - Microsoft Purview / Fabric "Protected sensitivity labels" behavior:
 *     unsupported export targets (CSV / TXT) cannot carry label metadata, so
 *     the protection context is lost on download — those exports are blocked
 *     for protected labels; changing/removing a protected label requires
 *     EXPORT or EDIT usage rights.
 *   - Azure RBAC: deny assignments cannot be created by applications (they are
 *     Azure-managed only). Enforcement is therefore a POSITIVE role grant —
 *     a higher-sensitivity protected label maps the principal to read-only
 *     (Storage Blob Data Reader / db_datareader / ADX viewers) on the backing
 *     store, rather than a deny. This reuses the proven
 *     `enforceAccessGrant()` data-plane path in `access-policy-client.ts`.
 *
 * Per-cloud:
 *   Commercial / GCC : full support (graph.microsoft.com).
 *   GCC-High         : hasProtection ✅; ownerEmail rights filter may 404/400
 *                      → honest gate (export still blocked by FORMAT for CSV/TXT;
 *                      label-change returns "contact your Purview admin").
 *   IL5 / DoD        : same degradation as GCC-High; RBAC enforcement ✅.
 *   The graph host is selected by `LOOM_MIP_GRAPH_BASE` (graph.microsoft.us /
 *   dod-graph.microsoft.us); ARM host by the cloud-endpoints helpers.
 */
import type { SensitivityLabel, SensitivityLabelUsageRights } from './mip-graph-client';
import { getSensitivityLabelWithRights } from './mip-graph-client';
import {
  enforceAccessGrant,
  type AccessGrantInput,
  type AccessGrantResult,
  type AccessPermission,
  type AccessScopeType,
  type PrincipalType,
} from './access-policy-client';
import type { WorkspaceItem } from '../types/workspace';

// ── Exported types ───────────────────────────────────────────────────────────

export type UsageRights = SensitivityLabelUsageRights;

export interface ExportCheckResult {
  /** True → the caller MUST NOT export. UI shows `reason` in an error MessageBar. */
  blocked: boolean;
  /** Human-readable reason shown when blocked. */
  reason?: string;
  /** Non-blocking caution (e.g. MIP not enabled — protection can't be verified). */
  warning?: string;
}

export interface LabelChangeRightsResult {
  allowed: boolean;
  /** Why the change is blocked (shown in the 403 body / greyed-action tooltip). */
  reason?: string;
  /** Remediation hint (who to contact / what rights to request). */
  hint?: string;
}

export interface LabelRbacGrant {
  /** ARM id of the Storage role assignment; undefined for warehouse/KQL grants. */
  assignmentId?: string;
  principalId: string;
  principalType: PrincipalType;
  scopeType: AccessScopeType;
  scopeRef: string;
  permission: AccessPermission;
  roleName?: string;
  appliedAt: string;
}

export type BackingScope =
  | { scopeType: AccessScopeType; scopeRef: string }
  | { pending: string };

// ── Pure helpers (synchronous, unit-tested) ──────────────────────────────────

/** True when the label has an AIP/RMS encryption policy (Graph beta hasProtection). */
export function isProtectedLabel(label: SensitivityLabel): boolean {
  return !!(label.hasProtection ?? (label.raw as any)?.hasProtection ?? false);
}

/** Read the label's numeric sensitivity rank (typed field, falling back to raw). */
export function labelSensitivity(label: SensitivityLabel): number {
  const v = label.sensitivity ?? (label.raw as any)?.sensitivity;
  return typeof v === 'number' ? v : 0;
}

/**
 * Map a label's sensitivity rank to a backing-store permission tier.
 *   sensitivity >= 3 (Confidential / Highly Confidential / Restricted) → 'read'
 *   sensitivity 0-2 (Public / General / Internal)                      → 'write'
 *
 * Azure-native equivalent of the Power BI / AIP protection tiers: stronger
 * labels constrain the principal to read-only on the real backing data plane.
 */
export function sensitivityToPermission(sensitivity: number | undefined): AccessPermission {
  return (sensitivity ?? 0) >= 3 ? 'read' : 'write';
}

/**
 * F19 — Decide whether exporting a labeled item to `format` is permitted.
 *
 * Rules for a PROTECTED label (hasProtection: true):
 *   1. If the caller's usage rights are known and `allowExport` is false →
 *      hard block regardless of format.
 *   2. CSV / TXT cannot carry AIP/RMS metadata → the protection is stripped on
 *      download → blocked even for users who DO hold the EXPORT right.
 *   3. Supported formats (XLSX / PDF, etc.) pass.
 *
 * Unprotected labels never block. Pure + synchronous so it is trivially
 * unit-testable and usable on both the BFF and (via the route) the client.
 */
export function checkExportProtection(
  label: SensitivityLabel,
  format: string,
  rights?: UsageRights | null,
): ExportCheckResult {
  if (!isProtectedLabel(label)) return { blocked: false };

  const fmt = String(format || '').toLowerCase().trim().replace(/^\./, '');
  const labelName = label.name || label.displayName || label.id;

  // (1) Hard block: caller has no EXPORT right at all.
  if (rights && !rights.allowExport) {
    return {
      blocked: true,
      reason:
        `Your usage rights for label "${labelName}" do not permit export. ` +
        `Contact the label issuer or your Microsoft Purview administrator to request the EXPORT right.`,
    };
  }

  // (2) Unsupported format for protected labels — strips the protection.
  if (fmt === 'csv' || fmt === 'txt') {
    return {
      blocked: true,
      reason:
        `Label "${labelName}" has encryption protection. Exporting to ${fmt.toUpperCase()} ` +
        `removes all protections and is not permitted for this label. ` +
        `Use a supported, protection-preserving format (XLSX or PDF) instead.`,
    };
  }

  return { blocked: false };
}

/**
 * Resolve the Azure backing-store scope for a Loom workspace item, so F21 can
 * enforce a real RBAC grant on it.
 *
 * Returns `{ pending }` (never a silent no-op, per no-vaporware.md) when the
 * item type has no Azure-native backing scope wired for label enforcement.
 *
 * State-field conventions (Azure-native defaults — no Fabric):
 *   lakehouse                → ADLS container (state.container, default 'bronze')
 *   warehouse                → Synapse dedicated pool (state.dedicatedPool /
 *                              LOOM_SYNAPSE_DEDICATED_POOL, default 'loompool')
 *   kql-database / eventhouse → ADX database (state.adxDatabase / displayName)
 */
export function resolveItemBackingScope(item: WorkspaceItem): BackingScope {
  const state = (item.state || {}) as Record<string, unknown>;
  switch (item.itemType) {
    case 'lakehouse':
      return { scopeType: 'adls-container', scopeRef: String(state.container || 'bronze') };
    case 'warehouse':
      return {
        scopeType: 'warehouse',
        scopeRef: String(state.dedicatedPool || process.env.LOOM_SYNAPSE_DEDICATED_POOL || 'loompool'),
      };
    case 'kql-database':
    case 'eventhouse':
      return { scopeType: 'kql-database', scopeRef: String(state.adxDatabase || item.displayName) };
    default:
      return {
        pending:
          `Item type "${item.itemType}" has no Azure backing scope for label RBAC enforcement. ` +
          `Scope label protection to a lakehouse, warehouse, or kql-database item.`,
      };
  }
}

// ── Async helpers (Graph / ARM backed) ───────────────────────────────────────

/**
 * F20 — Check whether `callerUpn` may change or remove the protected label
 * identified by `labelId`.
 *
 * Gate: `allowExport || allowEdit`. Per the Microsoft Purview / Fabric
 * "Protected sensitivity labels" rules, OWNER, EXPORT, or EDIT (+EDITRIGHTSDATA)
 * usage rights are sufficient to change a protected label. The Graph
 * `usageRightsInfo` booleans map allowExport → EXPORT and allowEdit → EDIT;
 * OWNER is implied when both are present.
 *
 *   - Unprotected label  → allowed (no gate).
 *   - rights === null     → rights evaluation unavailable for this cloud
 *                           (GCC-High / IL5) → allowed:false + admin hint.
 *   - lacks both rights   → allowed:false with the user's current rights echoed.
 */
export async function checkLabelChangeRights(
  labelId: string,
  label: SensitivityLabel,
  callerUpn: string,
): Promise<LabelChangeRightsResult> {
  if (!isProtectedLabel(label)) return { allowed: true };

  const labelName = label.name || label.displayName || labelId;
  const rights = await getSensitivityLabelWithRights(labelId, callerUpn);

  if (rights === null) {
    return {
      allowed: false,
      reason:
        `Cannot verify your usage rights for protected label "${labelName}". ` +
        `Label rights evaluation may not be available in this cloud boundary (GCC-High / IL5 / DoD).`,
      hint:
        'Contact the label issuer or your Microsoft Purview administrator to change this protected label.',
    };
  }

  if (!(rights.allowExport || rights.allowEdit)) {
    return {
      allowed: false,
      reason:
        `You need EXPORT or EDIT usage rights for label "${labelName}" to change it. ` +
        `Your current rights: allowExport=${rights.allowExport}, allowEdit=${rights.allowEdit}.`,
      hint:
        'Contact the person who applied this label or your Microsoft Purview administrator to request the necessary usage rights.',
    };
  }

  return { allowed: true };
}

/**
 * F21 — Enforce the label's protection tier as a real Azure RBAC grant on the
 * item's backing store.
 *
 * Maps `label.sensitivity` → permission tier → `enforceAccessGrant()` (which
 * issues the real ARM role assignment / Synapse SQL role / ADX database role).
 * Returns the grant descriptor for persistence (so the previous grant can be
 * adjusted/revoked on the next label change).
 *
 * Requires the Console UAMI to hold "Role Based Access Control Administrator"
 * (f58310d9-a9f6-439a-9e8d-f62e7b41a168) on the backing storage account — see
 * platform/fiab/bicep/modules/admin-plane/label-rbac-grants.bicep. When that
 * role is missing the ARM PUT returns 403, surfaced honestly as
 * `{ status: 'error', detail: <arm error> }`.
 */
export async function enforceLabelRbac(opts: {
  label: SensitivityLabel;
  principalId: string;
  principalName?: string;
  principalType: PrincipalType;
  scopeType: AccessScopeType;
  scopeRef: string;
}): Promise<AccessGrantResult & { grant?: LabelRbacGrant }> {
  const permission = sensitivityToPermission(labelSensitivity(opts.label));
  const input: AccessGrantInput = {
    principalId: opts.principalId,
    principalName: opts.principalName,
    principalType: opts.principalType,
    scopeType: opts.scopeType,
    scopeRef: opts.scopeRef,
    permission,
  };
  const result = await enforceAccessGrant(input);
  if (result.status === 'active') {
    const grant: LabelRbacGrant = {
      assignmentId: result.roleAssignmentId,
      principalId: opts.principalId,
      principalType: opts.principalType,
      scopeType: opts.scopeType,
      scopeRef: opts.scopeRef,
      permission,
      roleName: result.roleName,
      appliedAt: new Date().toISOString(),
    };
    return { ...result, grant };
  }
  return result;
}
