# Tutorial: Your First Data Product on Azure

**Estimated time: 2-3 hours** | **Difficulty: Intermediate** | **Audience: Foundry users migrating to Azure**

This hands-on tutorial walks you through building a complete data product on Azure using CSA-in-a-Box. By the end, you will have raw data flowing through a medallion pipeline, governed by a data contract, cataloged in Microsoft Purview, and visualized in a Power BI report -- all on Azure-native services.

If you have built datasets, transforms, and object types in Palantir Foundry, every step below maps to something you already know. Callout boxes explain what each step replaces.

---

## Prerequisites

Before you begin, make sure you have the following:

| Tool | Minimum version | Verify |
|---|---|---|
| Azure subscription | Pay-as-you-go or Enterprise | `az account show` |
| Azure CLI | 2.50+ | `az version` |
| Bicep CLI | 0.25+ | `az bicep version` |
| Git | 2.x | `git --version` |
| Python | 3.10+ | `python --version` |
| dbt-core | 1.7+ | `dbt --version` |
| Basic SQL | Comfortable writing SELECT/JOIN/CASE statements | -- |
| Basic Python | Can read and run scripts | -- |

You should also have **Contributor** (or higher) access to at least one Azure resource group.

> **Foundry comparison:** In Foundry you log in to the web UI and everything is preconfigured. On Azure you bring your own subscription and tools. The trade-off is full control over cost, networking, and compliance boundaries.

---

## Step 1: Deploy the CSA-in-a-Box Foundation

The foundation deploys three landing zones that mirror the CSA (Cloud-Scale Analytics) reference architecture: a management zone (ALZ), a data management zone (DMLZ), and a data landing zone (DLZ). This gives you ADLS Gen2 storage, Azure Data Factory, Databricks, Key Vault, and Purview -- all wired together.

```bash
# Clone the repository
git clone https://github.com/your-org/csa-inabox.git
cd csa-inabox

# Set up the Python environment
make setup          # Linux/macOS
# make setup-win    # Windows

# Preview what will be deployed (dry run)
bash scripts/deploy/deploy-platform.sh --environment dev --dry-run

# Deploy for real
bash scripts/deploy/deploy-platform.sh --environment dev
```

The deploy script runs three Bicep deployments in order:

1. **ALZ** (Management) -- logging, monitoring, policy guardrails
2. **DMLZ** (Data Management) -- Purview, Key Vault, shared services
3. **DLZ** (Data Landing Zone) -- ADF, Databricks, Synapse, ADLS, Event Hub

> **Foundry comparison:** In Foundry, your platform team provisions a new "enrollment" or "space" for you. Here, the `deploy-platform.sh` script is the equivalent -- it stamps out all the infrastructure from version-controlled Bicep templates under `deploy/bicep/`. Everything is auditable in Git.

**What success looks like:**

- Three resource groups appear in the Azure portal (e.g., `rg-alz-dev`, `rg-dmlz-dev`, `rg-dlz-dev`).
- `az group list -o table` shows all three with `ProvisioningState: Succeeded`.

**Troubleshooting:**

- If Bicep fails with a quota error, request a quota increase in the Azure portal or choose a different region.
- If you see `AuthorizationFailed`, confirm your account has **Contributor** on the target subscription.
- Run with `--dry-run` first to catch template errors before real deployment.

For full details see the CSA-in-a-Box deployment documentation.

---

## Step 2: Create a New Domain Folder Structure

CSA-in-a-Box organizes work by **domain** -- a self-contained business area with its own data, pipelines, and data products. You will create a domain called `my-domain`.

```bash
# From the repository root
mkdir -p domains/my-domain/{dbt/models/{bronze,silver,gold},dbt/seeds,pipelines/adf,data-products}
```

Your folder tree should look like this:

