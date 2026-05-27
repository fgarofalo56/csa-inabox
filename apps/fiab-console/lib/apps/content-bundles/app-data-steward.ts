// app-data-steward — provisions a Data Steward Console with a certified
// data product (4 datasets + 15+ business glossary terms) and a starter
// semantic model representing the steward's curated business view.
import type { AppBundle } from './types';

const bundle: AppBundle = {
  appId: 'app-data-steward',
  intro:
    '## Data Steward Console\n\n' +
    'Pre-populated with **four curated datasets** (customer-360, sales-summary, ' +
    'inventory-feed, fraud-scores), a **15+ term business glossary**, and a starter ' +
    '**semantic model** that joins the four core fact + dim tables your stewards will ' +
    'certify.\n\n' +
    'Use the data product to manage classification (Public / Internal / Confidential / ' +
    'Restricted), endorsement (Promoted / Certified), and ownership. The semantic model ' +
    'is the "shared business definitions" layer: dim_customer, dim_product, dim_date, ' +
    'fact_sales, fact_inventory with 10+ DAX measures already authored.',
  sourceDocs: [
    'docs/best-practices/data-governance.md',
    'docs/guides/purview.md',
    'CSA Data Governance reference patterns',
  ],
  items: [
    {
      itemType: 'data-product',
      displayName: 'Steward-Certified Data Products',
      description:
        'Four curated datasets the steward owns end-to-end with classification + ' +
        'glossary terms + endorsement status.',
      learnDoc: 'best-practices/data-governance',
      content: {
        kind: 'data-product',
        datasets: [
          {
            id: 'ds-customer-360',
            name: 'Customer 360',
            description:
              'Unified customer profile combining CRM master attributes, transactional ' +
              'history aggregates, support-ticket signals, and marketing engagement scores. ' +
              'Refreshed every 4 hours from silver-layer feeds; SCD2 history is retained ' +
              'for 7 years to satisfy regulatory record-keeping. Primary consumers: ' +
              'Customer Success, Renewals, and the Churn Risk model in AI Foundry. ' +
              'Field-level lineage is published to Purview and the curated semantic model ' +
              'exposes the "customer" entity through Power BI Direct Lake.',
            classification: 'Confidential',
          },
          {
            id: 'ds-sales-summary',
            name: 'Sales Summary (Daily)',
            description:
              'Aggregated daily sales facts at the customer x product x channel grain, ' +
              'derived from the gold-layer fact_sales table in the retail-sales lakehouse. ' +
              'Includes revenue, margin, units, and discount metrics with role-playing date ' +
              'dimensions (order, ship, recognized). Stewarded by Finance Analytics with ' +
              'sign-off from Revenue Accounting before each month-end close. The downstream ' +
              'FinOps Cost Optimizer and Casino Analytics apps consume this as a certified ' +
              'shortcut. SLA: 99.5% availability, max 30-minute freshness lag.',
            classification: 'Internal',
          },
          {
            id: 'ds-inventory-feed',
            name: 'Inventory Live Feed',
            description:
              'Near-real-time inventory snapshot streamed from the warehouse-management ' +
              'system through Event Hubs into the inventory_events KQL database, then ' +
              'snapshot-aggregated every 5 minutes into a Delta table. Tracks on-hand, ' +
              'in-transit, and committed quantities per SKU per warehouse. Used by store ' +
              'fulfillment, replenishment planning, and the IoT Real-Time Insights ' +
              'workspace. No PII; safe to publish to internal partners under NDA.',
            classification: 'Internal',
          },
          {
            id: 'ds-fraud-scores',
            name: 'Fraud Scores (Transaction-Level)',
            description:
              'Per-transaction composite fraud probability scores with risk-tier ' +
              'classification, sourced from the financial-fraud-detection data product. ' +
              'Includes velocity features, amount anomalies, merchant risk categories, ' +
              'and channel risk. Direct consumer is the BSA/AML compliance team and PCI ' +
              'auditors; downstream alerting feeds Activator rules on CRITICAL tier. ' +
              'Restricted classification — only fraud-analytics-team@ and audit-team@ ' +
              'security groups may query rows; data masking applied at the semantic-model layer.',
            classification: 'Restricted',
          },
        ],
        glossaryTerms: [
          {
            term: 'Customer',
            definition:
              'A legal entity (individual, household, or organization) with whom we have ' +
              'or have had a commercial relationship. Identified by customer_id (natural ' +
              'key) and customer_key (SCD2 surrogate). Distinct from Account, which is the ' +
              'billing relationship.',
          },
          {
            term: 'Account',
            definition:
              'The billing and contracting relationship attached to one or more Customers. ' +
              'A single Customer may hold multiple Accounts (e.g., separate cost centers); ' +
              'an Account always belongs to exactly one Customer at a point in time.',
          },
          {
            term: 'Transaction',
            definition:
              'A discrete monetary or value-bearing event recorded against an Account. ' +
              'Examples: an order line, a payment, a refund, a fraud-flagged authorization. ' +
              'Each Transaction has a transaction_id and a transaction_timestamp in UTC.',
          },
          {
            term: 'SKU',
            definition:
              'Stock Keeping Unit. The lowest-grain product identifier the supply chain ' +
              'operates against (per color, size, configuration). dim_product.product_id is ' +
              'the SKU; product_name is the merchandising name.',
          },
          {
            term: 'MRR',
            definition:
              'Monthly Recurring Revenue. The normalized, predictable, monthly value of ' +
              'active subscription contracts as of the snapshot date. Excludes one-time ' +
              'fees, professional services, and usage overages. Calculated as ARR / 12.',
          },
          {
            term: 'ARR',
            definition:
              'Annualized Recurring Revenue. MRR x 12, or the in-period sum of recognized ' +
              'subscription revenue annualized. Used for board reporting and SaaS valuation ' +
              'multiples. Does not include perpetual-license or services revenue.',
          },
          {
            term: 'NPS',
            definition:
              'Net Promoter Score. Survey-derived loyalty metric: %Promoters (9-10) minus ' +
              '%Detractors (0-6) on a 0-10 likelihood-to-recommend scale. Reported as a ' +
              'rolling 90-day window per segment; survey response rate must be >= 20% for ' +
              'the score to be considered statistically meaningful.',
          },
          {
            term: 'CLV',
            definition:
              'Customer Lifetime Value. The discounted sum of expected future gross profit ' +
              'attributable to a Customer over a 5-year horizon. Uses a 10% annual discount ' +
              'rate and the Customer Success retention model for churn probability per period.',
          },
          {
            term: 'Cohort',
            definition:
              'A group of Customers that share a defining event in a defining period — ' +
              'most commonly the first-purchase month. Cohort analysis tracks retention, ' +
              'expansion, and lifetime metrics over time relative to that anchor month.',
          },
          {
            term: 'Attribution',
            definition:
              'The assignment of conversion credit to one or more marketing touchpoints in ' +
              'a Customer journey. The certified attribution model is multi-touch ' +
              'data-driven; first-touch and last-touch breakdowns are provided as alternates.',
          },
          {
            term: 'Funnel',
            definition:
              'The ordered sequence of stages a prospective Customer passes through from ' +
              'first awareness to closed-won deal. The certified funnel stages are: ' +
              'Awareness, Interest, Evaluation, Commit, Closed-Won. Stage-to-stage ' +
              'conversion rates are reported weekly.',
          },
          {
            term: 'Conversion',
            definition:
              'A funnel-stage transition from one stage to the next (e.g., Interest → ' +
              'Evaluation). Conversion rate = next-stage entries / prior-stage entries, ' +
              'evaluated over a fixed lookback window (default 30 days).',
          },
          {
            term: 'Churn',
            definition:
              'A Customer ceasing the commercial relationship: either gross churn ' +
              '(cancellation) or revenue churn (downgrade reducing MRR). Reported monthly ' +
              'as a rate (churn $ / starting $); the 90-day trailing average is the ' +
              'leadership-deck KPI.',
          },
          {
            term: 'Retention',
            definition:
              'The complement of churn. Net Revenue Retention (NRR) = (starting ARR + ' +
              'expansion - downgrades - churn) / starting ARR. NRR > 100% indicates a net ' +
              'expansion business; 110%+ is industry-leading for B2B SaaS.',
          },
          {
            term: 'AOV',
            definition:
              'Average Order Value. Total revenue divided by total order count in a period. ' +
              'A leading indicator of upsell effectiveness when reported alongside units-per-order.',
          },
          {
            term: 'Risk Tier',
            definition:
              'A four-level classification (LOW / MEDIUM / HIGH / CRITICAL) of fraud ' +
              'likelihood applied to each Transaction by the fraud-scoring model. CRITICAL ' +
              'tier auto-fires an Activator alert to the BSA/AML team within 60 seconds.',
          },
          {
            term: 'CTR Flag',
            definition:
              'Currency Transaction Report flag — set when a Transaction equals or exceeds ' +
              'USD $10,000, triggering FinCEN reporting obligations under 31 CFR 1010.311. ' +
              'Aggregated across same-day related Transactions per BSA structuring rules.',
          },
        ],
        owner: { name: 'Data Steward Team', email: 'data-stewards@csa.example.com' },
        endorsement: 'certified',
      },
    },
    {
      itemType: 'semantic-model',
      displayName: 'Steward Business Glossary Model',
      description:
        'Star-schema semantic model exposing the certified business entities + 10+ ' +
        'pre-authored DAX measures. Direct Lake mode against the gold layer.',
      learnDoc: 'patterns/power-bi-fabric-roadmap',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'DimCustomer',
            columns: [
              { name: 'CustomerKey', dataType: 'Int64' },
              { name: 'CustomerId', dataType: 'String' },
              { name: 'CustomerName', dataType: 'String' },
              { name: 'CustomerSegment', dataType: 'String' },
              { name: 'Country', dataType: 'String' },
              { name: 'Region', dataType: 'String' },
              { name: 'ValidFrom', dataType: 'DateTime' },
              { name: 'ValidTo', dataType: 'DateTime' },
              { name: 'IsCurrent', dataType: 'Boolean' },
            ],
          },
          {
            name: 'DimProduct',
            columns: [
              { name: 'ProductKey', dataType: 'Int64' },
              { name: 'ProductId', dataType: 'String' },
              { name: 'ProductName', dataType: 'String' },
              { name: 'Category', dataType: 'String' },
              { name: 'Subcategory', dataType: 'String' },
              { name: 'ListPrice', dataType: 'Decimal' },
              { name: 'ValidFrom', dataType: 'DateTime' },
              { name: 'ValidTo', dataType: 'DateTime' },
              { name: 'IsCurrent', dataType: 'Boolean' },
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
              { name: 'DayOfWeek', dataType: 'Int64' },
              { name: 'IsWeekend', dataType: 'Boolean' },
              { name: 'IsHoliday', dataType: 'Boolean' },
            ],
          },
          {
            name: 'FactSales',
            columns: [
              { name: 'SalesKey', dataType: 'Int64' },
              { name: 'CustomerKey', dataType: 'Int64' },
              { name: 'ProductKey', dataType: 'Int64' },
              { name: 'OrderDateKey', dataType: 'Int64' },
              { name: 'ShipDateKey', dataType: 'Int64' },
              { name: 'OrderId', dataType: 'String' },
              { name: 'Quantity', dataType: 'Int64' },
              { name: 'UnitPrice', dataType: 'Decimal' },
              { name: 'DiscountPct', dataType: 'Decimal' },
              { name: 'ExtendedAmount', dataType: 'Decimal' },
              { name: 'CostAmount', dataType: 'Decimal' },
              { name: 'MarginAmount', dataType: 'Decimal' },
            ],
          },
          {
            name: 'FactInventory',
            columns: [
              { name: 'InventoryKey', dataType: 'Int64' },
              { name: 'ProductKey', dataType: 'Int64' },
              { name: 'WarehouseId', dataType: 'String' },
              { name: 'SnapshotDateKey', dataType: 'Int64' },
              { name: 'OnHandQty', dataType: 'Int64' },
              { name: 'InTransitQty', dataType: 'Int64' },
              { name: 'CommittedQty', dataType: 'Int64' },
              { name: 'AvailableQty', dataType: 'Int64' },
              { name: 'UnitCost', dataType: 'Decimal' },
            ],
          },
        ],
        measures: [
          {
            table: 'FactSales',
            name: 'Total Sales',
            expression: "SUM ( FactSales[ExtendedAmount] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'FactSales',
            name: 'Total Margin',
            expression: "SUM ( FactSales[MarginAmount] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'FactSales',
            name: 'Gross Margin %',
            expression:
              "DIVIDE ( [Total Margin], [Total Sales] )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactSales',
            name: 'Average Order Value',
            expression:
              "DIVIDE ( [Total Sales], DISTINCTCOUNT ( FactSales[OrderId] ) )",
            formatString: '"$"#,0.00',
          },
          {
            table: 'FactSales',
            name: 'New Customers',
            expression:
              "CALCULATE ( DISTINCTCOUNT ( FactSales[CustomerKey] ), FILTER ( ALL ( DimDate ), DimDate[Date] <= MAX ( DimDate[Date] ) ), USERELATIONSHIP ( FactSales[OrderDateKey], DimDate[DateKey] ) ) - " +
              "CALCULATE ( DISTINCTCOUNT ( FactSales[CustomerKey] ), FILTER ( ALL ( DimDate ), DimDate[Date] < MIN ( DimDate[Date] ) ) )",
            formatString: '#,0',
          },
          {
            table: 'FactSales',
            name: 'Repeat Rate %',
            expression:
              "VAR _AllCust = DISTINCTCOUNT ( FactSales[CustomerKey] ) " +
              "VAR _Repeat = COUNTROWS ( FILTER ( VALUES ( FactSales[CustomerKey] ), CALCULATE ( DISTINCTCOUNT ( FactSales[OrderId] ) ) > 1 ) ) " +
              "RETURN DIVIDE ( _Repeat, _AllCust )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactSales',
            name: 'Sales YoY %',
            expression:
              "VAR _Curr = [Total Sales] " +
              "VAR _Prior = CALCULATE ( [Total Sales], SAMEPERIODLASTYEAR ( DimDate[Date] ) ) " +
              "RETURN DIVIDE ( _Curr - _Prior, _Prior )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactSales',
            name: 'Sales MTD',
            expression:
              "TOTALMTD ( [Total Sales], DimDate[Date] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'FactSales',
            name: 'Sales YTD',
            expression:
              "TOTALYTD ( [Total Sales], DimDate[Date] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'FactInventory',
            name: 'On-Hand Units',
            expression: "SUM ( FactInventory[OnHandQty] )",
            formatString: '#,0',
          },
          {
            table: 'FactInventory',
            name: 'Inventory Value',
            expression:
              "SUMX ( FactInventory, FactInventory[OnHandQty] * FactInventory[UnitCost] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'FactInventory',
            name: 'Stockout SKUs',
            expression:
              "CALCULATE ( DISTINCTCOUNT ( FactInventory[ProductKey] ), FactInventory[AvailableQty] = 0 )",
            formatString: '#,0',
          },
        ],
        relationships: [
          { from: 'FactSales.CustomerKey', to: 'DimCustomer.CustomerKey', cardinality: '1:many' },
          { from: 'FactSales.ProductKey', to: 'DimProduct.ProductKey', cardinality: '1:many' },
          { from: 'FactSales.OrderDateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
          { from: 'FactSales.ShipDateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
          { from: 'FactInventory.ProductKey', to: 'DimProduct.ProductKey', cardinality: '1:many' },
          { from: 'FactInventory.SnapshotDateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
        ],
      },
    },
  ],
};

export default bundle;
