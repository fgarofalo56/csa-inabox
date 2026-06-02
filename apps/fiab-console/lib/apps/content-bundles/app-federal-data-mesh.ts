/**
 * Federal Data Mesh — app-install content bundle.
 *
 * Sourced from docs/fiab/use-cases/federal-data-mesh.md. Reproduces the
 * documented federated-governance pattern 1:1: a Department-CIO Admin Plane
 * governing multiple autonomous agency DLZ domains, each publishing data
 * products to a central cross-domain Marketplace, with Delta Sharing grants,
 * MIP sensitivity-label propagation (Purview), Sentinel audit of cross-DLZ
 * access, and a cross-DLZ cost rollup for the Department CIO.
 *
 * Items (one per documented object):
 *   - data-product       Cross-Domain Marketplace (Agency Performance Metrics
 *                        + 3 sibling domain products, classification + glossary)
 *   - lakehouse          Agency A domain lakehouse (the shared Delta tables +
 *                        seeded sample rows that back the data product)
 *   - notebook           Delta Sharing grant + catalog-adapter sync (the
 *                        "grant created -> Agency B catalog picks it up in 5 min"
 *                        automation step from the doc's cross-domain example)
 *   - warehouse          Federated access-request register + cross-domain
 *                        access audit (the request/approve/90-day-window flow)
 *   - semantic-model     Cross-Agency Performance model with MIP-label
 *                        propagation columns (Restricted-PII/PHI, CUI, CUI-NSS)
 *   - report             Cross-Agency Dashboards (Agency B's reporting surface
 *                        querying the shared product)
 *   - kql-database       FederationAudit ADX DB: cross-DLZ access events +
 *                        per-DLZ cost facts + Sentinel label-violation detections
 *   - kql-dashboard      Department CIO Federation & Cost pane (cross-DLZ rollup)
 *   - activator          Label-violation / large-PII-download alert -> Sentinel
 *   - ai-search-index    Marketplace catalog search index (browse/discover
 *                        cross-domain data products by classification + domain)
 *   - data-pipeline      Per-DLZ cost-rollup ingestion (Cost Management exports
 *                        per agency subscription -> FederationAudit.DomainCost)
 *
 * Backend per control (Phase-2 provisioners under lib/install/provisioners/):
 *   notebook -> notebook.ts (Fabric/Synapse Spark), kql-database -> kql-db.ts
 *   (ADX .create table + .ingest inline sample rows), lakehouse -> lakehouse.ts
 *   (OneLake/ADLS Delta + sample rows), warehouse -> warehouse.ts (TDS DDL +
 *   INSERT), semantic-model -> semantic-model.ts (TMDL), eventstream/activator
 *   -> activator.ts, ai-search-index -> ai-search.ts, data-pipeline ->
 *   data-pipeline.ts. kql-dashboard + report have editors but no dedicated
 *   provisioner yet (integrator/verify pass flags the gap); content is still
 *   stamped onto state.content so the editor renders a fully-formed surface.
 *
 * Sensitivity-label taxonomy and the cross-domain Delta Sharing protocol are
 * grounded in the use-case doc; Purview MIP labels (Restricted-PII,
 * Restricted-PHI, CUI, CUI-NSS) and Delta Sharing semantics follow Microsoft
 * Learn (Microsoft Purview Information Protection sensitivity labels; Delta
 * Sharing open protocol as exposed by Azure Databricks Unity Catalog).
 */

import type { AppBundle } from './types';

// ─── Delta Sharing grant + catalog-adapter notebook ─────────────────────
// Implements the doc's automation row: "Delta Sharing grant created; Agency
// B's catalog adapter picks it up within 5 min". Real, runnable PySpark +
// Delta Sharing client cells.

const NB_MD_INTRO = `# Cross-Domain Delta Sharing — grant + catalog sync

This notebook automates the **cross-domain data product** flow from the
[Federal Data Mesh use case](../../docs/fiab/use-cases/federal-data-mesh.md):

| Step | Actor |
|---|---|
| Agency A publishes "Agency Performance Metrics" to the Marketplace | Agency A Domain Steward |
| Agency B requests access ("Cross-agency dashboards") | Agency B Workspace Admin |
| Agency A approves with a **90-day window** | Agency A Domain Steward |
| **Delta Sharing grant created; Agency B catalog adapter picks it up in 5 min** | *this notebook* |
| Agency B Power BI reports query the shared product | Automatic |
| Audit entry: cross-DLZ access by Agency B user X | Automatic -> Sentinel |

The grant is expressed as a Delta Sharing **share / schema / table** plus a
time-boxed **recipient** token. The Agency-B side polls the share profile on
a 5-minute cadence and registers any newly granted tables in its catalog.

> Sensitivity labels (\`Restricted-PII\`, \`Restricted-PHI\`, \`CUI\`,
> \`CUI-NSS\`) authored by the Department CDO in Purview travel with the share
> metadata so the consumer inherits the producer's classification.`;

const NB_CODE_CONFIG = `# ── Federation config (resolved from Loom env / DLZ context) ──────────────
# Each agency owns its own DLZ subscription under one Entra tenant. The
# producer (Agency A) shares; the consumer (Agency B) subscribes.
from datetime import datetime, timedelta, timezone

PRODUCER_DOMAIN   = "agency-a"          # Domain Steward = Agency A
CONSUMER_DOMAIN   = "agency-b"          # requesting domain
SHARE_NAME        = "agency_a_performance"
DATA_PRODUCT      = "Agency Performance Metrics"
USE_CASE          = "Cross-agency dashboards"
GRANT_WINDOW_DAYS = 90                   # doc: "approves with 90-day window"

# Sensitivity labels travel with the share (Purview MIP taxonomy).
CLASSIFICATION    = "CUI"                # Controlled Unclassified Information

granted_at  = datetime.now(timezone.utc)
expires_at  = granted_at + timedelta(days=GRANT_WINDOW_DAYS)
print(f"Producer={PRODUCER_DOMAIN}  Consumer={CONSUMER_DOMAIN}")
print(f"Grant {SHARE_NAME} valid {granted_at:%Y-%m-%d} -> {expires_at:%Y-%m-%d} ({GRANT_WINDOW_DAYS}d)")`;

