# SIEM audit stream — `LoomAudit_CL` + Microsoft Sentinel

CSA Loom emits every **admin-plane mutation** as a structured event to a
Log Analytics **custom table** (`LoomAudit_CL`) through the Azure Monitor
**Logs Ingestion API** (DCR-based). Any workspace-connected SIEM —
Microsoft Sentinel is the first-party path — can then alert on privilege
changes, mass deletes, and off-hours admin activity **continuously**, with no
polling of the Console.

This is **additive telemetry** on top of the in-product audit trail
(`/admin/audit-logs`, backed by Cosmos + Purview). The Cosmos trail is the
authoritative record; the SIEM stream is the export surface for a security team.

---

## How it works

```
admin mutation (BFF route)
        │  emitAuditEvent({...})   ← fire-and-forget, never blocks the request
        ▼
Azure Monitor Logs Ingestion API
  POST {LOOM_AUDIT_DCR_ENDPOINT}/dataCollectionRules/{LOOM_AUDIT_DCR_ID}
       /streams/Custom-LoomAudit_CL?api-version=2023-01-01
  Authorization: Bearer <Console UAMI token, audience monitor.azure.com|.us>
        ▼
Data Collection Rule (transformKql: source)
        ▼
Log Analytics · table LoomAudit_CL   ──►  Microsoft Sentinel analytics rules
```

- **Emitter:** `apps/fiab-console/lib/admin/audit-stream.ts` — `emitAuditEvent()`
  is called at each mutation choke point. It is **fire-and-forget**: a slow or
  un-provisioned SIEM never blocks, slows, or fails an admin action.
- **Auth:** the Console user-assigned managed identity (UAMI), using the
  per-cloud Monitor ingestion audience (`https://monitor.azure.com` Commercial /
  `https://monitor.azure.us` Gov). The UAMI holds **Monitoring Metrics
  Publisher** on the DCR.
- **Infra:** `platform/fiab/bicep/modules/admin-plane/audit-stream.bicep` deploys
  the DCE, the DCR, the `LoomAudit_CL` table, and the role assignment. Its
  outputs wire `LOOM_AUDIT_DCR_ENDPOINT` / `LOOM_AUDIT_DCR_ID` into the Console.

### Honest gate (no-vaporware)

When `LOOM_AUDIT_DCR_ENDPOINT` / `LOOM_AUDIT_DCR_ID` are unset the emitter is a
**silent no-op** (one-time debug log). `/admin/env-config` surfaces both vars
(self-audit check `svc-audit-siem-stream`) so an operator sees exactly what to
set. The Cosmos audit trail is unaffected either way.

---

## `LoomAudit_CL` schema

| Column          | Type       | Meaning                                                        |
| --------------- | ---------- | ------------------------------------------------------------- |
| `TimeGenerated` | `datetime` | Event time (ISO-8601).                                         |
| `ActorOid`      | `string`   | Entra object id of the acting admin.                          |
| `ActorUpn`      | `string`   | UPN / email of the acting admin.                              |
| `Action`        | `string`   | Dotted verb, e.g. `feature-grant.upsert`, `workspace.delete`. |
| `TargetType`    | `string`   | Mutated object class, e.g. `feature-grant`, `workspace`.      |
| `TargetId`      | `string`   | Stable id of the mutated object.                              |
| `Outcome`       | `string`   | `success` \| `failure` \| `denied`.                           |
| `Detail`        | `string`   | JSON-encoded extra context (e.g. changed keys, item counts).  |
| `TenantId`      | `string`   | Entra tenant id.                                              |

### Actions emitted (Wave-1)

`feature-grant.upsert`, `feature-grant.delete`, `workspace.create`,
`workspace.delete`, `tenant-settings.update`, `env-config.update`,
`mcp-server.create`, `mcp-server.delete`, `mcp-server.deploy`,
`mcp-server.teardown`, `domain.delete`, `platform.update-apply`.