```text
domains/my-domain/
  dbt/
    models/
      bronze/          # Raw ingestion models
      silver/          # Cleaned, conformed models
      gold/            # Business-ready facts and dimensions
    seeds/             # CSV seed files for local development
  pipelines/
    adf/               # Azure Data Factory pipeline definitions
  data-products/       # Data product contracts
```

Copy the shared dbt project scaffolding:

```bash
cp domains/shared/dbt/dbt_project.yml domains/my-domain/dbt/dbt_project.yml
cp domains/shared/dbt/profiles.yml    domains/my-domain/dbt/profiles.yml
cp domains/shared/dbt/packages.yml    domains/my-domain/dbt/packages.yml
```

Edit `domains/my-domain/dbt/dbt_project.yml` to set the project name:

```yaml
name: 'my_domain_analytics'
version: '1.0.0'
config-version: 2
require-dbt-version: [">=1.7.0", "<2.0.0"]
profile: 'csa_analytics'

model-paths: ["models"]
seed-paths: ["seeds"]
macro-paths: ["macros"]

models:
  my_domain_analytics:
    bronze:
      +materialized: incremental
      +schema: bronze
      +tags: ['bronze']
    silver:
      +materialized: incremental
      +schema: silver
      +tags: ['silver']
    gold:
      +materialized: table
      +schema: gold
      +tags: ['gold']
```

> **Foundry comparison:** In Foundry, you create a new "project" in the left sidebar and organize datasets into folders. Here, the domain folder structure in Git serves the same purpose but with version control, code review, and branch-based collaboration built in.

**What success looks like:** `dbt debug --profiles-dir .` runs from `domains/my-domain/dbt/` without errors.

---

## Step 3: Set Up a Data Source Connection with ADF

Azure Data Factory replaces Foundry's built-in connectors. You will create a linked service (connection), a dataset (shape of the data), and a pipeline (the copy job).

### 3a. Create a Linked Service

CSA-in-a-Box ships a linked service template for ADLS Gen2 at `domains/shared/pipelines/adf/linkedServices/ls_adls_gen2.json`. It uses Managed Identity authentication with the storage URL pulled from Key Vault.

Deploy it to your ADF instance:

```bash
az datafactory linked-service create \
    --factory-name <your-adf-name> \
    --resource-group <your-rg> \
    --name ls_adls_gen2 \
    --properties @domains/shared/pipelines/adf/linkedServices/ls_adls_gen2.json
```

### 3b. Create a Dataset

The parameterized CSV dataset lets you reuse one definition for any source file path:

```bash
az datafactory dataset create \
    --factory-name <your-adf-name> \
    --resource-group <your-rg> \
    --name ds_source_delimited \
    --properties @domains/shared/pipelines/adf/datasets/ds_source_delimited.json
```

### 3c. Create an Ingestion Pipeline

The `pl_ingest_to_bronze` pipeline copies CSV data from a source container to the ADLS `raw` container, partitioned by date:

```bash
az datafactory pipeline create \
    --factory-name <your-adf-name> \
    --resource-group <your-rg> \
    --name pl_ingest_to_bronze \
    --properties @domains/shared/pipelines/adf/pl_ingest_to_bronze.json
```

Trigger a test run:

```bash
az datafactory pipeline create-run \
    --factory-name <your-adf-name> \
    --resource-group <your-rg> \
    --name pl_ingest_to_bronze \
    --parameters '{
        "sourceContainer": "source-data",
        "sourceFolderPath": "my-domain/sales",
        "domainName": "my-domain",
        "entityName": "transactions"
    }'
```

> **Foundry comparison:** In Foundry, you configure a "source" in the Data Connection application -- select a connector type, enter credentials, schedule a sync. On Azure, ADF linked services are the connector, datasets describe the shape, and pipelines define the copy logic. The key difference is that everything is declarative JSON checked into Git rather than configured in a UI.

**What success looks like:**

- The pipeline run shows `Succeeded` in `az datafactory pipeline-run show`.
- Files appear in ADLS under `raw/my-domain/transactions/year=.../month=.../day=.../`.

