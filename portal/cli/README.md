# CSA-in-a-Box CLI

A command-line interface for platform engineers to manage data sources, pipelines,
and marketplace products registered in the CSA-in-a-Box platform.

## Installation

The CLI is part of the `portal` package.  No extra dependencies beyond `click`
are required (click is already in the shared requirements).

```bash
# From the repo root — run directly as a module
python -m portal.cli --help
```

## Configuration

| Environment variable | Default                            | Purpose                        |
|----------------------|------------------------------------|--------------------------------|
| `CSA_API_URL`        | `http://localhost:8000/api/v1`     | Backend API base URL           |
| `CSA_API_TOKEN`      | *(none)*                           | Bearer token for auth          |
| `CSA_FORMAT`         | `table`                            | Output format: table/json/yaml |

```bash
export CSA_API_URL=https://portal.yourdomain.com/api/v1
export CSA_API_TOKEN=<your-token>
export CSA_FORMAT=table
```

## Global options

```
python -m portal.cli [OPTIONS] COMMAND [ARGS]...

Options:
  --api-url TEXT           Backend API URL
  --token TEXT             Bearer token
  --format [table|json|yaml]  Output format  [default: table]
  --version                Show version and exit
  --help                   Show this message and exit
```

---

## Commands

### sources

Manage registered data sources.

```bash
# List all sources
python -m portal.cli sources list

# Filter by domain and status
python -m portal.cli sources list --domain finance --status active

# Search by name/description
python -m portal.cli sources list --search "employee"

# Get details for a specific source
python -m portal.cli sources get src-001

# Register a new source (interactive prompts for required fields)
python -m portal.cli sources register \
  --name "Finance GL Export" \
  --domain finance \
  --type rest_api \
  --classification restricted \
  --description "SAP GL export via REST" \
  --owner-name "Alice Park" \
  --owner-email "alice.park@contoso.com" \
  --owner-team "Financial Reporting" \
  --connection-json '{"api_url": "https://sap.contoso.com/odata/v4/gl"}'

# Decommission a source
python -m portal.cli sources decommission src-001 --yes

# Trigger Data Landing Zone provisioning
python -m portal.cli sources provision src-003
```

**Source types:** `azure_sql`, `synapse`, `cosmos_db`, `adls_gen2`,
`blob_storage`, `databricks`, `postgresql`, `mysql`, `oracle`, `rest_api`,
`odata`, `sftp`, `sharepoint`, `event_hub`, `iot_hub`, `kafka`

**Classification levels:** `public`, `internal`, `confidential`, `restricted`,
`cui`, `fouo`

---

### pipelines

View and trigger data pipelines.

```bash
# List all pipelines
python -m portal.cli pipelines list

# Filter by status
python -m portal.cli pipelines list --status running

# Filter by source
python -m portal.cli pipelines list --source-id src-001

# Get pipeline details
python -m portal.cli pipelines get pl-001

# View recent execution runs
python -m portal.cli pipelines runs pl-001
python -m portal.cli pipelines runs pl-001 --limit 5

# Trigger a pipeline run
python -m portal.cli pipelines trigger pl-001 --yes
```

---

### marketplace

Discover and explore data products.

```bash
# List all products (sorted by quality score)
python -m portal.cli marketplace products

# Filter by domain or minimum quality
python -m portal.cli marketplace products --domain finance --min-quality 90

# Full-text search
python -m portal.cli marketplace search "employee"
python -m portal.cli marketplace search "sensor" --domain manufacturing

# Get product details (SLA, lineage, owner, tags)
python -m portal.cli marketplace get dp-001

# View quality metric history
python -m portal.cli marketplace quality dp-001
python -m portal.cli marketplace quality dp-001 --days 7

# List domains and product counts
python -m portal.cli marketplace domains

# Aggregate marketplace statistics
python -m portal.cli marketplace stats
```

---

### stats

Platform and domain-level statistics.

```bash
# Platform-wide summary
python -m portal.cli stats overview

# All domain overviews (sources, pipelines, products, quality)
python -m portal.cli stats domains

# Single domain detail
python -m portal.cli stats domain finance
python -m portal.cli stats domain human-resources
```

---

## Output formats

All commands support `--format table` (default), `--format json`,
and `--format yaml`.

```bash
# Machine-readable JSON (pipe to jq, etc.)
python -m portal.cli --format json sources list | jq '.[].name'

# YAML output
python -m portal.cli --format yaml stats overview

# Table output (default, human-readable)
python -m portal.cli stats domains
```

Example table output:

```
+------------------+---------+-----------+---------+-------------+--------+
| Domain           | Sources | Pipelines | Products| Avg Quality | Status |
+------------------+---------+-----------+---------+-------------+--------+
| finance          | 1       | 1         | 1       | 98.1        | healthy|
| human-resources  | 1       | 1         | 1       | 94.5        | healthy|
| manufacturing    | 1       | 1         | 1       | 91.2        | healthy|
+------------------+---------+-----------+---------+-------------+--------+
```

---

## Error handling

Network and API errors are printed to stderr and exit with code 1:

```
Error: HTTP 404: Source 'src-999' not found.
Error: HTTP 0: Connection error: [Errno 111] Connection refused
```

---

## Running tests

```bash
# Run all CLI tests
python -m pytest portal/cli/tests/ -v

# Run with coverage
python -m pytest portal/cli/tests/ --cov=portal.cli --cov-report=term-missing
```

---

## Portal variants

This CLI is the 4th portal implementation alongside:

| Variant       | Location                 | Target audience            |
|---------------|--------------------------|----------------------------|
| React         | `portal/react-webapp/`   | Business users / analysts  |
| PowerApps     | `portal/powerapps/`      | Power Platform users       |
| Kubernetes    | `portal/kubernetes/`     | K8s / GitOps operators     |
| **CLI**       | `portal/cli/`            | Platform engineers / DevOps|

All variants share the same FastAPI backend at `portal/shared/api/`.
