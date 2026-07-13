/**
 * Install-time report-binding transform tests (lib/install/report-binding.ts).
 *
 * Pure transform — no Azure. We assert the two contracts that make an
 * app-installed report RENDER real values:
 *   1. DDL → typed columns (so numeric wells aggregate on serverless).
 *   2. bundle visual ({type,title,field,config:{axis,values}}) → designer shape
 *      ({type,title,config:{wells:{category,values,legend}}}) with SINGLE-TABLE
 *      wells over the derived `Query` table, measures resolved to base column +
 *      aggregation, and one denormalized direct-query SELECT joining fact+dims.
 */
import { describe, it, expect } from 'vitest';
import {
  DERIVED_TABLE,
  synapseType,
  parseDdlTypedColumns,
  parseRef,
  parseMeasure,
  mapVisualType,
  mapModelTableToSeed,
  buildDenormalizedSelect,
  buildReportBinding,
  type SeedTable,
  type ModelInfo,
  type BundlePage,
} from '../report-binding';

const FACT_DDL =
  '-- partitioned\nCREATE TABLE gold.fact_sales (\n' +
  '  order_id VARCHAR(64) NOT NULL, customer_key BIGINT NOT NULL, product_key BIGINT NOT NULL,\n' +
  '  date_key INT NOT NULL, order_date DATE NOT NULL, quantity INT NOT NULL,\n' +
  '  unit_price DECIMAL(18,2) NOT NULL, extended_amount DECIMAL(18,2) NOT NULL,\n' +
  '  margin_amount DECIMAL(18,2) NOT NULL\n) USING DELTA PARTITIONED BY (order_date);';
const DATE_DDL =
  'CREATE TABLE gold.dim_date (date_key INT, date DATE, year INT, month INT, month_name VARCHAR(20));';
const PRODUCT_DDL =
  'CREATE TABLE gold.dim_product (product_key BIGINT, product_id VARCHAR(32), product_name VARCHAR(100), category VARCHAR(64));';

function seedFrom(name: string, ddl: string, rows = 5): SeedTable {
  const columns = parseDdlTypedColumns(ddl);
  return { name, columns, seeded: true, rowCount: rows };
}

const SEEDS: SeedTable[] = [
  seedFrom('fact_sales', FACT_DDL),
  seedFrom('dim_date', DATE_DDL),
  seedFrom('dim_product', PRODUCT_DDL),
];

const MODEL: ModelInfo = {
  tables: [
    { name: 'FactSales', columns: ['order_id', 'extended_amount', 'margin_amount'] },
    { name: 'DimDate', columns: ['date_key', 'month_name'] },
    { name: 'DimProduct', columns: ['product_key', 'category'] },
  ],
  measures: [
    { table: 'FactSales', name: 'Total Sales', expression: 'SUM(FactSales[extended_amount])' },
    { table: 'FactSales', name: 'Total Margin', expression: 'SUM(FactSales[margin_amount])' },
    { table: 'FactSales', name: 'Margin %', expression: 'DIVIDE([Total Margin], [Total Sales])' },
    { table: 'FactSales', name: 'Order Line Count', expression: 'COUNTROWS(FactSales)' },
  ],
  relationships: [
    { fromTable: 'FactSales', fromColumn: 'date_key', toTable: 'DimDate', toColumn: 'date_key' },
    { fromTable: 'FactSales', fromColumn: 'product_key', toTable: 'DimProduct', toColumn: 'product_key' },
  ],
};

const httpsUrlFor = (t: string) => `https://acct.dfs.core.windows.net/gold/lakehouses/lh/Tables/${t}/${t}.csv`;

describe('synapseType', () => {
  it('keeps numeric precision + flags numeric', () => {
    expect(synapseType('DECIMAL(18,2)')).toEqual({ sqlType: 'DECIMAL(18,2)', numeric: true });
    expect(synapseType('BIGINT')).toEqual({ sqlType: 'BIGINT', numeric: true });
    expect(synapseType('INT NOT NULL')).toEqual({ sqlType: 'INT', numeric: true });
    expect(synapseType('DOUBLE')).toEqual({ sqlType: 'FLOAT', numeric: true });
  });
  it('maps strings/dates as non-numeric', () => {
    expect(synapseType('VARCHAR(64)')).toEqual({ sqlType: 'VARCHAR(64)', numeric: false });
    expect(synapseType('STRING')).toEqual({ sqlType: 'VARCHAR(4000)', numeric: false });
    expect(synapseType('DATE')).toEqual({ sqlType: 'DATE', numeric: false });
  });
});

describe('parseDdlTypedColumns', () => {
  it('parses columns in order, skips constraints/comments/table-clauses', () => {
    const cols = parseDdlTypedColumns(FACT_DDL);
    expect(cols.map((c) => c.name)).toEqual([
      'order_id', 'customer_key', 'product_key', 'date_key', 'order_date',
      'quantity', 'unit_price', 'extended_amount', 'margin_amount',
    ]);
    expect(cols.find((c) => c.name === 'extended_amount')).toMatchObject({ sqlType: 'DECIMAL(18,2)', numeric: true });
    expect(cols.find((c) => c.name === 'order_date')).toMatchObject({ sqlType: 'DATE', numeric: false });
  });
});

describe('parseRef', () => {
  it('parses DAX / dotted / bare refs', () => {
    expect(parseRef('FactSales[Total Sales]')).toEqual({ table: 'FactSales', field: 'Total Sales' });
    expect(parseRef("'Dim Date'[month_name]")).toEqual({ table: 'Dim Date', field: 'month_name' });
    expect(parseRef('DimDate.month_name')).toEqual({ table: 'DimDate', field: 'month_name' });
    expect(parseRef('[Total Sales]')).toEqual({ field: 'Total Sales' });
    expect(parseRef('month_name')).toEqual({ field: 'month_name' });
    expect(parseRef('')).toBeNull();
  });
});

