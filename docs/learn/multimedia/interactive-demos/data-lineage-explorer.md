---
title: "Data Lineage Explorer - Interactive Visualization Demo"
tags:
  - multimedia
  - demos
---
# 🔍 Data Lineage Explorer - Interactive Visualization Demo

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive Demo](https://img.shields.io/badge/Type-Interactive%20Demo-purple)
![Complexity: Intermediate](https://img.shields.io/badge/Complexity-Intermediate-yellow)
![Duration: 25 mins](https://img.shields.io/badge/Duration-25%20mins-blue)

## 📋 Overview

The Data Lineage Explorer is an interactive visualization tool that allows you to trace data flows through your Azure Synapse Analytics environment. This demo provides hands-on experience with understanding data lineage, tracking transformations, and identifying dependencies across your data estate.

## 🎯 Learning Objectives

By completing this interactive demo, you will be able to:

- Visualize end-to-end data lineage across multiple services
- Trace data transformations from source to destination
- Identify upstream and downstream dependencies
- Understand impact analysis for data changes
- Explore column-level lineage and transformations
- Use lineage information for compliance and governance
- Troubleshoot data quality issues using lineage traces

## 🎓 Prerequisites

### Knowledge Requirements

- Basic understanding of ETL/ELT concepts
- Familiarity with Azure Synapse Analytics pipelines
- Understanding of data transformation concepts
- Basic SQL and data modeling knowledge

### Technical Requirements

- Modern web browser (Chrome, Edge, Firefox, Safari)
- Active Azure subscription (for full integration)
- Azure Synapse Analytics workspace (optional)
- Azure Purview account (recommended)
- Stable internet connection

### Recommended Experience

- Experience with data pipeline development
- Understanding of data governance concepts
- Familiarity with metadata management
- Basic knowledge of data quality frameworks

## 🚀 Demo Description

### What This Demo Covers

The Data Lineage Explorer demo provides an interactive environment where you can:

1. **Explore Lineage Graphs**: Navigate interactive visual representations of data flows
2. **Trace Data Paths**: Follow data from source systems through transformations to targets
3. **Analyze Impact**: Understand the impact of changes to datasets or pipelines
4. **Column-Level Tracking**: Drill down to see column-level transformations
5. **Time-Based Views**: View lineage at different points in time
6. **Search and Filter**: Find specific datasets, tables, or columns in complex lineages

### Demo Features

#### Visual Lineage Graph

```html
<!-- Interactive Lineage Visualization Component -->
<div id="lineage-explorer">
  <div class="graph-container">
    <svg id="lineage-graph"></svg>
  </div>
  <div class="control-panel">
    <button class="zoom-in">Zoom In</button>
    <button class="zoom-out">Zoom Out</button>
    <button class="reset-view">Reset View</button>
    <button class="export-lineage">Export</button>
  </div>
</div>
```

#### Node Types

- **Source Systems**: External data sources (databases, files, APIs)
- **Ingestion Pipelines**: Data ingestion processes
- **Transformation Stages**: Data transformation activities
- **Storage Layers**: Data lake zones (bronze, silver, gold)
- **Analytics Tables**: Final consumption tables and views
- **Reports/Dashboards**: Downstream reporting assets

#### Lineage Metadata Display

```json
{
  "node_id": "sales_fact_table",
  "node_type": "table",
  "qualified_name": "synapse.gold.sales_fact",
  "description": "Aggregated sales transactions",
  "owner": "data_engineering_team",
  "upstream_dependencies": [
    "silver.cleaned_sales",
    "silver.customer_dim",
    "silver.product_dim"
  ],
  "downstream_dependencies": [
    "power_bi.sales_dashboard",
    "synapse.monthly_sales_view"
  ],
  "transformation_logic": "GROUP BY customer_id, product_id WITH SUM(amount)",
  "last_modified": "2025-12-10T10:30:00Z",
  "schema_version": "1.2.0"
}
```

## 📝 Step-by-Step Guide

### Phase 1: Basic Lineage Exploration (5 minutes)

#### Step 1: Load Sample Lineage

1. Access the Data Lineage Explorer interface
2. Click **"Load Sample Dataset"** to load pre-configured lineage
3. Observe the initial graph showing data sources, transformations, and targets

**Expected Outcome**: Interactive lineage graph displays with multiple connected nodes

#### Step 2: Navigate the Graph

1. Use mouse drag to pan around the graph
2. Use scroll wheel to zoom in/out
3. Click on individual nodes to see detailed information
4. Hover over edges to see transformation descriptions

**Expected Outcome**: Smooth navigation through complex lineage graphs

#### Step 3: Select a Data Asset

1. Click on the search bar and enter "sales_fact"
2. Select the matching table from the dropdown
3. The graph will center and highlight the selected asset
4. Observe connected upstream and downstream nodes highlighted

**Expected Outcome**: Selected asset and its dependencies are highlighted

### Phase 2: Trace Data Flows (7 minutes)

#### Step 4: Upstream Lineage Analysis

1. Right-click on "sales_fact_table" node
2. Select **"Show Upstream Lineage"**
3. Observe all source systems and transformation stages
4. Click on each upstream node to see transformation logic

**Sample Upstream Path**:

```text
[Source: ERP Database]
    → [Pipeline: Daily_Sales_Extract]
    → [Bronze: raw_sales_data]
    → [Pipeline: Sales_Cleansing]
    → [Silver: cleaned_sales]
    → [Pipeline: Sales_Aggregation]
    → [Gold: sales_fact_table]
```

#### Step 5: Downstream Impact Analysis

1. Right-click on "sales_fact_table" node
2. Select **"Show Downstream Impact"**
3. View all reports, dashboards, and processes that depend on this table
4. Identify critical dependencies marked with warning icons

**Expected Outcome**: Complete view of downstream consumers and their criticality

#### Step 6: Column-Level Lineage

1. Double-click on "sales_fact_table" to expand
2. Select the "total_amount" column
3. Click **"Show Column Lineage"**
4. Trace how this column was derived from source columns

**Column Lineage Example**:

```sql
-- Column: sales_fact.total_amount
-- Derived from:
--   1. raw_sales.amount (Source)
--   2. Transformation: CAST(amount AS DECIMAL(18,2))
--   3. Cleansing: WHERE amount > 0 AND amount < 1000000
--   4. Aggregation: SUM(cleaned_amount) GROUP BY order_id
```

### Phase 3: Advanced Features (8 minutes)

#### Step 7: Time-Based Lineage

1. Open the time slider at the bottom of the screen
2. Move slider to view lineage at different dates
3. Observe how lineage changes over time (schema evolution)
4. Compare current vs. historical lineage

**Use Case**: Understanding when a dependency was added or removed

#### Step 8: Impact Analysis Simulation

1. Select "cleaned_sales" table in the graph
2. Click **"Simulate Impact Analysis"**
3. Choose scenario: "Schema Change - Add Column"
4. View highlighted downstream assets that would be affected

**Impact Report Example**:

```text
Impact Analysis Results:
- Directly Affected: 3 pipelines, 2 tables
- Indirectly Affected: 5 reports, 1 ML model
- Risk Level: MEDIUM
- Estimated Downtime: 2-3 hours
- Recommended Action: Coordinate with BI team
```

#### Step 9: Search and Filter

1. Use the filter panel on the right side
2. Apply filters:
   - Node Type: "Tables only"
   - Owner: "data_engineering_team"
   - Last Modified: "Last 7 days"
3. Graph updates to show only matching nodes
4. Clear filters to return to full view

#### Step 10: Export Lineage

1. Select a subset of nodes (drag to select multiple)
2. Click **"Export Selected Lineage"**
3. Choose export format:
   - JSON (for API integration)
   - PNG (for documentation)
   - CSV (for analysis)
4. Download the exported lineage

### Phase 4: Real-World Scenarios (5 minutes)

#### Step 11: Data Quality Investigation

**Scenario**: Reports show incorrect sales totals

1. Start at the affected report node: "Sales_Summary_Report"
2. Trace upstream to identify data sources
3. Check transformation logic at each stage
4. Identify the pipeline where data quality issue originated
5. View recent changes to that pipeline

**Expected Outcome**: Identify root cause of data quality issue

#### Step 12: Compliance and Governance

1. Click **"Governance View"** toggle
2. Nodes display additional compliance metadata:
   - Data classification (PII, Confidential, Public)
   - Retention policies
   - Access controls
3. Filter to show only "PII" classified data
4. Generate compliance report for audit

**Expected Outcome**: Complete view of sensitive data flows

## 🛠️ Technical Implementation Notes

### Visualization Technology Stack

```javascript
// Core Technologies
const techStack = {
  graphVisualization: "D3.js v7",
  graphLayout: "dagre-d3 (Directed Acyclic Graph)",
  uiFramework: "React 18",
  stateManagement: "Redux Toolkit",
  backend: "Azure Functions (Python)",
  database: "Azure Cosmos DB (Graph API)"
};
```

### Graph Rendering

```javascript
// D3.js-based Lineage Graph Rendering
import * as d3 from 'd3';
import dagreD3 from 'dagre-d3';

class LineageRenderer {
  constructor(containerId) {
    this.svg = d3.select(`#${containerId}`);
    this.graph = new dagreD3.graphlib.Graph()
      .setGraph({})
      .setDefaultEdgeLabel(() => ({}));
  }

  renderLineage(lineageData) {
    // Add nodes
    lineageData.nodes.forEach(node => {
      this.graph.setNode(node.id, {
        label: node.name,
        class: node.type,
        shape: this.getNodeShape(node.type)
      });
    });

    // Add edges
    lineageData.edges.forEach(edge => {
      this.graph.setEdge(edge.source, edge.target, {
        label: edge.transformation,
        curve: d3.curveBasis
      });
    });

    // Render
    const render = new dagreD3.render();
    render(d3.select('svg g'), this.graph);

    // Apply zoom behavior
    this.applyZoomBehavior();
  }

  getNodeShape(nodeType) {
    const shapes = {
      'source': 'cylinder',
      'table': 'rect',
      'pipeline': 'diamond',
      'report': 'ellipse'
    };
    return shapes[nodeType] || 'rect';
  }

  applyZoomBehavior() {
    const zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        this.svg.select('g').attr('transform', event.transform);
      });
    this.svg.call(zoom);
  }
}
```

### Lineage Data Model

```python
# Azure Cosmos DB Graph API Data Model
from dataclasses import dataclass
from typing import List, Optional
from datetime import datetime

