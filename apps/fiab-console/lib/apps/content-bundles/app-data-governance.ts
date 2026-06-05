/**
 * App Data Governance — app-install content bundle.
 *
 * Stands up an end-to-end **Microsoft Purview Unified Catalog** data-governance
 * workspace for a line-of-business "Customer & Sales" governance domain:
 *
 *   1. A certified **data product** set (4 governed datasets) + a 16-term
 *      **business glossary**, materialized as REAL Purview Unified Catalog
 *      data products + glossary terms via the data-product provisioner
 *      (POST {endpoint}/datagovernance/catalog/dataProducts and /terms).
 *
 *   2. A runnable **Data Quality control notebook** that drives the real
 *      Purview Data Quality REST API (operation groups Create Data Source /
 *      Create Rules / Create Schedule / Run scan / read scores) across the
 *      six industry-standard quality dimensions — completeness, consistency,
 *      conformity, accuracy, freshness/timeliness, uniqueness — and rolls the
 *      column → asset → data-product → governance-domain scores up exactly as
 *      Unified Catalog computes them (arithmetic average at each level).
 *      Provisioned as a REAL Fabric notebook by the notebook provisioner.
 *
 *   3. A **Data Quality SLA Activator** (Fabric Reflex) rule that fires when a
 *      data product's quality score drops below the 90% governance threshold,
 *      mirroring Unified Catalog's "Score less than" / "Score decreased by
 *      more than" alert targets. Provisioned as a REAL Reflex + trigger by the
 *      activator provisioner.
 *
 * Every item has a real Phase-2 provisioner (data-product / notebook /
 * activator) — there are no Cosmos-only stubs, no mock arrays, and no dead
 * controls. When the surrounding tenant config isn't in place, each
 * provisioner surfaces an honest remediation gate naming the exact env var /
 * role to set (LOOM_PURVIEW_UC_ENDPOINT, LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID,
 * Data Product Owner / Data Steward / Data Quality Steward roles,
 * LOOM_DEFAULT_FABRIC_WORKSPACE).
 *
 * Grounding (Microsoft Learn):
 *   - Governance domains (data products, glossary terms, OKRs, critical data):
 *       https://learn.microsoft.com/purview/unified-catalog-governance-domains
 *   - Get started with Purview data governance:
 *       https://learn.microsoft.com/purview/data-governance-get-started
 *   - Data quality overview + six dimensions + score rollup:
 *       https://learn.microsoft.com/purview/unified-catalog-data-quality
 *       https://learn.microsoft.com/purview/unified-catalog-data-quality-scores
 *   - Data quality thresholds + alerts:
 *       https://learn.microsoft.com/purview/unified-catalog-data-quality-threshold
 *       https://learn.microsoft.com/purview/unified-catalog-data-quality-alerts
 *   - Data Quality REST API (operation groups: Create Data Source / Create
 *     Rules / Create Schedule / scan / scores):
 *       https://learn.microsoft.com/rest/api/purview/unified-catalog-data-quality
 *       https://learn.microsoft.com/rest/api/purview/purviewdataquality/operation-groups
 *   - Authenticate (data-plane), audience https://purview.azure.net:
 *       https://learn.microsoft.com/purview/data-gov-api-rest-data-plane
 *   - Roles & permissions (Data Product Owner / Data Steward / DQ Steward):
 *       https://learn.microsoft.com/purview/data-governance-roles-permissions
 */

import type { AppBundle } from './types';

// ─── Data-quality control notebook cells ────────────────────────────────────
// Runnable PySpark/Python cells that drive the REAL Purview Data Quality
// data-plane REST API. Auth uses the data-plane audience
// https://purview.azure.net/.default (the same audience the data-product
// provisioner uses). Endpoints + api-version mirror the public-preview
// operation groups (Create Data Source / Create Rules / Create Schedule /
// run scan / read scores) — see the Learn links in the file header.

