# 📊 Power BI Integration Guide

## Table of Contents
- [Integration Overview](#integration-overview)
- [Direct Lake Configuration](#direct-lake-configuration)
- [Data Source Setup](#data-source-setup)
- [Semantic Model Development](#semantic-model-development)
- [Report Development](#report-development)
- [Performance Optimization](#performance-optimization)
- [Security Implementation](#security-implementation)
- [Deployment & Governance](#deployment--governance)

## Integration Overview

Power BI integration with Azure Databricks enables real-time analytics through Direct Lake mode, providing sub-second query performance on Delta Lake data without data movement or transformation.

### Architecture Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Databricks    │────│   Power BI      │────│   Consumption   │
│                 │    │                 │    │                 │
│ • Delta Tables  │    │ • Direct Lake   │    │ • Dashboards    │
│ • Unity Catalog │    │ • Semantic      │    │ • Reports       │
│ • SQL Endpoints │    │   Models        │    │ • Mobile Apps   │
│ • Compute       │    │ • Dataflows     │    │ • Embedded      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Integration Benefits

| Feature | Direct Lake | Import Mode | DirectQuery |
|---------|-------------|-------------|-------------|
| **Performance** | Sub-second | Fast | Variable |
| **Data Freshness** | Real-time | Scheduled | Real-time |
| **Data Size Limit** | No limit | 10GB+ | No limit |
| **Memory Usage** | Efficient | High | Low |
| **Query Complexity** | High | High | Limited |

## Direct Lake Configuration

### Prerequisites

#### Power BI Requirements
- **Power BI Premium**: Per User (PPU) or Premium Capacity (P1+)
- **OneLake Storage**: Enabled in Fabric workspace
- **Permissions**: Workspace Admin or Member role

#### Databricks Requirements
- **Unity Catalog**: Enabled and configured
- **SQL Warehouse**: Serverless or Pro SQL warehouse
- **Delta Tables**: Optimized for analytics
- **Network Access**: Power BI service can reach Databricks

### Step 1: Configure Unity Catalog for Power BI

```sql
-- Enable Unity Catalog external access
CREATE CATALOG IF NOT EXISTS powerbi_analytics
LOCATION 'abfss://powerbi@stadatalakeprodbp001.dfs.core.windows.net/'
COMMENT 'Power BI Direct Lake catalog';

-- Create schemas for different business domains
CREATE SCHEMA IF NOT EXISTS powerbi_analytics.sales
LOCATION 'abfss://powerbi@stadatalakeprodbp001.dfs.core.windows.net/sales/'
COMMENT 'Sales analytics tables';

CREATE SCHEMA IF NOT EXISTS powerbi_analytics.customer
LOCATION 'abfss://powerbi@stadatalakeprodbp001.dfs.core.windows.net/customer/'
COMMENT 'Customer analytics tables';

CREATE SCHEMA IF NOT EXISTS powerbi_analytics.operations
LOCATION 'abfss://powerbi@stadatalakeprodbp001.dfs.core.windows.net/operations/'
COMMENT 'Operational metrics tables';
```

### Step 2: Optimize Delta Tables for Power BI

```python
# optimize_for_powerbi.py
from pyspark.sql import SparkSession
from delta.tables import DeltaTable

spark = SparkSession.builder \
    .appName("PowerBIOptimization") \
    .config("spark.databricks.delta.autoCompact.enabled", "true") \
    .config("spark.databricks.delta.optimizeWrite.enabled", "true") \
    .getOrCreate()

def optimize_table_for_powerbi(table_name, partition_columns=None, z_order_columns=None):
    """Optimize Delta table for Power BI Direct Lake performance"""
    
    # Basic optimization
    spark.sql(f"OPTIMIZE {table_name}")
    
    # Z-ORDER optimization for common query patterns
    if z_order_columns:
        z_order_cols = ", ".join(z_order_columns)
        spark.sql(f"OPTIMIZE {table_name} ZORDER BY ({z_order_cols})")
    
    # Update table statistics
    spark.sql(f"ANALYZE TABLE {table_name} COMPUTE STATISTICS FOR ALL COLUMNS")
    
    # Set table properties for Power BI
    spark.sql(f"""
        ALTER TABLE {table_name} SET TBLPROPERTIES (
            'delta.autoOptimize.optimizeWrite' = 'true',
            'delta.autoOptimize.autoCompact' = 'true',
            'delta.enableChangeDataFeed' = 'true',
            'powerbi.directlake.enabled' = 'true'
        )
    """)

# Optimize key tables for Power BI
optimization_config = [
    {
        "table": "powerbi_analytics.sales.fact_sales",
        "z_order": ["date_key", "customer_id", "product_id"],
        "partitions": ["year", "month"]
    },
    {
        "table": "powerbi_analytics.customer.dim_customer",
        "z_order": ["customer_id", "customer_segment"],
        "partitions": None
    },
    {
        "table": "powerbi_analytics.operations.metrics_hourly",
        "z_order": ["timestamp", "metric_type"],
        "partitions": ["date"]
    }
]

for config in optimization_config:
    optimize_table_for_powerbi(
        config["table"],
        config.get("partitions"),
        config["z_order"]
    )
```

### Step 3: Create Power BI Optimized Views

```sql
-- Create Power BI friendly views with proper data types
CREATE OR REPLACE VIEW powerbi_analytics.sales.v_sales_summary AS
SELECT 
    CAST(sale_date AS DATE) as SaleDate,
    CAST(customer_id AS BIGINT) as CustomerID,
    CAST(product_id AS BIGINT) as ProductID,
    CAST(quantity AS INT) as Quantity,
    CAST(unit_price AS DECIMAL(10,2)) as UnitPrice,
    CAST(total_amount AS DECIMAL(15,2)) as TotalAmount,
    CAST(discount_percent AS DECIMAL(5,2)) as DiscountPercent,
    region as Region,
    sales_channel as SalesChannel,
    YEAR(sale_date) as SaleYear,
    MONTH(sale_date) as SaleMonth,
    DAYOFWEEK(sale_date) as DayOfWeek
FROM customer_analytics.curated.sales_transactions
WHERE sale_date >= '2023-01-01';

-- Customer dimension view
CREATE OR REPLACE VIEW powerbi_analytics.customer.v_customer_profile AS
SELECT 
    CAST(customer_id AS BIGINT) as CustomerID,
    customer_name as CustomerName,
    CAST(customer_age AS INT) as CustomerAge,
    customer_segment as CustomerSegment,
    registration_date as RegistrationDate,
    CAST(lifetime_value AS DECIMAL(15,2)) as LifetimeValue,
    CAST(total_orders AS INT) as TotalOrders,
    last_order_date as LastOrderDate,
    DATEDIFF(CURRENT_DATE(), last_order_date) as DaysSinceLastOrder,
    CASE 
        WHEN DATEDIFF(CURRENT_DATE(), last_order_date) <= 30 THEN 'Active'
        WHEN DATEDIFF(CURRENT_DATE(), last_order_date) <= 90 THEN 'At Risk'
        ELSE 'Inactive'
    END as CustomerStatus
FROM customer_analytics.curated.customer_profiles;

-- Real-time metrics view
CREATE OR REPLACE VIEW powerbi_analytics.operations.v_realtime_metrics AS
SELECT 
    CAST(timestamp AS TIMESTAMP) as MetricTimestamp,
    metric_name as MetricName,
    CAST(metric_value AS DECIMAL(18,4)) as MetricValue,
    metric_unit as MetricUnit,
    source_system as SourceSystem,
    DATE(timestamp) as MetricDate,
    HOUR(timestamp) as MetricHour
FROM operations_analytics.curated.realtime_metrics
WHERE timestamp >= CURRENT_TIMESTAMP() - INTERVAL 7 DAYS;
```

## Data Source Setup

### Step 1: Create Databricks Connection in Power BI

```python
# powerbi_connection_setup.py
import requests
import json
from azure.identity import DefaultAzureCredential

def create_powerbi_gateway_connection():
    """Create gateway connection for Databricks in Power BI"""
    
    # Power BI REST API configuration
    credential = DefaultAzureCredential()
    token = credential.get_token("https://analysis.windows.net/powerbi/api/.default")
    
    headers = {
        'Authorization': f'Bearer {token.token}',
        'Content-Type': 'application/json'
    }
    
    # Gateway data source configuration
    datasource_config = {
        "datasourceType": "Databricks",
        "connectionDetails": {
            "server": "adb-1234567890123456.7.azuredatabricks.net",
            "httpPath": "/sql/1.0/warehouses/your-warehouse-id",
            "database": "powerbi_analytics"
        },
        "credentialDetails": {
            "credentialType": "OAuth2",
            "useEndUserOAuth2Credentials": False
        },
        "datasourceName": "Databricks Analytics Warehouse"
    }
    
    # Create the data source
    gateway_id = "your-gateway-id"
    url = f"https://api.powerbi.com/v1.0/myorg/gateways/{gateway_id}/datasources"
    
    response = requests.post(url, headers=headers, data=json.dumps(datasource_config))
    
    if response.status_code == 201:
        return response.json()
    else:
        raise Exception(f"Failed to create datasource: {response.text}")

# Configure connection parameters
connection_params = {
    "server": "adb-1234567890123456.7.azuredatabricks.net",
    "http_path": "/sql/1.0/warehouses/your-warehouse-id",
    "catalog": "powerbi_analytics",
    "authentication": "Azure Active Directory",
    "advanced_options": {
        "command_timeout": 600,
        "connection_timeout": 30,
        "enable_direct_lake": True
    }
}
```

### Step 2: Power BI Desktop Connection

```python
# powerbi_desktop_connection.py
def generate_powerbi_connection_string():
    """Generate connection string for Power BI Desktop"""
    
    connection_string = """
    let
        Source = Databricks.Catalogs(
            "adb-1234567890123456.7.azuredatabricks.net",
            "/sql/1.0/warehouses/your-warehouse-id",
            [Catalog = "powerbi_analytics"]
        ),
        Navigation = Source{[Name="powerbi_analytics"]}[Data],
        Tables = Navigation{[Name="Tables"]}[Data]
    in
        Tables
    """
    
    return connection_string

# M Query for specific table access
def generate_table_query(schema_name, table_name):
    """Generate M query for specific table access"""
    
    query = f"""
    let
        Source = Databricks.Catalogs(
            "adb-1234567890123456.7.azuredatabricks.net", 
            "/sql/1.0/warehouses/your-warehouse-id"
        ),
        Catalog = Source{{[Name="powerbi_analytics"]}}[Data],
        Schema = Catalog{{[Name="{schema_name}"]}}[Data],
        Table = Schema{{[Name="{table_name}"]}}[Data]
    in
        Table
    """
    
    return query
```

## Semantic Model Development

### Step 1: Data Model Design

```json
{
  "model": {
    "name": "Analytics Data Model",
    "description": "Enterprise analytics semantic model",
    "tables": [
      {
        "name": "Sales",
        "source": "powerbi_analytics.sales.v_sales_summary",
        "mode": "DirectLake",
        "columns": [
          {"name": "SaleDate", "dataType": "DateTime", "isKey": false},
          {"name": "CustomerID", "dataType": "Int64", "isKey": false},
          {"name": "ProductID", "dataType": "Int64", "isKey": false},
          {"name": "TotalAmount", "dataType": "Decimal", "isKey": false, "summarizeBy": "Sum"}
        ],
        "measures": [
          {
            "name": "Total Sales",
            "expression": "SUM(Sales[TotalAmount])",
            "formatString": "$#,##0.00"
          },
          {
            "name": "Sales Count",
            "expression": "COUNTROWS(Sales)",
            "formatString": "#,##0"
          },
          {
            "name": "Average Sale Amount",
            "expression": "AVERAGE(Sales[TotalAmount])",
            "formatString": "$#,##0.00"
          }
        ]
      },
      {
        "name": "Customer",
        "source": "powerbi_analytics.customer.v_customer_profile",
        "mode": "DirectLake",
        "columns": [
          {"name": "CustomerID", "dataType": "Int64", "isKey": true},
          {"name": "CustomerName", "dataType": "String", "isKey": false},
          {"name": "CustomerSegment", "dataType": "String", "isKey": false},
          {"name": "LifetimeValue", "dataType": "Decimal", "isKey": false}
        ]
      }
    ],
    "relationships": [
      {
        "name": "Sales to Customer",
        "fromTable": "Sales",
        "fromColumn": "CustomerID",
        "toTable": "Customer", 
        "toColumn": "CustomerID",
        "cardinality": "ManyToOne"
      }
    ]
  }
}
```

### Step 2: Advanced DAX Measures

```dax
-- Time Intelligence Measures
Total Sales = SUM(Sales[TotalAmount])

Total Sales LY = 
CALCULATE(
    [Total Sales],
    SAMEPERIODLASTYEAR('Calendar'[Date])
)

Sales Growth % = 
DIVIDE(
    [Total Sales] - [Total Sales LY],
    [Total Sales LY],
    0
)

-- Customer Analytics Measures
Active Customers = 
CALCULATE(
    DISTINCTCOUNT(Customer[CustomerID]),
    Customer[CustomerStatus] = "Active"
)

Customer Lifetime Value = 
SUMX(
    Customer,
    Customer[LifetimeValue]
)

Average Order Value = 
DIVIDE(
    [Total Sales],
    [Sales Count]
)

-- Advanced Analytics
Sales Forecast = 
VAR CurrentMonth = MAX('Calendar'[Date])
VAR HistoricalData = 
    CALCULATETABLE(
        SUMMARIZE(
            Sales,
            'Calendar'[Year],
            'Calendar'[Month],
            "Sales", [Total Sales]
        ),
        'Calendar'[Date] <= CurrentMonth
    )
VAR Trend = 
    LINESTX(HistoricalData, [Sales], 'Calendar'[Month])
RETURN
    Trend

Customer Churn Risk = 
SWITCH(
    TRUE(),
    Customer[DaysSinceLastOrder] <= 30, "Low",
    Customer[DaysSinceLastOrder] <= 60, "Medium", 
    Customer[DaysSinceLastOrder] <= 90, "High",
    "Very High"
)

-- Real-time Metrics
Current Hour Sales = 
CALCULATE(
    [Total Sales],
    HOUR(Sales[SaleDate]) = HOUR(NOW())
)

Real-time Conversion Rate = 
VAR Visits = 
    CALCULATE(
        SUM(Metrics[MetricValue]),
        Metrics[MetricName] = "website_visits"
    )
VAR Sales = [Sales Count]
RETURN
    DIVIDE(Sales, Visits, 0)
```

### Step 3: Calculation Groups

```dax
-- Time Intelligence Calculation Group
CALCULATIONGROUP 'Time Intelligence'[Period] = 
    CALCULATIONITEM "Current" = SELECTEDMEASURE()
    CALCULATIONITEM "Previous Year" = 
        CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR('Calendar'[Date]))
    CALCULATIONITEM "Year to Date" = 
        CALCULATE(SELECTEDMEASURE(), DATESYTD('Calendar'[Date]))
    CALCULATIONITEM "Previous YTD" = 
        CALCULATE(SELECTEDMEASURE(), DATESYTD(SAMEPERIODLASTYEAR('Calendar'[Date])))
    CALCULATIONITEM "Growth %" = 
        VAR Current = SELECTEDMEASURE()
        VAR Previous = CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR('Calendar'[Date]))
        RETURN DIVIDE(Current - Previous, Previous, 0)
```

## Report Development

### Step 1: Executive Dashboard

```json
{
  "dashboard": {
    "name": "Executive Analytics Dashboard",
    "pages": [
      {
        "name": "Overview",
        "visuals": [
          {
            "type": "Card",
            "title": "Total Revenue",
            "measure": "Total Sales",
            "position": {"x": 0, "y": 0, "width": 3, "height": 2}
          },
          {
            "type": "Card", 
            "title": "Growth Rate",
            "measure": "Sales Growth %",
            "position": {"x": 3, "y": 0, "width": 3, "height": 2}
          },
          {
            "type": "LineChart",
            "title": "Revenue Trend",
            "axis": "Sales[SaleDate]",
            "values": ["Total Sales", "Total Sales LY"],
            "position": {"x": 0, "y": 2, "width": 12, "height": 6}
          },
          {
            "type": "DonutChart",
            "title": "Revenue by Segment",
            "legend": "Customer[CustomerSegment]",
            "values": ["Total Sales"],
            "position": {"x": 0, "y": 8, "width": 6, "height": 6}
          }
        ]
      },
      {
        "name": "Customer Analytics",
        "visuals": [
          {
            "type": "Matrix",
            "title": "Customer Performance",
            "rows": ["Customer[CustomerSegment]"],
            "columns": ["Time Intelligence[Period]"],
            "values": ["Total Sales", "Active Customers"]
          },
          {
            "type": "Scatter",
            "title": "Customer Value Analysis", 
            "x": "Customer[TotalOrders]",
            "y": "Customer[LifetimeValue]",
            "size": "Total Sales"
          }
        ]
      }
    ]
  }
}
```

### Step 2: Operational Dashboard

```python
# operational_dashboard_config.py
dashboard_config = {
    "real_time_dashboard": {
        "refresh_interval": "15 seconds",
        "visuals": [
            {
                "type": "streaming_line_chart",
                "title": "Real-time Sales Volume",
                "data_source": "powerbi_analytics.operations.v_realtime_metrics",
                "filter": "MetricName = 'sales_per_minute'",
                "time_window": "4 hours",
                "auto_scroll": True
            },
            {
                "type": "gauge",
                "title": "System Performance",
                "data_source": "powerbi_analytics.operations.v_realtime_metrics", 
                "metric": "cpu_utilization",
                "min_value": 0,
                "max_value": 100,
                "target": 80
            },
            {
                "type": "table",
                "title": "Recent Transactions",
                "data_source": "powerbi_analytics.sales.v_sales_summary",
                "top_n": 100,
                "sort_by": "SaleDate DESC",
                "auto_refresh": True
            }
        ]
    }
}
```

## Performance Optimization

### Step 1: Query Performance Tuning

```sql
-- Optimize queries for Power BI consumption
-- Create aggregated tables for common queries
CREATE OR REPLACE TABLE powerbi_analytics.sales.agg_sales_daily AS
SELECT 
    DATE(sale_date) as sale_date,
    customer_segment,
    region,
    COUNT(*) as transaction_count,
    SUM(total_amount) as total_sales,
    AVG(total_amount) as avg_sale_amount,
    SUM(quantity) as total_quantity
FROM powerbi_analytics.sales.v_sales_summary
GROUP BY DATE(sale_date), customer_segment, region;

-- Create monthly aggregations
CREATE OR REPLACE TABLE powerbi_analytics.sales.agg_sales_monthly AS
SELECT 
    DATE_TRUNC('MONTH', sale_date) as month_start,
    YEAR(sale_date) as sale_year,
    MONTH(sale_date) as sale_month,
    customer_segment,
    region,
    COUNT(*) as transaction_count,
    SUM(total_amount) as total_sales,
    AVG(total_amount) as avg_sale_amount
FROM powerbi_analytics.sales.v_sales_summary
GROUP BY DATE_TRUNC('MONTH', sale_date), YEAR(sale_date), MONTH(sale_date), customer_segment, region;
```

### Step 2: Model Optimization

```python
# model_optimization.py
def optimize_powerbi_model():
    """Power BI model optimization recommendations"""
    
    optimizations = {
        "data_types": {
            "description": "Optimize data types for memory efficiency",
            "actions": [
                "Use integer instead of string for IDs where possible",
                "Use decimal(10,2) for currency instead of float", 
                "Use date instead of datetime for date-only columns",
                "Remove unnecessary precision from decimal columns"
            ]
        },
        
        "relationships": {
            "description": "Optimize table relationships",
            "actions": [
                "Use integer keys for relationships",
                "Avoid bidirectional relationships where possible",
                "Create proper star schema structure",
                "Use role-playing dimensions carefully"
            ]
        },
        
        "aggregations": {
            "description": "Implement aggregation tables",
            "tables": [
                "sales_daily_agg",
                "sales_monthly_agg", 
                "customer_monthly_agg",
                "product_performance_agg"
            ]
        },
        
        "partitioning": {
            "description": "Implement table partitioning",
            "strategy": [
                "Partition large fact tables by date",
                "Use incremental refresh for historical data",
                "Set appropriate refresh policies"
            ]
        }
    }
    
    return optimizations

def create_incremental_refresh_policy():
    """Configure incremental refresh for large tables"""
    
    policy = {
        "table": "Sales",
        "refresh_policy": {
            "incremental_periods": 24,  # months
            "refresh_periods": 3,       # months  
            "partition_column": "SaleDate",
            "detect_data_changes": True,
            "only_refresh_complete_periods": True
        }
    }
    
    return policy
```

### Step 3: Caching Strategy

```python
# caching_strategy.py
def implement_caching_strategy():
    """Implement multi-level caching for optimal performance"""
    
    caching_config = {
        "databricks_cache": {
            "type": "Delta Cache",
            "configuration": {
                "spark.databricks.io.cache.enabled": "true",
                "spark.databricks.io.cache.maxDiskUsage": "50g",
                "spark.databricks.io.cache.compression.enabled": "true"
            },
            "tables_to_cache": [
                "powerbi_analytics.sales.v_sales_summary",
                "powerbi_analytics.customer.v_customer_profile",
                "powerbi_analytics.operations.v_realtime_metrics"
            ]
        },
        
        "powerbi_cache": {
            "type": "Power BI Premium Cache",
            "configuration": {
                "automatic_page_refresh": "15 minutes",
                "query_caching": "enabled",
                "dataset_cache": "enabled"
            }
        },
        
        "sql_warehouse_cache": {
            "type": "Databricks SQL Warehouse Cache",
            "configuration": {
                "enable_serverless_compute": "true",
                "auto_stop_minutes": 10,
                "min_num_clusters": 1,
                "max_num_clusters": 5
            }
        }
    }
    
    return caching_config
```

## Security Implementation

### Step 1: Row-Level Security

```sql
-- Create RLS security predicates
CREATE OR REPLACE FUNCTION powerbi_analytics.security.user_region_filter()
RETURNS TABLE
AS
RETURN 
  SELECT region 
  FROM powerbi_analytics.security.user_region_mapping 
  WHERE user_principal_name = current_user();

-- Apply RLS to sales view
CREATE OR REPLACE VIEW powerbi_analytics.sales.v_sales_summary_secure AS
SELECT s.*
FROM powerbi_analytics.sales.v_sales_summary s
INNER JOIN powerbi_analytics.security.user_region_filter() urf
  ON s.region = urf.region;

-- Create user mapping table
CREATE OR REPLACE TABLE powerbi_analytics.security.user_region_mapping (
    user_principal_name STRING,
    region STRING,
    access_level STRING
);

-- Insert security mappings
INSERT INTO powerbi_analytics.security.user_region_mapping VALUES
('sales.east@company.com', 'East', 'full'),
('sales.west@company.com', 'West', 'full'),
('manager.national@company.com', 'ALL', 'full'),
('analyst.intern@company.com', 'East', 'read_only');
```

### Step 2: Column-Level Security

```sql
-- Create column masking functions
CREATE OR REPLACE FUNCTION mask_customer_pii(
    column_value STRING,
    user_role STRING
)
RETURNS STRING
DETERMINISTIC
RETURN 
  CASE 
    WHEN user_role IN ('admin', 'data_engineer') THEN column_value
    WHEN user_role = 'analyst' THEN CONCAT(LEFT(column_value, 3), '***')
    ELSE '***'
  END;

-- Apply column masking to customer view
CREATE OR REPLACE VIEW powerbi_analytics.customer.v_customer_profile_secure AS
SELECT 
    CustomerID,
    mask_customer_pii(CustomerName, current_user_role()) as CustomerName,
    CustomerSegment,
    CASE 
      WHEN current_user_role() IN ('admin', 'finance') THEN LifetimeValue
      ELSE NULL
    END as LifetimeValue,
    CustomerStatus
FROM powerbi_analytics.customer.v_customer_profile;
```

### Step 3: Power BI Security Configuration

```python
# powerbi_security.py
import requests
import json

def configure_powerbi_security():
    """Configure Power BI workspace and dataset security"""
    
    security_config = {
        "workspace_access": [
            {
                "group": "Analytics-PowerBI-Admins",
                "access_right": "Admin"
            },
            {
                "group": "Analytics-PowerBI-Members", 
                "access_right": "Member"
            },
            {
                "group": "Analytics-Business-Users",
                "access_right": "Viewer"
            }
        ],
        
        "dataset_permissions": [
            {
                "dataset": "Analytics Data Model",
                "rls_roles": [
                    {
                        "role": "RegionEast",
                        "members": ["sales.east@company.com"],
                        "filter": "[Region] = 'East'"
                    },
                    {
                        "role": "RegionWest", 
                        "members": ["sales.west@company.com"],
                        "filter": "[Region] = 'West'"
                    },
                    {
                        "role": "AllRegions",
                        "members": ["manager.national@company.com"],
                        "filter": "1=1"
                    }
                ]
            }
        ]
    }
    
    return security_config

def create_rls_roles(dataset_id, roles_config):
    """Create RLS roles in Power BI dataset"""
    
    headers = {
        'Authorization': f'Bearer {get_powerbi_token()}',
        'Content-Type': 'application/json'
    }
    
    for role in roles_config:
        # Create role
        role_data = {
            "name": role["role"],
            "tablePermissions": [
                {
                    "name": "Sales",
                    "filterExpression": role["filter"]
                }
            ]
        }
        
        response = requests.post(
            f"https://api.powerbi.com/v1.0/myorg/datasets/{dataset_id}/roles",
            headers=headers,
            data=json.dumps(role_data)
        )
        
        if response.status_code == 201:
            # Add members to role
            for member in role["members"]:
                member_data = {"identifier": member}
                requests.post(
                    f"https://api.powerbi.com/v1.0/myorg/datasets/{dataset_id}/roles/{role['role']}/users",
                    headers=headers,
                    data=json.dumps(member_data)
                )
```

## Deployment & Governance

### Step 1: Deployment Pipeline

```yaml
# azure-pipelines-powerbi.yml
trigger:
  branches:
    include:
    - main
  paths:
    include:
    - powerbi/*

variables:
  - group: PowerBI-Production

stages:
- stage: Build
  jobs:
  - job: BuildPowerBI
    pool:
      vmImage: 'windows-latest'
    steps:
    - task: PowerShell@2
      displayName: 'Install Power BI PowerShell Module'
      inputs:
        script: |
          Install-Module -Name MicrosoftPowerBIMgmt -Force -Scope CurrentUser
          Import-Module MicrosoftPowerBIMgmt
    
    - task: PowerShell@2
      displayName: 'Connect to Power BI Service'
      inputs:
        script: |
          $securePassword = ConvertTo-SecureString "$(powerbi-service-principal-secret)" -AsPlainText -Force
          $credential = New-Object System.Management.Automation.PSCredential ("$(powerbi-service-principal-id)", $securePassword)
          Connect-PowerBIServiceAccount -ServicePrincipal -Credential $credential -TenantId "$(tenant-id)"
    
    - task: PowerShell@2
      displayName: 'Deploy Power BI Reports'
      inputs:
        script: |
          $reports = Get-ChildItem -Path "powerbi/reports" -Filter "*.pbix"
          foreach ($report in $reports) {
            New-PowerBIReport -Path $report.FullName -WorkspaceId "$(powerbi-workspace-id)"
          }

- stage: Deploy
  dependsOn: Build
  condition: succeeded()
  jobs:
  - deployment: DeployToProd
    environment: 'PowerBI-Production'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: PowerShell@2
            displayName: 'Update Dataset Connections'
            inputs:
              script: |
                # Update dataset connection to point to production Databricks
                $datasources = Get-PowerBIDatasource -DatasetId "$(dataset-id)"
                foreach ($datasource in $datasources) {
                  if ($datasource.DatasourceType -eq "Databricks") {
                    Update-PowerBIDatasource -DatasetId "$(dataset-id)" -DatasourceId $datasource.Id -UpdateDetails @{
                      connectionDetails = @{
                        server = "$(prod-databricks-server)"
                        httpPath = "$(prod-sql-warehouse-path)"
                      }
                    }
                  }
                }
```

### Step 2: Governance Framework

```python
# powerbi_governance.py
def implement_governance_framework():
    """Implement Power BI governance and monitoring"""
    
    governance_framework = {
        "data_classification": {
            "sensitivity_labels": [
                {
                    "label": "Public",
                    "description": "Data that can be shared publicly",
                    "protection": "None"
                },
                {
                    "label": "Internal", 
                    "description": "Internal company data",
                    "protection": "Encryption"
                },
                {
                    "label": "Confidential",
                    "description": "Sensitive business data", 
                    "protection": "Encryption + Access Control"
                },
                {
                    "label": "Highly Confidential",
                    "description": "Highly sensitive data",
                    "protection": "Full Protection"
                }
            ]
        },
        
        "access_governance": {
            "workspace_governance": [
                "Require approval for workspace creation",
                "Automatic workspace expiration policies", 
                "Regular access reviews",
                "Usage monitoring and alerts"
            ],
            
            "content_governance": [
                "Require certification for production reports",
                "Version control for all content",
                "Automated testing before deployment",
                "Impact analysis for changes"
            ]
        },
        
        "monitoring": {
            "usage_metrics": [
                "Report view counts",
                "User activity patterns",
                "Performance metrics",
                "Error rates and failures"
            ],
            
            "compliance_monitoring": [
                "Data lineage tracking",
                "Access pattern analysis",
                "Security incident detection",
                "Audit log analysis"
            ]
        }
    }
    
    return governance_framework

def setup_monitoring_dashboard():
    """Create Power BI governance monitoring dashboard"""
    
    monitoring_queries = {
        "workspace_usage": """
            PowerBIActivity
            | where TimeGenerated > ago(30d)
            | where Activity == "ViewReport"
            | summarize ViewCount = count() by WorkspaceId, ReportId, UserId
            | join kind=inner (PowerBIDatasets | project DatasetId, WorkspaceId) on WorkspaceId
            | order by ViewCount desc
        """,
        
        "performance_metrics": """
            PowerBIActivity  
            | where TimeGenerated > ago(7d)
            | where Activity in ("ViewReport", "ExportReport")
            | extend Duration = DurationMs / 1000.0
            | summarize 
                AvgDuration = avg(Duration),
                P95Duration = percentile(Duration, 95),
                RequestCount = count()
            by bin(TimeGenerated, 1h), ReportId
        """,
        
        "error_analysis": """
            PowerBIActivity
            | where TimeGenerated > ago(24h) 
            | where ResultType == "Failure"
            | summarize ErrorCount = count() by Activity, ErrorCode, bin(TimeGenerated, 15m)
            | order by TimeGenerated desc
        """
    }
    
    return monitoring_queries
```

### Step 3: Maintenance Procedures

```python
# powerbi_maintenance.py
from datetime import datetime, timedelta
import schedule
import time

def daily_maintenance_tasks():
    """Daily Power BI maintenance tasks"""
    
    tasks = [
        "refresh_datasets",
        "check_gateway_status", 
        "monitor_capacity_usage",
        "review_error_logs",
        "update_usage_metrics"
    ]
    
    for task in tasks:
        try:
            globals()[task]()
            print(f"✅ Completed: {task}")
        except Exception as e:
            print(f"❌ Failed: {task} - {str(e)}")

def refresh_datasets():
    """Refresh all production datasets"""
    datasets = [
        "analytics-data-model",
        "operational-metrics", 
        "customer-insights"
    ]
    
    for dataset in datasets:
        # Trigger refresh via API
        pass

def weekly_maintenance_tasks():
    """Weekly Power BI maintenance tasks"""
    
    tasks = [
        "optimize_datasets",
        "review_capacity_metrics",
        "update_security_groups",
        "backup_reports",
        "performance_analysis"
    ]
    
    for task in tasks:
        try:
            globals()[task]()
            print(f"✅ Weekly task completed: {task}")
        except Exception as e:
            print(f"❌ Weekly task failed: {task} - {str(e)}")

# Schedule maintenance tasks
schedule.every().day.at("02:00").do(daily_maintenance_tasks)
schedule.every().sunday.at("01:00").do(weekly_maintenance_tasks)

def run_maintenance_scheduler():
    """Run the maintenance scheduler"""
    while True:
        schedule.run_pending()
        time.sleep(60)
```

## Best Practices Summary

### Performance Best Practices
- **Use Direct Lake mode** for real-time analytics on Delta Lake
- **Optimize Delta tables** with Z-ORDER and statistics
- **Implement aggregation tables** for common queries
- **Use incremental refresh** for large historical datasets
- **Cache frequently accessed data** at multiple levels

### Security Best Practices
- **Implement row-level security** at the data source level
- **Use service principals** for automated processes
- **Apply sensitivity labels** to classify data appropriately
- **Regular access reviews** for workspace and dataset permissions
- **Monitor and audit** all data access patterns

### Governance Best Practices
- **Establish clear data ownership** and stewardship roles
- **Implement automated deployment** pipelines
- **Regular certification** of production reports and datasets
- **Comprehensive monitoring** of usage and performance
- **Document all processes** and maintain change logs

---

**🚀 Ready to Deploy**: Follow this guide to implement enterprise-grade Power BI integration with your Databricks analytics platform.

**📊 Real-time Analytics**: Enable sub-second query performance on live data with Direct Lake mode.

**🔒 Enterprise Security**: Implement comprehensive security controls at every layer of the integration.
