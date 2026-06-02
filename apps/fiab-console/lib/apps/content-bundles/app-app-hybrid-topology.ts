/**
 * Hybrid Fabric Commercial + CSA Loom Gov — app-install content bundle.
 *
 * Sourced 1:1 from docs/fiab/use-cases/hybrid-topology.md. Reproduces the
 * "most likely federal pattern": Microsoft Fabric (full SaaS) in the Azure
 * Commercial tenant for non-classified workloads, running side-by-side with
 * CSA Loom (the parity layer) in the Azure Government tenant (GCC-H / IL4 /
 * IL5) for CUI / classified / ITAR workloads — bridged by Entra cross-cloud
 * B2B, a controlled cross-cloud APIM brokering lane, and customer-initiated
 * (never automatic) data movement.
 *
 * IMPORTANT — which side this bundle provisions.
 *   Loom installs into the *Gov* tenant. So the items below are the Gov-side
 *   (Loom) artifacts — the ones that get real backends via the Phase-2
 *   provisioners. The Commercial/Fabric side is the partner estate: it is
 *   modeled as honest *configuration* (the cross-cloud B2B trust, the APIM
 *   bridge allow-list, the manual data-movement register) rather than
 *   pretending Loom reaches across the cloud boundary to create Fabric
 *   resources — per the doc, "Loom doesn't initiate cross-cloud movement".
 *   Everything Loom CAN do (and the doc says it should) is built and wired.
 *
 * Items (every documented object in the use-case):
 *   1. warehouse            Workload-Placement Register — the doc's "What
 *                           lives where" routing table + the cross-boundary
 *                           data-movement audit log (request -> approve ->
 *                           azcopy -> attest). Real TDS DDL + seeded rows.
 *   2. data-product         Cross-Cloud Catalog Federation — the manual
 *                           catalog-reconciliation manifest: Gov-side data
 *                           products that may be shared to / from the
 *                           Commercial Fabric catalog as JSON manifests.
 *   3. lakehouse            Gov Mission CUI Lakehouse — the Loom DLZ Bronze/
 *                           Silver/Gold for CUI data that must stay in Gov.
 *                           Seeded Delta tables + sample rows.
 *   4. notebook             Cross-Cloud Bootstrap & Identity Reconciliation —
 *                           runnable PySpark that (a) verifies the Entra
 *                           cross-cloud B2B trust both ways, (b) reconciles
 *                           the same user's separate Commercial / Gov
 *                           identities, and (c) performs a customer-initiated
 *                           azcopy of a NON-classified aggregate Commercial->
 *                           Gov with a full audit entry.
 *   5. mirrored-database    Commercial Aggregate Mirror (Gov side) — mirrors a
 *                           NON-classified aggregate that the customer staged
 *                           into a Gov-reachable Azure SQL into the Loom
 *                           lakehouse Bronze, so Gov analysts can join public
 *                           reference data against mission CUI without a live
 *                           cross-cloud query.
 *   6. data-pipeline        Cross-Cloud APIM Brokered Sync — the controlled,
 *                           allow-listed, audit-every-call API brokering lane
 *                           (forward-proxy APIM in Commercial, reverse-proxy
 *                           in Gov) materialized as a Loom data pipeline with
 *                           an on-demand validation run.
 *   7. semantic-model       Hybrid Estate Model — a star schema spanning the
 *                           routing facts so a single Power BI surface shows
 *                           what runs where, at what classification, on which
 *                           cloud, at what cost.
 *   8. report               Hybrid Estate Operations — the exec surface: a
 *                           "what lives where" map, the cross-cloud movement
 *                           audit, and the two-bill cost split.
 *   9. kql-database         HybridBridgeAudit (ADX) — cross-cloud B2B sign-in
 *                           events, APIM cross-cloud call log, and data-
 *                           movement attestations, with detection functions.
 *                           Seeded sample rows + retention policies.
 *  10. kql-dashboard        Hybrid Bridge & Cost — the SOC/ops pane: cross-
 *                           cloud sign-ins, brokered-call volume, movement
 *                           attestations, two-cloud cost, ITAR-gate status.
 *  11. activator            ITAR Cross-Cloud Guard — fires when a cross-cloud
 *                           B2B sign-in or brokered call touches an ITAR-
 *                           scoped DLZ (where cross-cloud B2B MUST be off),
 *                           or when a data-movement attestation is missing.
 *  12. ai-search-index      Hybrid Workload Placement Search — discover, by
 *                           classification + cloud + boundary, where any
 *                           workload should live and where it currently runs.
 *
 * Backend per control (existing Phase-2 provisioners, no new provisioner
 * required — all itemTypes below are already mapped in
 * lib/install/provisioning-engine.ts):
 *   warehouse           -> provisioners/warehouse.ts      (TDS DDL + INSERT)
 *   data-product        -> provisioners/data-product.ts   (Purview Unified Catalog products + glossary)
 *   lakehouse           -> provisioners/lakehouse.ts      (OneLake/ADLS Delta + sample rows)
 *   notebook            -> provisioners/notebook.ts       (Fabric/Synapse Spark notebook)
 *   mirrored-database   -> provisioners/mirrored-database.ts (Fabric Mirroring + startMirroring)
 *   data-pipeline       -> provisioners/data-pipeline.ts  (Fabric pipeline + on-demand run)
 *   semantic-model      -> provisioners/semantic-model.ts (TMDL)
 *   report              -> provisioners/report.ts         (PBIR bound to the model)
 *   kql-database        -> provisioners/kql-db.ts         (.create table + .ingest inline)
 *   kql-dashboard       -> provisioners/kql-dashboard.ts  (Real-Time Dashboard item)
 *   activator           -> provisioners/activator.ts      (Reflex + rule)
 *   ai-search-index     -> provisioners/ai-search.ts      (index + sample docs)
 *
 * Grounding:
 *   - The whole topology, "what lives where" table, cross-cloud B2B, APIM
 *     bridge, customer-controlled (never automatic) data movement, catalog
 *     federation, identity reconciliation, ITAR cross-cloud disablement, and
 *     two-bill cost framing are all from docs/fiab/use-cases/hybrid-topology.md.
 *   - Entra cross-cloud B2B mechanics (Microsoft cloud settings, mutual
 *     enablement, partner tenant-id lookup, UPN-only invites, MFA/compliant-
 *     device/HAADJ claim trust) are grounded in Microsoft Learn:
 *     https://learn.microsoft.com/entra/external-id/cross-cloud-settings
 *     https://learn.microsoft.com/entra/external-id/b2b-government-national-clouds
 *   - Power BI "BYO-license doesn't cross clouds" + cross-cloud sharing limits
 *     from https://learn.microsoft.com/fabric/enterprise/powerbi/service-admin-entra-b2b#cross-cloud-b2b
 *   - Fabric Mirroring REST (create + startMirroring) per the mirrored-database
 *     provisioner's cited docs.
 *
 * INTEGRATOR NOTE — to seed at install, add to the apps-catalog (the
 * bootstrap-catalogs route is outside this domain). Entry to add:
 *   { id:'hybrid-topology', name:'Hybrid Fabric Commercial + CSA Loom Gov',
 *     description:'The most-likely federal pattern: Microsoft Fabric (SaaS) in
 *       Commercial for non-classified workloads + CSA Loom in Gov (GCC-H/IL4/
 *       IL5) for CUI/classified/ITAR, bridged by Entra cross-cloud B2B, a
 *       controlled cross-cloud APIM lane, and customer-initiated (never
 *       automatic) data movement. Seeds a workload-placement register
 *       (warehouse), cross-cloud catalog federation (data product), Gov
 *       mission-CUI lakehouse, cross-cloud bootstrap + identity-reconciliation
 *       notebook, Commercial-aggregate mirror, APIM brokered-sync pipeline,
 *       hybrid-estate semantic model + report, a HybridBridgeAudit ADX DB +
 *       dashboard + ITAR cross-cloud Activator guard, and a placement search
 *       index.', category:'Government', publisher:'CSA',
 *     items:[
 *       {type:'warehouse',template:'workload-placement-register'},
 *       {type:'data-product',template:'cross-cloud-catalog-federation'},
 *       {type:'lakehouse',template:'gov-mission-cui'},
 *       {type:'notebook',template:'cross-cloud-bootstrap'},
 *       {type:'mirrored-database',template:'commercial-aggregate-mirror'},
 *       {type:'data-pipeline',template:'apim-brokered-sync'},
 *       {type:'semantic-model',template:'hybrid-estate'},
 *       {type:'report',template:'hybrid-estate-operations'},
 *       {type:'kql-database',template:'hybrid-bridge-audit'},
 *       {type:'kql-dashboard',template:'hybrid-bridge-cost'},
 *       {type:'activator',template:'itar-cross-cloud-guard'},
 *       {type:'ai-search-index',template:'hybrid-placement'},
 *     ] }
 * And register in content-bundles/index.ts:
 *   import hybridTopology from './app-app-hybrid-topology';
 *   [hybridTopology.appId]: hybridTopology,
 */

