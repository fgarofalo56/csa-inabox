'use client';

/**
 * /admin/mcp-servers — the MCP Servers catalog: the single, first-class home to
 * browse + deploy curated MCP servers, manage what's deployed, and connect
 * external MCP endpoints.
 *
 * Everything here is wired to the REAL routes under /api/admin/mcp-servers/*:
 *   • McpServersPanel (lib/components/admin/mcp-servers-panel) renders:
 *       - the curated "Browse library" catalog (McpCatalogBrowser) — card grid
 *         of the vetted, gov-safe servers from lib/mcp/catalog, each with a
 *         guided per-field Deploy wizard that POSTs /api/admin/mcp-servers/deploy
 *         (internal Azure Container App + per-field Key Vault secretRef + auto
 *         registration). Secrets go to Key Vault, never plaintext in the form.
 *       - the "Deployed from library" table — live status
 *         (/api/admin/mcp-servers/deployed/status) + teardown
 *         (/api/admin/mcp-servers/deployed/teardown), each row showing the
 *         Container App + provisioning state.
 *       - the Loom built-in MCP card (/api/admin/mcp-servers/builtin) and the
 *         stdio→HTTP/SSE bridge card (/api/admin/mcp-servers/bridge) for
 *         one-click registration.
 *       - the External MCP registry — add / edit / test-connection
 *         (/api/admin/mcp-servers/test-connection) / delete, persisted via
 *         /api/admin/mcp-servers (CRUD).
 *   • IqMcpPanel publishes Loom's own unified surface as ONE MCP endpoint
 *     (/api/iq/mcp) for external agents to ground on.
 *
 * Honest Fluent MessageBar gates (named env var / role / bicep module) come from
 * the panels themselves whenever a prerequisite (Container Apps env, Key Vault,
 * built-in server URL, bridge URL, IQ enablement) is missing — never a raw error
 * or an empty stub. Azure-native end-to-end, no Microsoft Fabric dependency.
 */

import { AdminShell } from '@/lib/components/admin-shell';
import { McpServersPanel } from '@/lib/components/admin/mcp-servers-panel';
import { IqMcpPanel } from '@/lib/components/admin/iq-mcp-panel';

export default function McpServersPage() {
  return (
    <AdminShell sectionTitle="MCP Servers">
      <McpServersPanel />
      <IqMcpPanel />
    </AdminShell>
  );
}
