/**
 * Protection-policy reconciler (EH Phase-1 §2.3) — sovereign-rbac default.
 *
 * reconcilePolicy(policy) converges the labeled source to the policy's
 * allow-list. SOVEREIGN-RBAC (default, NO Fabric/Purview):
 *   (a) enumerate items carrying policy.label — the Loom-applied label stored on
 *       item docs (state.sensitivityLabel); pure Cosmos query, no Graph call;
 *   (b) target grant set = allowPrincipals + issuer (never blocked);
 *   (c) diff vs live grants — listContainerRoleAssignments on each item's ADLS
 *       backing container (reuse adls/rbac-client); for warehouse items list
 *       Synapse SQL db-role members (db_datareader/writer/owner) and for
 *       kql-database items list ADX database principals — all three follow the
 *       SAME live−target diff, gated honestly when their backend is unset;
 *   (d) converge POSITIVE grants only — enforceAccessGrant for missing,
 *       revokeAccessGrant (ADLS) / revokeStructuredGrant (SQL) / dropDatabase-
 *       Principal (ADX) for principals NOT in target. Apps cannot create Azure
 *       deny assignments, so enforcement = grant-allowlist + remove-others + RLS;
 *   (e) write a drift/convergence receipt to _auditLog.
 *
 * PURVIEW mode is opt-in (mip-graph-client may resolve the label graph). HONEST
 * gate if no storage/grant backend (no-vaporware.md). Idempotent; returns
 * counters. The target/diff computation is a PURE fn (computeReconcile) factored
 * out for tests — no Azure import on that path.
 */

import {
  enforceAccessGrant,
  revokeAccessGrant,
  revokeStructuredGrant,
  type AccessGrantInput,
  type PrincipalType,
} from './rbac-client';
import { listContainerRoleAssignments } from './rbac-client';
import { listWarehousePrincipals } from './access-policy-client';
import { showDatabasePrincipals, dropDatabasePrincipal, kustoConfigGate } from './kusto-client';
import { itemsContainer, auditLogContainer } from './cosmos-client';
import { resolveItemBackingScope } from './label-protection';
import type { ProtectionPolicy } from './protection-policy-client';
import type { WorkspaceItem } from '../types/workspace';

// ── PURE: target + diff computation (no Azure) ────────────────────────────────

export interface ReconcilePlan {
  /** Exhaustive allow-list incl. issuer — these principals SHOULD hold access. */
  target: string[];
  /** Live principals not in target — to revoke (positive-grant removal). */
  toRevoke: string[];
  /** Target principals not currently live — to grant. */
  toGrant: string[];
  /** True only when mode === 'purview' (sovereign needs no label graph). */
  purviewRequired: boolean;
  /** Propagated to obligations: export blocked for allow-listed principals too. */
  exportBlock: boolean;
}

/**
 * Best-effort principal classification (no Graph): UPN/email form is always a
 * User; a known live assignment carries its real type; bare oids default to
 * Group only when nothing else is known. The grant API treats principalType as
 * a hint Azure re-validates, but mislabeling a user oid as a Group can fail —
 * so never blanket-assume Group.
 */
export function detectPrincipalType(principal: string, liveTypes?: Map<string, PrincipalType>): PrincipalType {
  const known = liveTypes?.get(principal);
  if (known) return known;
  if (principal.includes('@')) return 'User';
  return 'Group';
}

/**
 * Pure: from the policy + the live principal set, compute the convergence plan.
 * target = allowPrincipals ∪ {issuer (if retainFullControl !== false)}.
 * Sovereign mode never needs Purview. The issuer is never in toRevoke.
 */
export function computeReconcile(policy: ProtectionPolicy, livePrincipals: string[]): ReconcilePlan {
  const target = new Set<string>((policy.allowPrincipals || []).filter(Boolean));
  if (policy.issuer && policy.retainFullControl !== false) target.add(policy.issuer);
  const live = new Set<string>((livePrincipals || []).filter(Boolean));
  const toGrant = [...target].filter((p) => !live.has(p));
  const toRevoke = [...live].filter((p) => !target.has(p) && p !== policy.issuer);
  return {
    target: [...target],
    toGrant,
    toRevoke,
    purviewRequired: policy.mode === 'purview',
    exportBlock: policy.exportBlock === true,
  };
}

// ── Reconcile (real grant converge or honest gate) ────────────────────────────

export interface ReconcileReceipt {
  status: 'converged' | 'partial' | 'gated';
  policyId: string;
  label: string;
  mode: ProtectionPolicy['mode'];
  itemsMatched: number;
  grantsAdded: number;
  grantsRevoked: number;
  errors: number;
  gate?: string;
  detail: string[];
  at: string;
}

/** Enumerate items carrying the policy label (sovereign: no Graph). */
async function listLabeledItems(policy: ProtectionPolicy): Promise<WorkspaceItem[]> {
  const c = await itemsContainer();
  const { resources } = await c.items
    .query<WorkspaceItem>({
      query:
        'SELECT * FROM c WHERE (c.state.sensitivityLabel = @l OR c.state.sensitivityLabelId = @l) ' +
        'AND (NOT IS_DEFINED(c.tenantId) OR c.tenantId = @t)',
      parameters: [
        { name: '@l', value: policy.label },
        { name: '@t', value: policy.tenantId },
      ],
    })
    .fetchAll();
  // domain/scope narrowing: if scope set, only that item id.
  if (policy.scope) return resources.filter((i) => i.id === policy.scope);
  return resources;
}

/**
 * Converge one policy. Real ADLS RBAC converge per labeled lakehouse container;
 * warehouse converges via Synapse SQL db-role membership (list + drop-others)
 * and kql-database via ADX database principals (list + drop-others). All three
 * grant the allow-list and revoke non-allowed; gated honestly when a backend is
 * unset. Returns counters; idempotent; writes a receipt to the audit log.
 */
