# DOJ Antitrust Domain

This domain provides comprehensive data models and analytics for the U.S. Department of Justice Antitrust Division enforcement activities, including criminal prosecutions, civil enforcement actions, Hart-Scott-Rodino (HSR) merger reviews, and penalty analysis.

## Overview

The DOJ Antitrust domain implements a complete data pipeline following CSA-in-a-Box patterns to analyze:

- **Antitrust Cases**: Both civil and criminal enforcement actions across all violation types
- **Criminal Enforcement**: Fines, jail sentences, and restitution data
- **Civil Actions**: Merger challenges, conduct cases, and consent decrees  
- **HSR Filings**: Merger review statistics and outcomes
- **Merger Analysis**: Market concentration (HHI) and competitive impact assessment

## Data Sources

All data in this domain is derived from publicly available DOJ Antitrust Division sources:

- **Case Data**: Federal court filings and DOJ press releases
- **Penalty Information**: Criminal sentencing records and civil settlement agreements
- **HSR Statistics**: Annual Hart-Scott-Rodino filing reports
- **Merger Reviews**: DOJ merger review decisions and competitive analysis

*Note: All data in this implementation is synthetic but based on actual DOJ statistical patterns and publicly available enforcement data.*

## Domain Structure

```
doj/
├── README.md                           # This file
├── dbt/                               # dbt transformation pipeline
│   ├── dbt_project.yml               # dbt project configuration
│   ├── profiles.yml                  # Database connection profiles
│   ├── packages.yml                  # dbt dependencies
│   ├── macros/                       # Shared SQL macros
│   ├── seeds/                        # Raw CSV data files
│   │   ├── raw_antitrust_cases.csv   # Case records
│   │   ├── raw_hsr_filings.csv       # HSR filing data
│   │   ├── raw_criminal_enforcement.csv # Criminal penalties
│   │   ├── raw_civil_actions.csv     # Civil enforcement actions
│   │   └── raw_merger_reviews.csv    # Merger review analysis
│   └── models/                       # dbt transformations
│       ├── bronze/                   # Raw data ingestion layer
│       ├── silver/                   # Cleaned and validated data
│       └── gold/                     # Business logic and analytics
├── notebooks/                        # Analysis notebooks
│   └── doj_antitrust_analysis.py    # Comprehensive enforcement analysis
└── data-products/                   # Data product contracts
    ├── antitrust-cases/contract.yaml
    ├── enforcement-actions/contract.yaml
    ├── merger-review-summary/contract.yaml
    └── penalty-analysis/contract.yaml
```

## Key Data Models

### Bronze Layer (Raw Data Ingestion)
- `brz_antitrust_cases`: Case records with minimal transformation
- `brz_hsr_filings`: HSR filing records  
- `brz_criminal_enforcement`: Criminal penalty data
- `brz_civil_actions`: Civil enforcement actions
- `brz_merger_reviews`: Detailed merger review analysis

### Silver Layer (Data Quality and Validation)
- `slv_antitrust_cases`: Validated case records with quality flags
- `slv_hsr_filings`: Clean HSR data with business rules applied
- `slv_criminal_enforcement`: Validated penalty and sentencing data
- `slv_civil_actions`: Clean civil action records
- `slv_merger_reviews`: Validated merger analysis with HHI metrics

### Gold Layer (Analytics and Business Logic)
- `dim_industries`: Industry sector dimension with regulatory flags
- `dim_violation_types`: Violation type dimension with statutory references
- `fact_enforcement_actions`: Unified enforcement fact table
- `gld_antitrust_trends`: Year-over-year enforcement trend analysis
- `gld_merger_review_summary`: HSR filing and review outcome statistics
- `gld_penalty_analysis`: Comprehensive penalty analysis by multiple dimensions

## Key Metrics and Analysis

### Enforcement Trends
- Annual case volumes (criminal vs civil)
- Success rates and resolution timelines
- Year-over-year changes in enforcement activity
- Industry-specific enforcement patterns

