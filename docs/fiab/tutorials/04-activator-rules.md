# Tutorial 04 — Activator rules over IoT stream

Author a Loom Activator rule that fires a Teams message when an IoT
sensor reports high CPU sustained for 5 minutes. **30 minutes.**

!!! warning "Navigation + action-set accuracy (2026-06-06)"
    There is **no per-workspace KQL/Activator “pane.”** Create an activator with
    **+ New item → Activator** (KQL via **+ New item → KQL Database**). The
    supported action types are **Teams, Email, Webhook, Logic App** (engine) plus
    **ADF Pipeline, Notebook run, Power Automate** (editor) — a **“Databricks
    Job” action does NOT exist**, and there are no Firings / Rule History /
    Export surfaces. Use Teams/Email for this tutorial's second action.

## Prerequisites

- Workspace from previous tutorials
- ADX database in the shared cluster (provisioned at workspace
  creation)
- A Teams channel webhook URL (or use Test channel for the tutorial)

## Steps

### 1. Set up synthetic IoT data in ADX

Open the **KQL** pane in your workspace. Run:

```kql
// Create a sample table
.create table VmMetrics (
  TimestampUtc: datetime,
  VmId: string,
  CpuPercent: real,
  MemoryMb: int
)

// Add update policy to set bin'd CPU averages
.create function CalcCpuAvg() {
  VmMetrics
  | summarize avg_cpu = avg(CpuPercent) by VmId, bin(TimestampUtc, 1m)
}

// Generate 30 min of synthetic data
.create-or-alter function MockData() {
  range Idx from 1 to 1800 step 1
  | extend TimestampUtc = ago(30m) + Idx * 1s
  | extend VmId = "vm-001"
  | extend CpuPercent = case(
      Idx < 600, rand() * 30 + 10,   // first 10 min: 10-40%
      Idx < 1500, rand() * 30 + 85,  // next 15 min: 85-115%  ← spike
      rand() * 30 + 20               // last 5 min: 20-50%
    )
  | extend MemoryMb = 4096
}

.set-or-append VmMetrics <| MockData() | project TimestampUtc, VmId, CpuPercent=tofloat(CpuPercent), MemoryMb
```

### 2. Verify the data

```kql
VmMetrics
| where TimestampUtc > ago(30m)
| summarize avg_cpu = avg(CpuPercent) by bin(TimestampUtc, 1m), VmId
| render timechart
```

You should see CPU spike to ~100% for ~15 min, then drop.

### 3. Author the activator rule

Open the **Activator** pane. Click **+ New Rule**.

Visual rule designer:
- **Data source**: ADX → `VmMetrics` → use query: `CalcCpuAvg`
- **Object**: split by `VmId`
- **Attribute**: `current_cpu = avg_cpu`
- **Rule**: `current_cpu` **is above** `85` **and stays for** `5 min`
- **Action**: Teams message
  - Channel: `<your-test-channel>`
  - Template: `VM {VmId} CPU is at {current_cpu}% sustained for >5 min`

Cadence: `1 min`

Click **Save + Enable**.

### 4. Watch it fire

The rule scheduler runs every 1 min. After your synthetic data is
~5 min into the spike, you should see:
- Console "Activator → Firings" log: a new firing event
- Teams channel: `VM vm-001 CPU is at 99.2% sustained for >5 min`
  (or similar)

### 5. Verify state machine

The `andStays` rule has per-object state in Redis. When CPU drops
back below 85%, the rule de-arms. If it spikes again, it re-arms
the 5-minute timer.

Check rule firing log:
- Console "Activator → Rule History"
- Should show 1 firing event for `vm-001`
- After CPU drops, no further firings (rule de-armed)

### 6. Extend with multiple actions

Edit the rule. Add a second action:
- Type: Databricks Job
- Job ID: `<auto-remediation-job-id>` (e.g., scale-up-job)
- Parameters: `{"affected_vm": "{VmId}"}`

Now the rule fires both a Teams alert AND a Databricks job that
auto-remediates the affected VM.

### 7. Export the rule definition (Git-friendly)

Console "Activator → Export". Saves JSON:

```json
{
  "id": "rule-cpu-high-andstays",
  "workspaceId": "<your-workspace>",
  "name": "VM CPU sustained high",
  ...
}
```

Commit this to Git. Re-import in another workspace via Console
"Activator → Import".

## What's next

- [Tutorial 06 — Mirroring from Cosmos DB](06-mirroring-cosmos.md) —
  real-time CDC into Bronze + activator rules on the stream
- [Activator engine service docs](../services/activator-engine.md)
- [Data Activator parity workload](../workloads/data-activator-parity.md)

## Cleanup

- Console "Activator → Disable" then "Delete" the rule
- ADX: `.drop table VmMetrics`

## Troubleshooting

- Rule doesn't fire: see [Activator rules not firing runbook](../runbooks/activator-rules-not-firing.md)
- Teams message doesn't arrive: verify webhook URL + Function App
  egress
