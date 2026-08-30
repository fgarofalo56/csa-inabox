/**
 * Workspace → Power BI workspace mapping (WS-PBIMAP).
 *
 * An operator can bind a Loom workspace to an EXISTING Power BI / Fabric
 * workspace so PBI integrations (report publish, embed, semantic-model refresh)
 * target the right PBI workspace — under user-passthrough (OBO) auth, which is
 * built separately (see the PBI-OBO work item). The mapping lives on the
 * workspace Cosmos doc (`pbiWorkspaceMapping`), persisted like every other
 * workspace setting; no new container.
 *
 * This module is the single source of truth for the mapping SHAPE + validation +
 * a server-side READ helper the OBO integration consumes. Per
 * no-fabric-dependency.md the mapping is strictly opt-in — a workspace with no
 * mapping is fully functional on the Azure-native path.
 */
import { loadWorkspaceAdmin } from '@/lib/clients/workspaces-client';
// THE tenant comparison — one implementation, never a private copy here (#3833).
import { sameTenantConfirmed, tenantUnconfirmedCause } from '@/lib/auth/tenant-boundary';
import type { Workspace } from '@/lib/types/workspace';

export interface PbiWorkspaceMapping {
  pbiWorkspaceId: string;
  pbiWorkspaceName?: string;
  mappedBy: string;
  mappedAt: string;
}

/** Power BI workspace (group) ids are GUIDs. */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isPbiWorkspaceId(v: unknown): v is string {
  return typeof v === 'string' && GUID_RE.test(v.trim());
}

/**
 * Mapping-aware precedence for the TARGET Power BI / Fabric workspace of an
 * item deploy / publish. This is the single source of truth for "which PBI
 * workspace does this item land in", mirroring how a bound Synapse workspace
 * targets its items:
 *
 *   1. `explicit`   — a per-item binding (`state.fabricWorkspaceId`). Most
 *                     specific, so it always wins.
 *   2. `mapped`     — the Loom-workspace → Power BI-workspace mapping
 *                     (`pbiWorkspaceMapping.pbiWorkspaceId`). When an operator
 *                     maps a Loom workspace to a PBI workspace in Settings, every
 *                     PBI item in that workspace deploys there by default.
 *   3. `envDefault` — the platform default (`LOOM_DEFAULT_FABRIC_WORKSPACE`).
 *
 * Pure + trimmed; returns `undefined` when nothing is bound (the caller then
 * shows the honest "no workspace bound" gate — never a hard failure, and the
 * Azure-native default path is unaffected per no-fabric-dependency.md).
 */
export function pickPbiWorkspaceId(opts: {
  explicit?: string | null;
  mapped?: string | null;
  envDefault?: string | null;
}): string | undefined {
  const pick = (v?: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return pick(opts.explicit) ?? pick(opts.mapped) ?? pick(opts.envDefault);
}

/**
 * Read the Power BI workspace mapping for a Loom workspace, or `null` when
 * unmapped or when the workspace is not CONFIRMED to be in the caller's tenant.
 *
 * ── #3833 MEMBER 3, TRIAGED AND CLOSED ─────────────────────────────────────
 * #3833 listed this as the third member of the tenant-admin bypass family
 * (Shape B: `loadWorkspaceAdmin(id)` is a bare cross-partition `SELECT *` with
 * NO tenant predicate, so a GUID from any tenant resolves) and explicitly said
 * "I have not checked its callers … do not assume the safe answer."
 *
 * MEASURED at head — `grep -rn getPbiWorkspaceMapping apps/fiab-console` — there
 * is exactly ONE non-test caller: `app/api/items/report/[id]/publish/route.ts`,
 * which passes `item.workspaceId` off an item loaded by
 * `loadContentBackedItem(reportId, 'report', session.claims.oid)` — an
 * OWNER-CHECKED load. So it was NOT reachable with an attacker-chosen id.
 *
 * THAT IS NOT A REASON TO LEAVE IT. It was a property of the CALLER, not of this
 * function, and `workspaces-client.ts`'s own header records that the previous
 * "the one caller gates it" claim about `loadWorkspaceAdmin` was FALSE and had to
 * be corrected (#3826). A safety argument that lives in someone else's file is
 * one refactor away from being wrong silently. The boundary is therefore applied
 * HERE, where the unfiltered read is:
 *
 *   - `boundary` is REQUIRED and has no default, so a new call site is a COMPILE
 *     ERROR rather than a silent hole — the same device `WorkspaceAccessOpts`
 *     uses in `lib/auth/workspace-access.ts`.
 *   - The comparison is `sameTenantConfirmed` from `lib/auth/tenant-boundary.ts`
 *     — the ONE implementation. A fourth private copy of the tid comparison is
 *     precisely what produced #3823, #3825, #3840 and #3843, and section 10 of
 *     `scripts/ci/check-tid-boundary-chokepoint.mjs` fails the build on one.
 *   - It FAILS CLOSED on `unconfirmed` (either tid absent). Read that as
 *     "unmapped", which is a fully supported state: Power BI is opt-in
 *     (no-fabric-dependency.md), the publish path falls through to the platform
 *     default and then to the Azure-native org gallery, and nothing errors.
 *
 * WHAT THIS IS NOT. It is not an authorization decision — the canonical answer
 * to "may this caller touch this workspace" remains `resolveWorkspaceAccessByOid`
 * and this function deliberately does not re-implement it. It is the narrower
 * claim the read needs: the record it just fanned across partitions belongs to
 * the caller's own tenant. The caller must still have authorized the workspace
 * or the item; this only ensures a cross-TENANT id cannot disclose a mapping.
 */
export async function getPbiWorkspaceMapping(
  workspaceId: string,
  boundary: {
    /** The caller's Entra tenant id — normally `session.claims.tid`. */
    callerTid: string | undefined;
  },
): Promise<PbiWorkspaceMapping | null> {
  const ws: Workspace | null = await loadWorkspaceAdmin(workspaceId);
  if (!ws) return null;
  if (!sameTenantConfirmed(boundary.callerTid, ws.tid)) {
    // Not thrown and not surfaced: to this caller the mapping simply does not
    // exist. Logged server-side so a real cross-tenant probe is not silent, and
    // the log states only what was OBSERVED — never the other tenant's id (R7).
    console.warn(
      `[pbi-workspace-mapping] refused to disclose the Power BI mapping for workspace ${workspaceId}: `
      + `its tenancy was not confirmed as the caller's (${tenantUnconfirmedCause(boundary.callerTid, ws.tid)
        ?? 'the record belongs to a different Entra tenant'}). Reporting it as unmapped.`,
    );
    return null;
  }
  const m = ws.pbiWorkspaceMapping;
  if (!m || !isPbiWorkspaceId(m.pbiWorkspaceId)) return null;
  return {
    pbiWorkspaceId: m.pbiWorkspaceId,
    pbiWorkspaceName: m.pbiWorkspaceName,
    mappedBy: m.mappedBy,
    mappedAt: m.mappedAt,
  };
}