> Secret values are **never** streamed. `env-config.update` carries changed key
> **names** only; MCP secrets are Key Vault references, never values.

---

## Starter KQL

### 1. Privilege changes (role / permission grants)

```kusto
LoomAudit_CL
| where Action in ('feature-grant.upsert', 'feature-grant.delete')
| project TimeGenerated, ActorUpn, Action, TargetId, Detail, TenantId
| order by TimeGenerated desc
```

### 2. Mass deletes (workspace / domain / MCP teardown burst by one actor)

```kusto
LoomAudit_CL
| where Action in ('workspace.delete', 'domain.delete', 'mcp-server.teardown', 'mcp-server.delete')
| summarize deletes = count(), targets = make_set(TargetId, 50)
    by ActorUpn, bin(TimeGenerated, 10m)
| where deletes >= 5
| order by deletes desc
```

### 3. Off-hours admin activity (outside 06:00–20:00 UTC, any day)

```kusto
LoomAudit_CL
| extend hourUtc = datetime_part('hour', TimeGenerated)
| where hourUtc < 6 or hourUtc >= 20
| project TimeGenerated, hourUtc, ActorUpn, Action, TargetType, TargetId
| order by TimeGenerated desc
```

---

## Microsoft Sentinel scheduled analytics rule (template)

Prerequisite: the Loom Log Analytics workspace is onboarded to Sentinel
(`monitoring.bicep` already deploys the `SecurityInsights` solution +
`onboardingStates/default`). Create an analytics rule from this ARM snippet
(portal: **Sentinel → Analytics → Create → Scheduled query rule**, or deploy the
resource) — this example alerts on a mass-delete burst:

```json
{
  "type": "Microsoft.SecurityInsights/alertRules",
  "apiVersion": "2024-09-01",
  "name": "loom-audit-mass-delete",
  "kind": "Scheduled",
  "properties": {
    "displayName": "CSA Loom — admin mass-delete burst",
    "description": "One admin deleted 5+ workspaces/domains/MCP servers in 10 minutes.",
    "severity": "High",
    "enabled": true,
    "query": "LoomAudit_CL\n| where Action in ('workspace.delete','domain.delete','mcp-server.teardown','mcp-server.delete')\n| summarize deletes = count() by ActorUpn, ActorOid, bin(TimeGenerated, 10m)\n| where deletes >= 5",
    "queryFrequency": "PT10M",
    "queryPeriod": "PT10M",
    "triggerOperator": "GreaterThan",
    "triggerThreshold": 0,
    "suppressionEnabled": false,
    "suppressionDuration": "PT1H",
    "tactics": ["Impact"],
    "entityMappings": [
      {
        "entityType": "Account",
        "fieldMappings": [
          { "identifier": "AadUserId", "columnName": "ActorOid" },
          { "identifier": "Name", "columnName": "ActorUpn" }
        ]
      }
    ]
  }
}
```

Clone the template for the privilege-change and off-hours queries above,
adjusting `displayName`, `query`, `severity`, and `tactics`
(`Persistence` / `PrivilegeEscalation` for grant changes).

---

## Deploy / verify

1. Deploy (or redeploy) the admin-plane stack — `audit-stream.bicep` is wired
   into `admin-plane/main.bicep` and deploys default-ON with monitoring.
2. Confirm the Console picked up the env: `/admin/env-config` → the
   **SIEM audit stream** row shows `LOOM_AUDIT_DCR_ENDPOINT` /
   `LOOM_AUDIT_DCR_ID` as set.
3. Perform any admin mutation (e.g. toggle a tenant setting), wait a few minutes
   (first-write latency can be longer), then query:

   ```kusto
   LoomAudit_CL | order by TimeGenerated desc | take 20
   ```

> **Operator action (Wave-1):** deploying the DCR/DCE/table is the only required
> step; the Sentinel analytics rules above are optional starter content you
> import into your workspace.
