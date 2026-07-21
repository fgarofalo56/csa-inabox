/**
 * agent-registry-store — WS-9 Cosmos CRUD for the Sovereign Agent Mesh registry.
 *
 * Persists `MeshAgentDef` rows in the `agent-registry` container (PK /tenantId).
 * The mesh is DEFAULT-ON (loom_default_on_opt_out): the FIRST time a tenant reads
 * its mesh with no agents registered, the built-in governance / pipeline / BI /
 * orchestrator trio is seeded so the mesh is functional day-one. Everything is a
 * REAL Cosmos read/write (no-vaporware.md) — no mock arrays.
 *
 * The default egress profile is derived from `LOOM_MESH_PROFILE` (or the cloud:
 * a Gov cloud seeds 'gov'), so a sovereign / air-gapped deployment starts its
 * agents fail-closed.
 */

import { agentRegistryContainer } from './cosmos-client';
import { isGovCloud } from './cloud-endpoints';
import {
  builtinMeshAgents,
  normalizeMeshAgent,
  type MeshAgentDef,
  type MeshEgressProfile,
} from '@/lib/copilot/agent-registry';

/** Resolve the deployment's default mesh egress profile (opt-out, not opt-in).
 *  `LOOM_MESH_PROFILE` overrides; otherwise a Gov cloud defaults to 'gov'. */
export function defaultMeshProfile(): MeshEgressProfile {
  const raw = (process.env.LOOM_MESH_PROFILE || '').trim().toLowerCase();
  if (raw === 'air-gap' || raw === 'airgap') return 'air-gap';
  if (raw === 'gov') return 'gov';
  if (raw === 'commercial') return 'commercial';
  return isGovCloud() ? 'gov' : 'commercial';
}

/** The operator egress allow-list suffixes shared by mesh + MCP + A2A egress. */
export function meshEgressAllowSuffixes(): string[] {
  const raw = `${process.env.LOOM_A2A_EGRESS_ALLOW || ''},${process.env.LOOM_MCP_EGRESS_ALLOW || ''}`;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter(Boolean);
}

/** Persisted doc shape (MeshAgentDef + a discriminator + partition key already on it). */
type MeshAgentDoc = MeshAgentDef & { docType: 'mesh-agent' };

function toDoc(a: MeshAgentDef): MeshAgentDoc {
  return { ...a, docType: 'mesh-agent' };
}

/**
 * List every registered mesh agent for a tenant. Seeds the built-in trio on first
 * access (empty registry) so the mesh works day-one.
 */
export async function listMeshAgents(tenantId: string): Promise<MeshAgentDef[]> {
  const c = await agentRegistryContainer();
  const { resources } = await c.items
    .query<MeshAgentDoc>({
      query: "SELECT * FROM c WHERE c.tenantId = @t AND c.docType = 'mesh-agent'",
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  const rows = resources
    .map((r) => normalizeMeshAgent(r, tenantId))
    .filter((r): r is MeshAgentDef => !!r);
  if (rows.length > 0) return sortAgents(rows);

  // Empty registry → seed the built-in trio (default-on).
  const seeded = await seedBuiltinMeshAgents(tenantId);
  return sortAgents(seeded);
}

/** Order: orchestrator first (the lead), then governance / pipeline / bi, then the rest. */
function sortAgents(rows: MeshAgentDef[]): MeshAgentDef[] {
  const rank: Record<string, number> = { orchestrator: 0, governance: 1, pipeline: 2, bi: 3, custom: 4 };
  return [...rows].sort((a, b) => (rank[a.kind] ?? 5) - (rank[b.kind] ?? 5) || a.name.localeCompare(b.name));
}

/** Get one mesh agent by id (tenant-scoped). */
export async function getMeshAgent(tenantId: string, id: string): Promise<MeshAgentDef | null> {
  const c = await agentRegistryContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<MeshAgentDoc>();
    if (!resource || resource.docType !== 'mesh-agent') return null;
    return normalizeMeshAgent(resource, tenantId);
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Create / update a mesh agent (tenant-scoped, upsert). */
export async function upsertMeshAgent(agent: MeshAgentDef): Promise<MeshAgentDef> {
  const c = await agentRegistryContainer();
  const now = new Date().toISOString();
  const doc = toDoc({ ...agent, createdAt: agent.createdAt || now, updatedAt: now });
  const { resource } = await c.items.upsert<MeshAgentDoc>(doc);
  return normalizeMeshAgent(resource, agent.tenantId) || agent;
}

/** Delete a mesh agent (tenant-scoped). Built-in agents can be deleted then re-seeded. */
export async function deleteMeshAgent(tenantId: string, id: string): Promise<void> {
  const c = await agentRegistryContainer();
  try {
    await c.item(id, tenantId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/**
 * Seed the built-in governance / pipeline / BI / orchestrator agents for a tenant
 * (idempotent — only creates the ones that don't already exist). Returns the full
 * current set. The seed profile is the deployment default (Gov → 'gov').
 */
export async function seedBuiltinMeshAgents(tenantId: string): Promise<MeshAgentDef[]> {
  const c = await agentRegistryContainer();
  const profile = defaultMeshProfile();
  const builtins = builtinMeshAgents(tenantId, profile);
  const out: MeshAgentDef[] = [];
  for (const a of builtins) {
    try {
      const { resource } = await c.item(a.id, tenantId).read<MeshAgentDoc>();
      if (resource && resource.docType === 'mesh-agent') {
        out.push(normalizeMeshAgent(resource, tenantId) || a);
        continue;
      }
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    const { resource } = await c.items.upsert<MeshAgentDoc>(toDoc(a));
    out.push(normalizeMeshAgent(resource, tenantId) || a);
  }
  return out;
}
