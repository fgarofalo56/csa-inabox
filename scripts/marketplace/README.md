# CSA-in-a-Box Marketplace CLI

A comprehensive command-line tool for managing data products in the CSA-in-a-Box data marketplace. This CLI provides functionality to register data products, browse the marketplace, validate contracts, and request access to data products.

## Features

- **Contract Management**: Validate and register data product contracts
- **Marketplace Discovery**: Browse and search data products by domain, quality, and other filters
- **Quality Monitoring**: View quality history and metrics for data products
- **Access Management**: Request access to data products with justification
- **Rich Output**: Beautiful tables and formatted output using Rich library
- **Template Support**: Pre-built contract templates for different data product types

## Installation

### Prerequisites

- Python 3.10 or higher
- Access to CSA-in-a-Box marketplace API

### Install Dependencies

```bash
pip install httpx rich pyyaml pydantic
```

### Environment Setup

Set the marketplace API URL (optional, defaults to local development):

```bash
export MARKETPLACE_API_URL="https://your-csa-marketplace.azurewebsites.net/api/v1/marketplace"
```

## Usage

### Basic Commands

```bash
# Get help
python marketplace-cli.py --help

# List all data products
python marketplace-cli.py list

# Get detailed information about a specific product
python marketplace-cli.py get dp-001

# View quality history for a product
python marketplace-cli.py quality dp-001

# Validate a contract file
python marketplace-cli.py validate --contract my-product.yaml

# Register a new data product
python marketplace-cli.py register --contract my-product.yaml

# Request access to a product
python marketplace-cli.py request-access dp-001 --justification "Need for quarterly analysis"
```

### Advanced Usage

#### Filtering and Search

```bash
# Filter by domain
python marketplace-cli.py list --domain finance

# Search by keywords
python marketplace-cli.py list --search "customer analytics"

# Filter by minimum quality score
python marketplace-cli.py list --min-quality 0.8

# Combine filters
python marketplace-cli.py list --domain manufacturing --min-quality 0.9 --search "sensor"

# Pagination
python marketplace-cli.py list --limit 20 --offset 40
```

#### Quality Analysis

```bash
# View last 7 days of quality metrics
python marketplace-cli.py quality dp-001 --days 7

# View full year of history
python marketplace-cli.py quality dp-001 --days 365
```

#### Contract Validation

```bash
# Validate without registering
python marketplace-cli.py validate --contract contract.yaml

# Validate as part of registration
python marketplace-cli.py register --contract contract.yaml

# Validate only (don't register)
python marketplace-cli.py register --contract contract.yaml --validate-only
```

#### Access Requests

```bash
# Request read access (default)
python marketplace-cli.py request-access dp-001 --justification "Need for monthly reporting"

# Request read-write access
python marketplace-cli.py request-access dp-001 \\
    --justification "Data enrichment project" \\
    --access-level read_write

# Request admin access
python marketplace-cli.py request-access dp-001 \\
    --justification "Data steward responsibilities" \\
    --access-level admin
```

## Contract Templates

The CLI includes pre-built contract templates for common data product patterns:

### Available Templates

1. **data-product.yaml** - General-purpose data product template
2. **gold-layer.yaml** - Gold layer (business-ready) data products with strict quality requirements
3. **silver-layer.yaml** - Silver layer (cleansed) data products with standard quality requirements  
4. **streaming.yaml** - Real-time streaming data products with low-latency SLA

### Using Templates

```bash
# Copy a template to start your contract
cp scripts/marketplace/contract-templates/gold-layer.yaml my-finance-product.yaml

# Edit the contract file
nano my-finance-product.yaml

# Validate your changes
python marketplace-cli.py validate --contract my-finance-product.yaml

# Register when ready
python marketplace-cli.py register --contract my-finance-product.yaml
```

### Template Customization

Each template includes:
- **Pre-configured SLA settings** appropriate for the data layer
- **Quality threshold recommendations** based on best practices
- **Commented examples** showing common patterns
- **Domain-specific tags** and metadata suggestions

