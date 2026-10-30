/** GET /api/admin/api-gateway/environments/findings -> advisory findings (never block). Gateways x MCP servers now; W2 adds endpoint producers. */
import { apiOk } from '@/lib/api/respond';
import { getFindingsSource } from '@/lib/api-gateway/environments/deps';
import { runFindings } from '@/lib/api-gateway/environments/findings';
import { adminContext, isResponse, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { loadCatalog, settingsOf } from '@/lib/api-gateway/environments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
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
}
