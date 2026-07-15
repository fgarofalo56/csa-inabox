# MCP Servers admin page

> **Surface:** `/admin/mcp-servers`
> **BFF:** `apps/fiab-console/app/api/admin/mcp-servers/{route.ts,builtin,deploy,deployed,bridge,ms-remote,powerbi,test-connection}`
> **Store:** Cosmos `mcp-servers` (PK `/tenantId`)

The **MCP Servers** page is the single home for the Model Context Protocol tools
Copilot can call. An operator browses a curated catalog of gov-safe MCP servers,
deploys them one-click onto Azure Container Apps (with Key Vault `secretRef`
credentials and Azure Files state), manages the deployed servers with live status
and teardown, and connects external MCP endpoints.

## What you can do

- **Browse the catalog** — `/api/admin/mcp-servers/builtin` lists the curated,
  gov-safe MCP servers (each vetted to run inside the Loom VNet).
- **Deploy** — `/api/admin/mcp-servers/deploy` provisions a server as an ACA app
  with KV secretRef secrets + an Azure Files share for state; **Enable-all** rolls
  the full Microsoft MCP set.
- **Manage deployed** — `/api/admin/mcp-servers/deployed` shows live status and
  supports teardown.
- **Connect external** — register a remote MCP endpoint (`ms-remote`, `bridge`,
  `powerbi`) and **Test connection** before Copilot uses it.

## Backend

| Control | Backend |
|---|---|
| Catalog | `lib/azure/mcp-catalog.ts` (built-in descriptors) |
| Deploy / teardown | ARM `Microsoft.App/containerApps` + Key Vault + Azure Files |
| Registry | Cosmos `mcp-servers` (PK `/tenantId`) |
| Test connection | Live MCP handshake against the endpoint |

## RBAC & honest gates

Tenant-admin. Deploy needs the Console UAMI to hold **Contributor** on the ACA
environment + **Key Vault Secrets User**. A server that requires a credential not
yet in Key Vault surfaces the exact secret name to add; nothing is faked.

## Related

- [API Management](api-management.md) · [Runtime configuration](env-config.md)