describe('parseMeasure', () => {
  it('extracts base column + aggregation for simple aggregates', () => {
    expect(parseMeasure('SUM(FactSales[extended_amount])')).toEqual({ column: 'extended_amount', aggregation: 'Sum' });
    expect(parseMeasure('AVERAGE(FactSales[unit_price])')).toEqual({ column: 'unit_price', aggregation: 'Avg' });
    expect(parseMeasure('DISTINCTCOUNT(DimCustomer[customer_id])')).toEqual({ column: 'customer_id', aggregation: 'Count' });
  });
  it('returns null for composite expressions', () => {
    expect(parseMeasure('DIVIDE([Total Margin], [Total Sales])')).toBeNull();
    expect(parseMeasure('COUNTROWS(FactSales)')).toBeNull();
  });
});

describe('mapVisualType', () => {
  it('maps bundle chart types to designer types', () => {
    expect(mapVisualType('lineChart')).toBe('line');
    expect(mapVisualType('columnChart')).toBe('column');
    expect(mapVisualType('donutChart')).toBe('donut');
    expect(mapVisualType('card')).toBe('card');
    expect(mapVisualType('table')).toBe('table');
    expect(mapVisualType('treemap')).toBe('treemap');
    expect(mapVisualType('somethingChart')).toBe('column'); // unknown chart → column
  });
});

describe('mapModelTableToSeed', () => {
  it('matches PascalCase model names to snake_case physical tables', () => {
    expect(mapModelTableToSeed('FactSales', SEEDS)?.name).toBe('fact_sales');
    expect(mapModelTableToSeed('DimDate', SEEDS)?.name).toBe('dim_date');
    expect(mapModelTableToSeed('Nope', SEEDS)).toBeNull();
  });
});

describe('buildDenormalizedSelect', () => {
  it('emits a typed OPENROWSET join over the seeded CSVs', () => {
    const fact = SEEDS[0];
    const joins = [
      { dim: SEEDS[1], factColumn: 'date_key', dimColumn: 'date_key' },
      { dim: SEEDS[2], factColumn: 'product_key', dimColumn: 'product_key' },
    ];
    const { sql, columns } = buildDenormalizedSelect(fact, joins, httpsUrlFor);
    expect(sql).toContain("FORMAT = 'CSV'");
    expect(sql).toContain('[extended_amount] DECIMAL(18,2)');
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('ON f.[date_key] = d0.[date_key]');
    // fact + non-key dim columns are all selectable
    expect(columns.get('extended_amount')).toBe(true);
    expect(columns.get('month_name')).toBe(false);
    expect(columns.get('category')).toBe(false);
    // join-key dim columns are NOT re-projected
    expect(columns.has('date_key')).toBe(true); // fact's
  });
});

describe('buildReportBinding', () => {
  const report = {
    pages: [
      {
        name: 'Overview',
        visuals: [
          { type: 'card', title: 'Total Sales', field: 'FactSales[Total Sales]' },
          { type: 'lineChart', title: 'Sales by Month', config: { axis: 'DimDate[month_name]', values: ['FactSales[Total Sales]'] } },
          { type: 'columnChart', title: 'Sales by Category', config: { axis: 'DimProduct[category]', values: ['FactSales[Total Sales]'] } },
        ],
      },
    ] as BundlePage[],
  };

  it('binds a direct-query source and rewrites visuals to Query wells', () => {
    const binding = buildReportBinding({ report, model: MODEL, seeds: SEEDS, httpsUrlFor });
    expect(binding).not.toBeNull();
    expect(binding!.dataSource.kind).toBe('direct-query');
    expect(binding!.dataSource.target).toBe('lakehouse');
    expect(binding!.dataSource.sql).toContain('OPENROWSET');

    const visuals = binding!.content.pages[0].visuals;
    // card: measure Total Sales → SUM(extended_amount) as a value well
    expect(visuals[0].type).toBe('card');
    expect(visuals[0].config.wells.values).toEqual([
      { table: DERIVED_TABLE, column: 'extended_amount', aggregation: 'Sum' },
    ]);
    // line: axis month_name (dim) → category; value → SUM(extended_amount)
    expect(visuals[1].type).toBe('line');
    expect(visuals[1].config.wells.category).toEqual([{ table: DERIVED_TABLE, column: 'month_name' }]);
    expect(visuals[1].config.wells.values).toEqual([
      { table: DERIVED_TABLE, column: 'extended_amount', aggregation: 'Sum' },
    ]);
    // column: axis category (dim) → category
    expect(visuals[2].config.wells.category).toEqual([{ table: DERIVED_TABLE, column: 'category' }]);
  });

  it('returns null when no seeded fact table exists', () => {
    const empty = SEEDS.map((s) => ({ ...s, seeded: false }));
    expect(buildReportBinding({ report, model: MODEL, seeds: empty, httpsUrlFor })).toBeNull();
  });

  it('binds single-table (no joins) when no model is present', () => {
    const binding = buildReportBinding({ report, model: null, seeds: [SEEDS[0]], httpsUrlFor });
    expect(binding).not.toBeNull();
    expect(binding!.dataSource.sql).not.toContain('LEFT JOIN');
    // Without a model, the measure ref doesn't resolve, but a raw column would.
  });
});
