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
 * This page is also the home of the **Microsoft MCP + agent-skills family**,
 * surfaced WITHOUT a parallel system by extending the existing plumbing:
 *   • Curated Microsoft-official MCP servers (github.com/microsoft/mcp) appear
 *     in the same McpCatalogBrowser library (source 'microsoft', deployed to an
 *     internal Azure Container App with Key Vault secretRefs), and the
 *     Microsoft-hosted remote servers connect through the panel's remote-builtin
 *     cards (the generalized REMOTE_BUILTIN_MCP_CATALOG in lib/mcp/catalog, the
 *     same shape as the Power BI opt-in) via /api/admin/mcp-servers/ms-remote.
 *   • ~30 Microsoft agent skills (github.com/microsoft/skills, in
 *     lib/copilot/ms-skills) ground Loom Copilot in Azure-native tools and light
 *     up the matching MS MCP tools once a server is connected.
 *   • no-fabric-dependency: Microsoft Learn (https://learn.microsoft.com/api/mcp,
 *     no auth) is the SOLE default-on server; every other server is strictly
 *     opt-in (per-user Microsoft Entra On-Behalf-Of, or a GitHub PAT in Key
 *     Vault), and Microsoft Fabric / Power BI MCP servers never sit on a default
 *     path. No api.fabric / api.powerbi host is reached unless explicitly opted in.
 *
 * Honest Fluent MessageBar gates (named env var / role / scope / Key Vault secret
 * / bicep module) come from the panels themselves whenever a prerequisite
 * (Container Apps env, Key Vault, built-in server URL, bridge URL, OBO client id,
 * IQ enablement) is missing — never a raw error or an empty stub. Azure-native
 * end-to-end, no Microsoft Fabric dependency.
 */

import { AdminShell } from '@/lib/components/admin-shell';
import { McpServersPanel } from '@/lib/components/admin/mcp-servers-panel';
import { IqMcpPanel } from '@/lib/components/admin/iq-mcp-panel';
import { Body1, Caption1, Link, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  intro: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  lead: { color: tokens.colorNeutralForeground1 },
  attribution: { color: tokens.colorNeutralForeground3 },
  link: { fontSize: tokens.fontSizeBase200 },
});

export default function McpServersPage() {
  const styles = useStyles();
  return (
    <AdminShell sectionTitle="MCP Servers">
      {/* Page intro — names the Microsoft MCP + agent-skills family so the page
          title/intro copy reflects what the panel surfaces (web3-ui Loom tokens,
          no-fabric-dependency: Learn is the only default-on entry). */}
      <div className={styles.intro}>
        <Body1 className={styles.lead}>
          Browse, deploy, and connect Model Context Protocol (MCP) servers so Loom Copilot can
          call their tools — including the curated{' '}
          <Link className={styles.link} href="https://github.com/microsoft/mcp" target="_blank" rel="noreferrer">
            Microsoft MCP
          </Link>{' '}
          servers and ~30{' '}
          <Link className={styles.link} href="https://github.com/microsoft/skills" target="_blank" rel="noreferrer">
            Microsoft agent skills
          </Link>{' '}
          that ground Copilot in Azure-native tools.
        </Body1>
        <Caption1 className={styles.attribution}>
          Microsoft Learn is connected day-one — no auth, no Microsoft Fabric dependency. Every
          other server is strictly opt-in (per-user Microsoft Entra On-Behalf-Of, or a GitHub PAT
          stored in Key Vault) and shows an honest gate naming the exact env var, scope, or secret
          to provide; Microsoft Fabric / Power BI MCP servers never sit on a default path.
        </Caption1>
      </div>
      <McpServersPanel />
      <IqMcpPanel />
    </AdminShell>
  );
}
