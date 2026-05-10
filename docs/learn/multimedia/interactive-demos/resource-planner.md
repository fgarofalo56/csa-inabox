---
title: "Resource Planner - Interactive Capacity Calculator"
tags:
  - multimedia
  - demos
---
# 📊 Resource Planner - Interactive Capacity Calculator

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive Demo](https://img.shields.io/badge/Type-Interactive%20Demo-purple)
![Complexity: Intermediate](https://img.shields.io/badge/Complexity-Intermediate-yellow)
![Duration: 30 mins](https://img.shields.io/badge/Duration-30%20mins-blue)

## 📋 Overview

The Resource Planner is an interactive calculator that helps you optimize Azure Synapse Analytics resource allocation based on your workload characteristics. This demo provides hands-on experience with capacity planning, performance tuning, and cost optimization for compute and storage resources.

## 🎯 Learning Objectives

By completing this interactive demo, you will be able to:

- Calculate optimal Spark pool sizes for your workloads
- Determine appropriate SQL pool DWU settings
- Estimate storage requirements for Data Lake layers
- Balance performance requirements with cost constraints
- Plan for scalability and growth
- Optimize resource allocation across multiple workloads
- Understand cost implications of different configuration choices

## 🎓 Prerequisites

### Knowledge Requirements

- Basic understanding of cloud computing concepts
- Familiarity with Azure Synapse Analytics components
- Understanding of compute vs. storage trade-offs
- Basic knowledge of workload characteristics (batch, streaming, interactive)

### Technical Requirements

- Modern web browser (Chrome, Edge, Firefox, Safari)
- JavaScript enabled
- Stable internet connection
- Calculator or spreadsheet (optional, for comparisons)

### Recommended Experience

- Experience with Azure resource management
- Understanding of performance metrics (latency, throughput)
- Familiarity with cost optimization strategies
- Basic knowledge of capacity planning concepts

## 🚀 Demo Description

### What This Demo Covers

The Resource Planner demo provides interactive calculators for:

1. **Spark Pool Sizing**: Determine node counts, sizes, and autoscale settings
2. **SQL Pool Configuration**: Calculate DWU requirements and performance tiers
3. **Storage Planning**: Estimate Data Lake storage needs and costs
4. **Cost Optimization**: Compare configuration options and identify savings
5. **Workload Profiling**: Match resources to workload characteristics
6. **Growth Planning**: Project future resource needs based on growth rates

### Demo Features

#### Interactive Input Forms

```html
<!-- Workload Characteristics Input -->
<div class="workload-input-form">
  <h3>Define Your Workload</h3>

  <label>Workload Type:</label>
  <select id="workload-type">
    <option value="batch">Batch Processing</option>
    <option value="streaming">Streaming Analytics</option>
    <option value="interactive">Interactive Queries</option>
    <option value="ml">Machine Learning</option>
    <option value="mixed">Mixed Workload</option>
  </select>

  <label>Data Volume (TB/day):</label>
  <input type="number" id="data-volume" min="0.1" step="0.1" value="1.0">

  <label>Query Complexity:</label>
  <input type="range" id="query-complexity" min="1" max="10" value="5">
  <span id="complexity-label">Medium</span>

  <label>Concurrent Users:</label>
  <input type="number" id="concurrent-users" min="1" value="10">

  <label>SLA Requirements (ms):</label>
  <input type="number" id="sla-requirement" min="100" step="100" value="1000">
</div>
```

#### Real-Time Cost Calculator

```javascript
// Cost calculation engine
class ResourceCostCalculator {
  constructor() {
    this.pricingData = {
      sparkNodeHourly: {
        'Small': 0.30,
        'Medium': 0.60,
        'Large': 1.20,
        'XLarge': 2.40
      },
      sqlDWU: {
        'DW100c': 1.20,
        'DW500c': 6.00,
        'DW1000c': 12.00,
        'DW2000c': 24.00
      },
      storageTB: 0.020  // per GB/month
    };
  }

  calculateMonthlyCost(config) {
    const sparkCost = this.calculateSparkCost(config.spark);
    const sqlCost = this.calculateSQLCost(config.sql);
    const storageCost = this.calculateStorageCost(config.storage);

    return {
      spark: sparkCost,
      sql: sqlCost,
      storage: storageCost,
      total: sparkCost + sqlCost + storageCost
    };
  }

  calculateSparkCost(sparkConfig) {
    const nodePrice = this.pricingData.sparkNodeHourly[sparkConfig.nodeSize];
    const hoursPerMonth = sparkConfig.hoursPerDay * 30;
    return sparkConfig.nodeCount * nodePrice * hoursPerMonth;
  }
}
```

## 📝 Step-by-Step Guide

### Phase 1: Workload Profiling (8 minutes)

#### Step 1: Define Workload Characteristics

1. Open the Resource Planner interface
2. Navigate to **"Workload Profile"** tab
3. Fill in your workload details:
   - **Workload Type**: Select "Batch Processing"
   - **Data Volume**: Enter "5.0 TB/day"
   - **Query Complexity**: Set slider to "7 (High)"
   - **Concurrent Users**: Enter "25"
   - **SLA Requirement**: Enter "2000 ms"

**Expected Outcome**: System displays workload classification and resource recommendations

#### Step 2: Review Workload Analysis

```text
Workload Analysis Results:
==========================
Classification: High-Volume Batch Processing
Recommended Architecture: Spark-based with Delta Lake
Peak Resource Needs: 8-10 hours daily
Optimization Strategy: Auto-scaling with scheduled start/stop

Key Metrics:
- Daily Processing Window: 8 hours
- Peak Throughput Required: 640 MB/s
- Average Query Time: 45 seconds
- Data Retention: 90 days
```

**Action**: Note the recommended architecture pattern

#### Step 3: Set Business Constraints

1. Click **"Business Constraints"** section
2. Configure constraints:
   - **Monthly Budget**: $5,000
   - **Performance Priority**: High (slider at 80%)
   - **Cost Priority**: Medium (slider at 50%)
   - **Uptime Requirements**: 99.5%
3. Click **"Apply Constraints"**

**Expected Outcome**: Calculator adjusts recommendations to fit constraints

### Phase 2: Spark Pool Optimization (10 minutes)

#### Step 4: Calculate Spark Pool Requirements

1. Navigate to **"Spark Pool Calculator"** tab
2. Input your processing requirements:
   - **Data to Process**: 5 TB/day
   - **Processing Window**: 8 hours
   - **Parallelism Needed**: High
3. Click **"Calculate Optimal Configuration"**

**Calculation Results**:

```text
Recommended Spark Pool Configuration:
=====================================
Node Size: Large (16 vCPU, 128 GB RAM)
Min Nodes: 2
Max Nodes: 10
Autoscale: Enabled
Auto-pause: 15 minutes

Performance Metrics:
- Estimated Processing Time: 6.5 hours
- Throughput: 800 MB/s
- Cores Available: 160 (at max scale)
- Memory Available: 1.28 TB (at max scale)

Cost Estimate:
- Average Nodes Used: 6.5
- Active Hours/Day: 8
- Monthly Cost: $3,744
```

#### Step 5: Compare Configuration Options

1. Click **"Compare Configurations"** button
2. Review side-by-side comparison of 3 options:

| Metric | Budget | Balanced | Performance |
|--------|--------|----------|-------------|
| **Node Size** | Medium | Large | XLarge |
| **Max Nodes** | 6 | 10 | 12 |
| **Processing Time** | 9.5 hrs | 6.5 hrs | 4.2 hrs |
| **Monthly Cost** | $2,160 | $3,744 | $6,912 |
| **Reliability** | 95% | 98% | 99.5% |

3. Select **"Balanced"** configuration
4. Click **"Save Configuration"**

#### Step 6: Configure Auto-Scaling Rules

1. Open **"Auto-Scaling Settings"** panel
2. Configure scaling triggers:
   ```yaml
   scaling_rules:
     scale_up:
       - metric: executor_cpu_utilization
         threshold: 80
         action: add_2_nodes
         cooldown: 5_minutes

     scale_down:
       - metric: executor_cpu_utilization
         threshold: 30
         action: remove_1_node
         cooldown: 10_minutes

     scheduled_scaling:
       - schedule: "0 6 * * *"  # 6 AM daily
         action: set_min_nodes_8
       - schedule: "0 15 * * *"  # 3 PM daily
         action: set_min_nodes_2
   ```

3. Click **"Apply Scaling Rules"**

**Expected Outcome**: Estimated cost reduces by 15-20% with smart auto-scaling

### Phase 3: SQL Pool Configuration (7 minutes)

#### Step 7: Calculate SQL Pool DWU

1. Navigate to **"SQL Pool Calculator"** tab
2. Define query workload:
   - **Query Type**: Mixed (70% simple, 30% complex)
   - **Concurrent Queries**: 15
   - **Average Query Time Target**: 3 seconds
   - **Data Size**: 2 TB
3. Click **"Recommend DWU Level"**

**Recommendation Output**:

```text
SQL Pool Configuration Recommendation:
======================================
Service Level: DW1000c
DWU: 1000
Max Concurrent Queries: 32
Memory per Query: 1 GB

Performance Projections:
- Simple Query Avg Time: 0.8 seconds
- Complex Query Avg Time: 12 seconds
- Mixed Workload Avg Time: 3.4 seconds
- 95th Percentile: 18 seconds

Monthly Cost: $8,640
```

#### Step 8: Optimize for Cost

1. Click **"Cost Optimization"** button
2. Review optimization suggestions:
   - **Pause during off-hours**: Save 45% ($3,888/month)
   - **Use lower DWU for dev/test**: Save 15% ($1,296/month)
   - **Implement result caching**: Improve performance 20%
3. Select optimization options
4. View updated cost: $5,752/month (33% savings)

### Phase 4: Storage Planning (5 minutes)

#### Step 9: Calculate Storage Requirements

1. Navigate to **"Storage Calculator"** tab
2. Input data characteristics:
   - **Daily Ingestion**: 5 TB
   - **Retention Period**: 90 days
   - **Compression Ratio**: 3:1 (Delta Lake)
   - **Data Lake Zones**: Bronze, Silver, Gold
   - **Redundancy**: LRS (Locally Redundant)

**Storage Calculation**:

```text
Data Lake Storage Estimation:
==============================

Bronze Layer (Raw Data):
- Daily: 5 TB
- 90-day retention: 450 TB
- Format: Parquet (compressed)
- Actual Storage: 150 TB

Silver Layer (Cleansed):
- Daily: 4 TB (20% reduction)
- 180-day retention: 720 TB
- Format: Delta Lake
- Actual Storage: 240 TB

Gold Layer (Curated):
- Daily: 1.5 TB (70% aggregation)
- 365-day retention: 547.5 TB
- Format: Delta Lake
- Actual Storage: 182.5 TB

Total Storage Required: 572.5 TB

Monthly Cost Breakdown:
- Bronze: $3,072
- Silver: $4,915
- Gold: $3,736
- Total: $11,723/month
```

#### Step 10: Optimize Storage Costs

1. Click **"Storage Optimization Wizard"**
2. Review optimization recommendations:
   - **Tier bronze data to Cool after 30 days**: Save 25%
   - **Archive silver data after 120 days**: Save 15%
   - **Enable data lifecycle policies**: Save 10%
3. Apply optimizations
4. New monthly cost: $7,969 (32% savings)

### Phase 5: Complete Resource Plan (10 minutes)

#### Step 11: Generate Full Resource Plan

1. Navigate to **"Summary"** tab
2. Review consolidated resource plan:

```text
Azure Synapse Analytics Resource Plan
======================================

Compute Resources:
------------------
Spark Pools:
  - Pool Name: primary-pool
  - Node Size: Large
  - Nodes: 2-10 (autoscale)
  - Monthly Cost: $3,744

SQL Pools:
  - Pool Name: dwh-pool
  - DWU Level: DW1000c
  - Pause Schedule: Off-hours
  - Monthly Cost: $5,752

Storage Resources:
------------------
Data Lake Storage:
  - Total Capacity: 572.5 TB
  - Tiering: Enabled
  - Lifecycle Policies: Active
  - Monthly Cost: $7,969

Total Monthly Cost: $17,465
Annual Cost: $209,580

Cost vs. Budget:
  Budget: $5,000/month ⚠️ OVER BUDGET
  Actual: $17,465/month
  Variance: +249%

Recommendations:
1. Consider phased implementation
2. Review data retention policies
3. Optimize query patterns to reduce DWU needs
4. Implement more aggressive auto-scaling
```

#### Step 12: Scenario Planning

1. Click **"Scenario Analysis"** button
2. Compare multiple scenarios:

**Scenario 1: Aggressive Cost Optimization**
- Reduce Spark pool max nodes to 6
- Lower SQL DWU to DW500c
- Reduce retention to 60 days
- **Monthly Cost**: $8,950 (within budget)
- **Trade-off**: 30% longer processing times

**Scenario 2: Performance Optimized**
- Increase Spark pool max nodes to 15
- Raise SQL DWU to DW2000c
- Full retention policies
- **Monthly Cost**: $24,600
- **Trade-off**: 40% faster, higher reliability

**Scenario 3: Balanced Approach**
- Current configuration with optimizations
- Scheduled scaling
- Smart tiering
- **Monthly Cost**: $14,200
- **Trade-off**: Good performance, manageable cost

3. Select **"Scenario 3: Balanced"**
4. Click **"Export Resource Plan"**

#### Step 13: Generate Cost Forecast

1. Navigate to **"Cost Forecast"** section
2. Input growth parameters:
   - **Data Growth Rate**: 15% per quarter
   - **User Growth**: 10% per quarter
   - **New Workloads**: 2 per year
3. Click **"Generate 12-Month Forecast"**

**Forecast Output**:

```text
12-Month Cost Forecast:
=======================

Q1 2025: $14,200/month
Q2 2025: $16,330/month (+15%)
Q3 2025: $18,780/month (+15%)
Q4 2025: $21,597/month (+15%)

Year-End Projection:
- Total Year 1 Cost: $212,620
- Average Monthly: $17,718

Growth Drivers:
1. Data volume increase (60% of growth)
2. Additional workloads (25% of growth)
3. User expansion (15% of growth)

Optimization Opportunities:
- Committed use discounts: Save 15%
- Reserved capacity: Save 20%
- Enterprise agreement: Save 10%

Potential Savings: $42,524/year
```

## 🛠️ Technical Implementation Notes

### Calculation Engine

```python
# Python-based Resource Calculator
from dataclasses import dataclass
from typing import List, Dict
import math

@dataclass
class WorkloadProfile:
    """Workload characteristics for resource planning"""
    data_volume_tb: float
    processing_window_hours: int
    query_complexity: int  # 1-10 scale
    concurrent_users: int
    sla_ms: int
    workload_type: str

class SparkPoolCalculator:
    """Calculate optimal Spark pool configuration"""

    def __init__(self):
        self.node_specs = {
            'Small': {'vcpu': 4, 'memory_gb': 32, 'cost_per_hour': 0.30},
            'Medium': {'vcpu': 8, 'memory_gb': 64, 'cost_per_hour': 0.60},
            'Large': {'vcpu': 16, 'memory_gb': 128, 'cost_per_hour': 1.20},
            'XLarge': {'vcpu': 32, 'memory_gb': 256, 'cost_per_hour': 2.40}
        }

    def calculate_node_requirements(self, workload: WorkloadProfile) -> Dict:
        """Calculate required nodes based on workload"""

        # Calculate data processing requirements
        throughput_required_mb_s = (workload.data_volume_tb * 1024) / (workload.processing_window_hours * 3600)

        # Determine node size based on query complexity
        if workload.query_complexity <= 3:
            node_size = 'Small'
        elif workload.query_complexity <= 6:
            node_size = 'Medium'
        elif workload.query_complexity <= 8:
            node_size = 'Large'
        else:
            node_size = 'XLarge'

        node_spec = self.node_specs[node_size]

        # Calculate number of nodes
        # Assume each node can process ~100 MB/s for medium complexity
        processing_capacity_per_node = 100 * (10 / workload.query_complexity)
        min_nodes = math.ceil(throughput_required_mb_s / processing_capacity_per_node)
        max_nodes = min_nodes * 3  # Allow 3x scaling

        # Ensure minimum of 2 nodes for reliability
        min_nodes = max(2, min_nodes)

        return {
            'node_size': node_size,
            'min_nodes': min_nodes,
            'max_nodes': max_nodes,
            'vcpu_per_node': node_spec['vcpu'],
            'memory_per_node_gb': node_spec['memory_gb'],
            'cost_per_hour': node_spec['cost_per_hour'],
            'estimated_processing_time_hours': self._estimate_processing_time(
                workload, min_nodes, node_size
            )
        }

    def _estimate_processing_time(self, workload: WorkloadProfile,
                                   nodes: int, node_size: str) -> float:
        """Estimate job processing time"""
        node_throughput = self.node_specs[node_size]['vcpu'] * 25  # MB/s per node
        total_throughput = node_throughput * nodes

        data_to_process_mb = workload.data_volume_tb * 1024 * 1024
        processing_time_hours = data_to_process_mb / (total_throughput * 3600)

        # Add overhead for complexity
        complexity_factor = 1 + (workload.query_complexity / 10)

        return processing_time_hours * complexity_factor

class SQLPoolCalculator:
    """Calculate optimal SQL Pool DWU"""

    def __init__(self):
        self.dwu_levels = {
            'DW100c': {'dw': 100, 'memory_gb': 60, 'cost_per_hour': 1.20},
            'DW500c': {'dw': 500, 'memory_gb': 300, 'cost_per_hour': 6.00},
            'DW1000c': {'dw': 1000, 'memory_gb': 600, 'cost_per_hour': 12.00},
            'DW2000c': {'dw': 2000, 'memory_gb': 1200, 'cost_per_hour': 24.00},
        }

    def recommend_dwu(self, workload: WorkloadProfile) -> Dict:
        """Recommend DWU level based on workload"""

        # Calculate required concurrency slots
        required_slots = workload.concurrent_users * 1.2  # 20% buffer

        # Calculate memory requirements (rough estimate)
        data_size_gb = workload.data_volume_tb * 1024
        memory_needed = (data_size_gb * 0.1) + (required_slots * 1)  # GB

        # Find appropriate DWU level
        for level, specs in sorted(self.dwu_levels.items(),
                                   key=lambda x: x[1]['dw']):
            if specs['memory_gb'] >= memory_needed:
                return {
                    'level': level,
                    'dwu': specs['dw'],
                    'memory_gb': specs['memory_gb'],
                    'max_concurrent_queries': specs['dw'] // 100 * 4,
                    'cost_per_hour': specs['cost_per_hour'],
                    'monthly_cost_24x7': specs['cost_per_hour'] * 730
                }

        # Default to highest if nothing fits
        return self._format_recommendation('DW2000c')
```

### Cost Optimization Algorithms

```python
class CostOptimizer:
    """Optimize resource configuration for cost"""

    def optimize_spark_pool(self, config: Dict, constraints: Dict) -> Dict:
        """Optimize Spark pool configuration"""

        optimizations = []

        # Auto-pause optimization
        if config['active_hours_per_day'] < 24:
            savings = self._calculate_pause_savings(config)
            optimizations.append({
                'strategy': 'Auto-pause during idle time',
                'savings_percent': savings['percent'],
                'savings_monthly': savings['amount']
            })

        # Right-sizing optimization
        utilization = config.get('average_utilization', 0.5)
        if utilization < 0.5:
            savings = self._calculate_rightsizing_savings(config, utilization)
            optimizations.append({
                'strategy': 'Right-size nodes based on utilization',
                'savings_percent': savings['percent'],
                'savings_monthly': savings['amount']
            })

        # Scheduled scaling optimization
        if self._has_predictable_pattern(config):
            savings = self._calculate_scheduled_scaling_savings(config)
            optimizations.append({
                'strategy': 'Implement scheduled auto-scaling',
                'savings_percent': savings['percent'],
                'savings_monthly': savings['amount']
            })

        return {
            'original_cost': config['monthly_cost'],
            'optimizations': optimizations,
            'optimized_cost': self._apply_optimizations(config, optimizations),
            'total_savings': sum(o['savings_monthly'] for o in optimizations)
        }
```

### Forecasting Model

```python
class ResourceForecaster:
    """Forecast future resource needs and costs"""

    def forecast_growth(self, current_config: Dict,
                       growth_params: Dict,
                       months: int = 12) -> List[Dict]:
        """Generate resource and cost forecast"""

        forecasts = []
        config = current_config.copy()

        for month in range(1, months + 1):
            # Apply growth factors
            config['data_volume_tb'] *= (1 + growth_params['data_growth_rate'])
            config['concurrent_users'] *= (1 + growth_params['user_growth_rate'])

            # Recalculate resources
            spark_config = self.spark_calculator.calculate_node_requirements(config)
            sql_config = self.sql_calculator.recommend_dwu(config)
            storage_config = self.storage_calculator.estimate_capacity(config)

            # Calculate costs
            total_cost = (
                spark_config['monthly_cost'] +
                sql_config['monthly_cost_24x7'] +
                storage_config['monthly_cost']
            )

            forecasts.append({
                'month': month,
                'data_volume_tb': config['data_volume_tb'],
                'concurrent_users': config['concurrent_users'],
                'spark_cost': spark_config['monthly_cost'],
                'sql_cost': sql_config['monthly_cost_24x7'],
                'storage_cost': storage_config['monthly_cost'],
                'total_cost': total_cost,
                'config_changes': self._detect_config_changes(config, spark_config, sql_config)
            })

        return forecasts
```

### Interactive UI Components

```javascript
// React component for Resource Planner
import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';

const ResourcePlanner = () => {
  const [workload, setWorkload] = useState({
    dataVolumeTB: 5.0,
    processingWindowHours: 8,
    queryComplexity: 5,
    concurrentUsers: 25,
    slaMs: 2000
  });

  const [recommendation, setRecommendation] = useState(null);
  const [forecast, setForecast] = useState([]);

  useEffect(() => {
    // Fetch recommendations when workload changes
    fetchRecommendations();
  }, [workload]);

  const fetchRecommendations = async () => {
    const response = await fetch('/api/resource-planner/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workload)
    });
    const data = await response.json();
    setRecommendation(data);
  };

  const generateForecast = async (growthParams) => {
    const response = await fetch('/api/resource-planner/forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workload, growthParams, months: 12 })
    });
    const data = await response.json();
    setForecast(data);
  };

  return (
    <div className="resource-planner">
      <WorkloadForm workload={workload} onChange={setWorkload} />
      <RecommendationPanel recommendation={recommendation} />
      <CostForecastChart data={forecast} />
      <OptimizationSuggestions config={recommendation} />
    </div>
  );
};
```

## 🎯 Key Takeaways

After completing this demo, you should understand:

1. **Capacity Planning**: How to calculate resource requirements for different workloads
2. **Cost Optimization**: Techniques to reduce costs while maintaining performance
3. **Trade-offs**: Balance between performance, reliability, and cost
4. **Scaling Strategies**: When to use auto-scaling vs. manual scaling
5. **Storage Management**: Optimize storage costs with tiering and lifecycle policies
6. **Forecasting**: Project future needs and budget accordingly

## 🔗 Related Resources

### Documentation

- [Cost Optimization Best Practices](../../best-practices-extra/cost-optimization/README.md)
- [Performance Optimization Guide](../../05-best-practices/cross-cutting-concerns/performance/performance-optimization.md)
- [Spark Pool Configuration](../../02-services/analytics-compute/azure-synapse/spark-pools/configuration.md)
- [SQL Pool Sizing Guide](../../02-services/analytics-compute/azure-synapse/dedicated-sql/sizing.md)

### Tutorials

- Right-Sizing Resources Tutorial
- Auto-Scaling Configuration
- Cost Monitoring Setup

### Tools

- [Cost Calculator Demo](cost-calculator.md)
- [Performance Monitoring Dashboard](monitoring-dashboard-builder.md)
- [Architecture Explorer](architecture-explorer.md)

## ❓ FAQ

**Q: How accurate are the cost estimates?**
A: Cost estimates are based on current Azure pricing and typical usage patterns. Actual costs may vary based on your specific usage, region, and enterprise agreements.

**Q: Can I import my current resource configuration?**
A: Yes, the tool supports importing configurations from Azure Resource Manager (ARM) templates or directly from your Azure subscription.

**Q: Does this account for reserved capacity discounts?**
A: The calculator can factor in reserved capacity discounts when you enable that option in the pricing settings.

**Q: How often should I review my resource plan?**
A: Review your resource plan quarterly or whenever there are significant changes in workload characteristics or business requirements.

## 💬 Feedback

Help us improve this resource planner!

- [Report an Issue](https://github.com/csa-inabox-docs/issues/new?title=[Demo]%20Resource%20Planner)
- [Request a Feature](https://github.com/csa-inabox-docs/issues/new?title=[Feature]%20Resource%20Planner)
- [Share Feedback](https://github.com/csa-inabox-docs/discussions)

---

**Next Steps:**
- Try the [Cost Calculator](cost-calculator.md)
- Explore the [Migration Assessment Wizard](migration-assessment.md)
- Review [Performance Optimization Guide](../../05-best-practices/cross-cutting-concerns/performance/performance-optimization.md)

---

*Last Updated: December 2025 | Version: 1.0.0*
