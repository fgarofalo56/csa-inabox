# KQL Queryset Editor - Real-Time Intelligence (Fiab Console Parity Spec)

Document Date: 2026-05-26
Experience: Microsoft Fabric - Real-Time Intelligence (Kusto Query Language)
Item Type: KQL Queryset (Embedded in KQL Database)

## Overview

The KQL Queryset editor is a specialized query development and execution environment within Microsoft Fabric's Real-Time Intelligence experience. Querysets provide an interactive workspace for writing, testing, and managing KQL queries within a specific database context.

## Architecture & Access

Querysets appear in the left sidebar under the parent database. They are accessed via embedded navigation within the database view.

URL pattern: /databases/{dbId}/embeddedQueryset/{querysetName}

## UI Components

### Navigation Tabs

Top Tab Navigation (Database Context):
- Eventhouse - Eventhouse/container-level view
- Database - Database administration and metadata
- Queryset - Current queryset editor (active tab highlighted)

Query Tabs (within Queryset):
- Unnamed tabs default to "Tab" label
- Edit icon for renaming tabs
- "+" button to add new query tabs
- Each tab maintains independent query state

### Toolbar & Actions

Query Operations:
- Run - Execute the current KQL query
- Preview - Preview query results with sampling
- Recall - Access query history for the current session
- Share query - Share current query with other users
- Save to Dashboard - Add query results to dashboards
- KQL Tools - Access advanced KQL utilities and helpers
- Export to CSV - Export query results to CSV format
- Power BI report - Create Power BI reports from query results
- Add alert - Configure alerts based on query results

### Query Editor

Editor Features:
- Line numbering for reference
- Syntax highlighting (green comments, blue keywords, red operators)
- Multi-line query support
- Pipe operator support (|)
- Full KQL language support

Pre-populated Template:
- Comments with documentation links
- KQL reference guide link
- SQL to KQL conversion guide link
- Example queries: take, count, summarize with bin()
- TABLE_NAME placeholders for customization

### Results Display Area

Results Pane:
- Tabular results layout below query editor
- Empty state message: "Run a query and explore the results here"
- Magnifying glass icon for search functionality
- Results refresh timestamp display

Results Features:
- Column sorting
- Column filtering
- Column type indicators
- Data visualization toggle options
- Result count display
- Pagination support for large result sets

### Left Sidebar - Database Context

Database Navigation includes:
- Copilot button
- System overview
- Databases section
- Monitoring
- Search box for filtering
- KQL databases with parent database name
- Parent database schema objects

## Query Development Features

### Multi-Query Support

Tab Management:
- Create new query tabs with "+" button
- Rename tabs using edit icon
- Close tabs (implied)
- Switch between tabs without losing state
- Independent execution for each tab
- Shared database context across all tabs

### Query Execution Workflow

1. Edit - Write or modify KQL query in editor
2. Run - Execute query against database
3. Preview - Quick sampling of results
4. Review - Examine results in tabular format
5. Export/Share - Distribute results or create visualizations

### Query History & Recall

History Features:
- Recall button - Access previously executed queries
- Session-based history
- Quick recovery of earlier query versions
- Useful for iterative development

### Code Completion

Editor Assistance:
- KQL keyword autocomplete
- Table name suggestions
- Column name suggestions
- Operator hints
- Function references

## KQL Language Support

### Supported KQL Operations

Query Operations:
- take N - Limit results to N records
- count - Count total records
- summarize - Aggregate data with grouping
- bin() - Histogram binning for time-series
- where - Filter records
- project - Select and rename columns
- join - Combine multiple tables
- union - Append result sets
- sort / order by - Sort results
- extend - Add calculated columns

Data Support:
- Fully typed result sets
- Type information displayed in results

### Documentation Integration

Built-in References:
- KQL Reference Guide: https://aka.ms/KQLguide
- SQL-to-KQL Conversion Guide: https://aka.ms/sqlcheatsheet
- Examples in template queries demonstrate common patterns

## Advanced Features

### Power BI Integration

Power BI Report Creation:
- Direct report generation from query results
- Visualization of KQL query data
- Embedded analytics capability

### Alerts & Monitoring

Alert Features:
- Add alert button for creating data alerts
- Monitor query results for changes
- Notification configuration
- Threshold-based alerting

### Dashboard Integration

Save to Dashboard:
- Pin query results to dashboards
- Create custom visualizations
- Embed real-time KQL data in dashboards
- Dashboard management integration

### CSV Export

Export Capabilities:
- Export full result sets to CSV
- Format: CSV (comma-separated values)
- Download integration
- Compatible with Excel and other tools

### Query Sharing

Collaboration Features:
- Share query with other users
- Share links with permission controls
- Share saved dashboard pins
- Implicit collaboration within same workspace

## Session Management

Current Session Details:
- Database: eventhouse1
- Queryset: eventhouse1_queryset
- Tab count: Multiple tabs supported
- Timestamp: "2026-05-26 18:16 (UTC)"

### Editing Features

- Distraction-free query editing
- Full-screen query editor (implied)
- Collapsible sidebar (implied)
- Dedicated results pane

## Related Sidebar Features

### Copilot Integration

- Copilot button visible in sidebar
- AI-assisted query writing (likely)
- Query optimization suggestions (inferred)

### Schema Object Access While Editing

- Tables list visible in sidebar
- Materialized views reference
- Functions library access
- Data streams configuration
- Shortcuts for commonly used objects

## Performance & Optimization

Query Execution:
- Run vs Preview distinction (Preview = sampling)
- Result timestamp tracking
- Session-based caching (inferred)
- Query optimization via KQL Tools

## Notable Design Patterns

1. Embedded Model - Querysets are embedded tabs in database view
2. Template Guidance - Pre-populated template provides clear structure
3. Integrated Tools - All query tools in single toolbar
4. Multi-Tab Workspace - Multiple independent queries in single queryset
5. Context Preservation - Database and schema remain visible while editing
6. Documentation Links - In-template links to KQL guides
7. Real-Time Execution - Immediate query execution with timestamp tracking

## Key Differences from Traditional SQL

KQL-Specific Features:
- Pipe-based syntax (|) for chaining operations
- bin() for time-series histogram operations
- summarize with by grouping syntax
- take for result limiting
- Native support for dynamic data types
- Optimized for time-series and log analytics

## Related Documentation

- KQL Reference: https://aka.ms/KQLguide
- SQL to KQL Conversion: https://aka.ms/sqlcheatsheet
- Eventhouse & Real-Time Intelligence: Microsoft Fabric documentation
- Power BI Integration: Fabric Power BI connector documentation
