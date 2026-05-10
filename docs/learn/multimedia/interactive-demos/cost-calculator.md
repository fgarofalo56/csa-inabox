---
title: "Interactive Cost Calculator"
tags:
  - multimedia
  - demos
---
# 💰 Interactive Cost Calculator

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Beginner](https://img.shields.io/badge/Difficulty-Beginner-green)

## 📋 Overview

Interactive cost estimation tool for Azure Synapse Analytics workloads. Calculate monthly costs based on your usage patterns, compare pricing tiers, and optimize spending with real-time recommendations.

**Duration:** 15-20 minutes
**Format:** Interactive calculator with real-time updates
**Prerequisites:** Basic understanding of Azure Synapse components

## 🎯 Learning Objectives

- Estimate monthly costs for Synapse workloads
- Compare serverless vs dedicated SQL pool pricing
- Understand Spark pool cost factors
- Optimize resource allocation for cost efficiency
- Generate detailed cost breakdown reports
- Plan budgets and capacity

## 🚀 Prerequisites and Setup

### Calculator Components

```javascript
const costComponents = {
  serverlessSQL: {
    dataProcessed: 0, // TB per month
    pricePerTB: 5.00,
    minimumCharge: 10.00
  },
  dedicatedSQL: {
    dwuLevel: 'DW100c',
    hoursPerMonth: 730,
    pricing: {
      'DW100c': 1.20,
      'DW500c': 6.00,
      'DW1000c': 12.00,
      'DW2000c': 24.00
    }
  },
  sparkPool: {
    nodeSize: 'Small',
    nodeCount: 5,
    hoursPerMonth: 160,
    pricing: {
      'Small': 0.20,
      'Medium': 0.40,
      'Large': 0.80
    }
  },
  storage: {
    dataLake: 0, // GB
    pricePerGB: 0.021
  }
};
```

## 🎮 Interactive Calculator Interface

### HTML Implementation

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Azure Synapse Cost Calculator</title>
  <style>
    .calculator-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .cost-section {
      background: #f5f5f5;
      padding: 20px;
      margin: 15px 0;
      border-radius: 8px;
    }
    .input-group {
      margin: 15px 0;
    }
    .cost-result {
      font-size: 2em;
      color: #0078D4;
      font-weight: bold;
    }
    .slider-container {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    .recommendation {
      background: #fff3cd;
      padding: 10px;
      margin: 10px 0;
      border-left: 4px solid #ffc107;
    }
  </style>
</head>
<body>
  <div class="calculator-container">
    <h1>💰 Azure Synapse Cost Calculator</h1>

    <!-- Serverless SQL Pool -->
    <div class="cost-section">
      <h2>Serverless SQL Pool</h2>
      <div class="input-group">
        <label>Data Processed (TB/month):</label>
        <div class="slider-container">
          <input type="range" id="serverless-data" min="0" max="100" value="10" step="1">
          <span id="serverless-value">10 TB</span>
        </div>
      </div>
      <div class="cost-result">
        Monthly Cost: $<span id="serverless-cost">50.00</span>
      </div>
    </div>

    <!-- Dedicated SQL Pool -->
    <div class="cost-section">
      <h2>Dedicated SQL Pool</h2>
      <div class="input-group">
        <label>DWU Level:</label>
        <select id="dwu-level">
          <option value="100">DW100c - $1.20/hour</option>
          <option value="500">DW500c - $6.00/hour</option>
          <option value="1000">DW1000c - $12.00/hour</option>
          <option value="2000">DW2000c - $24.00/hour</option>
        </select>
      </div>
      <div class="input-group">
        <label>Hours Running per Month:</label>
        <input type="number" id="dedicated-hours" value="730" min="0" max="730">
      </div>
      <div class="cost-result">
        Monthly Cost: $<span id="dedicated-cost">876.00</span>
      </div>
    </div>

    <!-- Spark Pool -->
    <div class="cost-section">
      <h2>Spark Pool</h2>
      <div class="input-group">
        <label>Node Size:</label>
        <select id="spark-size">
          <option value="small">Small (4 vCores) - $0.20/hour</option>
          <option value="medium">Medium (8 vCores) - $0.40/hour</option>
          <option value="large">Large (16 vCores) - $0.80/hour</option>
        </select>
      </div>
      <div class="input-group">
        <label>Node Count:</label>
        <div class="slider-container">
          <input type="range" id="spark-nodes" min="3" max="50" value="5">
          <span id="spark-nodes-value">5 nodes</span>
        </div>
      </div>
      <div class="input-group">
        <label>Hours Running per Month:</label>
        <input type="number" id="spark-hours" value="160" min="0" max="730">
      </div>
      <div class="cost-result">
        Monthly Cost: $<span id="spark-cost">160.00</span>
      </div>
    </div>

    <!-- Total Cost -->
    <div class="cost-section" style="background: #e3f2fd;">
      <h2>Total Estimated Cost</h2>
      <div class="cost-result" style="font-size: 3em;">
        $<span id="total-cost">1,086.00</span>/month
      </div>
    </div>

    <!-- Recommendations -->
    <div id="recommendations">
      <!-- Dynamic recommendations will appear here -->
    </div>
  </div>

  <script src="cost-calculator.js"></script>
</body>
</html>
```

### JavaScript Calculator Logic

```javascript
// Cost Calculator Implementation
class SynapseCostCalculator {
  constructor() {
    this.pricing = {
      serverless: 5.00, // per TB
      dedicated: {
        'DW100c': 1.20,
        'DW500c': 6.00,
        'DW1000c': 12.00,
        'DW2000c': 24.00
      },
      spark: {
        'small': 0.20,
        'medium': 0.40,
        'large': 0.80
      }
    };
    this.initializeEventListeners();
  }

  calculateServerlessCost(dataProcessedTB) {
    const baseCost = dataProcessedTB * this.pricing.serverless;
    return Math.max(baseCost, 10.00); // $10 minimum
  }

  calculateDedicatedCost(dwuLevel, hours) {
    const hourlyRate = this.pricing.dedicated[dwuLevel];
    return hourlyRate * hours;
  }

  calculateSparkCost(nodeSize, nodeCount, hours) {
    const nodeRate = this.pricing.spark[nodeSize];
    return nodeRate * nodeCount * hours;
  }

  getRecommendations(costs) {
    const recommendations = [];

    // Dedicated SQL Pool recommendations
    if (costs.dedicated > 5000) {
      recommendations.push({
        type: 'cost-saving',
        title: 'High Dedicated SQL Pool Cost',
        message: 'Consider pausing the pool during non-business hours',
        savings: (costs.dedicated * 0.67).toFixed(2)
      });
    }

    // Serverless vs Dedicated comparison
    const serverlessEquivalent = costs.dedicated / this.pricing.serverless;
    if (serverlessEquivalent < 10) {
      recommendations.push({
        type: 'cost-saving',
        title: 'Consider Serverless SQL Pool',
        message: `Your workload processes less than ${serverlessEquivalent.toFixed(1)} TB/month. Serverless might be more cost-effective.`,
        savings: (costs.dedicated - costs.serverless).toFixed(2)
      });
    }

    // Spark Pool recommendations
    if (costs.spark > 2000) {
      recommendations.push({
        type: 'optimization',
        title: 'Optimize Spark Pool Usage',
        message: 'Enable auto-pause and optimize job execution time',
        savings: (costs.spark * 0.30).toFixed(2)
      });
    }

    return recommendations;
  }

  initializeEventListeners() {
    // Update calculations on input change
    document.getElementById('serverless-data').addEventListener('input', (e) => {
      this.updateServerlessCost(e.target.value);
    });

    document.getElementById('dwu-level').addEventListener('change', () => {
      this.updateDedicatedCost();
    });

    document.getElementById('dedicated-hours').addEventListener('input', () => {
      this.updateDedicatedCost();
    });

    document.getElementById('spark-size').addEventListener('change', () => {
      this.updateSparkCost();
    });

    document.getElementById('spark-nodes').addEventListener('input', () => {
      this.updateSparkCost();
    });

    document.getElementById('spark-hours').addEventListener('input', () => {
      this.updateSparkCost();
    });
  }

  updateTotalCost() {
    const serverless = parseFloat(document.getElementById('serverless-cost').textContent);
    const dedicated = parseFloat(document.getElementById('dedicated-cost').textContent);
    const spark = parseFloat(document.getElementById('spark-cost').textContent);

    const total = serverless + dedicated + spark;
    document.getElementById('total-cost').textContent = total.toFixed(2);

    this.displayRecommendations({
      serverless,
      dedicated,
      spark,
      total
    });
  }

  displayRecommendations(costs) {
    const recommendations = this.getRecommendations(costs);
    const container = document.getElementById('recommendations');

    container.innerHTML = recommendations.map(rec => `
      <div class="recommendation">
        <h3>💡 ${rec.title}</h3>
        <p>${rec.message}</p>
        <strong>Potential Savings: $${rec.savings}/month</strong>
      </div>
    `).join('');
  }
}

// Initialize calculator
const calculator = new SynapseCostCalculator();
```

## 📊 Cost Scenarios

### Scenario 1: Small Analytics Workload

```javascript
const smallWorkload = {
  serverlessSQL: {
    dataProcessed: 2, // TB/month
    cost: 10.00 // minimum charge
  },
  dedicatedSQL: {
    dwu: 'DW100c',
    hours: 160, // 8 hours/day, weekdays only
    cost: 192.00
  },
  sparkPool: {
    size: 'small',
    nodes: 3,
    hours: 40,
    cost: 24.00
  },
  totalMonthlyCost: 226.00
};
```

### Scenario 2: Medium Enterprise Workload

```javascript
const mediumWorkload = {
  serverlessSQL: {
    dataProcessed: 15,
    cost: 75.00
  },
  dedicatedSQL: {
    dwu: 'DW1000c',
    hours: 730, // 24/7
    cost: 8760.00
  },
  sparkPool: {
    size: 'medium',
    nodes: 10,
    hours: 200,
    cost: 800.00
  },
  totalMonthlyCost: 9635.00,
  optimization: {
    pauseDedicated: -2920.00, // Pause 16 hours/day
    optimizeSpark: -240.00,  // Better job efficiency
    potentialSavings: 3160.00
  }
};
```

## 💡 Cost Optimization Tips

### Automated Recommendations

```javascript
const optimizationStrategies = [
  {
    name: 'Pause Dedicated Pools',
    applicableIf: 'hours < 730',
    impact: 'High',
    savings: '30-70%',
    implementation: 'Configure auto-pause during non-business hours'
  },
  {
    name: 'Use Serverless for Ad-hoc Queries',
    applicableIf: 'queryFrequency === "ad-hoc"',
    impact: 'High',
    savings: '40-80%',
    implementation: 'Migrate exploratory workloads to serverless SQL'
  },
  {
    name: 'Right-size Dedicated Pools',
    applicableIf: 'utilizationRate < 60',
    impact: 'Medium',
    savings: '20-40%',
    implementation: 'Scale down DWU level to match actual usage'
  },
  {
    name: 'Enable Spark Auto-scaling',
    applicableIf: 'sparkWorkloadVariable === true',
    impact: 'Medium',
    savings: '15-30%',
    implementation: 'Configure min/max nodes with auto-scale'
  },
  {
    name: 'Optimize Data Storage',
    applicableIf: 'dataRetention > requirements',
    impact: 'Low',
    savings: '5-15%',
    implementation: 'Archive old data to cool/archive tiers'
  }
];
```

## 🔧 Troubleshooting

### Common Cost Issues

**Issue: Unexpected High Costs**

```javascript
const troubleshootHighCosts = {
  checks: [
    'Verify pools are pausing when not in use',
    'Check for long-running queries',
    'Review data processed by serverless SQL',
    'Identify unused or idle resources',
    'Check for data egress charges'
  ],

  costAnalysisQuery: `
    SELECT
      ResourceType,
      ResourceName,
      SUM(Cost) as TotalCost,
      COUNT(*) as EventCount
    FROM azure.cost_management
    WHERE ResourceGroup = 'synapse-rg'
      AND Date >= DATEADD(day, -30, GETDATE())
    GROUP BY ResourceType, ResourceName
    ORDER BY TotalCost DESC
  `
};
```

## 🔗 Embedded Demo Link

**Launch Cost Calculator:** [https://demos.csa-inabox.com/cost-calculator](https://demos.csa-inabox.com/cost-calculator)

## 📚 Additional Resources

- [Azure Synapse Pricing](https://azure.microsoft.com/pricing/details/synapse-analytics/)
- [Cost Optimization Guide](../../best-practices/cost-optimization.md)
- [Resource Planning](./resource-planner.md)

## 💬 Feedback

> **💡 Was the cost calculator helpful?**

- ✅ **Helped plan my budget** - [Share feedback](https://github.com/csa-inabox/docs/discussions)
- ⚠️ **Pricing seems incorrect** - [Report issue](https://github.com/csa-inabox/docs/issues/new)
- 💡 **Missing cost factors** - [Suggest addition](https://github.com/csa-inabox/docs/issues/new?title=[Calculator]+Feature)

---

*Last Updated: January 2025 | Version: 1.0.0*
