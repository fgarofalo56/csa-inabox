/**
 * /admin/mcp-servers - W1-5: redirects to the API Gateway hub's MCP servers tab when the plane is on.
 *
 * LOOM_APIPLANE_ENABLED=false keeps the previous page primary: its body now lives in
 * app/admin/api-gateway/_legacy/mcp-servers-legacy.tsx, unchanged. Dynamic so the flag is read per request.
 */
import { redirect } from 'next/navigation';
import LegacyMcpServersPage from '../api-gateway/_legacy/mcp-servers-legacy';
import { HUB_PATH, legacyRedirectTarget } from '../api-gateway/_lib/flag';

export const dynamic = 'force-dynamic';

export default function McpServersPage() {
  const target = legacyRedirectTarget(`${HUB_PATH}?tab=mcp`);
  if (target) redirect(target);
  return <LegacyMcpServersPage />;
}
