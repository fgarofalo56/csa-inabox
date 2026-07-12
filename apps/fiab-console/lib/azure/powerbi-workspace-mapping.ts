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
 * unmapped. Server-side ONLY — cross-partition point-read by workspace id (the
 * account-scoped Cosmos role authorizes the fan-out). Intended for the PBI-OBO
 * integration to resolve the target PBI workspace before it acquires an OBO
 * token; it never fabricates a mapping.
 */
export async function getPbiWorkspaceMapping(workspaceId: string): Promise<PbiWorkspaceMapping | null> {
  const ws: Workspace | null = await loadWorkspaceAdmin(workspaceId);
  const m = ws?.pbiWorkspaceMapping;
  if (!m || !isPbiWorkspaceId(m.pbiWorkspaceId)) return null;
  return {
    pbiWorkspaceId: m.pbiWorkspaceId,
    pbiWorkspaceName: m.pbiWorkspaceName,
    mappedBy: m.mappedBy,
    mappedAt: m.mappedAt,
  };
}