export async function reconcilePolicy(policy: ProtectionPolicy): Promise<ReconcileReceipt> {
  const at = new Date().toISOString();
  const detail: string[] = [];
  let itemsMatched = 0;
  let grantsAdded = 0;
  let grantsRevoked = 0;
  let errors = 0;
  let gate: string | undefined;

  let items: WorkspaceItem[];
  try {
    items = await listLabeledItems(policy);
  } catch (e: any) {
    return {
      status: 'gated', policyId: policy.id, label: policy.label, mode: policy.mode,
      itemsMatched: 0, grantsAdded: 0, grantsRevoked: 0, errors: 0,
      gate: 'Cosmos items store is not reachable — cannot enumerate labeled items.',
      detail: [String(e?.message || e).slice(0, 200)], at,
    };
  }
  itemsMatched = items.length;

  for (const item of items) {
    const scope = resolveItemBackingScope(item);
    if ('pending' in scope) { detail.push(scope.pending); continue; }
    // Per-scope live enumeration → POSITIVE-grant converge: enforceAccessGrant
    // for missing target principals, revoke for live principals NOT in target.
    // ADLS = ARM role assignments; warehouse = Synapse SQL db-role members;
    // kql = ADX database principals. Each gates honestly when its backend is
    // unset (status:gated) — never a silent no-op (no-vaporware.md).
    let live: string[] = [];
    const liveTypes = new Map<string, PrincipalType>();
    const liveAssignmentIds = new Map<string, string>();
    // ADX rows keyed by objectId so a non-allowed principal is dropped by its
    // real role + FQN (apps cannot author Azure deny — remove-others only).
    const adxRevoke = new Map<string, { role: string; fqn: string }[]>();
    if (scope.scopeType === 'adls-container') {
      try {
        const assignments = await listContainerRoleAssignments(scope.scopeRef);
        live = assignments.map((a) => a.principalId);
        for (const a of assignments) {
          liveAssignmentIds.set(a.principalId, a.id);
          if (a.principalType === 'User' || a.principalType === 'Group' || a.principalType === 'ServicePrincipal') {
            liveTypes.set(a.principalId, a.principalType);
          }
        }
      }
      catch (e: any) { gate = gate || `ADLS RBAC list gated: ${String(e?.message || e).slice(0, 120)}`; }
    } else if (scope.scopeType === 'warehouse') {
      const wh = await listWarehousePrincipals().catch((e: any) => ({ gate: String(e?.message || e).slice(0, 120) }));
      if ('gate' in wh) gate = gate || wh.gate;
      else live = wh.principals;
    } else if (scope.scopeType === 'kql-database') {
      if (kustoConfigGate()) { gate = gate || 'ADX not configured: set LOOM_KUSTO_CLUSTER_URI to converge KQL-database access.'; }
      else {
        try {
          const rows = await showDatabasePrincipals(scope.scopeRef);
          for (const r of rows) {
            const key = r.objectId || r.fqn;
            if (!key) continue;
            const list = adxRevoke.get(key) || [];
            list.push({ role: r.role, fqn: r.fqn });
            adxRevoke.set(key, list);
          }
          live = [...adxRevoke.keys()];
        } catch (e: any) { gate = gate || `ADX principals list gated: ${String(e?.message || e).slice(0, 120)}`; }
      }
    }
    const plan = computeReconcile(policy, live);
    for (const principalId of plan.toGrant) {
      try {
        const input: AccessGrantInput = {
          principalId,
          principalType: detectPrincipalType(principalId, liveTypes),
          ...(principalId.includes('@') ? { principalName: principalId } : {}),
          scopeType: scope.scopeType, scopeRef: scope.scopeRef, permission: 'read',
        };
        const r = await enforceAccessGrant(input);
        if (r.status === 'active') grantsAdded++;
        else if (r.status === 'pending') gate = gate || r.detail;
        else errors++;
      } catch { errors++; }
    }
    for (const principalId of plan.toRevoke) {
      try {
        if (scope.scopeType === 'adls-container') {
          const assignmentId = liveAssignmentIds.get(principalId);
          if (assignmentId) { await revokeAccessGrant(assignmentId); grantsRevoked++; }
        } else if (scope.scopeType === 'warehouse') {
          // Drop the Entra DB user from every data-access role (one revoke).
          for (const permission of ['read', 'write', 'admin'] as const) {
            await revokeStructuredGrant({
              principalId, principalName: principalId, principalType: 'User',
              scopeType: 'warehouse', scopeRef: scope.scopeRef, permission,
            });
          }
          grantsRevoked++;
        } else if (scope.scopeType === 'kql-database') {
          for (const { role, fqn } of adxRevoke.get(principalId) || []) {
            await dropDatabasePrincipal(scope.scopeRef, role, fqn);
          }
          grantsRevoked++;
        }
      } catch { errors++; }
    }
  }

  const status: ReconcileReceipt['status'] = gate ? 'gated' : errors ? 'partial' : 'converged';
  const receipt: ReconcileReceipt = {
    status, policyId: policy.id, label: policy.label, mode: policy.mode,
    itemsMatched, grantsAdded, grantsRevoked, errors, gate, detail, at,
  };
  try {
    const aud = await auditLogContainer();
    await aud.items.upsert({
      id: `pp-reconcile:${policy.id}:${at}`, itemId: policy.resourceId,
      kind: 'protection-policy-reconcile', tenantId: policy.tenantId, ...receipt,
    });
  } catch { /* audit best-effort */ }
  return receipt;
}
