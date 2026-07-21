/**
 * GET /api/mesh/catalog — WS-9 Tier-0 air-gap-safe tool catalog + profile info.
 *
 * Returns the native in-VNet tool kinds + the air-gap-safe MCP servers selectable
 * for a sovereign / air-gap agent (zero external egress), the deployment's default
 * egress profile, whether Gov AOAI direct is in effect, and the current mesh egress
 * allow-list — so the mesh UI can render the sovereign tool surface honestly.
 */
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized } from '@/lib/api/respond';
import { tier0ToolCatalog, MESH_EGRESS_PROFILES } from '@/lib/copilot/agent-registry';
import { defaultMeshProfile, meshEgressAllowSuffixes } from '@/lib/azure/agent-registry-store';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const govAoaiDirect = isGovCloud();
  const catalog = tier0ToolCatalog(govAoaiDirect);
  return apiOk({
    catalog,
    profiles: MESH_EGRESS_PROFILES,
    defaultProfile: defaultMeshProfile(),
    govAoaiDirect,
    egressAllowSuffixes: meshEgressAllowSuffixes(),
  });
}