@dataclass
class LineageNode:
    """Represents a data asset in the lineage graph"""
    id: str
    name: str
    type: str  # source, table, pipeline, report
    qualified_name: str
    description: Optional[str]
    owner: str
    created_date: datetime
    modified_date: datetime
    metadata: dict

@dataclass
class LineageEdge:
    """Represents a transformation or data flow"""
    source_id: str
    target_id: str
    transformation_type: str  # extract, transform, load
    transformation_logic: str
    created_date: datetime
    metadata: dict

class LineageService:
    """Service for querying and managing lineage"""

    def get_upstream_lineage(self, asset_id: str, depth: int = 5) -> dict:
        """Retrieve upstream lineage for a given asset"""
        query = f"""
        g.V('{asset_id}')
         .repeat(inE().outV())
         .times({depth})
         .path()
         .by(valueMap())
        """
        return self.cosmos_client.execute_gremlin(query)

    def get_downstream_impact(self, asset_id: str) -> dict:
        """Get all downstream assets affected by changes"""
        query = f"""
        g.V('{asset_id}')
         .repeat(outE().inV())
         .emit()
         .path()
         .by(valueMap())
        """
        return self.cosmos_client.execute_gremlin(query)

    def get_column_lineage(self, table_id: str, column_name: str) -> dict:
        """Trace column-level lineage"""
        query = f"""
        g.V('{table_id}')
         .has('column', '{column_name}')
         .repeat(inE('derived_from').outV())
         .emit()
         .path()
        """
        return self.cosmos_client.execute_gremlin(query)