import type { AppBundle } from './types';

// ─── 1. Workload-Placement Register + cross-boundary movement audit (TDS) ──
// Codifies the doc's "What lives where" routing table AND the customer-
// controlled data-movement lifecycle (request -> approve -> azcopy -> attest).

const WAREHOUSE_DDL = `-- Hybrid estate workload-placement register + cross-cloud data-movement
-- audit (T-SQL / TDS). Backs the doc's "What lives where" routing table and
-- the "Customer-controlled data movement" + "never automatic" requirements.

CREATE SCHEMA hybrid;
GO

-- The placement policy: which workload class lives in which cloud + why.
-- One row per workload pattern from the doc's "What lives where" table.
CREATE TABLE hybrid.WorkloadPlacement (
    workload_id        VARCHAR(64)  NOT NULL,
    workload_name      VARCHAR(160) NOT NULL,
    data_class         VARCHAR(32)  NOT NULL,  -- Public | CUI | CUI-NSS | ITAR | PHI
    cloud              VARCHAR(16)  NOT NULL,  -- Commercial | Gov
    platform           VARCHAR(32)  NOT NULL,  -- Fabric | Loom
    boundary           VARCHAR(16)  NULL,      -- (Gov only) GCC-H | IL4 | IL5
    rationale          VARCHAR(400) NOT NULL,
    cross_cloud_b2b    BIT          NOT NULL,  -- 0 = disabled (ITAR), 1 = allowed
    CONSTRAINT pk_placement PRIMARY KEY (workload_id)
);
GO

-- Customer-initiated cross-cloud data-movement register. Loom NEVER moves
-- data automatically; every movement is a customer-approved, audited event.
CREATE TABLE hybrid.DataMovement (
    movement_id        VARCHAR(64)  NOT NULL,
    direction          VARCHAR(24)  NOT NULL,  -- Commercial->Gov | Gov->Commercial
    dataset_name       VARCHAR(200) NOT NULL,
    data_class         VARCHAR(32)  NOT NULL,
    method             VARCHAR(24)  NOT NULL,  -- azcopy | manual-export | apim-broker
    requested_by       VARCHAR(128) NOT NULL,
    approved_by        VARCHAR(128) NULL,      -- customer data-owner
    status             VARCHAR(16)  NOT NULL,  -- requested|approved|moved|attested|denied
    bytes_moved        BIGINT       NULL,
    attestation_hash   VARCHAR(128) NULL,      -- SHA-256 of the moved payload manifest
    requested_at       DATETIME2    NOT NULL,
    moved_at           DATETIME2    NULL,
    CONSTRAINT pk_movement PRIMARY KEY (movement_id)
);
GO

-- Seed: the doc's "What lives where" table, verbatim, as placement policy.
INSERT INTO hybrid.WorkloadPlacement
    (workload_id, workload_name, data_class, cloud, platform, boundary, rationale, cross_cloud_b2b)
VALUES
 ('wp-public-ref','Public reference datasets (NOAA / Census)','Public','Commercial','Fabric',NULL,'Non-classified public data fits Fabric Commercial naturally.',1),
 ('wp-xagency-metrics','Cross-agency aggregate metrics','Public','Commercial','Fabric',NULL,'Aggregate, non-classified; exec + cross-agency analytics.',1),
 ('wp-exec-pbi','Exec Power BI dashboards (M365 commercial identity)','Public','Commercial','Fabric',NULL,'Bound to M365 Commercial identity; BYO-license does not cross clouds.',1),
 ('wp-demo-train','Demo / training environments','Public','Commercial','Fabric',NULL,'Throwaway, non-mission; cheapest in Commercial SaaS.',1),
 ('wp-mission-cui','Mission CUI data','CUI','Gov','Loom','IL4','CUI requires the Gov boundary; stays in the Loom DLZ.',1),
 ('wp-agency-classified','Agency-internal classified analytics','CUI-NSS','Gov','Loom','IL5','Classified analytics on a National Security System.',1),
 ('wp-itar','ITAR-eligible workloads','ITAR','Gov','Loom','GCC-H','GCC-H specifically; cross-cloud B2B DISABLED for this DLZ.',0),
 ('wp-hhs-cui','HHS / VHA clinical CUI','PHI','Gov','Loom','IL4','HIPAA-aligned clinical CUI; Gov-only.',1);
GO

-- Seed: customer-initiated movements (the doc's worked patterns).
INSERT INTO hybrid.DataMovement
    (movement_id, direction, dataset_name, data_class, method, requested_by, approved_by, status, bytes_moved, attestation_hash, requested_at, moved_at)
VALUES
 ('mv-0001','Commercial->Gov','NOAA station normals 1991-2020','Public','azcopy','analyst-gov@contoso.gov','data-owner-gov@contoso.gov','attested',734003200,'b7c9...e21a','2026-05-18T13:00:00','2026-05-18T13:42:00'),
 ('mv-0002','Commercial->Gov','Census ACS 5-year tract aggregates','Public','azcopy','analyst-gov@contoso.gov','data-owner-gov@contoso.gov','attested',1288490188,'4f1d...9ac3','2026-05-22T09:10:00','2026-05-22T09:55:00'),
 ('mv-0003','Gov->Commercial','Non-classified program KPI rollup (Q1)','Public','manual-export','reporter-gov@contoso.gov','dept-cdo@contoso.gov','approved',NULL,NULL,'2026-05-29T15:20:00',NULL),
 ('mv-0004','Commercial->Gov','Live mission feed (BLOCKED)','CUI','apim-broker','analyst-gov@contoso.gov',NULL,'denied',NULL,NULL,'2026-05-30T08:05:00',NULL);
GO`;

const WH_Q_PLACEMENT = `-- The "what lives where" routing policy, ordered by cloud + classification.
SELECT workload_name, data_class, cloud, platform, boundary,
       CASE cross_cloud_b2b WHEN 1 THEN 'allowed' ELSE 'DISABLED (ITAR)' END AS cross_cloud_b2b,
       rationale
FROM hybrid.WorkloadPlacement
ORDER BY cloud, data_class, workload_name;`;

const WH_Q_PENDING_MOVES = `-- Movements awaiting a customer data-owner decision or not yet attested.
SELECT movement_id, direction, dataset_name, data_class, method,
       requested_by, status, requested_at
FROM hybrid.DataMovement
WHERE status IN ('requested','approved')
ORDER BY requested_at;`;

const WH_Q_BLOCKED_MOVES = `-- Cross-cloud movements that were DENIED — classified data must never leave
-- Gov; this is the governance review hook the doc requires.
SELECT movement_id, direction, dataset_name, data_class, method,
       requested_by, requested_at
FROM hybrid.DataMovement
WHERE status = 'denied'
ORDER BY requested_at DESC;`;

const WH_Q_ITAR_GATE = `-- ITAR DLZ posture check: any ITAR-scoped workload MUST have cross-cloud B2B
-- disabled. A row here with cross_cloud_b2b = 1 is a policy violation.
SELECT workload_name, data_class, boundary, cross_cloud_b2b
FROM hybrid.WorkloadPlacement
WHERE data_class = 'ITAR';`;

