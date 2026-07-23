/**
 * workspace-identity-preflight — I7 (loom-next-level): the grant-check preflight
 * an operator runs BEFORE flipping a workspace from shadow → enforce (I6).
 *
 * The migration runbook (docs/fiab/runbooks/workspace-identity-migration.md) is
 * a 7-step play: (1) global LOOM_WORKSPACE_IDENTITY_MODE=shadow, (2) shadow N
 * days, (3) review the I4 report per workspace, (4) **run this preflight**,
 * (5) flip per-workspace enforce (I6), (6) smoke-test, (7) rollback =
 * enforce:false (instant — the I5 factory fail-safes to the shared UAMI on the
 * next request, bounded by the credential LRU TTL).
 *
 * This module answers step (4) from REAL state — NO mocks on the default path:
 *  - the workspace's provisioned UAMI (uami-ws-<id>) via the I1
 *    workspace-identity-client (ARM GET);
 *  - each I2 grant, evaluated against LIVE RBAC / data-plane
 *    (workspace-grants.evaluateWorkspaceGrant — ARM role-assignment list /
 *    Cosmos sqlRoleAssignments / sys.database_principals / .show database
 *    principals, cached 5 min per workspace+backend);
 *  - the I3 shadow rollup — divergence + observed-call counts read from the
 *    existing audit-log container's `identity.shadow` rows for the workspace.
 *
 * A workspace is READY to enforce when its UAMI is provisioned, EVERY applicable
 * grant would ALLOW (zero would-be-denied backends), AND shadow observed ZERO
 * divergences. `observedCalls === 0` does NOT block (a brand-new workspace may
 * carry no traffic) but is surfaced as a warning so the operator can judge
 * whether enough shadow evidence was collected.
 *
 * Cloud-neutral: every probe resolves ARM/data-plane hosts through
 * cloud-endpoints (armBase / kustoClusterUri / …) via the clients it calls — no
 * public-cloud host is hard-coded, so Commercial / GCC-High / IL5 all work.
 *
 * NEVER throws: the caller (the I6 GET route + the enforce script) gets a
 * structured verdict even when ARM / Cosmos is unreachable — an unreachable
 * probe degrades to a blocking reason, never an exception.
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  getWorkspaceUami,
  workspaceIdentityConfigGate,
  workspaceUamiName,
  type WorkspaceUami,
} from '@/lib/azure/workspace-identity-client';
import {
  WORKSPACE_GRANTS,
  evaluateWorkspaceGrant,
  type WorkspaceGrantEvaluation,
} from '@/lib/azure/workspace-grants';

/** Minimal workspace shape the preflight needs — a `WorkspaceRef` (id + optional
 * per-workspace storage binding, consumed by the ADLS grant scope resolver). A
 * full {@link import('@/lib/types/workspace').Workspace} satisfies it too. */
export interface WorkspaceEnforceTarget {
  id: string;
  storageAccountId?: string;
}

export interface WorkspaceEnforcePreflight {
  workspaceId: string;
  /** true ⇔ safe to flip enforce: UAMI provisioned + zero missing grants +
   * zero shadow divergences (+ config gate clear). */
  ready: boolean;
  /** Whether uami-ws-<id> exists in ARM (a hard precondition for enforce). */
  uamiProvisioned: boolean;
  /** I2 backend keys whose grant would DENY the workspace UAMI (wouldAllow
   * === false). Not-applicable / unresolvable backends are NOT listed. */
  missingGrants: string[];
  /** Count of `identity.shadow` rows for this workspace where the shared UAMI
   * was allowed but the workspace UAMI would have been denied. */
  divergences: number;
  /** Total `identity.shadow` observations recorded for this workspace. */
  observedCalls: number;
  /** Full per-backend grant evaluation detail (built ✅ / would-deny ❌ / n-a). */
  grantEvaluations: WorkspaceGrantEvaluation[];
  /** Human-readable BLOCKERS — why `ready` is false (empty when ready). */
  reasons: string[];
  /** Advisory notes that do NOT block enforce (e.g. no shadow evidence yet). */
  warnings: string[];
  checkedAt: string;
}

/** Read the I3 shadow rollup for one workspace from the audit-log container.
 * Single logical partition (`identity.shadow` rows are keyed by workspaceId).
 * NEVER throws — an unreachable Cosmos returns zeros AND signals the failure so
 * the caller can add a blocking reason (we must not call a workspace "ready"
 * off an unread shadow log). */
