# PRP-05 — Self-Hosted Azure MCP Server

## Context

The Loom Setup Wizard + Loom Copilot need a privileged tool layer to
execute ARM operations on the customer's behalf. The canonical Microsoft
Azure MCP server (`microsoft/mcp/servers/Azure.Mcp.Server`) is the
right starting point; we self-host it inside the customer's Admin
Plane for boundary-safe operation.

PRD ref: `temp/fiab-prd/06-custom-apps.md` (MCP backing tier),
`temp/fiab-prd/07-deployment.md` §7.7; AMENDMENTS §A8.

## Goal

Self-hosted Azure MCP server running inside the Admin Plane's
Container App environment (Commercial / GCC) or AKS cluster (GCC-High
/ IL5). Configured for the customer's cloud + tenant. Acts as the
tool catalog for the Wizard, Copilot, and (future v1.1) update channel.

## Acceptance criteria

- [ ] Container image based on `microsoft/mcp/servers/Azure.Mcp.Server`
  pinned to a stable release tag
- [ ] Deployed via PRP-02 Bicep `mcp-app.bicep` module
- [ ] User-assigned Managed Identity (`Loom MCP Server MI`) configured
  with:
  - Standing: Reader on every FiaB sub + Key Vault Secrets User
  - PIM-eligible: Contributor on each sub via `FiaB MCP Operators`
    Entra group membership
- [ ] `AZURE_AUTHORITY_HOST` set to `login.microsoftonline.us` for Gov
  tiers
- [ ] Sovereign cloud env: `azureEnvironment=AzureUSGovernment` for Gov
- [ ] Workaround applied for the `@azure/mcp` Node MI bug (set
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_AUTHORITY_HOST` explicitly
  so `EnvironmentCredential` lights up)
- [ ] Tool catalog enabled: group_*, deployment_*, role_assignment_*,
  keyvault_*, storage_*, foundry_models_deploy, region_availability
- [ ] Tools disabled that would call commercial-only endpoints when
  deployed in Gov (block `*.azure.com` egress at NSG level)
- [ ] Ingress: Private Link only (within Admin Plane hub VNet);
  authenticated via Entra (caller token validated)
- [ ] Health endpoint `/health` returning 200
- [ ] Telemetry to Application Insights (per-tool-call latency,
  success rate, caller UPN)

## Validation gates

- Smoke test: list resource groups via `azmcp_group_list` against
  staging sub; expect non-empty array
- Smoke test: dry-run a Bicep deploy via `azmcp extension az` proxy
- Gov test: same against `usgovvirginia` sub using `limitlessdata_deploy`
  SP cred
- Egress test: assert outbound to `*.azure.com` blocked in Gov by NSG
- Identity test: PIM elevation flow grants Contributor for 2h then
  expires

## Implementation outline

1. Container image: pull from `microsoft/mcp` upstream, pin tag
2. Bicep module `mcp-app.bicep` deploys:
   - Container App (Commercial / GCC) or AKS Deployment (GCC-High)
   - UAMI with policies above
   - Entra group `FiaB MCP Operators` membership eligibility
   - Private ingress
   - App Insights binding
3. Document tool-catalog whitelist in `apps/fiab-mcp-config/` for
   per-boundary differences
4. Emit runbook `docs/fiab/operations/mcp-troubleshooting.md` (Part of
   PRP-17)
5. Wire from PRP-03 Console + PRP-04 Wizard via authenticated HTTP
   POST (MCP-over-HTTP transport)

## File changes

```
apps/fiab-mcp-config/                                    created
apps/fiab-mcp-config/tools-commercial.yaml               created
apps/fiab-mcp-config/tools-gov.yaml                      created
apps/fiab-mcp-config/Dockerfile.wrapper                  created
platform/fiab/bicep/modules/admin-plane/mcp-app.bicep    created
.github/workflows/build-fiab-mcp.yml                     created
docs/fiab/operations/mcp-troubleshooting.md              created (by PRP-17)
```

## Open questions / risks

- Azure MCP server release cadence is weekly/bi-weekly; pin to a
  stable tag and update intentionally rather than tracking main
- `azmcp_deployment_create` first-class tool not yet shipped; deploys
  via `azmcp extension az` proxy or direct ARM SDK call
- Some MCP tools call `*.azure.com` for global registries (model
  catalog); disable or block those tools in Gov

## References

- `temp/fiab-research/06-copilot-driven-deploy.md` §2.1
- github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/README.md
- learn.microsoft.com/azure/developer/azure-mcp-server/overview
- Memory: [[azure-deployment-principal]]