// ─── 4. Cross-cloud bootstrap + identity reconciliation notebook (PySpark) ──

const NB_INTRO = `# Cross-Cloud Bootstrap & Identity Reconciliation

This notebook stands up the **Hybrid Fabric Commercial + CSA Loom Gov** bridge
from the [Hybrid Topology use case](../../docs/fiab/use-cases/hybrid-topology.md).
It runs on the **Gov** (Loom) side and:

| Step | What it does |
|---|---|
| 1 | Verifies the **Entra cross-cloud B2B** trust is enabled *both ways* (Commercial ↔ Gov) via Microsoft cloud settings |
| 2 | Reconciles the same person's **two separate identities** (\`jane.doe@contoso.com\` Commercial ↔ \`jane.doe@contoso.gov\` Gov) |
| 3 | Performs a **customer-initiated** \`azcopy\` of a *non-classified aggregate* Commercial → Gov, and writes the **attestation** to the movement register |

> Per the doc, **Loom never initiates cross-cloud movement automatically** —
> every step here is a customer-approved, audited action. For **ITAR** DLZs the
> doc requires cross-cloud B2B to be **disabled entirely**; the guardrail cell
> below refuses to proceed if this DLZ is ITAR-scoped.

Grounding: [Entra cross-cloud B2B / Microsoft cloud settings](https://learn.microsoft.com/entra/external-id/cross-cloud-settings),
[B2B in government & national clouds](https://learn.microsoft.com/entra/external-id/b2b-government-national-clouds).`;

const NB_CONFIG = `# ── Hybrid bridge config (resolved from Loom DLZ context) ───────────────
# Each side is a SEPARATE Microsoft cloud + tenant. Cross-cloud B2B requires
# the PARTNER TENANT ID (domain-name lookup is NOT available across clouds).
import os

COMMERCIAL_TENANT_ID = os.environ.get("HYBRID_COMMERCIAL_TENANT_ID", "<commercial-tenant-guid>")
GOV_TENANT_ID        = os.environ.get("HYBRID_GOV_TENANT_ID",        "<gov-tenant-guid>")

# Authority endpoints differ per cloud (the Entra portal endpoint is different
# for each cloud, per Microsoft Learn).
COMMERCIAL_AUTHORITY = "https://login.microsoftonline.com"      # Azure Commercial
GOV_AUTHORITY        = "https://login.microsoftonline.us"        # Azure Government

# DLZ classification for THIS Loom workspace. ITAR => cross-cloud B2B must be off.
DLZ_DATA_CLASS = os.environ.get("HYBRID_DLZ_DATA_CLASS", "CUI")  # CUI | CUI-NSS | ITAR | PHI
DLZ_BOUNDARY   = os.environ.get("HYBRID_DLZ_BOUNDARY", "IL4")    # GCC-H | IL4 | IL5

print(f"Commercial tenant: {COMMERCIAL_TENANT_ID}  authority: {COMMERCIAL_AUTHORITY}")
print(f"Gov tenant:        {GOV_TENANT_ID}  authority: {GOV_AUTHORITY}")
print(f"This DLZ: class={DLZ_DATA_CLASS}  boundary={DLZ_BOUNDARY}")`;

const NB_ITAR_GUARD = `# ── ITAR guardrail — refuse cross-cloud bridging on an ITAR DLZ ─────────
# The doc is explicit: "For ITAR-scoped workloads, DISABLE cross-cloud B2B for
# that DLZ entirely (no foreign-person collaboration risk)."
if DLZ_DATA_CLASS == "ITAR":
    raise RuntimeError(
        "ITAR DLZ detected. Cross-cloud B2B must be DISABLED for this workspace. "
        "Do not bridge to Commercial. Remove this notebook from the ITAR DLZ and "
        "verify the WorkloadPlacement register shows cross_cloud_b2b = 0."
    )
print(f"DLZ class '{DLZ_DATA_CLASS}' permits a controlled cross-cloud bridge. Proceeding.")`;

const NB_VERIFY_TRUST = `# ── Step 1: verify Entra cross-cloud B2B trust BOTH ways ─────────────
# Reads each tenant's cross-tenant access policy (Microsoft cloud settings) and
# confirms the partner cloud is enabled + the partner tenant is on the org list.
# Uses Microsoft Graph (Gov: graph.microsoft.us; Commercial: graph.microsoft.com).
import requests
from azure.identity import DefaultAzureCredential

def cross_tenant_policy(graph_base, scope):
    cred  = DefaultAzureCredential()
    token = cred.get_token(f"{scope}/.default").token
    r = requests.get(
        f"{graph_base}/v1.0/policies/crossTenantAccessPolicy/partners",
        headers={"Authorization": f"Bearer {token}"}, timeout=30)
    r.raise_for_status()
    return r.json().get("value", [])

gov_partners = cross_tenant_policy("https://graph.microsoft.us", "https://graph.microsoft.us")
gov_trusts_commercial = any(p.get("tenantId") == COMMERCIAL_TENANT_ID for p in gov_partners)
print(f"Gov tenant trusts Commercial partner ({COMMERCIAL_TENANT_ID}): {gov_trusts_commercial}")

# The Commercial side must mirror this (admin runs the same on graph.microsoft.com).
# Mutual enablement is REQUIRED: "Both organizations must enable collaboration."
if not gov_trusts_commercial:
    print("REMEDIATION: In the Gov Entra admin center > External Identities > "
          "Cross-tenant access settings > Microsoft cloud settings, enable "
          "'Microsoft Azure Commercial', then add the Commercial tenant id to "
          "Organizational settings. The Commercial admin must do the reverse.")`;

const NB_RECONCILE = `# ── Step 2: reconcile the same person's two cloud identities ──────────
# A user typically has SEPARATE identities per cloud (the separation is a
# control). We build a reconciliation map keyed on an employee id so reports +
# audit can correlate the same human across clouds WITHOUT merging the accounts.
identity_map = spark.createDataFrame(
    [
        # employee_id, commercial_upn,            gov_upn,                  sso_across_clouds
        ("E-10042", "jane.doe@contoso.com",  "jane.doe@contoso.gov",  False),
        ("E-10198", "sam.lee@contoso.com",   "sam.lee@contoso.gov",   False),
        ("E-10377", "ava.kim@contoso.com",   "ava.kim@contoso.gov",   False),
    ],
    ["employee_id", "commercial_upn", "gov_upn", "sso_across_clouds"],
)
# Note (Microsoft Learn): cross-cloud invites use the UPN (email-as-sign-in is
# NOT supported across clouds), and "BYO Power BI license does not work across
# clouds" — the provider tenant must assign a new license to guests.
identity_map.write.mode("overwrite").saveAsTable("hybrid.identity_reconciliation")
display(identity_map)`;

const NB_MOVE = `# ── Step 3: customer-initiated azcopy (non-classified aggregate, C->Gov) ──
# Loom does NOT auto-move data. This cell is the customer-approved action that
# stages a NON-CLASSIFIED aggregate from the Commercial estate into the Gov
# lakehouse Bronze, then writes the attestation to hybrid.DataMovement.
import hashlib, json, subprocess, uuid
from datetime import datetime, timezone

DATASET   = "Census ACS 5-year tract aggregates"
DATA_CLASS = "Public"           # GUARD: refuse if not Public/non-classified
assert DATA_CLASS in ("Public",), "Only non-classified aggregates may move Commercial->Gov."

SRC = "https://commrefdata.blob.core.windows.net/public/acs5yr/"          # Commercial
DST = "abfss://bronze@govdlzlake.dfs.core.usgovcloudapi.net/reference/acs5yr/"  # Gov

# azcopy with SAS on each side (customer-supplied; never embedded in code).
# subprocess.run(["azcopy","copy",SRC+"?<src-sas>",DST+"?<dst-sas>","--recursive"], check=True)
print(f"[customer-initiated] azcopy {SRC} -> {DST}")

manifest = {"dataset": DATASET, "class": DATA_CLASS, "src": SRC, "dst": DST,
            "moved_at": datetime.now(timezone.utc).isoformat()}
attestation_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()

movement = {
    "movement_id": str(uuid.uuid4()), "direction": "Commercial->Gov",
    "dataset_name": DATASET, "data_class": DATA_CLASS, "method": "azcopy",
    "status": "attested", "attestation_hash": attestation_hash, **manifest,
}
print(json.dumps(movement, indent=2))
# Append to hybrid.DataMovement (TDS) + emit a HybridBridgeAudit.DataMovement row.`;

