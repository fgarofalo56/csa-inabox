# FedRAMP Compliance Tracker — from install to a live control scorecard

Install `app-fedramp-tracker`, get a **13-family NIST 800-53 Rev 5 scorecard** with
worst-child rollup and FedRAMP-aligned status rules, plus an **8-tile ADX compliance
dashboard** over your Sentinel-backed cyber medallion. **~20 minutes.**

!!! abstract "What you end up with"
    Two workspace items: `NIST 800-53 Control Families — FedRAMP Moderate` (scorecard)
    and `Compliance Events Dashboard` (KQL dashboard). The scorecard is fully live on
    Loom's own goal store — check-ins, history, rollups, status colouring — with **no
    Power BI or Fabric required**.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_KUSTO_CLUSTER_URI` set | The dashboard tiles need a queryable ADX data source | The dashboard installs with a remediation gate naming the variable |
| A cyber medallion in ADX (`bronze.stg_sentinel_alerts`, `silver.fct_security_alerts`, `silver.dim_mitre_techniques`, `gold.rpt_compliance_posture`) | The eight tiles query **these** tables by name | See the honest caveat below |

!!! warning "This app does not create the cyber tables"
    The bundle ships a scorecard and a dashboard — it does **not** provision the
    Sentinel medallion the tiles read. The tile KQL is grounded in the
    [Cybersecurity (MITRE ATT&CK) example](../../examples/cybersecurity.md)
    (`examples/cybersecurity/domains/{bronze,silver,gold}`). Until those tables exist
    in the ADX database the dashboard resolves to, the tiles return a Kusto
    "table not found" error rather than fabricated rows. That is the honest state, and
    it is the one thing to plan for before you install.

    The dashboard's database is resolved in this order: `content.database` on the
    bundle (not set here) → the install's resolved target DB (`LOOM_KUSTO_DEFAULT_DB`)
    → a slug of the dashboard's own name. In practice it lands on
    **`LOOM_KUSTO_DEFAULT_DB`** — put the cyber medallion tables there, or repoint the
    tiles after install.

## 1. Install the app

1. Left nav → **Apps** → **FedRAMP Compliance Tracker** (`/apps/app-fedramp-tracker`).
2. **Install into workspace** → pick the workspace, optionally a folder
   (e.g. `Compliance`).
3. Leave **Deploy artifacts to live Azure services** **On** and **Compute** on
   **Shared**.
4. **Install**. The route returns `202 { jobId }`; the dialog polls
   `/api/apps/install-jobs/<jobId>` and renders the per-item provisioning report.

## 2. What gets provisioned

| Item | Provisioner | Real backend | Notes |
| --- | --- | --- | --- |
| `NIST 800-53 Control Families — FedRAMP Moderate` (`scorecard`) | *none* — Cosmos-only | Loom's own goal store | The scorecard editor is fully functional against it (goals, check-ins, history, rollups) |
| `Compliance Events Dashboard` (`kql-dashboard`) | `kqlDashboardProvisioner` | Confirms the ADX data source (`LOOM_KUSTO_CLUSTER_URI` + database); the tiles run live KQL via `/api/items/kql-dashboard/<id>?run=1` | Azure-native by default; a Fabric Real-Time Dashboard is opt-in only (`LOOM_DASHBOARD_BACKEND=fabric` **and** a bound workspace) |

The dashboard row in the install report reads
`Loom-native KQL dashboard ready: 8/8 tile(s) bound to ADX <cluster> / <db>` when it
succeeds.

## 3. Seeded data — read this carefully

The scorecard installs with **sample mid-ATO maturity values**, clearly labelled as
such in the app intro and in every goal description:

| Family | Sample `% controls implemented` | Family | Sample |
| --- | --: | --- | --: |
| AC — Access Control | 92 | RA — Risk Assessment | 79 |
| AU — Audit and Accountability | 88 | SA — System & Services Acquisition | 82 |
| AT — Awareness and Training | 95 | SC — System & Comms Protection | 87 |
| CM — Configuration Management | 84 | SI — System & Information Integrity | 89 |
| CP — Contingency Planning | 81 | SR — Supply Chain Risk Management | 78 |
| IA — Identification & Authentication | 90 | MP — Media Protection | 93 |
| IR — Incident Response | 86 | | |

**Replace these with live evidence** (your CMDB + Sentinel workspace + the
`gold.rpt_compliance_posture` table) before anyone treats the number as an ATO
artifact. Step 4 shows how.

### The rollup semantic

`NIST 800-53 Overall Compliance` is the parent of all thirteen families, with
`rollupMethod: 'min'` — **worst-child aggregation**. The parent reflects the weakest
family, which is the standard compliance-scorecard semantic (you are not compliant on
average; you are compliant at your weakest control family). Status rules, applied at
both parent and family level:

- `>= 90` → **On track**
- `>= 75` → **At risk**
- otherwise → **Behind**

With the seeded values the parent lands on the SR family (78) → **At risk**.

The default baseline is **FedRAMP Moderate**. Flip to High by setting
`LOOM_FEDRAMP_BASELINE=high`.

## 4. First meaningful task — record a real check-in and watch the rollup move

1. Open **`NIST 800-53 Control Families — FedRAMP Moderate`**. The left tree lists
   scorecards; the main pane shows the goal hierarchy with current / target / status /
   owner / due.
2. Select the **SR — Supply Chain Risk Management** goal (the weakest child, 78).
3. Ribbon → **Goal** group → **Check in**. Record the real value from your evidence
   source, a status, and a note. Check-ins are versioned — **History** on the same
   ribbon group shows the full trail, which is the audit artifact an assessor asks for.
4. Save, then look at **NIST 800-53 Overall Compliance**. Because the parent rolls up
   with **Min (Worst child)**, the overall number tracks whichever family is now
   lowest — not the one you just edited, unless it is still the worst.
5. Ribbon → **Rollup** group → **Configure rollups** to inspect or change the
   aggregation and the status-rule ladder per goal (operator, threshold,
   value vs % of target, resulting status, and the "otherwise" fallback).
6. Optional, if you run a Power BI / AAS semantic model: **Bind metric** connects a
   goal's value to a live DAX measure so check-ins stop being manual. This requires
   the Power BI backend enabled in **Admin → Runtime configuration** and a selected
   workspace — it is an opt-in leg, not the default path.

### Then read the dashboard

Open **`Compliance Events Dashboard`**. Eight tiles, all real KQL:

1. **Total alerts (last 24h)** — card, `dcount(alert_id)` over `bronze.stg_sentinel_alerts`.
2. **Open high/critical incidents** — card, `severity_level >= 3` and status in
   `New / InProgress / Investigating`.
3. **Mean time to detect (minutes)** — card, `datetime_diff` between `processed_at`
   and `time_generated`.
4. **Alerts by MITRE technique (top 15, 30d)** — bar, joined to `silver.dim_mitre_techniques`.
5. **Alert trend — daily (30d, severity stacked)** — timechart.
6. **Top 10 risk users (30d)** — table, `mv-expand` over `account_entities`.
7. **Compliance posture by NIST control family (30d)** — pie over
   `gold.rpt_compliance_posture`.
8. **Top 10 remediation priorities (30d)** — table, ordered by `remediation_priority`.

## 5. Verify it worked

- **Install dialog**: the dashboard row is `created` and names the resolved
  cluster + database.
- **Scorecard editor**: 14 goals render (1 parent + 13 families) with statuses that
  match the ladder above; a check-in you record appears in **History**.
- **Dashboard**: tiles 1–3 return numeric cards. If they return a Kusto
  "table not found", the cyber medallion is missing — that is the documented caveat,
  not a broken app.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Dashboard row = `remediation`, "No ADX cluster configured" | `LOOM_KUSTO_CLUSTER_URI` unset | Set it to the cluster URI (e.g. `https://<adx>.<region>.kusto.<suffix>`), then **Retry** the row |
