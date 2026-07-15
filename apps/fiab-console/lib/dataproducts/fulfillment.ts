/**
 * DP-10 — subscription FULFILLMENT resolver (PURE, framework-free).
 *
 * The zero-touch fulfillment step (AWS DataZone parity): when a subscription is
 * approved, resolve the product's OUTPUT-PORT backing resources (DP-8) into the
 * concrete Azure RBAC grant targets a `fulfillSubscription` step then provisions
 * via the real role-assignment path. This module is the pure resolver — it does
 * no I/O, so the mapping from ports/assets → grant targets is unit-testable and
 * the route stays a thin caller of `enforceAccessGrant`.
 *
 * Grounding: AWS DataZone/SageMaker automated subscription fulfillment; Purview
 * access-policy tiered approval. Azure-native: targets are ADLS containers/paths,
 * Synapse serverless DBs, or ADX databases — no Fabric/Power BI dependency.
 */

import type { AccessScopeType, AccessPermission } from '@/lib/azure/access-policy-client';

export interface GrantTarget {
  scopeType: AccessScopeType;
  /** Container / path / db the grant is scoped to (per scopeType semantics). */
  scopeRef: string;
  permission: AccessPermission;
  /** Where this target came from (an output port name or a data asset) — for the receipt. */
  source: string;
}

/** A raw output port as stored on `state.ports.output` (DP-8) or the legacy flat array. */
interface RawPort { name?: unknown; direction?: unknown; kind?: unknown; ref?: unknown }

/** Map an output-port kind → the RBAC scope it grants. */
function portToTarget(p: RawPort, permission: AccessPermission): GrantTarget | null {
  const name = typeof p.name === 'string' ? p.name : '';
  const kind = typeof p.kind === 'string' ? p.kind : '';
  const ref = typeof p.ref === 'string' ? p.ref.trim() : '';
  if (!ref) return null; // nothing concrete to grant against
  switch (kind) {
    case 'adls':
    case 'delta':
      // ref = container or abfss path.
      return { scopeType: ref.startsWith('abfss://') || ref.includes('/') ? 'adls-path' : 'adls-container', scopeRef: ref, permission, source: `output port '${name || kind}'` };
    case 'sql-endpoint':
      return { scopeType: 'warehouse', scopeRef: ref, permission, source: `output port '${name || kind}'` };
    case 'adx':
      return { scopeType: 'kql-database', scopeRef: ref, permission, source: `output port '${name || kind}'` };
    // 'rest' and unknown kinds have no direct RBAC target.
    default:
      return null;
  }
}

/** Read the output ports off state, tolerating the structured model OR the legacy flat array. */
function outputPorts(state: Record<string, unknown>): RawPort[] {
  const ports = state.ports;
  if (Array.isArray(ports)) return (ports as RawPort[]).filter((p) => p?.direction === 'output');
  if (ports && typeof ports === 'object') {
    const out = (ports as Record<string, unknown>).output;
    return Array.isArray(out) ? (out as RawPort[]) : [];
  }
  return [];
}

/** A data asset with an ADLS-style qualified name → an adls-path grant (fallback). */
function assetToTarget(a: unknown, permission: AccessPermission): GrantTarget | null {
  if (!a || typeof a !== 'object') return null;
  const qn = (a as any).qualifiedName;
  const name = (a as any).name;
  if (typeof qn === 'string' && qn.startsWith('abfss://')) {
    return { scopeType: 'adls-path', scopeRef: qn, permission, source: `asset '${name || qn}'` };
  }
  return null;
}

/**
 * Resolve every concrete grant target for a product from its OUTPUT ports first
 * (DP-8), falling back to any ADLS-qualified data assets. De-duplicates by
 * scopeType+scopeRef. Returns [] when nothing is resolvable — the route then
 * honest-gates ("declare an output port on the Ports tab").
 */
export function resolveGrantTargets(
  state: Record<string, unknown> | undefined,
  permission: AccessPermission = 'read',
): GrantTarget[] {
  const st = state ?? {};
  const targets: GrantTarget[] = [];
  for (const p of outputPorts(st)) { const t = portToTarget(p, permission); if (t) targets.push(t); }
  if (targets.length === 0) {
    const assets = Array.isArray(st.dataAssets) ? st.dataAssets : [];
    for (const a of assets) { const t = assetToTarget(a, permission); if (t) targets.push(t); }
  }
  // De-dup.
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.scopeType}:${t.scopeRef}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The persisted attestations a requester accepts (DP-10 request form). */
export interface RequestAttestations {
  noCopy?: boolean;
  termsOfUse?: boolean;
  custom?: boolean;
}

/** Overall fulfillment status from a set of per-target grant results. */
export function rollUpFulfillment(results: Array<{ status: 'active' | 'pending' | 'error' }>): 'provisioned' | 'partial' | 'failed' | 'none' {
  if (results.length === 0) return 'none';
  if (results.some((r) => r.status === 'error')) return 'failed';
  if (results.some((r) => r.status === 'pending')) return 'partial';
  return 'provisioned';
}