**Troubleshooting:**

- `403 Forbidden` on ADLS: grant ADF's managed identity the **Storage Blob Data Contributor** role on the storage account.
- If the source container does not exist, create it first: `az storage container create --name source-data --account-name <storage>`.

---

## Step 4: Build Bronze / Silver / Gold dbt Models

The medallion architecture in dbt replaces Foundry's transform pipeline. Each tier has a clear responsibility.

### 4a. Bronze Model (Raw Ingestion)

Create `domains/my-domain/dbt/models/bronze/brz_transactions.sql`:

```sql
{{
  config(
    materialized='incremental',
    unique_key='_surrogate_key',
    incremental_strategy='merge',
    tags=['bronze', 'transactions']
  )
}}

/*
  Bronze: Raw transactions ingestion.
  Reads from ADLS raw container, adds metadata columns.
*/

SELECT
    {{ dbt_utils.generate_surrogate_key(['transaction_id']) }} AS _surrogate_key,
    transaction_id,
    customer_id,
    transaction_date,
    amount,
    category,
    _ingested_at,
    now() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id

FROM {{ source('raw_data', 'transactions') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
```

> **Foundry comparison:** This is your "raw dataset" in Foundry -- the first dataset that points at an external source. In Foundry you would click "New Dataset > Import" and select the source. Here you write a SQL model that dbt compiles and runs against Databricks.

### 4b. Silver Model (Cleaned and Validated)

Create `domains/my-domain/dbt/models/silver/slv_transactions.sql`:

```sql
{{
  config(
    materialized='incremental',
    unique_key='transaction_sk',
    incremental_strategy='merge',
    tags=['silver', 'transactions']
  )
}}

/*
  Silver: Conformed transactions.
  Deduplicates, casts types, and flags invalid records.
  Bad rows are NOT dropped -- they are marked with is_valid = false
  so downstream quality monitoring can track them.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_transactions') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY transaction_id
            ORDER BY _ingested_at DESC
        ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['transaction_id']) }} AS transaction_sk,
        CAST(transaction_id AS BIGINT)       AS transaction_id,
        CAST(customer_id AS BIGINT)          AS customer_id,
        CAST(transaction_date AS DATE)       AS transaction_date,
        CAST(amount AS DECIMAL(18, 2))       AS amount,
        UPPER(TRIM(category))               AS category,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN transaction_id IS NULL THEN TRUE ELSE FALSE END  AS _missing_id,
        CASE WHEN amount < 0             THEN TRUE ELSE FALSE END  AS _negative_amount,
        CASE WHEN transaction_date > CURRENT_DATE THEN TRUE ELSE FALSE END AS _future_date
    FROM cleaned
)

SELECT
    *,
    NOT (_missing_id OR _negative_amount OR _future_date) AS is_valid,
    CONCAT_WS('; ',
        CASE WHEN _missing_id       THEN 'transaction_id null' END,
        CASE WHEN _negative_amount  THEN 'amount negative' END,
        CASE WHEN _future_date      THEN 'transaction_date in future' END
    ) AS validation_errors
FROM validated
```

> **Foundry comparison:** In Foundry, you write a "transform" (Python or SQL) that cleans and deduplicates data. The key difference is that CSA-in-a-Box embeds validation flags (`is_valid`, `validation_errors`) directly in Silver rather than silently dropping bad rows. This gives you full lineage on data quality.

### 4c. Gold Model (Business-Ready)

Create `domains/my-domain/dbt/models/gold/gld_daily_transaction_summary.sql`:

```sql
{{
  config(
    materialized='table',
    tags=['gold', 'transactions', 'metrics']
  )
}}

/*
  Gold: Daily transaction summary.
  Filters to valid Silver records only, then aggregates.
*/

SELECT
    transaction_date,
    category,
    COUNT(*)                          AS transaction_count,
    SUM(amount)                       AS total_amount,
    AVG(amount)                       AS avg_amount,
    MIN(amount)                       AS min_amount,
    MAX(amount)                       AS max_amount,
    now()                             AS _dbt_refreshed_at

FROM {{ ref('slv_transactions') }}
WHERE is_valid = TRUE
GROUP BY transaction_date, category
```