const NB_CODE_GRANT = `# ── Producer side: create the Delta Sharing grant (Agency A) ──────────────
# Unity Catalog / Delta Sharing DDL. Run by the Agency A Domain Steward when
# they approve Agency B's request. The share exposes only the gold-layer
# performance tables — never the raw silver/bronze domain data.
grant_sql = f'''
CREATE SHARE IF NOT EXISTS {SHARE_NAME}
  COMMENT 'Data product: {DATA_PRODUCT} (classification: {CLASSIFICATION})';

ALTER SHARE {SHARE_NAME}
  ADD TABLE agency_a_gold.performance_metrics_daily;
ALTER SHARE {SHARE_NAME}
  ADD TABLE agency_a_gold.performance_metrics_monthly;

-- Time-boxed recipient for the consuming domain (90-day window).
CREATE RECIPIENT IF NOT EXISTS recipient_{CONSUMER_DOMAIN.replace("-","_")}
  COMMENT 'Use case: {USE_CASE}; expires {expires_at:%Y-%m-%d}';

GRANT SELECT ON SHARE {SHARE_NAME}
  TO RECIPIENT recipient_{CONSUMER_DOMAIN.replace("-","_")};
'''
for stmt in [s.strip() for s in grant_sql.split(";") if s.strip()]:
    spark.sql(stmt)
print("Delta Sharing grant created on producer side.")`;

const NB_CODE_AUDIT = `# ── Emit the cross-DLZ audit event (-> FederationAudit KQL DB -> Sentinel) ─
# Every grant + every consumer read is written to the central audit trail so
# the Department CIO / Sentinel can detect cross-domain access patterns.
import json, uuid

audit_event = {
    "event_id":       str(uuid.uuid4()),
    "event_time":     granted_at.isoformat(),
    "event_type":     "delta_share_grant_created",
    "producer_domain": PRODUCER_DOMAIN,
    "consumer_domain": CONSUMER_DOMAIN,
    "share_name":     SHARE_NAME,
    "data_product":   DATA_PRODUCT,
    "classification": CLASSIFICATION,
    "use_case":       USE_CASE,
    "granted_by":     "agency-a-domain-steward@dept.gov",
    "expires_at":     expires_at.isoformat(),
}
# Written to ADX table FederationAudit.CrossDomainAccess via the streaming
# ingest endpoint (see the FederationAudit KQL database item in this app).
print(json.dumps(audit_event, indent=2))`;

const NB_MD_CONSUMER = `## Consumer side — Agency B catalog adapter (5-minute poll)

The cell below is the **catalog adapter** that runs on Agency B's DLZ. It
polls the Delta Sharing profile and registers newly granted tables into
Agency B's catalog so Power BI / notebooks can query the shared product —
no copy, query-in-place over the open Delta Sharing protocol.`;

const NB_CODE_CONSUMER = `# ── Consumer side: poll share + register tables (Agency B) ────────────────
# Uses the delta-sharing client against the recipient profile (bearer token
# bootstrapped from the recipient activation link, stored in Key Vault).
import delta_sharing  # pip install delta-sharing (preinstalled in env)

PROFILE_PATH = "/dbfs/mnt/secrets/agency_a_performance.share"  # KV-backed

client = delta_sharing.SharingClient(PROFILE_PATH)
new_tables = []
for t in client.list_all_tables():
    full = f"{t.share}.{t.schema}.{t.name}"
    # Register as a catalog view over the shared table (query-in-place).
    spark.sql(f'''
        CREATE OR REPLACE VIEW agency_b_shared.{t.name}
        AS SELECT * FROM delta_sharing.\`{PROFILE_PATH}#{full}\`
    ''')
    new_tables.append(full)

print(f"Catalog adapter registered {len(new_tables)} shared table(s):")
for t in new_tables:
    print("  +", t)
# Scheduled every 5 minutes by the per-domain catalog-sync job.`;

const NB_CODE_VERIFY = `# ── Verify: Agency B can now query Agency A's performance product ─────────
df = spark.sql("""
    SELECT agency_code, metric_name, metric_value, reporting_period, classification
    FROM agency_b_shared.performance_metrics_monthly
    WHERE reporting_period >= '2026-01'
    ORDER BY reporting_period DESC, metric_name
    LIMIT 20
""")
display(df)
# Power BI reports in Agency B's workspace bind to this same shared view via
# Direct Lake; MIP labels propagate from the producer's classification column.`;

// ─── FederationAudit KQL — cross-DLZ access + cost + Sentinel detections ──

const KQL_FN_DOMAIN_COST_ROLLUP = `// Cross-DLZ cost rollup for the Department CIO "Monitoring -> Cost" pane.
// Aggregates per-agency Azure consumption into a department-level view and
// shows MACC (pre-purchased commit) burn-down.
.create-or-alter function DomainCostRollup(LookbackDays: int = 30)
{
    DomainCost
    | where usage_date > ago(LookbackDays * 1d)
    | summarize
        cost_usd        = sum(cost_usd),
        meter_count     = dcount(meter_category)
        by domain, subscription_id, boundary
    | extend macc_eligible = cost_usd        // all FedCiv consumption is MACC-eligible
    | order by cost_usd desc
}`;

const KQL_FN_LABEL_VIOLATION = `// Sentinel detection: a user pulling a large volume of Restricted-PII (or
// PHI) labeled rows across a cross-DLZ share within a short window. Mirrors
// the doc's "Sentinel rules detect label-violation patterns" requirement.
.create-or-alter function LabelViolationDetections(WindowMinutes: int = 60,
                                                   RowThreshold:  long = 50000)
{
    CrossDomainAccess
    | where event_time > ago(WindowMinutes * 1m)
    | where event_type == "delta_share_read"
    | where classification in ('Restricted-PII', 'Restricted-PHI')
    | summarize
        rows_read     = sum(rows_returned),
        reads         = count(),
        products      = make_set(data_product),
        domains       = make_set(producer_domain)
        by consumer_user, consumer_domain, bin(event_time, WindowMinutes * 1m)
    | where rows_read > RowThreshold
    | extend severity = iff(rows_read > 250000, 'High', 'Medium')
    | project event_time, consumer_user, consumer_domain, rows_read, reads,
              products, domains, severity
    | order by rows_read desc
}`;

const KQL_Q_CROSS_DLZ_RECENT = `// Cross-DLZ access in the last 24h — who read which agency's product.
CrossDomainAccess
| where event_time > ago(24h)
| where event_type in ('delta_share_read', 'delta_share_grant_created')
| project event_time, event_type, consumer_domain, consumer_user,
          producer_domain, data_product, classification, rows_returned
| order by event_time desc`;

const KQL_Q_ACTIVE_GRANTS = `// Active cross-domain grants and days remaining in their 90-day window.
CrossDomainAccess
| where event_type == 'delta_share_grant_created'
| summarize arg_max(event_time, *) by share_name, consumer_domain
| extend days_remaining = datetime_diff('day', expires_at, now())
| where days_remaining > 0
| project share_name, data_product, producer_domain, consumer_domain,
          classification, granted_at = event_time, expires_at, days_remaining
| order by days_remaining asc`;

const KQL_Q_COST_BY_DOMAIN = `// Department-level cost rollup by agency domain (last 30 days).
DomainCost
| where usage_date > ago(30d)
| summarize cost_usd = sum(cost_usd) by domain, boundary
| order by cost_usd desc`;