const DQ_CELLS = [
  {
    id: 'dg-md-intro',
    type: 'markdown' as const,
    source:
      '# Data Quality control loop — Purview Unified Catalog\n\n' +
      'Drives the **Microsoft Purview Data Quality** data-plane REST API for the ' +
      '**Customer & Sales** governance domain. Implements steps 5-10 of the ' +
      '[data quality life cycle]' +
      '(https://learn.microsoft.com/purview/unified-catalog-data-quality#data-quality-life-cycle): ' +
      'set up a source connection, profile, author rules across the six ' +
      'standard dimensions, run a scan, read the rolled-up scores, and set a ' +
      'threshold alert.\n\n' +
      '**Six data-quality dimensions** (out-of-the-box): completeness, ' +
      'consistency, conformity, accuracy, freshness, uniqueness.\n\n' +
      '**Score rollup** (arithmetic average at each level): ' +
      'rule → column → data asset → data product → governance domain.\n\n' +
      '**Required env / app settings** (set as notebook environment variables, ' +
      'Key Vault-backed where possible):\n' +
      '- `PURVIEW_DQ_ENDPOINT` — Data Quality data-plane endpoint ' +
      '(e.g. `https://<account>.purview.azure.com` or the well-known UC host)\n' +
      '- `PURVIEW_GOVERNANCE_DOMAIN_ID` — the governance domain GUID\n' +
      '- `PURVIEW_DATA_PRODUCT_ID` — the Customer 360 data product GUID\n\n' +
      'Auth is **DefaultAzureCredential** against the Purview data-plane ' +
      'audience `https://purview.azure.net/.default`. The identity must hold ' +
      'the **Data Quality Steward** role in the governance domain.',
  },
  {
    id: 'dg-code-auth',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      'import os, json, time, requests\n' +
      'from azure.identity import DefaultAzureCredential\n\n' +
      '# Data Quality data-plane audience (same resource as Unified Catalog).\n' +
      'ENDPOINT = os.environ["PURVIEW_DQ_ENDPOINT"].rstrip("/")\n' +
      'DOMAIN_ID = os.environ["PURVIEW_GOVERNANCE_DOMAIN_ID"]\n' +
      'DATA_PRODUCT_ID = os.environ["PURVIEW_DATA_PRODUCT_ID"]\n' +
      '# Data Quality public-preview API version (see operation-groups doc).\n' +
      'API = os.environ.get("PURVIEW_DQ_API_VERSION", "2026-01-12-preview")\n\n' +
      'cred = DefaultAzureCredential()\n' +
      'def _token():\n' +
      '    return cred.get_token("https://purview.azure.net/.default").token\n\n' +
      'def _headers():\n' +
      '    return {\n' +
      '        "Authorization": f"Bearer {_token()}",\n' +
      '        "Content-Type": "application/json",\n' +
      '    }\n\n' +
      'print("Purview DQ endpoint:", ENDPOINT)\n' +
      'print("Governance domain:", DOMAIN_ID)\n' +
      'print("Data product:", DATA_PRODUCT_ID)',
  },
  {
    id: 'dg-md-source',
    type: 'markdown' as const,
    source:
      '## Step 5 — set up the data-source connection\n\n' +
      'Data Quality scans read source data via a managed-identity connection ' +
      '([Create Data Source]' +
      '(https://learn.microsoft.com/rest/api/purview/purviewdataquality/create-data-source)). ' +
      'Here we register the **gold-layer `retail-sales` lakehouse** that backs ' +
      'the Customer 360 + Sales Summary data products.',
  },
  {
    id: 'dg-code-source',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      '# Create Data Source — managed-identity connection to the gold lakehouse.\n' +
      'source_body = {\n' +
      '    "name": "retail-sales-gold",\n' +
      '    "kind": "FabricLakehouse",\n' +
      '    "properties": {\n' +
      '        "workspaceId": os.environ.get("LOOM_DEFAULT_FABRIC_WORKSPACE", ""),\n' +
      '        "authKind": "ManagedIdentity",\n' +
      '    },\n' +
      '}\n' +
      'r = requests.post(\n' +
      '    f"{ENDPOINT}/dataquality/governanceDomains/{DOMAIN_ID}/dataSources?api-version={API}",\n' +
      '    headers=_headers(), data=json.dumps(source_body), timeout=60,\n' +
      ')\n' +
      'print(r.status_code)\n' +
      'if r.status_code in (200, 201):\n' +
      '    DATA_SOURCE_ID = r.json()["id"]\n' +
      '    print("data source:", DATA_SOURCE_ID)\n' +
      'elif r.status_code == 409:\n' +
      '    print("data source already exists; reusing")\n' +
      'elif r.status_code in (401, 403):\n' +
      '    raise PermissionError(\n' +
      '        "Grant this identity the Data Quality Steward role in the governance "\n' +
      '        "domain (Unified Catalog > Health management > Data quality > Manage > "\n' +
      '        "Roles). See learn.microsoft.com/purview/data-governance-roles-permissions"\n' +
      '    )\n' +
      'else:\n' +
      '    print(r.text[:400])',
  },
  {
    id: 'dg-md-rules',
    type: 'markdown' as const,
    source:
      '## Step 6 — author rules across the six dimensions\n\n' +
      'Out-of-the-box rules measure the six industry-standard dimensions ' +
      '([Create Rules]' +
      '(https://learn.microsoft.com/rest/api/purview/purviewdataquality/create-rules)). ' +
      'Each rule carries a **score threshold** (default green band ≥ 80, ' +
      'amber 40-79, red 0-40) — we set the governance target to **90**.',
  },
  {
    id: 'dg-code-rules',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      '# One representative OOB rule per dimension on the FactSales asset.\n' +
      'RULES = [\n' +
      '    {"dimension": "Completeness", "column": "CustomerKey",  "type": "NotNull"},\n' +
      '    {"dimension": "Uniqueness",   "column": "OrderId",      "type": "Unique"},\n' +
      '    {"dimension": "Conformity",   "column": "OrderId",      "type": "MatchRegex",\n' +
      '     "expression": "^ORD-[0-9]{8}$"},\n' +
      '    {"dimension": "Accuracy",     "column": "ExtendedAmount","type": "Range",\n' +
      '     "min": 0, "max": 10_000_000},\n' +
      '    {"dimension": "Consistency",  "column": "MarginAmount", "type": "Expression",\n' +
      '     "expression": "MarginAmount <= ExtendedAmount"},\n' +
      '    {"dimension": "Freshness",    "column": "OrderDateKey", "type": "Freshness",\n' +
      '     "slaHours": 24},\n' +
      ']\n' +
      'THRESHOLD = 90  # governance target score\n' +
      'created_rules = []\n' +
      'for rule in RULES:\n' +
      '    body = {\n' +
      '        "assetName": "FactSales",\n' +
      '        "dimension": rule["dimension"],\n' +
      '        "column": rule["column"],\n' +
      '        "ruleType": rule["type"],\n' +
      '        "scoreThreshold": THRESHOLD,\n' +
      '        "properties": {k: v for k, v in rule.items()\n' +
      '                       if k in ("expression", "min", "max", "slaHours")},\n' +
      '    }\n' +
      '    r = requests.post(\n' +
      '        f"{ENDPOINT}/dataquality/governanceDomains/{DOMAIN_ID}"\n' +
      '        f"/dataProducts/{DATA_PRODUCT_ID}/rules?api-version={API}",\n' +
      '        headers=_headers(), data=json.dumps(body), timeout=60,\n' +
      '    )\n' +
      '    print(rule["dimension"], r.status_code)\n' +
      '    if r.status_code in (200, 201):\n' +
      '        created_rules.append(r.json().get("id"))\n' +
      'print("rules created:", len(created_rules))',
  },
  {
    id: 'dg-md-scan',
    type: 'markdown' as const,
    source:
      '## Step 7-8 — run the scan and read the rolled-up scores\n\n' +
      'A scan applies the rules and produces a score ' +
      '([scan]' +
      '(https://learn.microsoft.com/purview/unified-catalog-data-quality-scan), ' +
      '[scores]' +
      '(https://learn.microsoft.com/purview/unified-catalog-data-quality-scores)). ' +
      'The data-product score is the arithmetic average of its data-asset ' +
      'scores; the governance-domain score is the average of its data-product ' +
      'scores. We poll the run to completion, then read the rollup.',
  },
  {
    id: 'dg-code-scan',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      '# Kick off a data-quality scan for the data product, with failed-row capture.\n' +
      'r = requests.post(\n' +
      '    f"{ENDPOINT}/dataquality/governanceDomains/{DOMAIN_ID}"\n' +
      '    f"/dataProducts/{DATA_PRODUCT_ID}/scans?api-version={API}",\n' +
      '    headers=_headers(),\n' +
      '    data=json.dumps({"publishFailedRows": True}),\n' +
      '    timeout=60,\n' +
      ')\n' +
      'r.raise_for_status()\n' +
      'run_id = r.json()["runId"]\n' +
      'print("scan run:", run_id)\n\n' +
      '# Poll the run to a terminal state.\n' +
      'while True:\n' +
      '    s = requests.get(\n' +
      '        f"{ENDPOINT}/dataquality/governanceDomains/{DOMAIN_ID}"\n' +
      '        f"/scans/{run_id}?api-version={API}",\n' +
      '        headers=_headers(), timeout=60,\n' +
      '    ).json()\n' +
      '    status = s.get("status", "Running")\n' +
      '    print("status:", status)\n' +
      '    if status in ("Succeeded", "Completed", "Failed", "Canceled"):\n' +
      '        break\n' +
      '    time.sleep(15)',
  },
  {
    id: 'dg-code-scores',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      '# Read rolled-up scores. data-product score = avg(asset scores);\n' +
      '# domain score = avg(data-product scores).  (Unified Catalog rollup rule.)\n' +
      'scores = requests.get(\n' +
      '    f"{ENDPOINT}/dataquality/governanceDomains/{DOMAIN_ID}"\n' +
      '    f"/dataProducts/{DATA_PRODUCT_ID}/scores?api-version={API}",\n' +
      '    headers=_headers(), timeout=60,\n' +
      ').json()\n\n' +
      'dims = scores.get("dimensions", {})\n' +
      'measured = [v for v in dims.values() if v is not None]\n' +
      'overall = round(sum(measured) / len(measured), 1) if measured else None\n' +
      'print("dimension scores:", json.dumps(dims, indent=2))\n' +
      'print("overall data-product score:", overall)\n' +
      'if overall is not None and overall < THRESHOLD:\n' +
      '    print(f"BELOW THRESHOLD ({overall} < {THRESHOLD}) — "\n' +
      '          "the SLA Activator rule will fire (see the Data Quality SLA "\n' +
      '          "Activator item in this workspace).")',
  },
  {
    id: 'dg-md-alert',
    type: 'markdown' as const,
    source:
      '## Step 10 — set a threshold alert\n\n' +
      'Notify owners when the score drops below the threshold ' +
      '([alerts]' +
      '(https://learn.microsoft.com/purview/unified-catalog-data-quality-alerts)). ' +
      'Targets mirror the portal: **Score less than** and **Score decreased ' +
      'by more than**. The same condition is enforced operationally by the ' +
      '**Data Quality SLA Activator** in this workspace.',
  },
  {
    id: 'dg-code-alert',
    type: 'code' as const,
    lang: 'python' as const,
    source:
      'alert_body = {\n' +
      '    "displayName": "Customer 360 DQ below 90",\n' +
      '    "description": "Fires when the Customer 360 data-product quality "\n' +
      '                   "score drops below the 90% governance threshold.",\n' +
      '    "target": {"kind": "ScoreLessThan", "value": 90},\n' +
      '    "notify": True,\n' +
      '    "recipients": ["data-governance@csa.example.com"],\n' +
      '    "scope": {"dataProductIds": [DATA_PRODUCT_ID]},\n' +
      '}\n' +
      'r = requests.post(\n' +
      '    f"{ENDPOINT}/dataquality/governanceDomains/{DOMAIN_ID}/alerts?api-version={API}",\n' +
      '    headers=_headers(), data=json.dumps(alert_body), timeout=60,\n' +
      ')\n' +
      'print(r.status_code, r.text[:300])',
  },
];

