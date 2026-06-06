# Tutorial 04 — Activator rules over a KQL stream

Author a Loom Activator (reflex) rule that fires a Teams message — and an
email — when a VM reports high CPU. **30 minutes.**

## Prerequisites

- Workspace from previous tutorials
- A Teams incoming-webhook URL (or any test webhook)
- An SMTP/email target for the second action

The KQL data lives in the shared Azure Data Explorer (ADX) cluster, which
is provisioned for the workspace. No real Fabric eventhouse is required.

## Steps

### 1. Create a KQL database

Left nav → **Workspaces** → open your workspace → **New item** → category
**Real-Time Intelligence** → **KQL Database** → **Create**. The KQL/
Eventhouse editor opens at `/items/kql-database/<id>`, backed by the
shared ADX cluster.

### 2. Seed synthetic data

In the editor's **KQL** tab, run these control commands (real ADX):

```kql
.create table VmMetrics (
  TimestampUtc: datetime,
  VmId: string,
  CpuPercent: real,
  MemoryMb: int
)

.create-or-alter function MockData() {
  range Idx from 1 to 1800 step 1
  | extend TimestampUtc = ago(30m) + Idx * 1s
  | extend VmId = "vm-001"
  | extend CpuPercent = case(
      Idx < 600, rand() * 30 + 10,   // first 10 min: 10-40%
      Idx < 1500, rand() * 30 + 85,  // next 15 min: 85-115%  <- spike
      rand() * 30 + 20               // last 5 min: 20-50%
    )
  | extend MemoryMb = 4096
}

.set-or-append VmMetrics <| MockData() | project TimestampUtc, VmId, CpuPercent=tofloat(CpuPercent), MemoryMb
```

### 3. Verify the data

```kql
VmMetrics
| where TimestampUtc > ago(30m)
| summarize avg_cpu = avg(CpuPercent) by bin(TimestampUtc, 1m), VmId
| render timechart
```

The results render as a timechart; CPU spikes to ~100% for ~15 min, then
drops.

### 4. Create an Activator

Return to the workspace item tree → **New item** → category **Real-Time
Intelligence** → **Activator** → **Create**. The Activator editor opens at
`/items/activator/<id>`. It auto-selects the first workspace and loads any
existing reflexes from `/api/items/activator?workspaceId=…`.

### 5. Create a reflex

Click **New reflex**, name it (e.g. `vm-cpu-watch`), and confirm. This
POSTs to `/api/items/activator?workspaceId=…`.

### 6. Add a Teams rule

Click **+ New rule** (or the ribbon **Teams** template, which pre-fills the
wizard). The rule wizard uses guided fields — no JSON:

- **Rule name**: `VM CPU high`
- **Condition**: property `CpuPercent`, operator **GreaterThan**, value
  `85`
- **Action kind**: **TeamsMessage** (the available kinds are
  **TeamsMessage, Email, Webhook, AdfPipelineRun, NotebookRun,
  PowerAutomateFlow**)
- **Target**: your Teams webhook URL
- **Message**: `VM {{eventValue}} CPU alert`

Save. The rule POSTs to
`/api/items/activator/<id>/rules?workspaceId=…`.

### 7. Start the reflex

Click **Start**. This POSTs to
`/api/items/activator/<id>/start?workspaceId=…`, which sets every trigger
Active.

### 8. Trigger and observe

Click **Trigger now** on the rule row for an immediate test fire. The rule
row's `lastTriggered` timestamp updates, and the Teams webhook fires if the
URL is valid.

### 9. Add a second action (Email)

Click **+ New rule** again (or the ribbon **Email** template) and add an
Email action alongside the Teams one:

- **Rule name**: `VM CPU email`
- **Condition**: property `CpuPercent`, operator **GreaterThan**, value
  `85`
- **Action kind**: **Email**
- **Target**: `<your-email>`
- **Message**: `VM {{eventValue}} CPU sustained high`

Save. (For pipeline-driven remediation you would instead pick
**AdfPipelineRun** or **NotebookRun** — those are the pipeline/compute
action kinds.)

### 10. Stop the reflex

When you're done, click **Stop** (POSTs to
`/api/items/activator/<id>/stop?workspaceId=…`).

## What's next

- [Tutorial 06 — Mirroring from Cosmos DB](06-mirroring-cosmos.md) —
  bring an operational store into Bronze and alert on it
- [Activator engine service docs](../services/activator-engine.md)
- [Data Activator parity workload](../workloads/data-activator-parity.md)

## Cleanup

- Activator editor: **Stop** the reflex, then delete it from the workspace
  item tree (right-click → Delete)
- KQL editor: `.drop table VmMetrics`

## Troubleshooting

- Rule doesn't fire: see [Activator rules not firing runbook](../runbooks/activator-rules-not-firing.md)
- Teams/email doesn't arrive: verify the webhook URL / SMTP target and the
  engine's egress