```

### Azure Purview Integration

```python
# Integration with Azure Purview for Lineage Data
from azure.purview.catalog import PurviewCatalogClient
from azure.identity import DefaultAzureCredential

class PurviewLineageConnector:
    """Connect to Azure Purview for lineage metadata"""

    def __init__(self, account_name: str):
        credential = DefaultAzureCredential()
        self.client = PurviewCatalogClient(
            endpoint=f"https://{account_name}.purview.azure.com",
            credential=credential
        )

    def fetch_lineage(self, guid: str, direction: str = "BOTH") -> dict:
        """Fetch lineage from Azure Purview"""
        return self.client.lineage.get(
            guid=guid,
            direction=direction,
            depth=3
        )

    def sync_to_cosmos(self, lineage_data: dict):
        """Sync Purview lineage to Cosmos DB for visualization"""
        # Transform Purview format to graph format
        nodes = self._extract_nodes(lineage_data)
        edges = self._extract_edges(lineage_data)

        # Bulk insert to Cosmos DB
        self._bulk_upsert_nodes(nodes)
        self._bulk_upsert_edges(edges)
```

### Performance Optimization

```javascript
// Optimization Techniques for Large Lineage Graphs
class LineageOptimizer {
  constructor() {
    this.visibleNodes = new Set();
    this.nodeCache = new Map();
  }

  // Lazy loading for large graphs
  lazyLoadLineage(centerNode, radius = 2) {
    const visibleNodes = this.getNodesWithinRadius(centerNode, radius);

    // Only render visible nodes
    this.renderSubgraph(visibleNodes);

    // Preload adjacent nodes in background
    this.preloadAdjacentNodes(visibleNodes);
  }

  // Virtual scrolling for node lists
  virtualizeNodeList(allNodes, viewportSize) {
    const visibleStart = this.getScrollPosition();
    const visibleEnd = visibleStart + viewportSize;

    return allNodes.slice(visibleStart, visibleEnd);
  }

