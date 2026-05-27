// app-finops-cost — provisions a FinOps Cost Optimizer workspace with a
// semantic model over Azure Cost Management exports, a monthly executive
// report, and an ADX-backed live-spend dashboard. Built to FinOps Foundation
// allocation + forecast + optimization principles.
import type { AppBundle } from './types';

const bundle: AppBundle = {
  appId: 'app-finops-cost',
  intro:
    '## FinOps Cost Optimizer\n\n' +
    'A complete FinOps workspace pre-stamped with three production-grade artifacts:\n\n' +
    '- **Semantic model** over Cost Management exports (BillingFact + 6 dims, 10+ DAX measures)\n' +
    '- **Monthly executive report** (5 pages: Summary, By Service, By Owner, Forecast & Anomalies, Recommendations)\n' +
    '- **KQL live-spend dashboard** sourcing the ADX `billing_events` table\n\n' +
    'Aligned to FinOps Foundation principles: visibility, allocation, forecasting, and ' +
    'optimization. Tag-driven ownership (cost_center, owner, environment); idle + ' +
    'untagged spend surfaced as actionable callouts.',
  sourceDocs: [
    'FinOps Foundation Framework v2',
    'Azure Cost Management daily exports schema',
    'docs/best-practices/cloud-cost-management.md',
  ],
  items: [
    {
      itemType: 'semantic-model',
      displayName: 'FinOps Cost Semantic Model',
      description:
        'Star-schema semantic model over Cost Management exports. BillingFact + 6 dims ' +
        'covering Service, Subscription, Region, Environment, Tag, Date. 10+ DAX measures.',
      learnDoc: 'best-practices/cloud-cost-management',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'BillingFact',
            columns: [
              { name: 'BillingEventKey', dataType: 'Int64' },
              { name: 'ResourceId', dataType: 'String' },
              { name: 'ServiceKey', dataType: 'Int64' },
              { name: 'SubscriptionKey', dataType: 'Int64' },
              { name: 'RegionKey', dataType: 'Int64' },
              { name: 'EnvironmentKey', dataType: 'Int64' },
              { name: 'TagKey', dataType: 'Int64' },
              { name: 'BillingDateKey', dataType: 'Int64' },
              { name: 'MeterCategory', dataType: 'String' },
              { name: 'MeterSubcategory', dataType: 'String' },
              { name: 'UsageQuantity', dataType: 'Decimal' },
              { name: 'UnitOfMeasure', dataType: 'String' },
              { name: 'EffectiveUnitPrice', dataType: 'Decimal' },
              { name: 'ChargeAmount', dataType: 'Decimal' },
              { name: 'PretaxCost', dataType: 'Decimal' },
              { name: 'BilledCost', dataType: 'Decimal' },
              { name: 'AmortizedCost', dataType: 'Decimal' },
              { name: 'ReservationId', dataType: 'String' },
              { name: 'IsReserved', dataType: 'Boolean' },
              { name: 'IsIdle', dataType: 'Boolean' },
              { name: 'TagOwner', dataType: 'String' },
              { name: 'TagCostCenter', dataType: 'String' },
              { name: 'TagProject', dataType: 'String' },
            ],
          },
          {
            name: 'DimService',
            columns: [
              { name: 'ServiceKey', dataType: 'Int64' },
              { name: 'ServiceName', dataType: 'String' },
              { name: 'ServiceFamily', dataType: 'String' },
              { name: 'ServiceTier', dataType: 'String' },
              { name: 'IsManaged', dataType: 'Boolean' },
            ],
          },
          {
            name: 'DimSubscription',
            columns: [
              { name: 'SubscriptionKey', dataType: 'Int64' },
              { name: 'SubscriptionId', dataType: 'String' },
              { name: 'SubscriptionName', dataType: 'String' },
              { name: 'BillingAccountId', dataType: 'String' },
              { name: 'EnrollmentNumber', dataType: 'String' },
              { name: 'OfferType', dataType: 'String' },
            ],
          },
          {
            name: 'DimRegion',
            columns: [
              { name: 'RegionKey', dataType: 'Int64' },
              { name: 'RegionCode', dataType: 'String' },
              { name: 'RegionDisplayName', dataType: 'String' },
              { name: 'Geography', dataType: 'String' },
              { name: 'IsPaired', dataType: 'Boolean' },
              { name: 'IsSovereign', dataType: 'Boolean' },
            ],
          },
          {
            name: 'DimEnvironment',
            columns: [
              { name: 'EnvironmentKey', dataType: 'Int64' },
              { name: 'EnvironmentName', dataType: 'String' },
              { name: 'EnvironmentTier', dataType: 'String' },
              { name: 'IsProduction', dataType: 'Boolean' },
              { name: 'BusinessCriticality', dataType: 'String' },
            ],
          },
          {
            name: 'DimTag',
            columns: [
              { name: 'TagKey', dataType: 'Int64' },
              { name: 'Owner', dataType: 'String' },
              { name: 'CostCenter', dataType: 'String' },
              { name: 'Project', dataType: 'String' },
              { name: 'Application', dataType: 'String' },
              { name: 'BusinessUnit', dataType: 'String' },
              { name: 'TagComplete', dataType: 'Boolean' },
            ],
          },
          {
            name: 'DimDate',
            columns: [
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'Date', dataType: 'Date' },
              { name: 'Year', dataType: 'Int64' },
              { name: 'Quarter', dataType: 'Int64' },
              { name: 'Month', dataType: 'Int64' },
              { name: 'MonthName', dataType: 'String' },
              { name: 'FiscalYear', dataType: 'Int64' },
              { name: 'FiscalQuarter', dataType: 'Int64' },
            ],
          },
        ],
        measures: [
          {
            table: 'BillingFact',
            name: 'Total Spend',
            expression: "SUM ( BillingFact[BilledCost] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'BillingFact',
            name: 'Amortized Spend',
            expression: "SUM ( BillingFact[AmortizedCost] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'BillingFact',
            name: 'MoM Growth',
            expression:
              "VAR _Curr = [Total Spend] " +
              "VAR _Prior = CALCULATE ( [Total Spend], DATEADD ( DimDate[Date], -1, MONTH ) ) " +
              "RETURN DIVIDE ( _Curr - _Prior, _Prior )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'BillingFact',
            name: 'YoY Growth',
            expression:
              "VAR _Curr = [Total Spend] " +
              "VAR _Prior = CALCULATE ( [Total Spend], SAMEPERIODLASTYEAR ( DimDate[Date] ) ) " +
              "RETURN DIVIDE ( _Curr - _Prior, _Prior )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'BillingFact',
            name: 'Forecast Spend (3M)',
            expression:
              "VAR _AvgDaily = DIVIDE ( CALCULATE ( [Total Spend], DATESINPERIOD ( DimDate[Date], MAX ( DimDate[Date] ), -90, DAY ) ), 90 ) " +
              "VAR _DaysAhead = 90 " +
              "RETURN _AvgDaily * _DaysAhead",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'BillingFact',
            name: 'Unit Cost',
            expression:
              "DIVIDE ( [Total Spend], SUM ( BillingFact[UsageQuantity] ) )",
            formatString: '"$"#,0.0000',
          },
          {
            table: 'BillingFact',
            name: 'Reserved Spend %',
            expression:
              "DIVIDE ( CALCULATE ( [Total Spend], BillingFact[IsReserved] = TRUE ), [Total Spend] )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'BillingFact',
            name: 'On-Demand Spend %',
            expression:
              "DIVIDE ( CALCULATE ( [Total Spend], BillingFact[IsReserved] = FALSE ), [Total Spend] )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'BillingFact',
            name: 'Untagged Spend',
            expression:
              "CALCULATE ( [Total Spend], FILTER ( BillingFact, ISBLANK ( BillingFact[TagOwner] ) || ISBLANK ( BillingFact[TagCostCenter] ) ) )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'BillingFact',
            name: 'Untagged Spend %',
            expression:
              "DIVIDE ( [Untagged Spend], [Total Spend] )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'BillingFact',
            name: 'Idle Spend',
            expression:
              "CALCULATE ( [Total Spend], BillingFact[IsIdle] = TRUE )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'BillingFact',
            name: 'Idle Spend %',
            expression:
              "DIVIDE ( [Idle Spend], [Total Spend] )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'BillingFact',
            name: 'Top Service Spend',
            expression:
              "CALCULATE ( [Total Spend], TOPN ( 1, VALUES ( DimService[ServiceName] ), [Total Spend], DESC ) )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
        ],
        relationships: [
          { from: 'BillingFact.ServiceKey', to: 'DimService.ServiceKey', cardinality: '1:many' },
          { from: 'BillingFact.SubscriptionKey', to: 'DimSubscription.SubscriptionKey', cardinality: '1:many' },
          { from: 'BillingFact.RegionKey', to: 'DimRegion.RegionKey', cardinality: '1:many' },
          { from: 'BillingFact.EnvironmentKey', to: 'DimEnvironment.EnvironmentKey', cardinality: '1:many' },
          { from: 'BillingFact.TagKey', to: 'DimTag.TagKey', cardinality: '1:many' },
          { from: 'BillingFact.BillingDateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
        ],
      },
    },
    {
      itemType: 'report',
      displayName: 'FinOps Monthly Executive Report',
      description:
        'Five-page report: Executive Summary, By Service, By Owner & Cost Center, ' +
        'Forecast & Anomalies, Recommendations.',
      learnDoc: 'best-practices/cloud-cost-management',
      content: {
        kind: 'report',
        pages: [
          {
            name: 'Executive Summary',
            visuals: [
              {
                type: 'card',
                title: 'Total Spend (This Month)',
                field: 'Total Spend',
                config: { dataLabel: true, tooltip: 'Billed cost net of credits, in USD' },
              },
              {
                type: 'card',
                title: 'MoM Growth',
                field: 'MoM Growth',
                config: {
                  conditionalFormatting: {
                    redAbove: 0.10,
                    yellowAbove: 0.05,
                    greenBelow: 0.05,
                  },
                },
              },
              {
                type: 'card',
                title: 'Untagged Spend %',
                field: 'Untagged Spend %',
                config: { conditionalFormatting: { redAbove: 0.05, yellowAbove: 0.02, greenBelow: 0.02 } },
              },
              {
                type: 'card',
                title: 'Idle Spend %',
                field: 'Idle Spend %',
                config: { conditionalFormatting: { redAbove: 0.10, yellowAbove: 0.05, greenBelow: 0.05 } },
              },
              {
                type: 'line',
                title: 'Spend Trend — Last 12 Months',
                field: 'Total Spend',
                config: {
                  axis: 'DimDate.MonthName',
                  sort: { field: 'DimDate.DateKey', order: 'asc' },
                  showTrendline: true,
                  showForecast: true,
                },
              },
              {
                type: 'bar',
                title: 'Reserved vs On-Demand',
                config: {
                  values: ['Reserved Spend %', 'On-Demand Spend %'],
                  stacked: true,
                  axis: 'DimDate.MonthName',
                },
              },
            ],
          },
          {
            name: 'By Service',
            visuals: [
              {
                type: 'treemap',
                title: 'Spend Distribution by Service Family',
                field: 'Total Spend',
                config: {
                  group: 'DimService.ServiceFamily',
                  subgroup: 'DimService.ServiceName',
                  colorBy: 'Total Spend',
                  palette: 'monochromaticBlue',
                },
              },
              {
                type: 'table',
                title: 'Top 25 Services by Spend',
                config: {
                  columns: [
                    { field: 'DimService.ServiceName', header: 'Service' },
                    { field: 'DimService.ServiceFamily', header: 'Family' },
                    { field: 'Total Spend', header: 'Spend', format: 'currency' },
                    { field: 'MoM Growth', header: 'MoM', format: 'percent', dataBar: true },
                    { field: 'Unit Cost', header: 'Unit Cost', format: 'currency4' },
                  ],
                  sort: { field: 'Total Spend', order: 'desc' },
                  rowLimit: 25,
                },
              },
              {
                type: 'bar',
                title: 'YoY Growth by Service',
                field: 'YoY Growth',
                config: { axis: 'DimService.ServiceName', orientation: 'horizontal', topN: 15, sort: 'desc' },
              },
            ],
          },
          {
            name: 'By Owner & Cost Center',
            visuals: [
              {
                type: 'matrix',
                title: 'Spend by Cost Center x Owner',
                field: 'Total Spend',
                config: {
                  rows: ['DimTag.CostCenter'],
                  columns: ['DimTag.Owner'],
                  values: ['Total Spend', 'MoM Growth'],
                  subtotals: true,
                  grandtotals: true,
                  conditionalFormatting: { field: 'MoM Growth', heatmap: 'redToGreen' },
                },
              },
              {
                type: 'card',
                title: 'Untagged Spend ($)',
                field: 'Untagged Spend',
                config: { conditionalFormatting: { redAbove: 50000, yellowAbove: 10000 } },
              },
              {
                type: 'table',
                title: 'Untagged Resources Detail',
                config: {
                  columns: [
                    { field: 'BillingFact.ResourceId', header: 'Resource' },
                    { field: 'DimService.ServiceName', header: 'Service' },
                    { field: 'DimSubscription.SubscriptionName', header: 'Subscription' },
                    { field: 'Total Spend', header: 'Monthly Spend', format: 'currency' },
                  ],
                  filter: 'Untagged Spend > 0',
                  sort: { field: 'Total Spend', order: 'desc' },
                  rowLimit: 100,
                },
              },
            ],
          },
          {
            name: 'Forecast & Anomalies',
            visuals: [
              {
                type: 'line',
                title: 'Actual vs Forecast (90-Day)',
                config: {
                  measures: ['Total Spend', 'Forecast Spend (3M)'],
                  axis: 'DimDate.Date',
                  showAnomalyDetection: true,
                  anomalySensitivity: 80,
                },
              },
              {
                type: 'bar',
                title: 'Daily Spend Anomalies — Last 30 Days',
                field: 'Total Spend',
                config: {
                  axis: 'DimDate.Date',
                  filter: 'Anomaly = TRUE',
                  color: { high: '#d13438', low: '#107c10' },
                },
              },
              {
                type: 'card',
                title: 'Forecast (Next 90 Days)',
                field: 'Forecast Spend (3M)',
              },
              {
                type: 'card',
                title: 'Variance to Budget',
                config: {
                  expression: "DIVIDE ( [Total Spend] - [Budget Amount], [Budget Amount] )",
                  format: 'percent',
                  conditionalFormatting: { redAbove: 0.10, yellowAbove: 0.05, greenBelow: 0.05 },
                },
              },
            ],
          },
          {
            name: 'Recommendations',
            visuals: [
              {
                type: 'table',
                title: 'Right-Sizing Suggestions',
                config: {
                  columns: [
                    { field: 'ResourceId', header: 'Resource' },
                    { field: 'CurrentSku', header: 'Current SKU' },
                    { field: 'RecommendedSku', header: 'Recommended SKU' },
                    { field: 'CurrentMonthlyCost', header: 'Current $/mo', format: 'currency' },
                    { field: 'ProjectedMonthlyCost', header: 'Projected $/mo', format: 'currency' },
                    { field: 'EstimatedMonthlySavings', header: 'Savings $/mo', format: 'currency', dataBar: true },
                    { field: 'Confidence', header: 'Confidence' },
                  ],
                  source: 'Advisor.RightSizingRecommendations',
                  sort: { field: 'EstimatedMonthlySavings', order: 'desc' },
                  rowLimit: 50,
                },
              },
              {
                type: 'table',
                title: 'Idle Resources — Candidates for Decommission',
                config: {
                  columns: [
                    { field: 'BillingFact.ResourceId', header: 'Resource' },
                    { field: 'DimService.ServiceName', header: 'Service' },
                    { field: 'IdleSince', header: 'Idle Since', format: 'date' },
                    { field: 'Total Spend', header: 'Wasted $/mo', format: 'currency', dataBar: true },
                  ],
                  filter: 'BillingFact.IsIdle = TRUE',
                  sort: { field: 'Total Spend', order: 'desc' },
                  rowLimit: 50,
                },
              },
              {
                type: 'card',
                title: 'Total Identified Monthly Savings',
                config: {
                  expression: "SUMX ( Recommendations, Recommendations[EstimatedMonthlySavings] ) + [Idle Spend]",
                  format: 'currency',
                },
              },
            ],
          },
        ],
      },
    },
    {
      itemType: 'kql-dashboard',
      displayName: 'FinOps Live Spend',
      description:
        '4-tile live KQL dashboard sourcing the ADX `billing_events` table (Cost Management ' +
        'exports streamed via Event Grid). Updates every 5 minutes.',
      learnDoc: 'best-practices/cloud-cost-management',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          {
            title: 'Spend Today (Running Total)',
            viz: 'card',
            kql:
              'billing_events\n' +
              '| where billing_date == startofday(now())\n' +
              '| summarize TodaySpend = sum(billed_cost)\n' +
              "| project Metric = 'Today Spend (USD)', Value = round(TodaySpend, 2)",
          },
          {
            title: 'Hourly Spend Trend — Last 24 Hours',
            viz: 'line',
            kql:
              'billing_events\n' +
              '| where billing_time > ago(24h)\n' +
              '| summarize Spend = sum(billed_cost) by bin(billing_time, 1h)\n' +
              '| order by billing_time asc\n' +
              '| render timechart',
          },
          {
            title: 'Top 10 Services by Spend (24h)',
            viz: 'bar',
            kql:
              'billing_events\n' +
              '| where billing_time > ago(24h)\n' +
              '| summarize Spend = sum(billed_cost) by service_name\n' +
              '| top 10 by Spend desc\n' +
              '| render barchart',
          },
          {
            title: 'Anomalies — Subscriptions with > 50% Daily Spend Increase',
            viz: 'table',
            kql:
              'let today = billing_events\n' +
              '    | where billing_date == startofday(now())\n' +
              '    | summarize TodaySpend = sum(billed_cost) by subscription_id, subscription_name;\n' +
              'let yesterday = billing_events\n' +
              '    | where billing_date == startofday(now()) - 1d\n' +
              '    | summarize YesterdaySpend = sum(billed_cost) by subscription_id;\n' +
              'today\n' +
              '| join kind=inner (yesterday) on subscription_id\n' +
              '| extend GrowthPct = round((TodaySpend - YesterdaySpend) / YesterdaySpend * 100, 1)\n' +
              '| where GrowthPct > 50\n' +
              '| project subscription_name, YesterdaySpend = round(YesterdaySpend, 2), TodaySpend = round(TodaySpend, 2), GrowthPct\n' +
              '| order by GrowthPct desc',
          },
        ],
      },
    },
  ],
};

export default bundle;