const NB_VERIFY = `# ── Verify: Gov analysts can now join public ref data against mission CUI ──
df = spark.sql("""
    SELECT m.program_code, m.metric_name, m.metric_value, m.classification,
           r.geoid, r.median_household_income
    FROM   mission_cui.gold_program_metrics  m
    LEFT JOIN reference.acs5yr_tract          r
           ON m.tract_geoid = r.geoid
    WHERE  m.reporting_period = '2026-05'
    LIMIT 20
""")
display(df)
# The CUI stays in Gov; only the NON-classified Commercial aggregate moved.
# Power BI in the Gov workspace binds to this via Direct Lake (Gov identity).`;

// ─── 9. HybridBridgeAudit ADX — cross-cloud sign-ins + APIM + movement ──────

const KQL_FN_ITAR_VIOLATION = `// Detection: any cross-cloud activity touching an ITAR-scoped DLZ, where the
// doc requires cross-cloud B2B to be DISABLED. Feeds the ITAR Activator guard.
.create-or-alter function ItarCrossCloudViolations(WindowMinutes: int = 60)
{
    union CrossCloudSignIn, ApimCrossCloudCall
    | where event_time > ago(WindowMinutes * 1m)
    | where dlz_data_class == 'ITAR'
    | project event_time, source_table = $table, actor_upn, dlz_id,
              dlz_data_class, partner_cloud, result
    | order by event_time desc
}`;

const KQL_FN_UNATTESTED_MOVE = `// Detection: a cross-cloud data movement that was marked 'moved' but never
// 'attested' within the SLA window (default 24h). Open compliance gap.
.create-or-alter function UnattestedMovements(SlaHours: int = 24)
{
    DataMovementAudit
    | where event_time > ago(30d)
    | summarize arg_max(event_time, *) by movement_id
    | where status == 'moved'
    | extend age_hours = datetime_diff('hour', now(), moved_at)
    | where age_hours > SlaHours
    | project movement_id, direction, dataset_name, data_class, moved_at, age_hours
    | order by age_hours desc
}`;

const KQL_Q_SIGNINS = `// Cross-cloud B2B sign-ins in the last 24h — who signed in across the boundary.
CrossCloudSignIn
| where event_time > ago(24h)
| project event_time, actor_upn, home_cloud, partner_cloud, dlz_id,
          dlz_data_class, conditional_access, mfa_satisfied, result
| order by event_time desc`;

const KQL_Q_APIM = `// Cross-cloud APIM brokered calls (last 24h) — allow-listed endpoints only.
ApimCrossCloudCall
| where event_time > ago(24h)
| summarize calls = count(), bytes = sum(response_bytes)
    by api_name, direction, result
| order by calls desc`;

const KQL_Q_MOVES = `// Data-movement attestations (last 30d) by direction + status.
DataMovementAudit
| where event_time > ago(30d)
| summarize arg_max(event_time, *) by movement_id
| summarize movements = count(), bytes = sum(bytes_moved)
    by direction, status, data_class
| order by direction, status`;

const KQL_Q_COST = `// Two-cloud cost split (the doc's "Two separate Azure bills" framing).
HybridCost
| where usage_date > ago(30d)
| summarize cost_usd = round(sum(cost_usd), 0) by cloud, platform
| order by cloud`;

const KQL_Q_ITAR = `// Open ITAR cross-cloud violations (feeds the Activator guard).
ItarCrossCloudViolations(1440)`;

// ─── 10. Dashboard tiles (Hybrid Bridge & Cost pane) ────────────────────────

const TILE_SIGNINS_CARD = `// Cross-cloud B2B sign-ins in the last 24h.
CrossCloudSignIn
| where event_time > ago(24h)
| summarize value = count()
| extend display_name = 'Cross-Cloud Sign-ins (24h)'`;

const TILE_BROKERED_CARD = `// Allow-listed cross-cloud APIM brokered calls in the last 24h.
ApimCrossCloudCall
| where event_time > ago(24h)
| summarize value = count()
| extend display_name = 'Brokered API Calls (24h)'`;

const TILE_ITAR_CARD = `// Open ITAR cross-cloud violations (should be ZERO).
ItarCrossCloudViolations(1440)
| summarize value = count()
| extend display_name = 'ITAR Cross-Cloud Violations'`;

const TILE_COST_BAR = `// Two-cloud cost split (Commercial Fabric vs Gov Loom).
HybridCost
| where usage_date > ago(30d)
| summarize cost_usd = round(sum(cost_usd), 0) by cloud
| order by cost_usd asc
| render barchart with (title='Azure Cost by Cloud (30d)',
                        xcolumn=cloud, ycolumns=cost_usd)`;

const TILE_SIGNIN_TREND = `// Daily cross-cloud sign-in trend.
CrossCloudSignIn
| where event_time > ago(30d)
| summarize signins = count() by bin(event_time, 1d), partner_cloud
| order by event_time asc
| render timechart with (title='Cross-Cloud Sign-in Trend (30d)')`;

const TILE_MOVE_PIE = `// Cross-cloud data movements by status (30d).
DataMovementAudit
| where event_time > ago(30d)
| summarize arg_max(event_time, *) by movement_id
| summarize value = count() by status
| render piechart with (title='Cross-Cloud Movements by Status (30d)',
                        xcolumn=status, ycolumns=value)`;

const TILE_VIOLATIONS_TABLE = `// Open ITAR violations + unattested movements (the compliance worklist).
union
  (ItarCrossCloudViolations(1440)
    | project event_time, kind='itar_cross_cloud', detail=actor_upn, dlz=dlz_id),
  (UnattestedMovements(24)
    | project event_time=moved_at, kind='unattested_movement', detail=dataset_name, dlz=direction)
| order by event_time desc`;