const KQL_Q_COST_TREND = `// Daily cross-DLZ cost trend powering the CIO cost timechart.
DomainCost
| where usage_date > ago(30d)
| summarize cost_usd = sum(cost_usd) by usage_date, domain
| order by usage_date asc`;

const KQL_Q_LABEL_VIOLATIONS = `// Recent label-violation detections (feeds the Activator alert + Sentinel).
LabelViolationDetections(60, 50000)`;

// ─── Dashboard tiles (Department CIO Federation & Cost pane) ──────────────

const TILE_TOTAL_DOMAINS = `// Active agency domains reporting consumption this month.
DomainCost
| where usage_date > startofmonth(now())
| summarize value = dcount(domain)
| extend display_name = 'Active Agency Domains'`;

const TILE_MTD_COST = `// Department-wide month-to-date Azure consumption (cross-DLZ rollup).
DomainCost
| where usage_date > startofmonth(now())
| summarize value = round(sum(cost_usd), 0)
| extend display_name = 'MTD Cross-DLZ Cost (USD)'`;

const TILE_ACTIVE_GRANTS_CARD = `// Active cross-domain data-product grants (within their 90-day window).
CrossDomainAccess
| where event_type == 'delta_share_grant_created'
| summarize arg_max(event_time, *) by share_name, consumer_domain
| where datetime_diff('day', expires_at, now()) > 0
| summarize value = count()
| extend display_name = 'Active Cross-Domain Grants'`;

const TILE_COST_BY_DOMAIN_BAR = `// Cost by agency domain — the per-domain cost-reporting view.
DomainCost
| where usage_date > ago(30d)
| summarize cost_usd = round(sum(cost_usd), 0) by domain
| order by cost_usd asc
| render barchart with (title='Azure Cost by Agency Domain (30d)',
                        xcolumn=domain, ycolumns=cost_usd)`;

const TILE_COST_TREND_LINE = `// Daily cost trend stacked by domain.
DomainCost
| where usage_date > ago(30d)
| summarize cost_usd = round(sum(cost_usd), 2) by usage_date, domain
| order by usage_date asc
| render timechart with (title='Cross-DLZ Daily Cost Trend (30d)')`;

const TILE_CLASSIFICATION_PIE = `// Cross-domain reads by sensitivity classification (24h).
CrossDomainAccess
| where event_time > ago(24h) and event_type == 'delta_share_read'
| summarize value = count() by classification
| render piechart with (title='Cross-Domain Reads by Classification (24h)',
                        xcolumn=classification, ycolumns=value)`;

const TILE_VIOLATIONS_TABLE = `// Open label-violation detections feeding Sentinel.
LabelViolationDetections(1440, 50000)
| project event_time, consumer_user, consumer_domain, rows_read, severity, products`;

// ─── Federated access-request register (Warehouse / TDS) ──────────────────

const WAREHOUSE_DDL = `-- Federated cross-domain access register + audit (T-SQL / TDS).
-- Backs the doc's request -> review -> approve(90d) -> grant flow and the
-- "different agencies may have different audit boundaries" requirement.

CREATE SCHEMA federation;
GO

-- Domain (agency) registry — one row per DLZ.
CREATE TABLE federation.Domains (
    domain_code        VARCHAR(32)  NOT NULL,
    domain_name        VARCHAR(128) NOT NULL,
    subscription_id    VARCHAR(64)  NOT NULL,
    region             VARCHAR(32)  NOT NULL,
    audit_boundary     VARCHAR(16)  NOT NULL,  -- FedRAMP-H | IL4 | IL5
    domain_steward_grp VARCHAR(128) NOT NULL,  -- Entra group object id/name
    onboarded_at       DATETIME2    NOT NULL,
    CONSTRAINT pk_domains PRIMARY KEY (domain_code)
);
GO

-- Data products published to the cross-domain Marketplace.
CREATE TABLE federation.DataProducts (
    product_id         VARCHAR(64)  NOT NULL,
    product_name       VARCHAR(160) NOT NULL,
    owner_domain       VARCHAR(32)  NOT NULL,
    classification     VARCHAR(32)  NOT NULL,  -- MIP label
    endorsement        VARCHAR(16)  NULL,      -- promoted | certified
    share_name         VARCHAR(128) NULL,      -- Delta Sharing share
    published_at       DATETIME2    NOT NULL,
    CONSTRAINT pk_products PRIMARY KEY (product_id),
    CONSTRAINT fk_products_domain FOREIGN KEY (owner_domain)
        REFERENCES federation.Domains(domain_code)
);
GO

-- Cross-domain access requests + their approval lifecycle.
CREATE TABLE federation.AccessRequests (
    request_id         VARCHAR(64)  NOT NULL,
    product_id         VARCHAR(64)  NOT NULL,
    requesting_domain  VARCHAR(32)  NOT NULL,
    requested_by       VARCHAR(128) NOT NULL,
    use_case           VARCHAR(256) NOT NULL,
    status             VARCHAR(16)  NOT NULL,  -- pending|approved|denied|expired
    decided_by         VARCHAR(128) NULL,      -- Domain Steward
    window_days        INT          NULL,      -- e.g. 90
    requested_at       DATETIME2    NOT NULL,
    decided_at         DATETIME2    NULL,
    expires_at         DATETIME2    NULL,
    CONSTRAINT pk_requests PRIMARY KEY (request_id),
    CONSTRAINT fk_requests_product FOREIGN KEY (product_id)
        REFERENCES federation.DataProducts(product_id)
);
GO

-- Seed: 4 agency domains across mixed audit boundaries (doc: FedRAMP-H / IL4 / IL5).
INSERT INTO federation.Domains
    (domain_code, domain_name, subscription_id, region, audit_boundary, domain_steward_grp, onboarded_at)
VALUES
 ('agency-a','Agency A','11111111-1111-1111-1111-111111111111','usgovvirginia','IL4','grp-agency-a-stewards','2026-01-12T00:00:00'),
 ('agency-b','Agency B','22222222-2222-2222-2222-222222222222','usgovvirginia','IL4','grp-agency-b-stewards','2026-02-03T00:00:00'),
 ('agency-c','Agency C','33333333-3333-3333-3333-333333333333','usgovtexas','FedRAMP-H','grp-agency-c-stewards','2026-03-18T00:00:00'),
 ('agency-n','Agency N','44444444-4444-4444-4444-444444444444','usgovarizona','IL5','grp-agency-n-stewards','2026-04-27T00:00:00');
GO

-- Seed: 4 published data products (one per domain).
INSERT INTO federation.DataProducts
    (product_id, product_name, owner_domain, classification, endorsement, share_name, published_at)
VALUES
 ('dp-a-perf','Agency Performance Metrics','agency-a','CUI','certified','agency_a_performance','2026-04-01T00:00:00'),
 ('dp-b-grants','Grant Disbursement Facts','agency-b','CUI','promoted','agency_b_grants','2026-04-08T00:00:00'),
 ('dp-c-bene','Beneficiary Outcomes (de-identified)','agency-c','Restricted-PHI','certified','agency_c_outcomes','2026-04-15T00:00:00'),
 ('dp-n-intel','Mission Readiness Indicators','agency-n','CUI-NSS','certified','agency_n_readiness','2026-05-02T00:00:00');
GO

-- Seed: the doc's worked example (Agency B requests Agency A's product, 90-day window).
INSERT INTO federation.AccessRequests
    (request_id, product_id, requesting_domain, requested_by, use_case, status, decided_by, window_days, requested_at, decided_at, expires_at)
VALUES
 ('req-0001','dp-a-perf','agency-b','workspace-admin-b@dept.gov','Cross-agency dashboards','approved','agency-a-domain-steward@dept.gov',90,'2026-05-20T14:02:00','2026-05-20T16:40:00','2026-08-18T16:40:00'),
 ('req-0002','dp-c-bene','agency-b','analyst-b@dept.gov','Outcome benchmarking','pending',NULL,NULL,'2026-05-29T09:15:00',NULL,NULL),
 ('req-0003','dp-a-perf','agency-c','steward-c@dept.gov','Inter-agency KPI rollup','denied','agency-a-domain-steward@dept.gov',NULL,'2026-05-22T11:00:00','2026-05-23T08:30:00',NULL);
GO`;