## Contract Schema

### Required Fields

Every data product contract must include:

```yaml
name: "My Data Product"
domain: "finance"  # See supported domains below
description: "Detailed description of what this product provides"
version: "1.0.0"   # Semantic versioning

owner:
  name: "Jane Smith"
  email: "jane.smith@company.com" 
  team: "Data Engineering"

schema:
  format: "delta"  # delta, parquet, csv, json, avro
  location: "abfss://gold@storage.dfs.core.windows.net/finance/my-product/"
  columns: []      # Column definitions
  partition_by: [] # Partition columns

sla:
  freshness_minutes: 120    # 1-43200 (1 min to 30 days)
  availability_percent: 99.5 # 50.0-100.0
  valid_row_ratio: 0.95     # 0.0-1.0

classification: "internal"  # public, internal, confidential, restricted

quality_thresholds:
  completeness: 0.90  # 0.0-1.0
  accuracy: 0.85      # 0.0-1.0
  timeliness: 0.80    # 0.0-1.0
  consistency: 0.85   # 0.0-1.0

lineage:
  upstream: []      # Source systems
  downstream: []    # Consumer systems  
  transformations: [] # Processing steps
```

### Supported Domains

- `finance` - Financial data and reporting
- `healthcare` - Health and medical data
- `environmental` - Environmental and sustainability data
- `manufacturing` - Production and operations data
- `human-resources` - Employee and HR data
- `marketing` - Customer and marketing data
- `supply-chain` - Logistics and supply chain data
- `operations` - General business operations
- `engineering` - Technical and system data
- `research` - Research and development data

### Column Schema

Define columns with detailed metadata:

```yaml
columns:
  - name: "customer_id"
    type: "string"           # string, integer, float, boolean, timestamp, date
    description: "Unique customer identifier"
    nullable: false
  - name: "total_spent"
    type: "double"
    description: "Customer lifetime value in USD"
    nullable: true
```

### Advanced Features

#### Data Classification Levels

- **public** - Publicly shareable data
- **internal** - Internal company use only
- **confidential** - Restricted to authorized teams
- **restricted** - Highly sensitive, minimal access

#### Quality Thresholds

Set appropriate quality expectations:

```yaml
quality_thresholds:
  completeness: 0.95  # % of required fields populated
  accuracy: 0.90      # % of values that are correct
  timeliness: 0.85    # % meeting freshness SLA
  consistency: 0.80   # % consistent across systems
```

#### Lineage Tracking

Document data flow and dependencies:

```yaml
lineage:
  upstream:
    - "crm-raw-customers"
    - "orders-transactional"
  downstream:
    - "customer-360-dashboard"
    - "marketing-segmentation"
  transformations:
    - "dbt model: customer_cleansed"
    - "ADF pipeline: customer_enrichment"
```

## Validation Rules

The CLI validates contracts against these rules:

### Structural Validation
- All required fields are present
- Field types match expected schemas
- Email addresses are valid format
- Version follows semantic versioning (X.Y.Z)
- Dates are in YYYY-MM-DD format

### Business Rules
- Domain is from supported list
- ADLS Gen2 locations follow proper format
- Quality thresholds are between 0.0 and 1.0
- SLA values are within reasonable ranges
- Column names are unique within schema
- Partition columns exist in schema definition

### Quality Recommendations
- Warnings for very relaxed SLAs
- Suggestions for low quality thresholds
- Best practice recommendations

## Output Examples

