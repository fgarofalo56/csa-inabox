# Runbook — MCP server troubleshooting

## Symptom

Loom Setup Wizard or Loom Console tool calls fail. MCP server
unreachable or tools return errors.

## Diagnosis

```bash
# 1. Health endpoint
curl https://<mcp-url>/health
# Expected: {"status":"healthy", "azure_environment":"AzureCloud" or "AzureUSGovernment"}

# 2. Tool list
curl https://<mcp-url>/tools
# Expected: array of 40+ Azure tools (azmcp_group_list, etc.)

# 3. Test a simple tool
curl -X POST https://<mcp-url>/tools/azmcp_subscription_list \
  -H "Authorization: Bearer <token>"
# Expected: array of subscriptions visible to the MCP MI

# 4. Check MCP MI identity
az identity show \
  --resource-group <admin-plane-rg> \
  --name csa-loom-mcp-mi

# 5. Check MI role assignments
az role assignment list --assignee <mcp-mi-client-id>
# Expected: Reader on each Loom sub; KV Secrets User
```

## Common issues + fixes

| Issue | Fix |
|---|---|
| `InteractiveBrowserCredential failed` (the @azure/mcp Node MI bug) | Apply workaround: set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_AUTHORITY_HOST` explicitly; or switch to .NET (dnx) host |
| `Forbidden` on tool calls | MCP MI lacks role; assign Reader or appropriate role |
| `Cannot reach login.microsoftonline.com` from Gov MCP | Set `AZURE_AUTHORITY_HOST=login.microsoftonline.us` |
| `azmcp_deployment_create` returns "not implemented" | Use `azmcp extension az deployment group create` proxy or direct ARM SDK from agent code |
| MCP container restart-looping | Check container logs; usually env var misconfig or MI permission delay |
| Setup Wizard timeout on MCP call | Wizard calls have 30 s timeout default; deployment-poll calls have 5 min — verify wizard config |
| PIM activation fails before deploy | Verify MCP MI is member of `Loom MCP Operators` PIM-eligible group |
| Outbound egress blocked to ARM endpoint | Verify NSG allows `management.usgovcloudapi.net` (Gov) or `management.azure.com` (Commercial) |

## Remediation

1. **Restart MCP container**:
   - Commercial / GCC: `az containerapp revision restart -g <rg> -n loom-mcp`
   - GCC-High / IL5: `kubectl rollout restart deployment/loom-mcp`

2. **Re-assign MI roles** if Forbidden errors:
   ```bash
   az role assignment create \
     --assignee <mcp-mi-client-id> \
     --role "Reader" \
     --scope /subscriptions/<sub-id>
   ```

3. **Re-validate** wizard end-to-end:
   - Open Console → Setup Wizard → Confirm test deploy
   - Verify each tool call lands in App Insights with correlation ID

## Prevention

- Pin Azure MCP image to a stable release tag (don't track `main`)
- Add health-check monitor with alert if `/health` returns non-200
- Monitor `mcp-tool-call-success-rate` < 99% → alert
- Document MCP MI permissions in `platform/fiab/bicep/modules/admin-plane/mcp-app.bicep`

## Related

- ADR: [fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md)
- PRP: PRP-05 (MCP server)
- Console: [Setup Wizard](../console/setup-wizard.md)
- Research: [`temp/fiab-research/06-copilot-driven-deploy.md` §2.1](../../../temp/fiab-research/06-copilot-driven-deploy.md)
