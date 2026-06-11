/**
 * GET /api/admin/mcp-catalog — the vetted, fixed allow-list of deployable MCP
 * servers (see lib/azure/mcp-catalog.ts). Drives the admin "Deploy from catalog"
 * dropdown so a tenant admin can only stand up servers we've gov-/license-vetted
 * (no free-form image strings — per the no-freeform-config rule).
 *
 *   → { ok: true, catalog: McpCatalogEntry[], deployed: McpServerConfigDoc[],
 *       deployConfigured: boolean, gate? }
 *
 * `deployed` is every catalog-sourced server for the tenant (ANY enabled state —
 * a freshly-deployed server is persisted disabled until confirmed healthy, so it
 * won't appear in the enabled-only /api/admin/mcp-servers list). `deployConfigured`
 * reflects whether the Container Apps platform is wired (LOOM_SUBSCRIPTION_ID /
 * LOOM_ADMIN_RG / LOOM_CAE_ID). When false the UI shows an honest MessageBar
 * naming the missing env — the catalog still renders.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { catalogForUi } from '@/lib/azure/mcp-catalog';
import { readMcpDeployConfig, McpDeployNotConfiguredError } from '@/lib/azure/mcp-deploy-client';
import { mcpServersContainer } from '@/lib/azure/cosmos-client';
import type { McpServerConfigDoc } from '@/lib/types/mcp-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

  let deployConfigured = false;
  let gate: { missing: string[]; message: string } | undefined;
  try {
    readMcpDeployConfig();
    deployConfigured = true;
  } catch (e: any) {
    if (e instanceof McpDeployNotConfiguredError) {
      gate = { missing: e.missing, message: e.hint };
    } else {
      gate = { missing: [], message: e?.message || String(e) };
    }
  }

  // Catalog-sourced servers, any enabled state (deploys start disabled).
  let deployed: McpServerConfigDoc[] = [];
  try {
    const c = await mcpServersContainer();
    const q = {
      query: "SELECT * FROM c WHERE c.tenantId = @t AND c.source = 'catalog' ORDER BY c.name",
      parameters: [{ name: '@t', value: tenantId }],
    };
    const { resources } = await c.items.query<McpServerConfigDoc>(q).fetchAll();
    deployed = resources || [];
  } catch { /* listing is best-effort; the catalog still renders */ }

  return NextResponse.json({ ok: true, catalog: catalogForUi(), deployed, deployConfigured, gate });
}

