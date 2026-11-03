/** GET /api/admin/api-gateway/environments/findings -> advisory findings (never block). Gateways x MCP servers now; W2 adds endpoint producers. */
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { apiOk } from '@/lib/api/respond';
import { getFindingsSource } from '@/lib/api-gateway/environments/deps';
import { runFindings } from '@/lib/api-gateway/environments/findings';
import { adminContext, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { loadCatalog, settingsOf } from '@/lib/api-gateway/environments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withPlaneGroupHint(withCapability(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session }) => {
  const ctx = adminContext(session);
  try {
    const source = getFindingsSource();
    if (!ctx.deps.classification || !source) {
      return apiOk({ data: { findings: [], available: false } });
    }
    const catalog = await loadCatalog(ctx.deps, ctx.tenantId);
    const [gateways, gatewayMcpServers, mcpEndpoints] = await Promise.all([
      ctx.deps.classification.list(ctx.tenantId, 'gateway'),
      source.gatewayMcpServers(ctx.tenantId),
      source.mcpEndpoints(ctx.tenantId),
    ]);
    return apiOk({ data: { findings: runFindings({ gateways, gatewayMcpServers, mcpEndpoints, settings: settingsOf(catalog) }), available: true } });
  } catch (e) {
    return serverError(e);
  }
}));