### Product List
```
                                    Data Products                                    
┏━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━┓
┃ ID    ┃ Name                  ┃ Domain          ┃ Quality ┃ Classification ┃ Owner              ┃ Updated    ┃
┡━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━┩
│ dp-01 │ Employee Master Data  │ human-resources │  94.5%  │ confidential   │ Jane Smith (HR)    │ 2026-04-22 │
│ dp-02 │ Sensor Analytics      │ manufacturing   │  91.2%  │ internal       │ Bob Chen (Mfg IT)  │ 2026-04-22 │
│ dp-03 │ Financial GL          │ finance         │  98.1%  │ restricted     │ Alice Park (Fin)   │ 2026-04-19 │
└───────┴───────────────────────┴─────────────────┴─────────┴────────────────┴────────────────────┴────────────┘
```

### Product Details
```
Data Product: Employee Master Data
ID: dp-001
Domain: human-resources
Classification: confidential
Version: 2.1.0
Status: active

Description:
Curated, PII-masked employee records refreshed daily. Includes org hierarchy, 
location, and role information.

Owner:
  Name: Jane Smith
  Email: jane.smith@contoso.com
  Team: People Analytics

Quality Metrics:
  Quality Score: 94.5%
  Completeness: 97.0%
  Availability: 99.8%
  Freshness: 6.2 hours

Service Level Agreement:
  Freshness SLA: 360 minutes
  Availability SLA: 99.8%
  Valid Row Ratio: 97.0%

Schema:
  Format: delta
  Location: abfss://gold@storage.dfs.core.windows.net/hr/employee-master/
  Columns (5):
    • employee_id: string (required) - Unique employee identifier
    • full_name: string (required) - Employee full name (PII masked)
    • department: string (nullable) - Department name
    • location: string (nullable) - Office location
    • hire_date: date (required) - Employee hire date
```

### Validation Results
```
✓ Contract is valid!

Warnings:
  • Unknown domain 'custom-domain'. Known domains: finance, healthcare, environmental, manufacturing, human-resources, marketing, supply-chain, operations, engineering, research
  • Freshness SLA is very relaxed: 1440 minutes
  • No sample queries provided
```

## Troubleshooting

### Common Issues

#### Connection Errors
```bash
# Check API URL
echo $MARKETPLACE_API_URL

# Test connectivity
curl -f "$MARKETPLACE_API_URL/stats"
```

#### Contract Validation Errors
```bash
# Validate first to see specific errors
python marketplace-cli.py validate --contract problematic-contract.yaml

# Check YAML syntax
python -c "import yaml; yaml.safe_load(open('contract.yaml'))"
```

#### Permission Denied
- Ensure you have access to the requested domain
- Check if the product exists and is accessible
- Verify your authentication credentials

### Debug Mode

For detailed error information, check the HTTP responses:

```python
# Add this to see full error details
import logging
logging.basicConfig(level=logging.DEBUG)
```

## Integration

### CI/CD Pipeline Integration

```yaml
# .github/workflows/validate-contracts.yml
name: Validate Data Contracts
on:
  pull_request:
    paths:
      - 'contracts/**/*.yaml'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      - run: pip install httpx rich pyyaml pydantic
      - name: Validate contracts
        run: |
          for contract in contracts/*.yaml; do
            python scripts/marketplace/marketplace-cli.py validate --contract "$contract"
          done
```

### Automated Registration

```bash
#!/bin/bash
# deploy-data-products.sh
for contract in data-products/*.yaml; do
    echo "Registering $contract..."
    python marketplace-cli.py register --contract "$contract"
done
```

## Development

### Adding New Commands

1. Add command parser in `main()`
2. Implement command function (`cmd_<name>`)
3. Add API method to `MarketplaceAPI` if needed
4. Add formatting function for output
5. Update help text and documentation

### Extending Validation

1. Add business rules to `contract_validator.py`
2. Update `DataProductContract` Pydantic model
3. Add corresponding error messages
4. Update contract templates if needed

### Testing

```bash
# Test with demo data
python marketplace-cli.py list --limit 5

# Test validation
python marketplace-cli.py validate --contract contract-templates/gold-layer.yaml

# Test against local development server
export MARKETPLACE_API_URL="http://localhost:8000/api/v1/marketplace"
python marketplace-cli.py list
```