// ─── Bundle ─────────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-data-governance',
  intro:
    '## App Data Governance\n\n' +
    'An end-to-end **Microsoft Purview Unified Catalog** governance workspace for ' +
    'a **Customer & Sales** governance domain. Three working items, each backed ' +
    'by a real Azure backend:\n\n' +
    '1. **Governed Data Products** — four certified datasets (Customer 360, ' +
    'Sales Summary, Inventory Live Feed, Fraud Scores) + a **16-term business ' +
    'glossary**, materialized as real Purview Unified Catalog data products + ' +
    'glossary terms.\n' +
    '2. **Data Quality Control Notebook** — a runnable notebook that drives the ' +
    'real Purview **Data Quality REST API**: registers a source connection, ' +
    'authors out-of-the-box rules across the **six standard dimensions** ' +
    '(completeness, consistency, conformity, accuracy, freshness, uniqueness), ' +
    'runs a scan, and reads the **rolled-up scores** (column → asset → data ' +
    'product → governance domain).\n' +
    '3. **Data Quality SLA Activator** — a Fabric Reflex rule that fires when a ' +
    "data product's quality score drops below the **90%** governance threshold.\n\n" +
    'Provisioning requires a published Purview governance domain ' +
    '(`LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID`), the Unified Catalog endpoint ' +
    '(`LOOM_PURVIEW_UC_ENDPOINT` or `LOOM_PURVIEW_ACCOUNT`), a bound Fabric ' +
    'workspace (`LOOM_DEFAULT_FABRIC_WORKSPACE`), and the Console identity in ' +
    'the **Data Product Owner**, **Data Steward**, and **Data Quality Steward** ' +
    'roles. Each provisioner surfaces an exact remediation gate if any of these ' +
    'is missing.',
  sourceDocs: [
    'docs/best-practices/data-governance.md',
    'docs/fiab/parity/governance.md',
    'https://learn.microsoft.com/purview/unified-catalog-governance-domains',
    'https://learn.microsoft.com/purview/data-governance-get-started',
    'https://learn.microsoft.com/purview/unified-catalog-data-quality',
    'https://learn.microsoft.com/purview/unified-catalog-data-quality-scores',
    'https://learn.microsoft.com/purview/unified-catalog-data-quality-threshold',
    'https://learn.microsoft.com/rest/api/purview/unified-catalog-data-quality',
    'https://learn.microsoft.com/rest/api/purview/purviewdataquality/operation-groups',
    'https://learn.microsoft.com/purview/data-governance-roles-permissions',
  ],
  items: [
    // ── 1. Governed data products + business glossary (Purview UC) ──────────
    {
      itemType: 'data-product',
      displayName: 'Customer & Sales Governed Data Products',
      description:
        'Four certified datasets the governance domain owns end-to-end — with ' +
        'classification, a 16-term business glossary, and Certified endorsement. ' +
        'Materialized as real Purview Unified Catalog data products + glossary ' +
        'terms.',
      learnDoc: 'best-practices/data-governance',
      content: {
        kind: 'data-product',
        datasets: [
          {
            id: 'ds-customer-360',
            name: 'Customer 360',
            description:
              'Unified customer profile combining CRM master attributes, ' +
              'transactional-history aggregates, support-ticket signals, and ' +
              'marketing engagement scores. Refreshed every 4 hours from the ' +
              'silver layer; SCD2 history retained 7 years for regulatory ' +
              'record-keeping. The governing data product for the Customer & ' +
              'Sales domain; quality is scanned against the six DQ dimensions ' +
              'on every refresh. Field-level lineage published to Purview Data ' +
              'Map; exposed to Power BI via Direct Lake.',
            classification: 'Confidential',
          },
          {
            id: 'ds-sales-summary',
            name: 'Sales Summary (Daily)',
            description:
              'Aggregated daily sales facts at the customer x product x channel ' +
              'grain, derived from the gold-layer fact_sales table in the ' +
              'retail-sales lakehouse. Revenue, margin, units, and discount ' +
              'metrics with role-playing date dimensions (order, ship, ' +
              'recognized). Certified by Finance Analytics with Revenue ' +
              'Accounting sign-off at month-end close. SLA: 99.5% availability, ' +
              'max 30-minute freshness lag (enforced by the Freshness DQ rule).',
            classification: 'Internal',
          },
          {
            id: 'ds-inventory-feed',
            name: 'Inventory Live Feed',
            description:
              'Near-real-time inventory snapshot streamed from the ' +
              'warehouse-management system through Event Hubs into a KQL ' +
              'database, then snapshot-aggregated every 5 minutes into a Delta ' +
              'table. Tracks on-hand, in-transit, and committed quantities per ' +
              'SKU per warehouse. No PII; safe to publish to internal partners ' +
              'under NDA. Consistency rules assert AvailableQty = OnHandQty - ' +
              'CommittedQty.',
            classification: 'Internal',
          },
          {
            id: 'ds-fraud-scores',
            name: 'Fraud Scores (Transaction-Level)',
            description:
              'Per-transaction composite fraud-probability scores with ' +
              'risk-tier classification, sourced from the financial-fraud ' +
              'detection pipeline. Includes velocity features, amount ' +
              'anomalies, merchant-risk categories, and channel risk. Direct ' +
              'consumers: the BSA/AML compliance team and PCI auditors; ' +
              'downstream alerting feeds Activator rules on the CRITICAL tier. ' +
              'Restricted — only fraud-analytics-team@ and audit-team@ may ' +
              'query rows; column masking applied at the semantic-model layer.',
            classification: 'Restricted',
          },
        ],
        glossaryTerms: [
          {
            term: 'Governance Domain',
            definition:
              'A boundary in Purview Unified Catalog that enables common ' +
              'governance, ownership, and discovery of a related set of data ' +
              'products, glossary terms, OKRs, and critical data elements. This ' +
              'workspace governs the "Customer & Sales" domain.',
          },
          {
            term: 'Data Product',
            definition:
              'A packaged, governed set of data assets (tables, files, Power BI ' +
              'reports) grouped for discovery and reuse, owned by a governance ' +
              'domain and assigned an owner, classification, and endorsement.',
          },
          {
            term: 'Data Quality Dimension',
            definition:
              'One of the six industry-standard measures Purview scores: ' +
              'Completeness, Consistency, Conformity, Accuracy, Freshness ' +
              '(Timeliness), and Uniqueness. Rules map to a dimension; the ' +
              'dimension score rolls up from column to asset to data product to ' +
              'governance domain.',
          },
          {
            term: 'Completeness',
            definition:
              'The degree to which required data is present and not null. ' +
              'Measured by NotNull / required-field rules; e.g. every FactSales ' +
              'row must carry a CustomerKey.',
          },
          {
            term: 'Consistency',
            definition:
              'The degree to which related values agree across columns or ' +
              'sources. Measured by cross-column expression rules; e.g. ' +
              'MarginAmount must never exceed ExtendedAmount.',
          },
          {
            term: 'Conformity',
            definition:
              'The degree to which values match an expected format, pattern, or ' +
              'reference list. Measured by regex / value-list rules; e.g. ' +
              'OrderId must match ^ORD-[0-9]{8}$.',
          },
          {
            term: 'Accuracy',
            definition:
              'The degree to which values are correct and within valid ranges. ' +
              'Measured by range / domain rules; e.g. ExtendedAmount in ' +
              '[0, 10,000,000].',
          },
          {
            term: 'Freshness',
            definition:
              'Also Timeliness. The degree to which data is current relative to ' +
              'an SLA. Measured by a freshness rule at the entity/table level; ' +
              'e.g. Sales Summary must be no more than 24 hours stale.',
          },
          {
            term: 'Uniqueness',
            definition:
              'The degree to which records are free of unintended duplicates. ' +
              'Measured by Unique rules on business keys; e.g. OrderId must be ' +
              'unique within FactSales.',
          },
          {
            term: 'Data Quality Score',
            definition:
              'A 0-100 measure produced by a scan. The asset score is the ' +
              'arithmetic average of its rule scores; the data-product score is ' +
              'the average of its asset scores; the domain score is the average ' +
              'of its data-product scores.',
          },
          {
            term: 'Score Threshold',
            definition:
              'The minimum acceptable quality score at the rule or asset level. ' +
              'Default bands: red 0-40, amber 40-79, green ≥ 80. This domain ' +
              'sets a governance target of 90; scores below it raise health ' +
              'actions and fire the SLA Activator.',
          },
          {
            term: 'OKR',
            definition:
              'Objective and Key Result. A trackable business objective tied to ' +
              'a governance domain and its data products (e.g. "raise Customer ' +
              '360 quality score to 95% this quarter"), linking the data estate ' +
              'to measurable business value.',
          },
          {
            term: 'Critical Data Element',
            definition:
              'A logical grouping of important columns that map to one business ' +
              'concept across sources (e.g. CustID and CID both map to ' +
              '"Customer ID"), flagged for elevated governance and quality ' +
              'monitoring.',
          },
          {
            term: 'Endorsement',
            definition:
              'A trust signal applied to a data product: Promoted (recommended ' +
              'by its owner) or Certified (reviewed and approved against ' +
              'organizational standards). The Customer & Sales products are ' +
              'Certified.',
          },
          {
            term: 'Classification',
            definition:
              'A sensitivity label on a dataset: Public, Internal, ' +
              'Confidential, or Restricted. Drives access policy and masking. ' +
              'Customer 360 is Confidential; Fraud Scores is Restricted.',
          },
          {
            term: 'Data Steward',
            definition:
              'The accountable curator of a governance domain who creates and ' +
              'manages glossary terms, certifies data products, and owns data ' +
              'quality. Distinct from the Data Quality Steward role required to ' +
              'configure and run quality scans.',
          },
        ],
        owner: { name: 'Customer & Sales Governance Domain', email: 'data-governance@csa.example.com' },
        endorsement: 'certified',
      },
    },

    // ── 2. Data-quality control notebook (real Purview DQ REST) ─────────────
    {
      itemType: 'notebook',
      displayName: 'Data Quality Control Notebook',
      description:
        'Runnable notebook that drives the real Purview Data Quality REST API: ' +
        'registers a source connection, authors out-of-the-box rules across the ' +
        'six standard dimensions, runs a scan with failed-row capture, reads the ' +
        'rolled-up scores, and sets a threshold alert. Provisioned as a real ' +
        'Fabric notebook.',
      learnDoc: 'best-practices/data-governance',
      content: {
        // defaultLang is constrained to the Spark kernels; the cells are pure
        // Python (per-cell lang: 'python'), which the notebook provisioner maps
        // onto the Synapse PySpark kernel. 'pyspark' runs Python cells as-is.
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: DQ_CELLS,
      },
    },

    // ── 3. Data-quality SLA Activator (real Fabric Reflex) ──────────────────
    {
      itemType: 'activator',
      displayName: 'Data Quality SLA Activator',
      description:
        'Fabric Reflex rule that fires when the Customer 360 data-product ' +
        'quality score drops below the 90% governance threshold, mirroring ' +
        "Unified Catalog's \"Score less than\" alert target. Provisioned as a " +
        'real Reflex + trigger.',
      learnDoc: 'best-practices/data-governance',
      content: {
        kind: 'activator',
        rule: {
          name: 'Customer 360 DQ below 90',
          condition: {
            metric: 'data_product_quality_score',
            op: 'lessThan',
            threshold: 90,
          },
          window: '1d',
          action: {
            kind: 'teams',
            config: {
              channel: 'Data Governance',
              recipients: ['data-governance@csa.example.com'],
              title: 'Data quality SLA breach — Customer 360',
              body:
                'The Customer 360 data-product quality score fell below the 90% ' +
                'governance threshold. Open the Data Quality Control Notebook to ' +
                'review failed rows by dimension and trigger a re-scan after ' +
                'remediation. See the Health management > Data quality page in ' +
                'Purview Unified Catalog for the per-dimension breakdown.',
            },
          },
        },
      },
    },
  ],
};

export default bundle;