### Run the Pipeline

```bash
cd domains/my-domain/dbt
dbt deps
dbt seed             # load any CSV seed files
dbt run --select tag:bronze
dbt run --select tag:silver
dbt run --select tag:gold
dbt test
```

> **Foundry comparison:** In Foundry, you click "Build" on a dataset and the platform figures out the execution graph. With dbt, `dbt run --select tag:bronze` achieves the same thing -- dbt resolves the DAG and runs models in dependency order. The `dbt test` step replaces Foundry's "Expectations" checks.

**What success looks like:**

- `dbt run` completes with `PASS` for all three tiers.
- `dbt test` shows zero failures.
- Querying `gold.gld_daily_transaction_summary` returns aggregated rows.

**Troubleshooting:**

- `Compilation Error: source raw_data.transactions not found`: create a `sources.yml` in the bronze folder that defines the `raw_data` source. See `domains/shared/dbt/models/bronze/sources.yml` for the pattern.
- `Connection refused`: verify `DATABRICKS_HOST` and `DATABRICKS_HTTP_PATH` environment variables are set. Run `dbt debug --profiles-dir .` to test the connection.

---

## Step 5: Define a Data Contract

A data contract is the authoritative interface between your domain and its consumers. It declares the schema, SLAs, and quality rules. CSA-in-a-Box ships a contract validator that enforces these at CI time and runtime.

Create `domains/my-domain/data-products/transactions/contract.yaml`:

```yaml
apiVersion: csa.microsoft.com/v1
kind: DataProductContract

metadata:
  name: my-domain.transactions
  domain: my-domain
  owner: my-team@contoso.com
  version: "1.0.0"
  description: >
    Daily transaction records, cleaned and validated through the
    medallion pipeline. Consumers can rely on the schema and SLAs
    defined below.

schema:
  primary_key: [transaction_sk]
  columns:
    - name: transaction_sk
      type: string
      nullable: false
      description: Surrogate key (hash of transaction_id).
    - name: transaction_id
      type: long
      nullable: false
      description: Unique transaction identifier from source system.
    - name: customer_id
      type: long
      nullable: false
      description: Customer identifier.
    - name: transaction_date
      type: date
      nullable: false
      description: Date the transaction occurred.
    - name: amount
      type: decimal(18,2)
      nullable: false
      description: Transaction amount in USD.
    - name: category
      type: string
      nullable: false
      description: Transaction category.
    - name: is_valid
      type: boolean
      nullable: false
      description: True when all quality checks pass.

sla:
  freshness_minutes: 60
  valid_row_ratio: 0.97
  supported_until: "2027-12-31"

quality_rules:
  - rule: expect_column_values_to_not_be_null
    column: transaction_sk
  - rule: expect_column_values_to_be_unique
    column: transaction_sk
  - rule: expect_column_values_to_not_be_null
    column: transaction_id
  - rule: expect_column_values_to_be_between
    column: amount
    min_value: 0
    mostly: 0.97
```

> **Foundry comparison:** In Foundry, you define an "object type" in the Ontology -- its properties, primary key, and links. A data contract in CSA-in-a-Box serves the same purpose: it is the published interface that tells consumers what columns exist, their types, nullability, and what quality guarantees are met. The difference is that contracts are YAML files in Git, validated in CI, and enforced at runtime by `governance/contracts/contract_validator.py`.

**What success looks like:** The contract passes validation:

```bash
python -m governance.contracts.contract_validator \
    domains/my-domain/data-products/transactions/contract.yaml
```

See `domains/finance/data-products/invoices/contract.yaml` for a production example.

---

