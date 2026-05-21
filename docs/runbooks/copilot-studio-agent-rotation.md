[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **Copilot Studio Agent Rotation**

# Copilot Studio Agent Rotation Runbook

!!! note
    **Quick Summary**: Procedure for rotating a Copilot Studio agent's underlying Entra app registration, custom-connector OAuth secrets, and MCP-server endpoint credentials. Covers scheduled rotation (90-day cadence), event-driven rotation (after a leak or scope change), and the agent-side configuration updates required so the rotation does not break live conversations.

## 📋 Table of Contents

- [1. Scope](#1-scope)
- [2. What needs rotating](#2-what-needs-rotating)
- [3. Pre-rotation checklist](#3-pre-rotation-checklist)
- [4. Rotation procedure](#4-rotation-procedure)
- [5. Validation](#5-validation)
- [6. Rollback](#6-rollback)
- [7. Audit and observability](#7-audit-and-observability)

---

## 1. Scope

Applies to:

- Copilot Studio agents that consume APIs through **Azure API Management** (APIM) custom connectors
- Agents that call **Model Context Protocol (MCP)** servers behind APIM
- Agents that authenticate to backend systems via Entra ID app registrations

Excludes:

- M365 Copilot itself (managed by the M365 Copilot service)
- Pre-built connectors (Dataverse, Graph, etc.) where the credential is the user's delegated token

## 2. What needs rotating

Each Copilot Studio agent typically depends on three credential surfaces. All three rotate on the same cadence to keep the rotation atomic.

| Surface | Where it lives | What rotates |
|---|---|---|
| Entra app registration for the connector | Entra ID portal → App registrations | Client secret or federated credential |
| APIM subscription key (per-connector) | APIM → Subscriptions | Primary key / Secondary key pair |
| MCP server authentication (if applicable) | The MCP server's identity provider | Managed identity assignment or service-principal cert |

> [!IMPORTANT]
> Rotate the **secondary** key first, validate the agent works, then rotate the **primary**. This zero-downtime pattern is the only way to avoid disrupting live conversations.

## 3. Pre-rotation checklist

- [ ] Confirm the agent's name, Power Platform environment, and Entra app ID
- [ ] Confirm the APIM instance name, the API path, and the subscription ID (or scope)
- [ ] Confirm whether MCP server credentials need to rotate (yes if the MCP was provisioned with a non-managed-identity)
- [ ] Schedule rotation in a low-traffic window
- [ ] Notify Copilot Studio agent owners (so they can pause new feature releases that depend on the connector)
- [ ] Confirm the rollback path (the previous secret value should remain valid until the new one is verified)

## 4. Rotation procedure

### 4.1 Rotate the APIM subscription key

```bash
APIM_NAME="<your-apim>"
APIM_RG="<your-rg>"
SUB_ID="<copilot-agent-subscription-sid>"

# Regenerate the secondary key
az apim subscription regenerate-key \
  --resource-group $APIM_RG \
  --service-name $APIM_NAME \
  --sid $SUB_ID \
  --key-type secondary

# Capture the new secondary key
NEW_SECONDARY=$(az apim subscription show \
  --resource-group $APIM_RG \
  --service-name $APIM_NAME \
  --sid $SUB_ID \
  --query secondaryKey -o tsv)
```

### 4.2 Update the Copilot Studio connector

In Power Platform admin center → Environments → **<your env>** → Custom connectors → **<your connector>** → Security:

1. Update the `Ocp-Apim-Subscription-Key` value to the new secondary key
2. Save and test from the connector's test pane
3. If the test passes, publish the connector update

The agent will pick up the new key on the next conversation turn. Existing in-flight conversations continue with the previous key until they end (APIM accepts both primary and secondary keys simultaneously).

### 4.3 Rotate the Entra app credentials

If the connector uses OAuth 2.0 with a client secret:

```bash
APP_ID="<connector-app-id>"

# Create a new secret with the desired lifetime
NEW_SECRET=$(az ad app credential reset \
  --id $APP_ID \
  --years 1 \
  --query password -o tsv)
```

In the Copilot Studio connector security pane, paste the new secret into the **Client secret** field, save, and test. Once the test passes:

```bash
# Remove old credentials (find their key IDs first)
az ad app credential list --id $APP_ID -o table
az ad app credential delete --id $APP_ID --key-id <old-kid>
```

### 4.4 Rotate primary APIM key

Repeat §4.1 / §4.2 for the **primary** key. Some teams prefer to swap roles (the new secondary becomes the new primary), which is fine — the important property is that no single moment has zero valid keys.

### 4.5 MCP server rotation (if applicable)

If the MCP server runs in a Container App with a system-assigned managed identity, **no rotation is needed** — managed-identity tokens auto-rotate.

If the MCP server uses a service-principal certificate:

```bash
# Generate a new certificate
az ad sp credential reset \
  --id <mcp-server-sp-id> \
  --create-cert \
  --cert <new-cert-name> \
  --keyvault <kv-name>

# Update the MCP server's environment / Key Vault reference to use the new cert
# (Specifics depend on the MCP server's deployment shape)
```

## 5. Validation

Smoke-test the agent end-to-end after each rotation step:

```bash
# 1. From the Copilot Studio test pane: send a test message that exercises the
#    connector's authentication path. Confirm a 200 response.

# 2. Verify APIM logs show the new key was used:
az monitor app-insights query --app <app-insights-name> \
  --analytics-query "ApiManagementGatewayLogs
                     | where TimeGenerated > ago(10m)
                     | where ApimSubscriptionId == '<sub-sid>'
                     | project TimeGenerated, Method, Url, ResponseCode
                     | take 10"

# 3. Confirm the agent's published topic still answers in production for a
#    pilot user (canary check).
```

If any step fails, **stop and roll back** before the old credentials are removed.

## 6. Rollback

The whole rotation is engineered for zero-downtime rollback because the old credentials remain valid until step §4.3's `az ad app credential delete` and §4.4's primary-key regeneration. If a failure is detected:

1. Restore the old credential value in the Copilot Studio connector
2. Re-publish the connector
3. Skip the credential-deletion step until the root cause is diagnosed

## 7. Audit and observability

| What | Where | Retention |
|---|---|---|
| App-registration credential changes | Entra ID Audit logs | 30 days hot; archived to Log Analytics |
| APIM subscription-key regeneration | Azure Activity Log on the APIM resource | 90 days |
| Copilot Studio connector changes | Power Platform admin center → Audit logs | 30 days |
| Agent-side errors during rotation | App Insights for the APIM instance | Per workspace retention |

```kql
// All credential resets on the connector's app registration
AuditLogs
| where TimeGenerated > ago(30d)
| where OperationName == "Update application – Certificates and secrets management"
| extend appId = tostring(TargetResources[0].id)
| where appId == "<connector-app-id>"
| project TimeGenerated, InitiatedBy.user.userPrincipalName, Result, OperationName
```

---

## Control process

| Date | Agent | Action | Performed by |
|---|---|---|---|
| _yyyy-mm-dd_ | _<agent-name>_ | Initial runbook published | _<author>_ |

Append every rotation here.

---

## Related material

- [`key-rotation.md`](key-rotation.md) — broader credential-rotation runbook
- [`azure-deployment-principal.md`](azure-deployment-principal.md) — companion SP rotation
- [`security-incident.md`](security-incident.md) — escalation if a leak triggered the rotation
- [Guide — APIM as the Universal API Gateway](../guides/apim-universal-gateway.md)
- [Guide — APIM + MCP Layered Orchestration](../guides/apim-mcp-layered-orchestration.md)
