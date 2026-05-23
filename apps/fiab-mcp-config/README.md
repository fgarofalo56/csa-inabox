# Loom MCP server (self-hosted Azure MCP)

Self-hosted Azure MCP server (from canonical `microsoft/mcp` repo)
configured for CSA Loom's deployment + management tools.

**Status**: SCAFFOLDED. Real container build + tool catalog config
per [PRP-05](../../PRPs/active/csa-loom/PRP-05-mcp-server.md).

## What it does

Self-hosts the canonical `microsoft/mcp/servers/Azure.Mcp.Server`
inside the Loom Admin Plane. Exposes 40+ Azure tools (resource group
CRUD, deployment, role assignment, Key Vault, ACR, etc.) as MCP
tools callable from Loom Setup Wizard + Loom Copilot.

## Deployment

- Commercial / GCC: Container App with Managed Identity
- GCC-High / IL5: AKS workload (Container Apps not at IL4+)

## Auth

`DefaultAzureCredential` chain. Workaround for the @azure/mcp Node MI
bug: explicitly set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_AUTHORITY_HOST` env vars.

Gov tenants: `AZURE_AUTHORITY_HOST=login.microsoftonline.us` +
`azureEnvironment=AzureUSGovernment`.

## Tool catalog whitelisting

`tools-commercial.yaml` and `tools-gov.yaml` define the allowed tool
set per boundary. Tools that hit `*.azure.com` (vs `*.azure.us`)
are disabled in Gov.

## JIT elevation flow

MCP MI starts with `Reader` on each Loom sub. For deployments,
Loom Setup Wizard activates PIM-for-Groups membership of `Loom MCP
Operators` → grants `Contributor` for 2 hours. After deploy, MI
reduces to RG-level `Contributor` only.

## Scaffolded structure

```
apps/fiab-mcp-config/
├── README.md
├── Dockerfile.wrapper        # wraps microsoft/mcp upstream image
├── tools-commercial.yaml     # tool catalog allow-list
├── tools-gov.yaml            # Gov-restricted tool catalog
└── entrypoint.sh             # env var setup for MI workaround
```

## Related

- [MCP troubleshooting runbook](../../docs/fiab/runbooks/mcp-troubleshooting.md)
- [PRP-05](../../PRPs/active/csa-loom/PRP-05-mcp-server.md)
- Upstream: [`microsoft/mcp/servers/Azure.Mcp.Server`](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/README.md)
- Research: [`temp/fiab-research/06-copilot-driven-deploy.md` §2.1](../../temp/fiab-research/06-copilot-driven-deploy.md)