  // Debounce expensive operations
  debouncedSearch = this.debounce((searchTerm) => {
    this.performSearch(searchTerm);
  }, 300);

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}
```

### REST API for Lineage Queries

```python
# FastAPI endpoints for lineage queries
from fastapi import FastAPI, Query, HTTPException
from typing import Optional, List

app = FastAPI()

@app.get("/api/lineage/{asset_id}")
async def get_lineage(
    asset_id: str,
    direction: str = Query("both", regex="^(upstream|downstream|both)$"),
    depth: int = Query(3, ge=1, le=10),
    include_columns: bool = False
):
    """Get lineage for a specific asset"""
    try:
        lineage_service = LineageService()

        if direction == "upstream":
            result = lineage_service.get_upstream_lineage(asset_id, depth)
        elif direction == "downstream":
            result = lineage_service.get_downstream_impact(asset_id)
        else:
            upstream = lineage_service.get_upstream_lineage(asset_id, depth)
            downstream = lineage_service.get_downstream_impact(asset_id)
            result = merge_lineage(upstream, downstream)

        if include_columns:
            result = enrich_with_column_lineage(result)

        return {"status": "success", "data": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/lineage/impact-analysis")
async def analyze_impact(
    asset_id: str,
    change_type: str,
    metadata: Optional[dict] = None
):
    """Perform impact analysis for proposed changes"""
    impact_service = ImpactAnalysisService()

    analysis_result = impact_service.simulate_change(
        asset_id=asset_id,
        change_type=change_type,
        metadata=metadata
    )

    return {
        "affected_assets": analysis_result.affected_count,
        "risk_level": analysis_result.risk_level,
        "recommendations": analysis_result.recommendations,
        "detailed_impact": analysis_result.details
    }
```

## 🎯 Key Takeaways

After completing this demo, you should understand:

1. **Lineage Visualization**: How to navigate and interpret lineage graphs
2. **Dependency Tracking**: Identifying upstream sources and downstream consumers
3. **Impact Analysis**: Understanding the blast radius of data changes
4. **Troubleshooting**: Using lineage to diagnose data quality issues
5. **Governance**: Leveraging lineage for compliance and data governance
6. **Column-Level Detail**: Tracing transformations at the column level

## 🔗 Related Resources

### Documentation

- [Azure Purview Data Lineage](../../02-services/data-governance/azure-purview/lineage.md)
- [Synapse Pipeline Lineage](../../02-services/analytics-compute/azure-synapse/pipelines/lineage-tracking.md)
- [Data Governance Best Practices](../../best-practices-extra/data-governance/README.md)
- [Metadata Management Guide](../../03-architecture-patterns/service-architectures/shared-metadata/shared-metadata.md)

### Tutorials

- Setting Up Azure Purview for Lineage
- Building Lineage-Aware Pipelines
- Data Quality with Lineage

### Code Examples

- [Purview Lineage API Examples](../../06-code-examples/integration/azure-purview.md)
- Custom Lineage Collection
- Lineage Visualization Components

## ❓ FAQ

**Q: Can I connect this demo to my actual Azure environment?**
A: Yes, the demo supports integration with Azure Purview and Synapse Analytics. You'll need to configure authentication and provide your workspace details.

**Q: How far back can I trace lineage?**
A: Lineage history depends on your Azure Purview retention settings. Typically, you can trace back 90 days to several years.

**Q: Does this work with non-Azure data sources?**
A: Yes, Azure Purview supports lineage from various sources including on-premises databases, other cloud platforms, and SaaS applications.

**Q: Can I export lineage for documentation?**
A: Yes, you can export lineage in multiple formats including PNG images, JSON data, and CSV reports.

**Q: How does column-level lineage work?**
A: Column-level lineage tracks individual columns through transformations, showing how source columns map to target columns and what transformations were applied.

## 💬 Feedback

Was this interactive demo helpful? Let us know how we can improve!

- [Report an Issue](https://github.com/csa-inabox-docs/issues/new?title=[Demo]%20Data%20Lineage%20Explorer)
- [Request a Feature](https://github.com/csa-inabox-docs/issues/new?title=[Feature]%20Data%20Lineage%20Explorer)
- [Share Feedback](https://github.com/csa-inabox-docs/discussions)

---

**Next Steps:**
- Try the [Resource Planner Demo](resource-planner.md)
- Explore the [Migration Assessment Wizard](migration-assessment.md)
- Review [Data Governance Diagrams](../../diagrams/data-governance-diagrams.md)

---

*Last Updated: December 2025 | Version: 1.0.0*