const WH_Q_PENDING = `-- Pending cross-domain access requests awaiting a Domain Steward decision.
SELECT r.request_id, p.product_name, p.owner_domain, r.requesting_domain,
       r.requested_by, r.use_case, r.requested_at
FROM federation.AccessRequests r
JOIN federation.DataProducts p ON p.product_id = r.product_id
WHERE r.status = 'pending'
ORDER BY r.requested_at;`;

const WH_Q_ACTIVE = `-- Active (approved, unexpired) cross-domain grants and days remaining.
SELECT r.request_id, p.product_name, p.owner_domain AS producer,
       r.requesting_domain AS consumer, p.classification,
       r.window_days, r.expires_at,
       DATEDIFF(DAY, SYSUTCDATETIME(), r.expires_at) AS days_remaining
FROM federation.AccessRequests r
JOIN federation.DataProducts p ON p.product_id = r.product_id
WHERE r.status = 'approved' AND r.expires_at > SYSUTCDATETIME()
ORDER BY days_remaining;`;

const WH_Q_BOUNDARY = `-- Cross-boundary shares — flags products shared into a different audit
-- boundary than the producer's (governance review hook).
SELECT p.product_name, pd.audit_boundary AS producer_boundary,
       cd.audit_boundary AS consumer_boundary, p.classification,
       r.requesting_domain, r.status
FROM federation.AccessRequests r
JOIN federation.DataProducts p  ON p.product_id    = r.product_id
JOIN federation.Domains      pd ON pd.domain_code  = p.owner_domain
JOIN federation.Domains      cd ON cd.domain_code  = r.requesting_domain
WHERE pd.audit_boundary <> cd.audit_boundary;`;