| Every tile errors "could not resolve table" | The cyber medallion tables are not in the resolved database | Build them from `examples/cybersecurity/domains/**` into `LOOM_KUSTO_DEFAULT_DB`, or edit the tile KQL to point at your own table names |
| Tiles 7–8 error but 1–6 work | `gold.rpt_compliance_posture` is missing | It is the gold-layer report table; create it from `examples/cybersecurity/domains/gold/rpt_compliance_posture.sql` |
| Scorecard shows "No scorecards yet" | You are looking at the Power BI-backed list with no workspace selected | The Loom-native goals load without a Power BI workspace; refresh the editor. Power BI is opt-in |
| Parent number does not change after a check-in | Worst-child rollup — another family is now the minimum | Working as designed; check the family list for the new minimum |

## Cleanup

Delete both items from the workspace tree, or delete the workspace. Nothing external
is created by this app — the ADX tables it reads were not created by it and are not
removed with it.

## What's next

- [Cybersecurity (MITRE ATT&CK) example](../../examples/cybersecurity.md) — build the
  medallion the dashboard reads.
- [Data Steward Console](data-steward.md) — the governance sign-off half of the same
  compliance story.
- [Workspace Monitoring](workspace-monitoring.md) — platform telemetry for the AU
  (audit) family evidence.