async function readShadowRollup(
  workspaceId: string,
): Promise<{ observedCalls: number; divergences: number; unreadable: boolean }> {
  try {
    const c = await auditLogContainer();
    const count = async (extra: string): Promise<number> => {
      const { resources } = await c.items
        .query<number>({
          query:
            "SELECT VALUE COUNT(1) FROM c WHERE c.kind = 'identity.shadow' AND c.workspaceId = @ws" +
            extra,
          parameters: [{ name: '@ws', value: workspaceId }],
        })
        .fetchAll();
      return Number(resources?.[0] ?? 0);
    };
    const observedCalls = await count('');
    const divergences = await count(' AND c.divergence = true');
    return { observedCalls, divergences, unreadable: false };
  } catch {
    return { observedCalls: 0, divergences: 0, unreadable: true };
  }
}

/**
 * I7 grant-check preflight — is workspace `ws` ready to flip shadow → enforce?
 * REAL ARM + data-plane + Cosmos probes; NEVER throws.
 */
export async function preflightWorkspaceEnforce(
  ws: WorkspaceEnforceTarget,
): Promise<WorkspaceEnforcePreflight> {
  const checkedAt = new Date().toISOString();
  const reasons: string[] = [];
  const warnings: string[] = [];
  const missingGrants: string[] = [];
  const grantEvaluations: WorkspaceGrantEvaluation[] = [];

  // 0. Honest config gate — without the sub/RG config the ARM probes can't run,
  //    so we cannot certify readiness (the shared-UAMI default is unaffected).
  const gate = workspaceIdentityConfigGate();
  if (gate) {
    reasons.push(
      `Workspace-identity ARM is not configured — set ${gate.missing}. Preflight cannot verify grants until the UAMI sub/RG is set.`,
    );
  }

  // 1. UAMI provisioned? (uami-ws-<id> must exist for enforce to mint it.)
  let uami: WorkspaceUami | null = null;
  let uamiProvisioned = false;
  if (!gate) {
    try {
      uami = await getWorkspaceUami(ws.id);
      uamiProvisioned = !!uami?.principalId;
    } catch (e: any) {
      reasons.push(
        `Could not read the workspace UAMI from ARM (${e?.message || String(e)}). Retry once ARM is reachable.`,
      );
    }
  }
  // Only add the "not provisioned" blocker when no ARM-read error was already
  // recorded above (this branch only runs when the config gate is clear).
  if (!gate && !uamiProvisioned && reasons.length === 0) {
    reasons.push(
      `The per-workspace UAMI ${workspaceUamiName(ws.id)} is not provisioned. Create the workspace with LOOM_WORKSPACE_IDENTITY_MODE set (shadow/enforce), or run the identity backfill, before enforcing.`,
    );
  }

  // 2. Evaluate EVERY I2 grant against live state. Only would-be-DENIED
  //    (wouldAllow === false) backends block; not-applicable / unresolvable
  //    (null) are recorded but never counted as missing.
  if (uami?.principalId) {
    const principal = { principalId: uami.principalId, clientId: uami.clientId, name: uami.name };
    for (const spec of WORKSPACE_GRANTS) {
      const evaluation = await evaluateWorkspaceGrant(ws, principal, spec.backend).catch(
        (e: any): WorkspaceGrantEvaluation => ({
          backend: spec.backend,
          wouldAllow: null,
          reason: e?.message || String(e),
          source: 'error',
          checkedAt,
        }),
      );
      grantEvaluations.push(evaluation);
      if (evaluation.wouldAllow === false) missingGrants.push(spec.backend);
    }
    if (missingGrants.length > 0) {
      reasons.push(
        `The workspace UAMI is missing ${missingGrants.length} grant(s): ${missingGrants.join(', ')}. Re-run grant provisioning (ensureWorkspaceGrants) before enforcing.`,
      );
    }
  }

  // 3. I3 shadow rollup — divergences MUST be zero to certify readiness.
  const { observedCalls, divergences, unreadable } = await readShadowRollup(ws.id);
  if (unreadable) {
    reasons.push(
      'The identity.shadow audit rollup could not be read from Cosmos — readiness cannot be certified without it.',
    );
  } else {
    if (divergences > 0) {
      reasons.push(
        `${divergences} shadow divergence(s) recorded: the shared UAMI succeeded where the workspace UAMI would have been DENIED. Resolve the underlying grants (see the I4 report) before enforcing.`,
      );
    }
    if (observedCalls === 0) {
      warnings.push(
        'No identity.shadow observations recorded yet for this workspace. Run in shadow mode long enough to exercise its data-plane paths before enforcing, so divergences can surface.',
      );
    }
  }

  const ready =
    !gate &&
    uamiProvisioned &&
    missingGrants.length === 0 &&
    !unreadable &&
    divergences === 0;

  return {
    workspaceId: ws.id,
    ready,
    uamiProvisioned,
    missingGrants,
    divergences,
    observedCalls,
    grantEvaluations,
    reasons,
    warnings,
    checkedAt,
  };
}