## Step 6: Register the Data Product in Purview

Microsoft Purview is the governance catalog that replaces Foundry's Data Catalog and Ontology Manager. You will register your data product so it is discoverable, classified, and lineage-tracked.

### 6a. Create a Glossary Term

```bash
# Bootstrap Purview collections and glossary (if not already done)
python scripts/purview/bootstrap_catalog.py \
    --purview-account <purview-name> \
    --storage-account <storage-name>
```

Then create a glossary term for your data product in the Azure portal:

1. Open **Microsoft Purview** > **Data Catalog** > **Glossary**.
2. Select your domain collection (e.g., `my-domain`).
3. Click **New Term** and fill in:
   - **Name:** `Daily Transactions`
   - **Definition:** `Cleaned and validated daily transaction records. Produced by the my-domain medallion pipeline.`
   - **Owner:** your team email
   - **Status:** `Approved`

Alternatively, use the Purview REST API:

```bash
az rest --method PUT \
    --url "https://<purview-name>.purview.azure.com/catalog/api/atlas/v2/glossary/term" \
    --headers "Content-Type=application/json" \
    --body '{
        "name": "Daily Transactions",
        "qualifiedName": "my-domain.transactions@glossary",
        "longDescription": "Cleaned and validated daily transaction records.",
        "status": "Approved",
        "anchor": { "glossaryGuid": "<your-glossary-guid>" }
    }'
```

### 6b. Add Classifications

Apply sensitivity and domain classifications:

1. In Purview, navigate to **Data Map** > **Classifications**.
2. Add classifications to your gold-layer assets (e.g., `Financial`, `PII` if customer data is present).

### 6c. Scan the Gold Layer

Register your ADLS storage as a source in Purview and run a scan:

1. **Data Map** > **Sources** > **Register** > select **Azure Data Lake Storage Gen2**.
2. Enter your storage account name and select the `gold` container.
3. Create a scan rule set that includes Delta/Parquet files.
4. Run the scan.

Once the scan completes, Purview automatically discovers your Gold tables and shows end-to-end lineage from raw to gold.

> **Foundry comparison:** In Foundry, the Ontology Manager automatically catalogs datasets and shows lineage. With Purview, you get the same capabilities -- automated discovery, lineage tracking, classification, and glossary -- but across your entire Azure estate, not just one platform. Purview also supports sensitivity labels and data access policies that integrate with Entra ID.

**What success looks like:**

- The glossary term `Daily Transactions` appears under your domain collection.
- Scanning your ADLS gold container shows discovered assets with schema details.
- Lineage view traces the path from raw source through bronze, silver, and gold.

**Troubleshooting:**

- If the scan shows zero assets, verify the scan rule set includes `.parquet` or Delta format.
- If lineage is missing, confirm that ADF pipelines have been registered as a source in Purview -- ADF lineage requires its own source registration.

---

## Step 7: Create a Power BI Semantic Model

A semantic model defines the business logic layer (measures, relationships, hierarchies) on top of your Gold data. This replaces Foundry's "analysis" or "dashboard dataset" concept.

CSA-in-a-Box includes a semantic model template at `csa_platform/semantic_model/semantic_model_template.yaml`. Use it as a reference and generate a model for your domain.

### 7a. Configure the SQL Endpoint

```bash
cd csa_platform/semantic_model

# Install dependencies
pip install -r requirements.txt

# Configure the Databricks SQL warehouse endpoint for Power BI
python scripts/configure_sql_endpoint.py \
    --workspace-url "https://adb-<workspace-id>.azuredatabricks.net" \
    --warehouse-name "csa-bi-warehouse"
```

### 7b. Generate the Semantic Model

```bash
python scripts/generate_semantic_model.py \
    --template semantic_model_template.yaml \
    --catalog unity_catalog \
    --schema gold \
    --tables "gld_daily_transaction_summary"
```

### 7c. Connect Power BI Desktop