### Criminal Enforcement
- Fine amounts by violation type and defendant type
- Jail sentence patterns and trends
- Restitution orders and compliance
- Corporate vs individual defendant analysis

### Merger Review Analysis
- HSR filing volumes and transaction values
- Early termination and second request rates
- Market concentration impact (HHI analysis)
- Challenge and approval patterns by industry

### Civil Enforcement
- Types of relief sought (injunctive, structural, behavioral)
- Settlement vs litigation outcomes
- Consent decree modifications and compliance
- Industry-specific civil enforcement patterns

## Running the dbt Pipeline

### Prerequisites
- dbt installed with Databricks adapter
- Unity Catalog access configured
- Environment variables set (see profiles.yml)

### Execution
```bash
cd domains/doj/dbt

# Install dependencies
dbt deps

# Run full pipeline
dbt run

# Run tests
dbt test

# Generate documentation
dbt docs generate
dbt docs serve
```

### Incremental Updates
The pipeline supports incremental updates based on ingestion timestamps:
```bash
# Run only changed data
dbt run --select +bronze
dbt run --select +silver  
dbt run --select +gold
```

## Data Quality

All silver layer models implement the "flag-don't-drop" pattern with comprehensive validation:

- **Data Completeness**: Required fields validation
- **Business Rules**: Date logic, amount validation, status consistency
- **Referential Integrity**: FK relationships and lookups
- **Domain Validation**: Controlled vocabularies and ranges

Quality flags and error descriptions are preserved in `is_valid` and `validation_errors` columns.

## Analysis Notebook

The `doj_antitrust_analysis.py` notebook provides:

1. **Enforcement Trends**: Multi-year trend analysis
2. **Case Distribution**: Criminal vs civil patterns
3. **Penalty Analysis**: Fine and sentence analysis by violation type
4. **HSR Trends**: Merger filing and review patterns  
5. **Industry Analysis**: Sector-specific enforcement focus
6. **Timeline Analysis**: Case resolution patterns
7. **Market Concentration**: HHI and competitive impact analysis
8. **Dashboard Exports**: Key metrics for executive reporting

## Data Product Contracts

Four data products are published with formal SLAs:

- **antitrust-cases**: Core case data with quality flags
- **enforcement-actions**: Unified enforcement fact table
- **merger-review-summary**: HSR and merger analysis by year
- **penalty-analysis**: Multi-dimensional penalty analysis

Each contract specifies schema, freshness SLAs, and quality rules.

## Legal and Compliance Notes

### Data Classification
- All enforcement data is derived from public sources
- No personally identifiable information (PII) is included
- Corporate names are anonymized in synthetic datasets

### Statutory References
- Sherman Antitrust Act (15 U.S.C. §§ 1-7)
- Clayton Act (15 U.S.C. §§ 12-27)  
- Hart-Scott-Rodino Act (15 U.S.C. § 18a)
- Federal Trade Commission Act (15 U.S.C. §§ 41-58)

### Use Cases
- Policy analysis and enforcement trend evaluation
- Academic research on antitrust economics
- Public transparency and government accountability
- Deterrence effectiveness assessment

## Variables and Configuration

Key dbt variables in `dbt_project.yml`:

- `fiscal_year_start_month: 10` - DOJ fiscal year starts October 1
- `criminal_fine_threshold: 1000000` - Threshold for significant fines
- `hhi_concentration_threshold: 2500` - HHI threshold for highly concentrated markets

## Support and Maintenance

This domain is maintained as part of the CSA-in-a-Box reference architecture. For questions or contributions:

- Review the CSA-in-a-Box documentation
- Follow established patterns from finance/inventory domains
- Ensure all changes maintain backward compatibility with data contracts

## Version History

- **v1.0.0**: Initial release with comprehensive DOJ antitrust analytics
- Follows CSA-in-a-Box v2.x patterns and conventions
- Compatible with Unity Catalog and Databricks SQL warehouses