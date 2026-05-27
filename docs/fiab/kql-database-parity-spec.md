# KQL Database Editor - Real-Time Intelligence (Fiab Console Parity Spec)

**Document Date:** 2026-05-26  
**Experience:** Microsoft Fabric - Real-Time Intelligence (Kusto Query Language)  
**Item Type:** KQL Database (Eventhouse)

## Overview

The KQL Database editor in Microsoft Fabric provides a comprehensive interface for managing Kusto Query Language (KQL) databases and querysets within the Real-Time Intelligence experience. The editor is accessed through the fabric-developer workspace experience and provides a unified environment for database administration, querying, and data exploration.

## UI Components

### Top Navigation & Tabs

**Tab Navigation:**
- **Eventhouse** - Container-level overview and management
- **Database** - Database-specific configuration and metadata
- **Queryset** - Query editing and execution interface (embedded querysets)

The tabs provide context-aware views for different operational levels of the Real-Time Intelligence hierarchy.

### Toolbar & Action Buttons

**Main Toolbar Features:**
- **Live view** - Real-time view toggle
- **New** - Create new queries or items
- **Get data** - Data ingestion options
- **Query with code** - Direct KQL code editor
- **KQL Queryset** - Open/create querysets
- **Notebook** - Analytical notebook interface
- **Real-Time Dashboard** - Visualization dashboard creation
- **Data Agent** - Data management/automation tools
- **Data policies** - Security and compliance policies
- **OneLake** - OneLake integration toggle (availability indicator)

### Left Sidebar - Schema Browser

**Database Navigation Structure:**
```
eventhouse1 (Database name)
├── System overview
├── Databases
├── Monitoring
├── Search (filter box)
└── KQL databases
    ├── eventhouse1
    │   ├── [queryset_name]_queryset (KQL Queryset)
    │   ├── Tables
    │   │   └── [No tables] / [table list]
    │   ├── Shortcuts
    │   ├── Materialized views
    │   ├── Functions
    │   └── Data streams
    └── [additional KQL databases]
```

**Schema Browser Capabilities:**
- Hierarchical display of database objects
- Expandable/collapsible nodes for tables, views, and functions
- Quick access to database metadata (tables, materialized views, functions, data streams)
- Search functionality to filter schema objects
- Shortcuts for frequently used queries/objects

### Database Status & Metadata

**Visible Information:**
- Database name (eventhouse1)
- Overall health/status indicator
- System overview panel
- Database empty state message with "Get data" button (when no tables present)
- Last access/modification timestamp

## Database Editor Features

### Schema Browser Details

**Tables Section:**
- Display count of tables in the database
- "No tables" message when database is empty
- Expandable table list showing:
  - Table names
  - Column information (schema)
  - Data types

**Advanced Object Types:**
- **Materialized Views** - Pre-computed aggregations for performance
- **Functions** - Custom KQL functions and stored procedures
- **Data Streams** - Streaming data sources and ingestion endpoints
- **Shortcuts** - Frequently used or shared queries/tables

### Query Management

**Queryset Integration:**
- Embedded queryset editor within database context
- Multi-tab query support (named tabs like "Tab", user-defined names)
- Query history and recall functionality
- Share query capability
- Save to Dashboard option
- Export to CSV functionality

**Sample Query Features:**
- Pre-populated template queries with comments
- Links to KQL documentation (https://aka.ms/KQLguide)
- Links to SQL-KQL conversion guide (https://aka.ms/sqlcheatsheet)
- Example patterns:
  - Basic table queries: `YOUR_TABLE_HERE`
  - Limiting results: `| take 100`
  - Counting records: `| count`
  - Aggregations: `| summarize IngestionCountCount = count() by bin(ingestion_time(), 1h)`

## KQL Query Features

### Query Editor

**Editor Capabilities:**
- Line-numbered editor
- Syntax highlighting:
  - Green for comments
  - Blue/Red for KQL keywords (take, count, summarize, etc.)
  - Table and column name recognition
- Real-time validation
- Autocomplete/IntelliSense support

**Query Operations:**
- **Run** - Execute the current query
- **Preview** - Preview results without full execution
- **Recall** - Access previous queries
- **Share query** - Share query with other users
- **Save to Dashboard** - Pin query results to dashboards
- **KQL Tools** - Advanced KQL utilities and helpers
- **Export to CSV** - Export results to CSV format
- **Power BI report** - Create Power BI reports from query results
- **Add alert** - Set up alerts on query results

### Results Grid

**Display Features:**
- Query results in tabular format
- Sorting capabilities (implied by UI)
- Filtering capabilities
- Column type indicators
- Visualization toggle options
- "Run a query and explore the results here" placeholder message when no results

**Results Metadata:**
- Timestamp display (e.g., "2026-05-26 18:16 (UTC)")
- Result count indicators
- Export options

## Data Management

### Data Ingestion

**Ingest Option Access:**
- "Get data" button in database view
- Data ingestion wizards
- OneLake integration for data source connectivity

### Data Management Commands

**Supported KQL Commands (conceptual):**
- `.show` commands - View database/table metadata
- `.alter` commands - Modify database/table properties
- `.drop` commands - Delete database objects
- `.ingest` commands - Programmatic data ingestion
- `.create` commands - Create new database objects

## Advanced Features

### OneLake Integration

**OneLake Features:**
- OneLake toggle button in toolbar
- Integration status indicator
- Data availability visibility
- Cross-workspace data access

### Monitoring & Administration

**Monitoring Panel:**
- System overview section in sidebar
- Monitoring option in sidebar navigation
- Database health indicators
- Usage metrics and diagnostics

### Data Policies

**Policy Management:**
- Data policies toolbar button
- Security policy configuration
- Access control settings
- Retention policy management (implied)
- Update policies for data transformation

## Session Information

**UI State Tracking:**
- Database name display: "eventhouse1"
- Queryset name: "eventhouse1_queryset"
- Empty database state handling
- Tab management for multiple querysets
- Focus mode for distraction-free editing

## Notable Observations

1. **Empty Database Handling** - Database displays helpful "This database is empty" message with "Get data" CTA
2. **Embedded Querysets** - Querysets are accessed as embedded tabs within the database context, not as separate navigation items
3. **Real-Time Experience** - Full integration with Fabric's Real-Time Intelligence workload
4. **Multi-Tab Support** - Multiple queries can be open in separate tabs within a single database view
5. **Template Queries** - Pre-populated query templates provide guidance and examples
6. **Integrated Tooling** - KQL Tools, Power BI integration, and alerts available directly in the editor
7. **OneLake Availability** - OneLake toggle indicates data lake integration for external data sources

## Related Documentation

- KQL Reference: https://aka.ms/KQLguide
- SQL to KQL Conversion: https://aka.ms/sqlcheatsheet
- Real-Time Intelligence Documentation: Microsoft Fabric documentation site