1. Open **Power BI Desktop**.
2. Select **Get Data** > **Azure Databricks**.
3. Enter the SQL warehouse hostname and HTTP path from your profile.
4. Choose **DirectQuery** mode for real-time queries against gold-layer Delta tables.
5. Select the `gold.gld_daily_transaction_summary` table.
6. Define measures in the model view:

```dax
Total Amount = SUM(gld_daily_transaction_summary[total_amount])
Transaction Count = SUM(gld_daily_transaction_summary[transaction_count])
Average Transaction = DIVIDE([Total Amount], [Transaction Count], 0)
```

> **Foundry comparison:** In Foundry, you build analyses and dashboards using Contour or Quiver. Power BI replaces both: the semantic model is your reusable business logic layer (like Foundry's "metric definitions"), and reports/dashboards are built on top. The Direct Lake / DirectQuery pattern means you get near-real-time data without extracts.

**What success looks like:**

- Power BI Desktop connects to the Databricks SQL warehouse.
- The `gld_daily_transaction_summary` table loads with correct row counts.
- DAX measures calculate correctly in a table visual.

---

## Step 8: Build a Power BI Report with Copilot

With your semantic model connected, build a report using Power BI Copilot (requires Fabric capacity or Power BI Premium).

1. In Power BI Desktop (or Power BI Service), open the report canvas.
2. Click the **Copilot** icon in the ribbon.
3. Enter a prompt such as:

   > "Create a report page showing daily transaction trends by category, with a bar chart of total amount by category and a line chart of transaction count over time."

4. Copilot generates visuals. Review and refine:
   - Adjust date filters to the relevant time range.
   - Add slicers for `category`.
   - Apply your organization's theme.

5. Add a second page manually for detail:
   - Table visual: `transaction_date`, `category`, `transaction_count`, `total_amount`, `avg_amount`.
   - Card visuals: `Total Amount`, `Transaction Count`.

6. Publish to the Power BI Service:

```bash
# Or publish from Power BI Desktop: File > Publish > Select workspace
```

> **Foundry comparison:** Foundry's Contour and Quiver provide drag-and-drop analysis and dashboards. Power BI offers similar drag-and-drop capabilities plus Copilot for natural language report generation, paginated reports for formal distribution, and embedded analytics for application integration. The ecosystem is broader.

**What success looks like:**

- The report renders with accurate data matching your Gold layer.
- Copilot-generated visuals display correct aggregations.
- The published report is accessible in the Power BI workspace.

---

## Step 9: Validate End-to-End

Now verify that the entire pipeline works from source to report.

### 9a. Verify Data Flows

```bash
# Check ADF pipeline status
az datafactory pipeline-run query-by-factory \
    --factory-name <your-adf-name> \
    --resource-group <your-rg> \
    --last-updated-after "2024-01-01T00:00:00Z" \
    --last-updated-before "2030-01-01T00:00:00Z" \
    --filters '[{"operand":"PipelineName","operator":"Equals","values":["pl_ingest_to_bronze"]}]'
```

### 9b. Query Each Layer

```sql
-- Bronze: raw records landed
SELECT COUNT(*) AS bronze_count FROM bronze.brz_transactions;

-- Silver: validated records with quality flags
SELECT
    COUNT(*) AS total_rows,
    SUM(CASE WHEN is_valid THEN 1 ELSE 0 END) AS valid_rows,
    SUM(CASE WHEN NOT is_valid THEN 1 ELSE 0 END) AS invalid_rows
FROM silver.slv_transactions;

-- Gold: business-ready aggregates
SELECT transaction_date, category, total_amount
FROM gold.gld_daily_transaction_summary
ORDER BY transaction_date DESC
LIMIT 10;
```

### 9c. Check Lineage in Purview

1. Open **Microsoft Purview** > **Data Catalog**.
2. Search for `gld_daily_transaction_summary`.
3. Click **Lineage** to see the end-to-end path: **Source** -> **ADLS Raw** -> **Bronze** -> **Silver** -> **Gold**.
4. Confirm that classifications and glossary terms are attached.

### 9d. Confirm the Report Renders

1. Open the Power BI report in the Power BI Service.
2. Verify that visuals load with current data.
3. Apply a filter (e.g., select a single category) and confirm the numbers match a manual query on the Gold table.

> **Foundry comparison:** In Foundry, you would check Pipeline Health, open the dataset preview, and view lineage in the Monocle graph. On Azure, the equivalent checks are: ADF Monitor (pipeline runs), Databricks SQL (query results), Purview (lineage graph), and Power BI (report rendering). The information is spread across purpose-built tools rather than a single UI.

**What success looks like:**

- ADF pipeline runs show `Succeeded`.
- Bronze row count matches the source file.
- Silver valid-row ratio is above 97% (matching your SLA).
- Gold aggregates are mathematically correct.
- Purview lineage shows the full chain.
- The Power BI report renders with accurate, current data.

---

## Foundry-to-Azure Concept Map

Use this table as a quick reference when you encounter a Foundry concept and need the Azure equivalent:

| Foundry concept | Azure / CSA-in-a-Box equivalent | Where in the repo |
|---|---|---|
| Project / Folder | Domain folder in Git | `domains/<domain>/` |
| Dataset (raw) | ADLS Gen2 container + ADF pipeline | `domains/<domain>/pipelines/adf/` |
| Transform (Python/SQL) | dbt model (Bronze/Silver/Gold) | `domains/<domain>/dbt/models/` |
| Object Type (Ontology) | Data contract + Purview glossary term | `domains/<domain>/data-products/` |
| Pipeline Builder | Azure Data Factory pipeline | `domains/<domain>/pipelines/adf/` |
| Data Catalog | Microsoft Purview | `scripts/purview/` |
| Expectations / Checks | dbt tests + contract validator | `governance/contracts/` |
| Contour / Quiver | Power BI report + semantic model | `csa_platform/semantic_model/` |
| Marketplace | CSA-in-a-Box data marketplace portal | `portal/` |
| Permissions (Compass) | Azure RBAC + Purview access policies | `deploy/bicep/` |
| Scheduling | ADF triggers | `domains/<domain>/pipelines/adf/triggers/` |

---

## Clean Up

If you deployed to a dev/test subscription and want to tear down:

```bash
bash scripts/deploy/teardown-platform.sh --env dev
```

This removes all resources in dependency-safe order and requires a typed confirmation (`DESTROY-dev`). Always tear down non-production environments to avoid unnecessary costs.

---

## Next Steps

- **Add more entities:** Create additional Bronze/Silver/Gold models for other tables in your domain.
- **Add quality rules:** Extend your data contract with more `quality_rules` entries and run the contract validator in CI.
- **Set up scheduling:** Deploy ADF triggers from `domains/shared/pipelines/adf/triggers/` for daily or hourly refreshes.
- **Add streaming:** Set up Event Hub streaming alongside batch ingestion using ADF's streaming pipeline support.
- **Scale to production:** Review the platform's production hardening guidance before going live.
- **Explore existing domains:** Study the `domains/shared/`, `domains/finance/`, `domains/inventory/`, and `domains/sales/` implementations for patterns you can reuse.

---

## Related Resources

- [CSA-in-a-Box Reference Architecture](../../reference-architecture/index.md) -- Platform architecture deep-dive
- [Migration Playbook](../palantir-foundry.md) -- End-to-end migration guide
- [Pipeline Migration Guide](pipeline-migration.md) -- Migrating Foundry pipelines to ADF and dbt
- [Ontology Migration Guide](ontology-migration.md) -- Mapping Foundry Ontology to Purview and contracts
- [Why Azure over Palantir](why-azure-over-palantir.md) -- Strategic comparison
- [Data Integration Migration](data-integration-migration.md) -- Connector and integration patterns