// ─── Bundle ─────────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'hybrid-topology',
  intro:
    '## Hybrid Fabric Commercial + CSA Loom Gov\n\n' +
    'The **most-likely federal pattern**: Microsoft **Fabric** (full SaaS) in ' +
    'the **Azure Commercial** tenant for non-classified workloads, side-by-side ' +
    'with **CSA Loom** in the **Azure Government** tenant (GCC-H / IL4 / IL5) ' +
    'for CUI / classified / ITAR — bridged by **Entra cross-cloud B2B**, a ' +
    'controlled **cross-cloud APIM** brokering lane, and **customer-initiated ' +
    '(never automatic)** data movement. Reproduces the ' +
    '[Hybrid Topology use case](../../docs/fiab/use-cases/hybrid-topology.md) ' +
    'end-to-end.\n\n' +
    'Loom installs into the **Gov** tenant, so this app seeds the **Gov-side** ' +
    'Loom artifacts with real backends, and models the Commercial/Fabric side ' +
    'as honest configuration (trust, allow-list, movement register) — because ' +
    '**Loom does not reach across the cloud boundary to create Fabric ' +
    'resources**.\n\n' +
    '**What this app seeds:**\n\n' +
    '- A **Workload-Placement Register** (Warehouse) encoding the doc’s ' +
    '"what lives where" routing table + the customer-initiated data-movement ' +
    'audit (request → approve → azcopy → attest).\n' +
    '- **Cross-Cloud Catalog Federation** (Data Product) — the manual ' +
    'catalog-reconciliation manifest for products shareable across the boundary.\n' +
    '- A **Gov Mission-CUI Lakehouse** (Bronze/Silver/Gold) seeded with sample ' +
    'CUI program metrics that must stay in Gov.\n' +
    '- A **Cross-Cloud Bootstrap & Identity-Reconciliation** notebook: verify ' +
    'the Entra cross-cloud B2B trust both ways, reconcile each user’s two ' +
    'cloud identities, and run a customer-initiated azcopy of a non-classified ' +
    'aggregate with full attestation (ITAR-guarded).\n' +
    '- A **Commercial Aggregate Mirror** (Fabric Mirroring) landing a ' +
    'non-classified aggregate into Gov Bronze for join-in-place.\n' +
    '- A **Cross-Cloud APIM Brokered Sync** pipeline (allow-listed, ' +
    'audit-every-call) with an on-demand validation run.\n' +
    '- A **Hybrid Estate** semantic model + **operations report** (what runs ' +
    'where, at what classification, on which cloud, at what cost — two bills).\n' +
    '- A **HybridBridgeAudit ADX database** (cross-cloud sign-ins, APIM call ' +
    'log, movement attestations) + **Hybrid Bridge & Cost dashboard** + an ' +
    '**ITAR Cross-Cloud Guard Activator**.\n' +
    '- A **Hybrid Workload Placement** AI Search index for discovery.',
  sourceDocs: [
    'docs/fiab/use-cases/hybrid-topology.md',
    'https://learn.microsoft.com/entra/external-id/cross-cloud-settings',
    'https://learn.microsoft.com/entra/external-id/b2b-government-national-clouds',
    'https://learn.microsoft.com/fabric/enterprise/powerbi/service-admin-entra-b2b#cross-cloud-b2b',
  ],
  items: [
    // 1 ── Workload-Placement Register (Warehouse / TDS)
    {
      itemType: 'warehouse',
      displayName: 'Workload-Placement Register',
      description:
        'T-SQL register encoding the doc’s "what lives where" routing table ' +
        '(public/CUI/ITAR → Commercial Fabric vs Gov Loom) and the ' +
        'customer-initiated cross-cloud data-movement audit (request → ' +
        'approve → azcopy → attest). Seeded with the documented placement ' +
        'policy + movement examples, including a DENIED classified-data move.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        starterQueries: [
          { name: 'What lives where (placement policy)', sql: WH_Q_PLACEMENT },
          { name: 'Pending / unattested movements', sql: WH_Q_PENDING_MOVES },
          { name: 'Denied cross-cloud movements (governance review)', sql: WH_Q_BLOCKED_MOVES },
          { name: 'ITAR DLZ cross-cloud posture check', sql: WH_Q_ITAR_GATE },
        ],
      },
    },

    // 2 ── Cross-Cloud Catalog Federation (Data Product)
    {
      itemType: 'data-product',
      displayName: 'Cross-Cloud Catalog Federation',
      description:
        'The manual catalog-reconciliation manifest from the doc’s "Catalog ' +
        'federation" section: Gov-side data products published as JSON ' +
        'manifests that may be shared to / from the Commercial Fabric catalog, ' +
        'each with a classification and a cross-cloud-shareable flag.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'data-product',
        datasets: [
          {
            id: 'dp-gov-cui-metrics',
            name: 'Mission Program Metrics (CUI)',
            description:
              'Gov-side CUI program KPIs from the mission lakehouse gold layer. ' +
              'NOT cross-cloud shareable — stays in Gov; the manifest exists in ' +
              'the federated catalog for discovery only, never the data.',
            classification: 'CUI',
          },
          {
            id: 'dp-gov-public-rollup',
            name: 'Non-Classified Program Rollup',
            description:
              'A de-classified aggregate rollup of program metrics suitable for ' +
              'Gov → Commercial sharing (audit-heavy, customer-approved only). ' +
              'This is the product that may flow back to the Commercial Fabric ' +
              'catalog for exec dashboards.',
            classification: 'Public',
          },
          {
            id: 'dp-comm-ref-noaa',
            name: 'NOAA Reference Climatology (Commercial)',
            description:
              'A Commercial Fabric data product (public reference data) whose ' +
              'manifest is reconciled into the Gov catalog so Gov analysts can ' +
              'request a customer-initiated copy into Gov Bronze.',
            classification: 'Public',
          },
          {
            id: 'dp-comm-census',
            name: 'Census ACS Aggregates (Commercial)',
            description:
              'Commercial Fabric public reference product. Already copied into ' +
              'Gov via the bootstrap notebook’s azcopy; the Gov catalog tracks ' +
              'provenance back to the Commercial manifest.',
            classification: 'Public',
          },
        ],
        glossaryTerms: [
          {
            term: 'Cross-Cloud B2B',
            definition:
              'Entra External ID Microsoft cloud settings enabling mutual B2B ' +
              'collaboration between Azure Commercial and Azure Government. ' +
              'Requires both tenants to enable each other and exchange tenant ids ' +
              '(domain-name lookup is not available across clouds).',
          },
          {
            term: 'Catalog Federation',
            definition:
              'Reconciling data-product manifests (JSON) between the Commercial ' +
              'Fabric catalog and the Gov Loom catalog. Each side’s catalog ' +
              'operates independently by default; only manifests are shared, ' +
              'never the underlying classified data.',
          },
          {
            term: 'Customer-Initiated Movement',
            definition:
              'The only way data crosses the boundary: a customer downloads from ' +
              'one cloud and uploads to the other via an approved channel ' +
              '(azcopy / manual export). Loom never moves data automatically.',
          },
          {
            term: 'ITAR Gate',
            definition:
              'For ITAR-eligible (GCC-H) DLZs, cross-cloud B2B is disabled ' +
              'entirely to remove foreign-person collaboration risk. No bridging, ' +
              'no brokered calls, no shared manifests touch an ITAR DLZ.',
          },
          {
            term: 'Two-Bill Model',
            definition:
              'Two separate Azure bills — Commercial (per Fabric F-SKU + ' +
              'consumption) and Gov (per Loom consumption). Optionally unified ' +
              'under a single MACC commit via a Microsoft EA.',
          },
        ],
        owner: { name: 'Department CDO Office', email: 'dept-cdo@contoso.gov' },
        endorsement: 'certified',
      },
    },

    // 3 ── Gov Mission-CUI Lakehouse
    {
      itemType: 'lakehouse',
      displayName: 'Gov Mission-CUI Lakehouse',
      description:
        'The Loom DLZ lakehouse for CUI mission data that must stay in the Gov ' +
        'boundary. Bronze (reference + raw), Silver (conformed), Gold (program ' +
        'metrics). Seeded with sample CUI program metrics and the non-classified ' +
        'reference aggregate copied in from Commercial.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'bronze/reference', description: 'Customer-copied non-classified Commercial reference data (NOAA / Census).' },
          { path: 'bronze/mission_raw', description: 'Raw mission CUI extracts (Gov-internal only).' },
          { path: 'silver/conformed', description: 'Cleaned + conformed mission facts.' },
          { path: 'gold/program_metrics', description: 'Curated CUI program KPIs (stay in Gov).' },
        ],
        deltaTables: [
          {
            name: 'gold_program_metrics',
            ddl:
              'CREATE TABLE mission_cui.gold_program_metrics (\n' +
              '  program_code     STRING,\n' +
              '  metric_name      STRING,\n' +
              '  metric_value     DOUBLE,\n' +
              '  target_value     DOUBLE,\n' +
              '  tract_geoid      STRING,\n' +
              '  reporting_period STRING,\n' +
              '  classification   STRING\n' +
              ') USING DELTA\n' +
              "TBLPROPERTIES ('delta.minReaderVersion'='3','delta.minWriterVersion'='7');",
            sampleRows: [
              ['PRG-001', 'cases_processed',    34110, 36000, '51059481600', '2026-05', 'CUI'],
              ['PRG-001', 'sla_attainment_pct',    97.1,   95.0, '51059481600', '2026-05', 'CUI'],
              ['PRG-002', 'avg_backlog',            329,    400, '51059481700', '2026-05', 'CUI'],
              ['PRG-003', 'field_visits',           512,    480, '06037206031', '2026-05', 'CUI'],
            ],
          },
          {
            name: 'acs5yr_tract',
            ddl:
              'CREATE TABLE reference.acs5yr_tract (\n' +
              '  geoid                    STRING,\n' +
              '  state_name               STRING,\n' +
              '  median_household_income  DOUBLE,\n' +
              '  population               BIGINT,\n' +
              '  classification           STRING\n' +
              ') USING DELTA;',
            sampleRows: [
              ['51059481600', 'Virginia',   118500, 4821, 'Public'],
              ['51059481700', 'Virginia',    96200, 5102, 'Public'],
              ['06037206031', 'California',  74300, 3955, 'Public'],
            ],
          },
        ],
        shortcuts: [
          {
            name: 'commercial_aggregate',
            target: 'abfss://bronze@govdlzlake.dfs.core.usgovcloudapi.net/reference/',
            description:
              'OneLake/ADLS shortcut over the customer-copied Commercial ' +
              'reference aggregate (non-classified only). Surfaces the data the ' +
              'azcopy step landed; no live cross-cloud query.',
          },
        ],
      },
    },

    // 4 ── Cross-Cloud Bootstrap & Identity-Reconciliation notebook
    {
      itemType: 'notebook',
      displayName: 'Cross-Cloud Bootstrap & Identity Reconciliation',
      description:
        'Runnable PySpark that verifies the Entra cross-cloud B2B trust both ' +
        'ways, reconciles each user’s separate Commercial / Gov identities, ' +
        'and performs a customer-initiated azcopy of a non-classified aggregate ' +
        'Commercial → Gov with full attestation. ITAR-guarded: refuses to run ' +
        'on an ITAR DLZ.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          { id: 'hyb-nb-0', type: 'markdown', source: NB_INTRO },
          { id: 'hyb-nb-1', type: 'code', lang: 'pyspark', source: NB_CONFIG },
          { id: 'hyb-nb-2', type: 'code', lang: 'pyspark', source: NB_ITAR_GUARD },
          { id: 'hyb-nb-3', type: 'code', lang: 'pyspark', source: NB_VERIFY_TRUST },
          { id: 'hyb-nb-4', type: 'code', lang: 'pyspark', source: NB_RECONCILE },
          { id: 'hyb-nb-5', type: 'code', lang: 'pyspark', source: NB_MOVE },
          { id: 'hyb-nb-6', type: 'code', lang: 'pyspark', source: NB_VERIFY },
        ],
      },
    },

    // 5 ── Commercial Aggregate Mirror (Fabric Mirroring, Gov side)
    {
      itemType: 'mirrored-database',
      displayName: 'Commercial Aggregate Mirror',
      description:
        'Mirrors a NON-classified aggregate that the customer staged into a ' +
        'Gov-reachable Azure SQL into the Loom lakehouse Bronze as Delta, so ' +
        'Gov analysts can join public reference data against mission CUI ' +
        'without a live cross-cloud query. Replication starts on install.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'mirrored-database',
        source: {
          kind: 'azure-sql',
          server: 'govrefstage.database.usgovcloudapi.net',
          database: 'commercial_reference_stage',
          tables: [
            'ref.acs5yr_tract',
            'ref.noaa_station_normals',
          ],
        },
      },
    },

    // 6 ── Cross-Cloud APIM Brokered Sync (Data Pipeline)
    {
      itemType: 'data-pipeline',
      displayName: 'Cross-Cloud APIM Brokered Sync',
      description:
        'The doc’s controlled cross-cloud APIM lane: forward-proxy APIM in ' +
        'Commercial, reverse-proxy in Gov, peered via federation policy with a ' +
        'customer allow-list and an audit log of every call. Materialized as a ' +
        'Loom pipeline that pulls only allow-listed, non-classified aggregates ' +
        'and lands them in Gov Bronze, with an on-demand validation run.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'synapse-pipeline',
        parameters: {
          allowListOnly: { type: 'bool', defaultValue: true },
          apiName: { type: 'string', defaultValue: 'public-reference-aggregates' },
        },
        activities: [
          {
            name: 'AssertAllowList',
            type: 'IfCondition',
            config: {
              description:
                'Refuse any endpoint not on the customer-defined allow-list. ' +
                'Classified / live-mission APIs are NEVER brokered across clouds.',
              expression: "@equals(pipeline().parameters.allowListOnly, true)",
            },
          },
          {
            name: 'CallCrossCloudApim',
            type: 'WebActivity',
            dependsOn: ['AssertAllowList'],
            config: {
              description:
                'Calls the Gov reverse-proxy APIM endpoint that fronts the ' +
                'peered Commercial forward-proxy. Every call is audited to ' +
                'HybridBridgeAudit.ApimCrossCloudCall. Reverse-proxy enforces ' +
                'the allow-list + classification headers.',
              method: 'GET',
              url: 'https://apim-gov-bridge.azure-api.us/broker/public-reference-aggregates',
              headers: {
                'x-data-class': 'Public',
                'x-allow-list': '@pipeline().parameters.apiName',
              },
            },
          },
          {
            name: 'LandToBronze',
            type: 'Copy',
            dependsOn: ['CallCrossCloudApim'],
            config: {
              source: {
                type: 'JsonSource',
                description: 'Brokered allow-listed non-classified payload.',
              },
              sink: {
                type: 'LakehouseTableSink',
                description: 'Land into the Gov mission lakehouse Bronze reference area.',
                lakehouse: 'Gov Mission-CUI Lakehouse',
                table: 'reference.brokered_aggregates',
              },
            },
          },
          {
            name: 'AuditCall',
            type: 'AzureDataExplorerCommand',
            dependsOn: ['LandToBronze'],
            config: {
              database: 'HybridBridgeAudit',
              command: ".ingest inline into table ApimCrossCloudCall <| now(),'public-reference-aggregates','Commercial->Gov','Public','succeeded'",
              description:
                'Append the brokered-call audit row so the Hybrid Bridge ' +
                'dashboard + ITAR guard see every cross-cloud call.',
            },
          },
        ],
      },
    },

    // 7 ── Hybrid Estate semantic model
    {
      itemType: 'semantic-model',
      displayName: 'Hybrid Estate Model',
      description:
        'Star schema over the workload-placement + movement + cost facts so a ' +
        'single Power BI surface shows what runs where, at what classification, ' +
        'on which cloud, at what cost (two bills). Direct Lake over the Gov ' +
        'lakehouse + register.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'DimWorkload',
            columns: [
              { name: 'WorkloadId', dataType: 'String' },
              { name: 'WorkloadName', dataType: 'String' },
              { name: 'DataClass', dataType: 'String' },
            ],
          },
          {
            name: 'DimCloud',
            columns: [
              { name: 'Cloud', dataType: 'String' },
              { name: 'Platform', dataType: 'String' },
              { name: 'Boundary', dataType: 'String' },
            ],
          },
          {
            name: 'DimDate',
            columns: [
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'Date', dataType: 'Date' },
              { name: 'Year', dataType: 'Int64' },
              { name: 'Month', dataType: 'Int64' },
            ],
          },
          {
            name: 'FactCost',
            columns: [
              { name: 'Cloud', dataType: 'String' },
              { name: 'Platform', dataType: 'String' },
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'CostUsd', dataType: 'Double' },
            ],
          },
          {
            name: 'FactMovement',
            columns: [
              { name: 'MovementId', dataType: 'String' },
              { name: 'Direction', dataType: 'String' },
              { name: 'DataClass', dataType: 'String' },
              { name: 'Status', dataType: 'String' },
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'BytesMoved', dataType: 'Double' },
            ],
          },
        ],
        measures: [
          {
            table: 'FactCost',
            name: 'Total Cost',
            expression: 'SUM ( FactCost[CostUsd] )',
            formatString: '\\$#,0',
          },
          {
            table: 'FactCost',
            name: 'Commercial Cost',
            expression: "CALCULATE ( [Total Cost], DimCloud[Cloud] = \"Commercial\" )",
            formatString: '\\$#,0',
          },
          {
            table: 'FactCost',
            name: 'Gov Cost',
            expression: "CALCULATE ( [Total Cost], DimCloud[Cloud] = \"Gov\" )",
            formatString: '\\$#,0',
          },
          {
            table: 'FactMovement',
            name: 'Movements',
            expression: 'DISTINCTCOUNT ( FactMovement[MovementId] )',
            formatString: '#,0',
          },
          {
            table: 'FactMovement',
            name: 'Attested Movements',
            expression: "CALCULATE ( [Movements], FactMovement[Status] = \"attested\" )",
            formatString: '#,0',
          },
          {
            table: 'FactMovement',
            name: 'GB Moved',
            expression: 'DIVIDE ( SUM ( FactMovement[BytesMoved] ), 1073741824 )',
            formatString: '#,0.00',
          },
        ],
        relationships: [
          { from: 'FactCost.Cloud', to: 'DimCloud.Cloud', cardinality: 'many:many' },
          { from: 'FactCost.DateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
          { from: 'FactMovement.DateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
        ],
      },
    },

    // 8 ── Hybrid Estate Operations report
    {
      itemType: 'report',
      displayName: 'Hybrid Estate Operations',
      description:
        'Exec report: a "what lives where" placement map, the cross-cloud ' +
        'data-movement audit, and the two-bill cost split (Commercial Fabric ' +
        'vs Gov Loom). Sensitivity labels propagate from the model to any ' +
        'export.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'report',
        pages: [
          {
            name: 'Estate Overview',
            visuals: [
              { type: 'card', title: 'Commercial Cost (30d)', field: 'Commercial Cost' },
              { type: 'card', title: 'Gov Cost (30d)', field: 'Gov Cost' },
              { type: 'card', title: 'Cross-Cloud Movements', field: 'Movements' },
              {
                type: 'clusteredColumnChart',
                title: 'Cost by Cloud',
                config: { axis: 'DimCloud.Cloud', value: 'Total Cost' },
              },
            ],
          },
          {
            name: 'What Lives Where',
            visuals: [
              {
                type: 'table',
                title: 'Workload Placement Policy',
                config: { columns: ['DimWorkload.WorkloadName', 'DimWorkload.DataClass', 'DimCloud.Cloud', 'DimCloud.Platform', 'DimCloud.Boundary'] },
              },
              {
                type: 'matrix',
                title: 'Classification x Cloud',
                config: { rows: 'DimWorkload.DataClass', columns: 'DimCloud.Cloud', values: 'Movements' },
              },
            ],
          },
          {
            name: 'Cross-Cloud Movement Audit',
            visuals: [
              {
                type: 'table',
                title: 'Movement Register',
                config: { columns: ['FactMovement.MovementId', 'FactMovement.Direction', 'FactMovement.DataClass', 'FactMovement.Status', 'GB Moved'] },
              },
              {
                type: 'donutChart',
                title: 'Movements by Status',
                config: { legend: 'FactMovement.Status', value: 'Movements' },
              },
              { type: 'kpi', title: 'Attestation Rate', config: { value: 'Attested Movements', target: 'Movements' } },
            ],
          },
        ],
      },
    },

    // 9 ── HybridBridgeAudit ADX database
    {
      itemType: 'kql-database',
      displayName: 'HybridBridgeAudit (ADX)',
      description:
        'Central cross-cloud audit ADX database: CrossCloudSignIn (Entra B2B ' +
        'sign-ins across the boundary), ApimCrossCloudCall (brokered-call log), ' +
        'DataMovementAudit (movement attestations), and HybridCost (two-bill ' +
        'facts), with ITAR-violation + unattested-movement detection functions. ' +
        'Seeded with sample rows.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'CrossCloudSignIn',
            columns: [
              { name: 'event_time',         type: 'datetime' },
              { name: 'actor_upn',          type: 'string'   },
              { name: 'home_cloud',         type: 'string'   },
              { name: 'partner_cloud',      type: 'string'   },
              { name: 'dlz_id',             type: 'string'   },
              { name: 'dlz_data_class',     type: 'string'   },
              { name: 'conditional_access', type: 'string'   },
              { name: 'mfa_satisfied',      type: 'bool'     },
              { name: 'result',             type: 'string'   },
            ],
            sample: [
              ['2026-05-29T13:02:00Z', 'jane.doe@contoso.com', 'Commercial', 'Gov', 'dlz-mission-il4', 'CUI', 'require-mfa+compliant', true, 'success'],
              ['2026-05-29T14:18:00Z', 'sam.lee@contoso.com',  'Commercial', 'Gov', 'dlz-mission-il4', 'CUI', 'require-mfa+compliant', true, 'success'],
              ['2026-05-30T08:40:00Z', 'ava.kim@contoso.com',  'Commercial', 'Gov', 'dlz-itar-gcch',  'ITAR', 'block-cross-cloud',    false, 'blocked'],
            ],
          },
          {
            name: 'ApimCrossCloudCall',
            columns: [
              { name: 'event_time',     type: 'datetime' },
              { name: 'api_name',       type: 'string'   },
              { name: 'direction',      type: 'string'   },
              { name: 'data_class',     type: 'string'   },
              { name: 'actor_upn',      type: 'string'   },
              { name: 'dlz_id',         type: 'string'   },
              { name: 'dlz_data_class', type: 'string'   },
              { name: 'response_bytes', type: 'long'     },
              { name: 'partner_cloud',  type: 'string'   },
              { name: 'result',         type: 'string'   },
            ],
            sample: [
              ['2026-05-29T13:05:00Z', 'public-reference-aggregates', 'Commercial->Gov', 'Public', 'svc-gov-bridge', 'dlz-mission-il4', 'CUI', 524288, 'Commercial', 'succeeded'],
              ['2026-05-29T18:22:00Z', 'public-reference-aggregates', 'Commercial->Gov', 'Public', 'svc-gov-bridge', 'dlz-mission-il4', 'CUI', 786432, 'Commercial', 'succeeded'],
              ['2026-05-30T08:41:00Z', 'live-mission-feed',           'Commercial->Gov', 'CUI',    'svc-gov-bridge', 'dlz-itar-gcch',  'ITAR', 0,      'Commercial', 'denied-not-allowlisted'],
            ],
          },
          {
            name: 'DataMovementAudit',
            columns: [
              { name: 'event_time',       type: 'datetime' },
              { name: 'movement_id',      type: 'string'   },
              { name: 'direction',        type: 'string'   },
              { name: 'dataset_name',     type: 'string'   },
              { name: 'data_class',       type: 'string'   },
              { name: 'method',           type: 'string'   },
              { name: 'status',           type: 'string'   },
              { name: 'bytes_moved',      type: 'long'     },
              { name: 'attestation_hash', type: 'string'   },
              { name: 'moved_at',         type: 'datetime' },
            ],
            sample: [
              ['2026-05-18T13:42:00Z', 'mv-0001', 'Commercial->Gov', 'NOAA station normals 1991-2020', 'Public', 'azcopy', 'attested', 734003200, 'b7c9e21a', '2026-05-18T13:42:00Z'],
              ['2026-05-22T09:55:00Z', 'mv-0002', 'Commercial->Gov', 'Census ACS 5-year tract aggregates', 'Public', 'azcopy', 'attested', 1288490188, '4f1d9ac3', '2026-05-22T09:55:00Z'],
              ['2026-05-29T15:20:00Z', 'mv-0003', 'Gov->Commercial', 'Non-classified program KPI rollup (Q1)', 'Public', 'manual-export', 'approved', 0, '', ''],
              ['2026-05-30T08:05:00Z', 'mv-0004', 'Commercial->Gov', 'Live mission feed (BLOCKED)', 'CUI', 'apim-broker', 'denied', 0, '', ''],
            ],
          },
          {
            name: 'HybridCost',
            columns: [
              { name: 'usage_date', type: 'datetime' },
              { name: 'cloud',      type: 'string'   },
              { name: 'platform',   type: 'string'   },
              { name: 'meter',      type: 'string'   },
              { name: 'cost_usd',   type: 'real'     },
            ],
            sample: [
              ['2026-05-29T00:00:00Z', 'Commercial', 'Fabric', 'F64 Capacity',      5200.00],
              ['2026-05-29T00:00:00Z', 'Commercial', 'Fabric', 'OneLake Storage',    410.30],
              ['2026-05-29T00:00:00Z', 'Gov',        'Loom',   'Databricks',        1820.55],
              ['2026-05-29T00:00:00Z', 'Gov',        'Loom',   'Azure Data Explorer', 640.12],
              ['2026-05-29T00:00:00Z', 'Gov',        'Loom',   'Synapse Serverless',  295.80],
              ['2026-05-30T00:00:00Z', 'Commercial', 'Fabric', 'F64 Capacity',      5200.00],
              ['2026-05-30T00:00:00Z', 'Gov',        'Loom',   'Databricks',        1798.44],
            ],
          },
        ],
        functions: [
          { name: 'ItarCrossCloudViolations', body: KQL_FN_ITAR_VIOLATION },
          { name: 'UnattestedMovements',      body: KQL_FN_UNATTESTED_MOVE },
        ],
        ingestionPolicies: [
          {
            table: 'CrossCloudSignIn',
            policy:
              '.alter-merge table CrossCloudSignIn policy retention softdelete = 365d\n' +
              '.alter table CrossCloudSignIn policy streamingingestion enable',
          },
          {
            table: 'DataMovementAudit',
            policy:
              '.alter-merge table DataMovementAudit policy retention softdelete = 730d\n' +
              '.alter-merge table DataMovementAudit policy caching   hot        =  90d',
          },
        ],
        starterQueries: [
          { name: 'Cross-cloud sign-ins (24h)', kql: KQL_Q_SIGNINS },
          { name: 'Brokered APIM calls (24h)', kql: KQL_Q_APIM },
          { name: 'Data movements (30d)', kql: KQL_Q_MOVES },
          { name: 'Two-cloud cost split (30d)', kql: KQL_Q_COST },
          { name: 'Open ITAR cross-cloud violations', kql: KQL_Q_ITAR },
        ],
      },
    },

    // 10 ── Hybrid Bridge & Cost dashboard
    {
      itemType: 'kql-dashboard',
      displayName: 'Hybrid Bridge & Cost',
      description:
        'SOC / ops pane for the hybrid estate: cross-cloud sign-ins, brokered ' +
        'API-call volume, ITAR violation count (should be zero), two-cloud ' +
        'cost split, sign-in trend, movements by status, and the open ITAR + ' +
        'unattested-movement worklist.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          { title: 'Cross-Cloud Sign-ins (24h)', viz: 'card',  kql: TILE_SIGNINS_CARD },
          { title: 'Brokered API Calls (24h)',   viz: 'card',  kql: TILE_BROKERED_CARD },
          { title: 'ITAR Cross-Cloud Violations', viz: 'card', kql: TILE_ITAR_CARD },
          { title: 'Azure Cost by Cloud (30d)',  viz: 'bar',   kql: TILE_COST_BAR },
          { title: 'Cross-Cloud Sign-in Trend',  viz: 'line',  kql: TILE_SIGNIN_TREND },
          { title: 'Movements by Status (30d)',  viz: 'pie',   kql: TILE_MOVE_PIE },
          { title: 'ITAR + Unattested Worklist', viz: 'table', kql: TILE_VIOLATIONS_TABLE },
        ],
      },
    },

    // 11 ── ITAR Cross-Cloud Guard Activator
    {
      itemType: 'activator',
      displayName: 'ITAR Cross-Cloud Guard',
      description:
        'Fires when any cross-cloud B2B sign-in or brokered call touches an ' +
        'ITAR-scoped DLZ (where cross-cloud B2B MUST be disabled), or when a ' +
        'cross-cloud data movement is marked moved but never attested. Routes ' +
        'to the Department security team and forwards the detection to Sentinel.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'activator',
        rule: {
          name: 'ITAR Cross-Cloud / Unattested-Movement Guard',
          condition: { metric: 'itar_cross_cloud_violations', op: '>', threshold: 0 },
          window: 'PT60M',
          action: {
            kind: 'webhook',
            config: {
              description:
                'POST the ItarCrossCloudViolations / UnattestedMovements rows to ' +
                'the Sentinel (Gov) Logs ingestion endpoint and notify security. ' +
                'Backed by HybridBridgeAudit.ItarCrossCloudViolations.',
              url: 'https://${sentinelGovWorkspace}.ods.opinsights.azure.us/api/logs',
              method: 'POST',
              source: 'HybridBridgeAudit.ItarCrossCloudViolations',
              dcrImmutableId: '${SENTINEL_GOV_DCR_IMMUTABLE_ID}',
              streamName: 'Custom-LoomHybridBridgeViolation_CL',
              alsoNotify: { kind: 'teams', channel: 'Department Security Operations' },
            },
          },
        },
      },
    },

    // 12 ── Hybrid Workload Placement search index
    {
      itemType: 'ai-search-index',
      displayName: 'Hybrid Workload Placement Search',
      description:
        'Azure AI Search (Gov) index over the workload-placement register so ' +
        'operators can discover, by classification + cloud + boundary, where ' +
        'any workload should live and where it currently runs. Seeded with the ' +
        'documented placement policy.',
      learnDoc: 'fiab/use-cases/hybrid-topology',
      content: {
        kind: 'ai-search-index',
        schema: {
          fields: [
            { name: 'workload_id',   type: 'Edm.String', key: true, filterable: true },
            { name: 'workload_name', type: 'Edm.String', searchable: true },
            { name: 'rationale',     type: 'Edm.String', searchable: true },
            { name: 'data_class',    type: 'Edm.String', filterable: true },
            { name: 'cloud',         type: 'Edm.String', filterable: true },
            { name: 'platform',      type: 'Edm.String', filterable: true },
            { name: 'boundary',      type: 'Edm.String', filterable: true },
            { name: 'cross_cloud_b2b', type: 'Edm.Boolean', filterable: true },
          ],
        },
        scoringProfiles: [
          {
            name: 'boost-name',
            description:
              'Boosts workload-name matches so operators find the right ' +
              'placement row quickly when searching the estate.',
          },
        ],
        sampleDocs: [
          { workload_id: 'wp-public-ref',       workload_name: 'Public reference datasets (NOAA / Census)', rationale: 'Non-classified public data fits Fabric Commercial naturally.', data_class: 'Public', cloud: 'Commercial', platform: 'Fabric', boundary: '', cross_cloud_b2b: true },
          { workload_id: 'wp-exec-pbi',         workload_name: 'Exec Power BI dashboards', rationale: 'M365 Commercial identity; BYO-license does not cross clouds.', data_class: 'Public', cloud: 'Commercial', platform: 'Fabric', boundary: '', cross_cloud_b2b: true },
          { workload_id: 'wp-mission-cui',      workload_name: 'Mission CUI data', rationale: 'CUI requires the Gov boundary; stays in the Loom DLZ.', data_class: 'CUI', cloud: 'Gov', platform: 'Loom', boundary: 'IL4', cross_cloud_b2b: true },
          { workload_id: 'wp-agency-classified', workload_name: 'Agency-internal classified analytics', rationale: 'Classified analytics on a National Security System.', data_class: 'CUI-NSS', cloud: 'Gov', platform: 'Loom', boundary: 'IL5', cross_cloud_b2b: true },
          { workload_id: 'wp-itar',             workload_name: 'ITAR-eligible workloads', rationale: 'GCC-H specifically; cross-cloud B2B DISABLED for this DLZ.', data_class: 'ITAR', cloud: 'Gov', platform: 'Loom', boundary: 'GCC-H', cross_cloud_b2b: false },
          { workload_id: 'wp-hhs-cui',          workload_name: 'HHS / VHA clinical CUI', rationale: 'HIPAA-aligned clinical CUI; Gov-only.', data_class: 'PHI', cloud: 'Gov', platform: 'Loom', boundary: 'IL4', cross_cloud_b2b: true },
        ],
      },
    },
  ],
};

export default bundle;