// ─── Bundle ───────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-federal-data-mesh',
  intro:
    '## Federal Data Mesh\n\n' +
    'A federal department running multiple agencies as **autonomous domains** ' +
    '(per-DLZ subscriptions), each owning its own data products + analytics, ' +
    'federated under a central **Department-CIO governance plane**. ' +
    'Reproduces the [Federal Data Mesh use case]' +
    '(../../docs/fiab/use-cases/federal-data-mesh.md) end-to-end.\n\n' +
    '**What this app seeds:**\n\n' +
    '- A **Cross-Domain Marketplace** data product (Agency A "Agency ' +
    'Performance Metrics" + 3 sibling agency products) with MIP ' +
    'classification (Restricted-PII / Restricted-PHI / CUI / CUI-NSS) and a ' +
    'searchable **AI Search** catalog.\n' +
    '- The **Agency A domain lakehouse** whose gold Delta tables back the ' +
    'product, seeded with sample performance rows.\n' +
    '- A **Delta Sharing** notebook implementing grant -> 5-minute ' +
    'catalog-adapter sync -> query-in-place (the doc\'s cross-domain example).\n' +
    '- A **federated access-request register** (Warehouse) implementing the ' +
    'request -> review -> approve-with-90-day-window -> grant lifecycle across ' +
    'mixed audit boundaries (FedRAMP-H / IL4 / IL5).\n' +
    '- A **Cross-Agency Performance semantic model + report** with ' +
    'sensitivity-label propagation, consumed by Agency B.\n' +
    '- A **FederationAudit ADX database** capturing cross-DLZ access events + ' +
    'per-DLZ cost facts + Sentinel label-violation detections, surfaced on the ' +
    '**Department CIO Federation & Cost dashboard** and wired to an ' +
    '**Activator** alert.\n' +
    '- A **per-DLZ cost-rollup pipeline** ingesting each agency ' +
    'subscription\'s Cost Management export into the department-level rollup.',
  sourceDocs: ['docs/fiab/use-cases/federal-data-mesh.md'],
  items: [
    // 1 ── Cross-Domain Marketplace (data products)
    {
      itemType: 'data-product',
      displayName: 'Cross-Domain Data Product Marketplace',
      description:
        'Central Marketplace of agency-published data products. Agency A\'s ' +
        '"Agency Performance Metrics" plus sibling products from Agencies B/C/N, ' +
        'each with MIP classification, endorsement, and a federated glossary.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'data-product',
        datasets: [
          {
            id: 'dp-a-perf',
            name: 'Agency Performance Metrics',
            description:
              'Agency A\'s certified performance product published to the ' +
              'cross-domain Marketplace. Daily + monthly KPI facts (program ' +
              'throughput, SLA attainment, backlog) at agency x program x ' +
              'period grain, sourced from the agency-a gold lakehouse. Shared ' +
              'to other agencies via a time-boxed Delta Sharing grant ' +
              '(query-in-place, no copy). This is the product Agency B requests ' +
              'in the documented cross-domain example. Consumers inherit the ' +
              'CUI sensitivity label that travels with the share metadata.',
            classification: 'CUI',
          },
          {
            id: 'dp-b-grants',
            name: 'Grant Disbursement Facts',
            description:
              'Agency B\'s grant-disbursement product: obligated, disbursed, ' +
              'and remaining balances per grant program per fiscal period. ' +
              'Promoted endorsement; CUI. Demonstrates a second domain ' +
              'publishing into the same Marketplace under Department-CDO ' +
              'governance.',
            classification: 'CUI',
          },
          {
            id: 'dp-c-bene',
            name: 'Beneficiary Outcomes (de-identified)',
            description:
              'Agency C\'s de-identified outcome measures. Even de-identified, ' +
              'it carries Restricted-PHI because re-identification risk exists ' +
              'on join; cross-domain reads of this product are the primary ' +
              'target of the Sentinel label-violation detection. Agency C ' +
              'operates in a FedRAMP-H boundary — distinct from Agency A/B\'s IL4.',
            classification: 'Restricted-PHI',
          },
          {
            id: 'dp-n-intel',
            name: 'Mission Readiness Indicators',
            description:
              'Agency N\'s mission-readiness rollups, classified CUI-NSS ' +
              '(National Security System). Agency N operates in an IL5 boundary; ' +
              'this product is publishable to the Marketplace catalog for ' +
              'discovery but grants require elevated Domain-Steward approval.',
            classification: 'CUI-NSS',
          },
        ],
        glossaryTerms: [
          {
            term: 'Domain',
            definition:
              'An autonomous agency unit that owns its own DLZ (Data Landing ' +
              'Zone) subscription, RBAC, cost reporting, and data products. The ' +
              'unit of decentralization in the federal data mesh.',
          },
          {
            term: 'Data Product',
            definition:
              'A curated, owned, discoverable dataset published by a Domain to ' +
              'the cross-domain Marketplace, with a classification, an owner ' +
              '(Domain Steward), an endorsement state, and a Delta Sharing share.',
          },
          {
            term: 'Domain Steward',
            definition:
              'The per-agency owner (mapped to an Entra group) who manages the ' +
              'agency\'s DLZ and approves or denies cross-domain access requests ' +
              'against that agency\'s products.',
          },
          {
            term: 'Cross-Domain Grant',
            definition:
              'A time-boxed (default 90-day) Delta Sharing grant created when a ' +
              'Domain Steward approves another domain\'s access request. ' +
              'Query-in-place; the consumer never copies the underlying data.',
          },
          {
            term: 'Audit Boundary',
            definition:
              'The compliance envelope a domain operates within ' +
              '(FedRAMP-High, IL4, IL5). A federal data mesh can span a mix; ' +
              'cross-boundary shares are flagged for governance review.',
          },
          {
            term: 'CUI',
            definition:
              'Controlled Unclassified Information — information requiring ' +
              'safeguarding or dissemination controls per 32 CFR Part 2002, ' +
              'but not classified. The default sensitivity label for inter-agency ' +
              'performance data.',
          },
          {
            term: 'CUI-NSS',
            definition:
              'CUI residing on or transiting a National Security System. ' +
              'Carries the strictest handling; grants require elevated approval.',
          },
          {
            term: 'Restricted-PII / Restricted-PHI',
            definition:
              'MIP sensitivity labels authored by the Department CDO in Purview ' +
              'for personally / protected-health identifiable information. ' +
              'Large cross-DLZ reads of these labels trigger Sentinel detections.',
          },
          {
            term: 'MACC',
            definition:
              'Microsoft Azure Consumption Commitment — a department-level ' +
              'pre-purchased Azure spend commit that can be allocated across ' +
              'agency subscriptions and burned down via the cross-DLZ cost rollup.',
          },
          {
            term: 'Federation Policy',
            definition:
              'A tenant-level policy the Department CIO/CDO sets (classification ' +
              'scheme, sensitivity-label taxonomy, mandatory catalog tags) that ' +
              'all domains inherit; Domain Stewards may override per-agency where ' +
              'the policy permits.',
          },
        ],
        owner: { name: 'Department CDO Office', email: 'dept-cdo@dept.gov' },
        endorsement: 'certified',
      },
    },

    // 2 ── Agency A domain lakehouse (the shared gold tables)
    {
      itemType: 'lakehouse',
      displayName: 'Agency A Domain Lakehouse',
      description:
        'Agency A\'s domain lakehouse. The gold performance tables here back ' +
        'the "Agency Performance Metrics" data product and are exposed via ' +
        'Delta Sharing to consuming agencies. Seeded with sample KPI rows.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'bronze/source_extracts', description: 'Raw program-system extracts (agency-internal only).' },
          { path: 'silver/conformed', description: 'Cleaned + conformed program facts.' },
          { path: 'gold/data_products', description: 'Curated, shareable performance products.' },
        ],
        deltaTables: [
          {
            name: 'performance_metrics_daily',
            ddl:
              'CREATE TABLE agency_a_gold.performance_metrics_daily (\n' +
              '  agency_code      STRING,\n' +
              '  program_code     STRING,\n' +
              '  metric_name      STRING,\n' +
              '  metric_value     DOUBLE,\n' +
              '  target_value     DOUBLE,\n' +
              '  reporting_date   DATE,\n' +
              '  classification   STRING\n' +
              ') USING DELTA\n' +
              "TBLPROPERTIES ('delta.minReaderVersion'='3','delta.minWriterVersion'='7');",
            sampleRows: [
              ['AGCY-A', 'PRG-001', 'cases_processed',   1284, 1200, '2026-05-28', 'CUI'],
              ['AGCY-A', 'PRG-001', 'sla_attainment_pct',  97.4,  95.0, '2026-05-28', 'CUI'],
              ['AGCY-A', 'PRG-002', 'backlog_count',       342,  400, '2026-05-28', 'CUI'],
              ['AGCY-A', 'PRG-001', 'cases_processed',   1190, 1200, '2026-05-29', 'CUI'],
              ['AGCY-A', 'PRG-001', 'sla_attainment_pct',  96.1,  95.0, '2026-05-29', 'CUI'],
              ['AGCY-A', 'PRG-002', 'backlog_count',       318,  400, '2026-05-29', 'CUI'],
            ],
          },
          {
            name: 'performance_metrics_monthly',
            ddl:
              'CREATE TABLE agency_a_gold.performance_metrics_monthly (\n' +
              '  agency_code      STRING,\n' +
              '  program_code     STRING,\n' +
              '  metric_name      STRING,\n' +
              '  metric_value     DOUBLE,\n' +
              '  target_value     DOUBLE,\n' +
              '  reporting_period STRING,\n' +
              '  classification   STRING\n' +
              ') USING DELTA;',
            sampleRows: [
              ['AGCY-A', 'PRG-001', 'cases_processed',     35420, 36000, '2026-04', 'CUI'],
              ['AGCY-A', 'PRG-001', 'sla_attainment_pct',     96.8,   95.0, '2026-04', 'CUI'],
              ['AGCY-A', 'PRG-002', 'avg_backlog',            361,    400, '2026-04', 'CUI'],
              ['AGCY-A', 'PRG-001', 'cases_processed',     34110, 36000, '2026-05', 'CUI'],
              ['AGCY-A', 'PRG-001', 'sla_attainment_pct',     97.1,   95.0, '2026-05', 'CUI'],
              ['AGCY-A', 'PRG-002', 'avg_backlog',            329,    400, '2026-05', 'CUI'],
            ],
          },
        ],
        shortcuts: [
          {
            name: 'shared_from_marketplace',
            target: 'deltasharing://marketplace/{consuming-domain}',
            description:
              'OneLake shortcut placeholder where Delta-Shared products from ' +
              'other domains surface once a grant is approved (query-in-place).',
          },
        ],
      },
    },

    // 3 ── Delta Sharing grant + catalog-adapter notebook
    {
      itemType: 'notebook',
      displayName: 'Cross-Domain Delta Sharing Automation',
      description:
        'Runnable notebook that creates a Delta Sharing grant on the producer ' +
        '(Agency A), emits the cross-DLZ audit event, and runs the consumer ' +
        '(Agency B) catalog adapter that registers shared tables within 5 min.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          { id: 'fdm-nb-0', type: 'markdown', source: NB_MD_INTRO },
          { id: 'fdm-nb-1', type: 'code', lang: 'pyspark', source: NB_CODE_CONFIG },
          { id: 'fdm-nb-2', type: 'code', lang: 'pyspark', source: NB_CODE_GRANT },
          { id: 'fdm-nb-3', type: 'code', lang: 'pyspark', source: NB_CODE_AUDIT },
          { id: 'fdm-nb-4', type: 'markdown', source: NB_MD_CONSUMER },
          { id: 'fdm-nb-5', type: 'code', lang: 'pyspark', source: NB_CODE_CONSUMER },
          { id: 'fdm-nb-6', type: 'code', lang: 'pyspark', source: NB_CODE_VERIFY },
        ],
      },
    },

    // 4 ── Federated access-request register (Warehouse)
    {
      itemType: 'warehouse',
      displayName: 'Federated Access Register',
      description:
        'T-SQL register of domains, published data products, and cross-domain ' +
        'access requests with the approve-with-90-day-window lifecycle across ' +
        'mixed FedRAMP-H / IL4 / IL5 boundaries. Seeded with the documented ' +
        'Agency-B-requests-Agency-A example.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        starterQueries: [
          { name: 'Pending access requests', sql: WH_Q_PENDING },
          { name: 'Active grants (days remaining)', sql: WH_Q_ACTIVE },
          { name: 'Cross-boundary shares (governance review)', sql: WH_Q_BOUNDARY },
        ],
      },
    },

    // 5 ── Cross-Agency Performance semantic model
    {
      itemType: 'semantic-model',
      displayName: 'Cross-Agency Performance Model',
      description:
        'Star-schema model over the shared performance products with a ' +
        'classification column so MIP labels propagate to reports + exports. ' +
        'Direct Lake against the Delta-Shared gold tables.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'DimAgency',
            columns: [
              { name: 'AgencyCode', dataType: 'String' },
              { name: 'AgencyName', dataType: 'String' },
              { name: 'AuditBoundary', dataType: 'String' },
              { name: 'Region', dataType: 'String' },
            ],
          },
          {
            name: 'DimProgram',
            columns: [
              { name: 'ProgramCode', dataType: 'String' },
              { name: 'ProgramName', dataType: 'String' },
              { name: 'AgencyCode', dataType: 'String' },
            ],
          },
          {
            name: 'DimMetric',
            columns: [
              { name: 'MetricName', dataType: 'String' },
              { name: 'MetricCategory', dataType: 'String' },
              { name: 'Unit', dataType: 'String' },
              { name: 'HigherIsBetter', dataType: 'Boolean' },
            ],
          },
          {
            name: 'DimDate',
            columns: [
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'Date', dataType: 'Date' },
              { name: 'Year', dataType: 'Int64' },
              { name: 'Month', dataType: 'Int64' },
              { name: 'ReportingPeriod', dataType: 'String' },
            ],
          },
          {
            name: 'FactPerformance',
            columns: [
              { name: 'AgencyCode', dataType: 'String' },
              { name: 'ProgramCode', dataType: 'String' },
              { name: 'MetricName', dataType: 'String' },
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'MetricValue', dataType: 'Double' },
              { name: 'TargetValue', dataType: 'Double' },
              { name: 'Classification', dataType: 'String' },
            ],
          },
        ],
        measures: [
          {
            table: 'FactPerformance',
            name: 'Metric Value',
            expression: 'SUM ( FactPerformance[MetricValue] )',
            formatString: '#,0.0',
          },
          {
            table: 'FactPerformance',
            name: 'Target Value',
            expression: 'SUM ( FactPerformance[TargetValue] )',
            formatString: '#,0.0',
          },
          {
            table: 'FactPerformance',
            name: 'Attainment %',
            expression: 'DIVIDE ( [Metric Value], [Target Value] )',
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactPerformance',
            name: 'Programs Reporting',
            expression: 'DISTINCTCOUNT ( FactPerformance[ProgramCode] )',
            formatString: '#,0',
          },
          {
            table: 'FactPerformance',
            name: 'Agencies Reporting',
            expression: 'DISTINCTCOUNT ( FactPerformance[AgencyCode] )',
            formatString: '#,0',
          },
          {
            table: 'FactPerformance',
            name: 'Attainment MoM',
            expression:
              'VAR _Curr = [Attainment %] ' +
              'VAR _Prior = CALCULATE ( [Attainment %], DATEADD ( DimDate[Date], -1, MONTH ) ) ' +
              'RETURN _Curr - _Prior',
            formatString: '0.0%;-0.0%;0.0%',
          },
        ],
        relationships: [
          { from: 'FactPerformance.AgencyCode', to: 'DimAgency.AgencyCode', cardinality: 'many:many' },
          { from: 'FactPerformance.ProgramCode', to: 'DimProgram.ProgramCode', cardinality: 'many:many' },
          { from: 'FactPerformance.MetricName', to: 'DimMetric.MetricName', cardinality: 'many:many' },
          { from: 'FactPerformance.DateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
        ],
      },
    },

    // 6 ── Cross-Agency Dashboards report (Agency B's reporting surface)
    {
      itemType: 'report',
      displayName: 'Cross-Agency Dashboards',
      description:
        'Power BI report Agency B builds against the shared "Agency ' +
        'Performance Metrics" product. Sensitivity labels propagate from the ' +
        'semantic model to this report and any Excel/PowerPoint export.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'report',
        pages: [
          {
            name: 'Department Overview',
            visuals: [
              { type: 'card', title: 'Agencies Reporting', field: 'Agencies Reporting' },
              { type: 'card', title: 'Programs Reporting', field: 'Programs Reporting' },
              { type: 'gauge', title: 'Dept Attainment %', field: 'Attainment %' },
              {
                type: 'clusteredColumnChart',
                title: 'Attainment % by Agency',
                config: { axis: 'DimAgency.AgencyName', value: 'Attainment %' },
              },
            ],
          },
          {
            name: 'Agency A Performance (shared)',
            visuals: [
              {
                type: 'lineChart',
                title: 'Cases Processed Trend',
                config: { axis: 'DimDate.ReportingPeriod', value: 'Metric Value', filter: "MetricName='cases_processed'" },
              },
              {
                type: 'table',
                title: 'Program KPIs',
                config: { columns: ['DimProgram.ProgramName', 'DimMetric.MetricName', 'Metric Value', 'Target Value', 'Attainment %'] },
              },
              {
                type: 'kpi',
                title: 'SLA Attainment MoM',
                config: { value: 'Attainment %', trend: 'Attainment MoM', filter: "MetricName='sla_attainment_pct'" },
              },
            ],
          },
        ],
      },
    },

    // 7 ── FederationAudit ADX database (cross-DLZ access + cost + Sentinel)
    {
      itemType: 'kql-database',
      displayName: 'FederationAudit (ADX)',
      description:
        'Central audit + cost ADX database: CrossDomainAccess (grant + read ' +
        'events), DomainCost (per-DLZ Cost Management facts), and Sentinel ' +
        'label-violation detection functions. Seeded with sample rows.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'CrossDomainAccess',
            columns: [
              { name: 'event_id',        type: 'string'   },
              { name: 'event_time',      type: 'datetime' },
              { name: 'event_type',      type: 'string'   },
              { name: 'producer_domain', type: 'string'   },
              { name: 'consumer_domain', type: 'string'   },
              { name: 'consumer_user',   type: 'string'   },
              { name: 'share_name',      type: 'string'   },
              { name: 'data_product',    type: 'string'   },
              { name: 'classification',  type: 'string'   },
              { name: 'use_case',        type: 'string'   },
              { name: 'rows_returned',   type: 'long'     },
              { name: 'granted_by',      type: 'string'   },
              { name: 'expires_at',      type: 'datetime' },
            ],
            sample: [
              ['e1', '2026-05-20T16:40:00Z', 'delta_share_grant_created', 'agency-a', 'agency-b', 'agency-a-domain-steward@dept.gov', 'agency_a_performance', 'Agency Performance Metrics', 'CUI', 'Cross-agency dashboards', 0, 'agency-a-domain-steward@dept.gov', '2026-08-18T16:40:00Z'],
              ['e2', '2026-05-21T09:12:00Z', 'delta_share_read', 'agency-a', 'agency-b', 'analyst-b@dept.gov', 'agency_a_performance', 'Agency Performance Metrics', 'CUI', 'Cross-agency dashboards', 1284, '', '2026-08-18T16:40:00Z'],
              ['e3', '2026-05-29T22:03:00Z', 'delta_share_read', 'agency-c', 'agency-b', 'analyst-b@dept.gov', 'agency_c_outcomes', 'Beneficiary Outcomes (de-identified)', 'Restricted-PHI', 'Outcome benchmarking', 84210, '', '2026-08-27T00:00:00Z'],
              ['e4', '2026-05-30T07:45:00Z', 'delta_share_read', 'agency-b', 'agency-a', 'workspace-admin-a@dept.gov', 'agency_b_grants', 'Grant Disbursement Facts', 'CUI', 'Budget reconciliation', 5120, '', '2026-09-01T00:00:00Z'],
            ],
          },
          {
            name: 'DomainCost',
            columns: [
              { name: 'usage_date',      type: 'datetime' },
              { name: 'domain',          type: 'string'   },
              { name: 'subscription_id', type: 'string'   },
              { name: 'boundary',        type: 'string'   },
              { name: 'meter_category',  type: 'string'   },
              { name: 'cost_usd',        type: 'real'     },
            ],
            sample: [
              ['2026-05-28T00:00:00Z', 'agency-a', '11111111-1111-1111-1111-111111111111', 'IL4', 'Azure Databricks', 412.55],
              ['2026-05-28T00:00:00Z', 'agency-a', '11111111-1111-1111-1111-111111111111', 'IL4', 'Storage', 88.20],
              ['2026-05-28T00:00:00Z', 'agency-b', '22222222-2222-2222-2222-222222222222', 'IL4', 'Azure Databricks', 298.10],
              ['2026-05-28T00:00:00Z', 'agency-c', '33333333-3333-3333-3333-333333333333', 'FedRAMP-H', 'Azure Data Explorer', 521.77],
              ['2026-05-28T00:00:00Z', 'agency-n', '44444444-4444-4444-4444-444444444444', 'IL5', 'Synapse', 634.40],
              ['2026-05-29T00:00:00Z', 'agency-a', '11111111-1111-1111-1111-111111111111', 'IL4', 'Azure Databricks', 401.02],
              ['2026-05-29T00:00:00Z', 'agency-c', '33333333-3333-3333-3333-333333333333', 'FedRAMP-H', 'Azure Data Explorer', 498.33],
              ['2026-05-29T00:00:00Z', 'agency-n', '44444444-4444-4444-4444-444444444444', 'IL5', 'Synapse', 612.88],
            ],
          },
        ],
        functions: [
          { name: 'DomainCostRollup',        body: KQL_FN_DOMAIN_COST_ROLLUP },
          { name: 'LabelViolationDetections', body: KQL_FN_LABEL_VIOLATION },
        ],
        ingestionPolicies: [
          {
            table: 'CrossDomainAccess',
            policy:
              '.alter-merge table CrossDomainAccess policy retention softdelete = 365d\n' +
              '.alter table CrossDomainAccess policy streamingingestion enable',
          },
          {
            table: 'DomainCost',
            policy:
              '.alter-merge table DomainCost policy retention softdelete = 730d\n' +
              '.alter table DomainCost policy caching hot = 90d',
          },
        ],
        starterQueries: [
          { name: 'Cross-DLZ access (last 24h)',          kql: KQL_Q_CROSS_DLZ_RECENT },
          { name: 'Active grants + days remaining',        kql: KQL_Q_ACTIVE_GRANTS },
          { name: 'Cost by agency domain (30d)',           kql: KQL_Q_COST_BY_DOMAIN },
          { name: 'Daily cost trend by domain (30d)',      kql: KQL_Q_COST_TREND },
          { name: 'Label-violation detections (Sentinel)', kql: KQL_Q_LABEL_VIOLATIONS },
        ],
      },
    },

    // 8 ── Department CIO Federation & Cost dashboard
    {
      itemType: 'kql-dashboard',
      displayName: 'Department CIO Federation & Cost',
      description:
        'Cross-DLZ governance pane for the Department CIO: active domains, ' +
        'MTD cost, active cross-domain grants, cost by domain + trend, ' +
        'classification mix, and open label-violation detections.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          { title: 'Active Agency Domains',         viz: 'card',  kql: TILE_TOTAL_DOMAINS },
          { title: 'MTD Cross-DLZ Cost (USD)',      viz: 'card',  kql: TILE_MTD_COST },
          { title: 'Active Cross-Domain Grants',    viz: 'card',  kql: TILE_ACTIVE_GRANTS_CARD },
          { title: 'Cost by Agency Domain (30d)',   viz: 'bar',   kql: TILE_COST_BY_DOMAIN_BAR },
          { title: 'Cross-DLZ Daily Cost Trend',    viz: 'line',  kql: TILE_COST_TREND_LINE },
          { title: 'Reads by Classification (24h)', viz: 'pie',   kql: TILE_CLASSIFICATION_PIE },
          { title: 'Label-Violation Detections',    viz: 'table', kql: TILE_VIOLATIONS_TABLE },
        ],
      },
    },

    // 9 ── Activator — label-violation / large-PII-download alert -> Sentinel
    {
      itemType: 'activator',
      displayName: 'Label-Violation Alert -> Sentinel',
      description:
        'Fires when a user reads more than 50,000 Restricted-PII/PHI rows ' +
        'across a cross-DLZ share within 60 minutes. Routes to the Department ' +
        'security team and forwards the detection to Microsoft Sentinel.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'activator',
        rule: {
          name: 'Cross-DLZ Restricted-Data Exfiltration Pattern',
          condition: { metric: 'rows_read', op: '>', threshold: 50000 },
          window: 'PT60M',
          action: {
            kind: 'webhook',
            config: {
              description:
                'POST the LabelViolationDetections row to the Sentinel ' +
                'Logs ingestion endpoint (DCR) and notify the security team. ' +
                'Backed by the FederationAudit.LabelViolationDetections function.',
              url: 'https://${sentinelWorkspace}.ods.opinsights.azure.us/api/logs',
              method: 'POST',
              source: 'FederationAudit.LabelViolationDetections',
              dcrImmutableId: '${SENTINEL_DCR_IMMUTABLE_ID}',
              streamName: 'Custom-LoomCrossDomainViolation_CL',
              alsoNotify: { kind: 'teams', channel: 'Department Security Operations' },
            },
          },
        },
      },
    },

    // 10 ── Marketplace catalog search index (AI Search)
    {
      itemType: 'ai-search-index',
      displayName: 'Marketplace Catalog Search',
      description:
        'Azure AI Search index over published data products so agencies can ' +
        'discover cross-domain products by name, owner domain, classification, ' +
        'and endorsement. Seeded with the four published products.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'ai-search-index',
        schema: {
          fields: [
            { name: 'product_id',     type: 'Edm.String', key: true, filterable: true },
            { name: 'product_name',   type: 'Edm.String', searchable: true },
            { name: 'description',    type: 'Edm.String', searchable: true },
            { name: 'owner_domain',   type: 'Edm.String', filterable: true, searchable: true },
            { name: 'classification', type: 'Edm.String', filterable: true },
            { name: 'endorsement',    type: 'Edm.String', filterable: true },
            { name: 'audit_boundary', type: 'Edm.String', filterable: true },
            { name: 'share_name',     type: 'Edm.String', filterable: true },
          ],
        },
        scoringProfiles: [
          {
            name: 'boost-certified',
            description:
              'Boosts certified + promoted products and name matches so ' +
              'endorsed, well-named products surface first in the Marketplace.',
          },
        ],
        sampleDocs: [
          { product_id: 'dp-a-perf', product_name: 'Agency Performance Metrics', description: 'Daily + monthly program KPIs from Agency A; shared via Delta Sharing.', owner_domain: 'agency-a', classification: 'CUI', endorsement: 'certified', audit_boundary: 'IL4', share_name: 'agency_a_performance' },
          { product_id: 'dp-b-grants', product_name: 'Grant Disbursement Facts', description: 'Obligated/disbursed/remaining balances per grant program.', owner_domain: 'agency-b', classification: 'CUI', endorsement: 'promoted', audit_boundary: 'IL4', share_name: 'agency_b_grants' },
          { product_id: 'dp-c-bene', product_name: 'Beneficiary Outcomes (de-identified)', description: 'De-identified outcome measures; Restricted-PHI on re-identification risk.', owner_domain: 'agency-c', classification: 'Restricted-PHI', endorsement: 'certified', audit_boundary: 'FedRAMP-H', share_name: 'agency_c_outcomes' },
          { product_id: 'dp-n-intel', product_name: 'Mission Readiness Indicators', description: 'Mission-readiness rollups; CUI-NSS, elevated approval required.', owner_domain: 'agency-n', classification: 'CUI-NSS', endorsement: 'certified', audit_boundary: 'IL5', share_name: 'agency_n_readiness' },
        ],
      },
    },

    // 11 ── Per-DLZ cost-rollup pipeline
    {
      itemType: 'data-pipeline',
      displayName: 'Per-DLZ Cost Rollup',
      description:
        'Copies each agency subscription\'s Cost Management daily export from ' +
        'its DLZ storage into the FederationAudit.DomainCost table, producing ' +
        'the department-level cross-DLZ cost rollup for the CIO pane.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'synapse-pipeline',
        parameters: {
          lookbackDays: { type: 'int', defaultValue: 7 },
        },
        activities: [
          {
            name: 'ForEachDomain',
            type: 'ForEach',
            config: {
              items: "@createArray('agency-a','agency-b','agency-c','agency-n')",
              isSequential: false,
              description:
                'Iterate each agency DLZ. Cost Management exports land in each ' +
                'subscription\'s storage account; this fans out per domain.',
            },
          },
          {
            name: 'CopyCostExport',
            type: 'Copy',
            dependsOn: ['ForEachDomain'],
            config: {
              source: {
                type: 'DelimitedTextSource',
                description:
                  'Daily amortized Cost Management export CSV from the ' +
                  'per-domain DLZ storage (cost-exports container).',
                store: 'https://${domainStorage}.blob.core.usgovcloudapi.net/cost-exports',
              },
              sink: {
                type: 'AzureDataExplorerSink',
                description: 'Ingest into FederationAudit.DomainCost (ADX).',
                database: 'FederationAudit',
                table: 'DomainCost',
                ingestionMappingName: 'DomainCostCsvMapping',
              },
              mappings: [
                { source: 'Date',            sink: 'usage_date' },
                { source: 'ResourceGroup',   sink: 'domain' },
                { source: 'SubscriptionId',  sink: 'subscription_id' },
                { source: 'Tags.boundary',   sink: 'boundary' },
                { source: 'MeterCategory',   sink: 'meter_category' },
                { source: 'CostInUsd',       sink: 'cost_usd' },
              ],
            },
          },
          {
            name: 'RefreshCostRollup',
            type: 'AzureDataExplorerCommand',
            dependsOn: ['CopyCostExport'],
            config: {
              database: 'FederationAudit',
              command: '.set-or-replace DomainCostRollup30d <| DomainCostRollup(30)',
              description:
                'Materialize the 30-day cross-DLZ rollup the CIO dashboard reads.',
            },
          },
        ],
      },
    },
  ],
};

export default bundle;
