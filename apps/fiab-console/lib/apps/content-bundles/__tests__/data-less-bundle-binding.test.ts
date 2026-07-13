/**
 * Guard: the two formerly DATA-LESS bundles (app-finops-cost,
 * app-real-time-dashboards) now each seed a lakehouse whose tables/columns
 * norm-match their semantic model, so the install-time report binder
 * (lib/install/report-binding.ts) turns their report into a direct-query that
 * renders REAL values instead of the "choose a data source" gate.
 *
 * This drives the SAME transform the app-install route runs (buildReportBinding
 * over the bundle's seeded lakehouse DDL + its semantic model), and asserts the
 * report's headline measure resolves to a real numeric value well over the
 * derived `Query` table. Pure static data — no Azure (no-vaporware.md).
 */
import { describe, it, expect } from 'vitest';

import { getBundle } from '../index';
import type { AppBundle } from '../types';
import {
  DERIVED_TABLE,
  buildReportBinding,
  parseDdlTypedColumns,
  type SeedTable,
  type ModelInfo,
  type BundlePage,
} from '@/lib/install/report-binding';

/** Build the binder inputs from a bundle exactly like the install route does. */
function bindFromBundle(bundle: AppBundle) {
  const lakehouse = bundle.items.find((i) => i.itemType === 'lakehouse');
  const sm = bundle.items.find((i) => i.itemType === 'semantic-model');
  const report = bundle.items.find((i) => i.itemType === 'report');
  expect(lakehouse, 'bundle has a lakehouse').toBeTruthy();
  expect(report, 'bundle has a report').toBeTruthy();

  const lhContent = lakehouse!.content as any;
  const seeds: SeedTable[] = (lhContent.deltaTables || []).map((t: any) => ({
    name: String(t.name).replace(/[^A-Za-z0-9_]/g, '_'),
    columns: parseDdlTypedColumns(t.ddl || ''),
    seeded: Array.isArray(t.sampleRows) && t.sampleRows.length > 0,
    rowCount: Array.isArray(t.sampleRows) ? t.sampleRows.length : undefined,
  }));

  const smContent = sm?.content as any;
  const model: ModelInfo | null = smContent
    ? {
        tables: (smContent.tables || []).map((t: any) => ({
          name: String(t.name),
          columns: (t.columns || []).map((c: any) => String(c.name)),
        })),
        measures: (smContent.measures || []).map((m: any) => ({
          name: String(m.name),
          expression: String(m.expression),
          table: m.table ? String(m.table) : undefined,
        })),
        relationships: (smContent.relationships || [])
          .map((r: any) => {
            const [fromTable, fromColumn] = String(r.from || '').split('.');
            const [toTable, toColumn] = String(r.to || '').split('.');
            return { fromTable, fromColumn, toTable, toColumn };
          })
          .filter((r: any) => r.fromTable && r.fromColumn && r.toTable && r.toColumn),
      }
    : null;

  const httpsUrlFor = (t: string) => `https://acct.dfs.core.windows.net/c/lh/Tables/${t}/${t}.csv`;
  const reportContent = report!.content as { pages: BundlePage[] };
  return buildReportBinding({ report: reportContent, model, seeds, httpsUrlFor });
}

/** Flatten every value well across the bound report's visuals. */
function valueWells(binding: NonNullable<ReturnType<typeof bindFromBundle>>) {
  return binding.content.pages.flatMap((p) => p.visuals.flatMap((v) => v.config.wells.values));
}
/** Flatten every category well. */
function categoryWells(binding: NonNullable<ReturnType<typeof bindFromBundle>>) {
  return binding.content.pages.flatMap((p) => p.visuals.flatMap((v) => v.config.wells.category));
}

describe('data-less bundle report binding renders real values', () => {
  it('app-finops-cost report binds Total Spend → SUM(BilledCost) over the seeded lakehouse', async () => {
    const bundle = (await getBundle('app-finops-cost')) as AppBundle;
    const binding = bindFromBundle(bundle);
    expect(binding, 'finops report binds').not.toBeNull();
    expect(binding!.dataSource.kind).toBe('direct-query');
    expect(binding!.dataSource.target).toBe('lakehouse');
    // Denormalized SELECT joins the seeded fact to DimService.
    expect(binding!.dataSource.sql).toContain('OPENROWSET');
    expect(binding!.dataSource.sql).toContain('LEFT JOIN');

    const values = valueWells(binding!);
    // The headline "Total Spend" measure resolves to a numeric SUM over the
    // fact's BilledCost column (proves the measure→base-column→physical-column
    // chain the untouched report depends on).
    expect(values).toContainEqual({ table: DERIVED_TABLE, column: 'BilledCost', aggregation: 'Sum' });

    // A by-service axis (ServiceFamily from the joined DimService) resolves too.
    const cats = categoryWells(binding!).map((c) => c.column);
    expect(cats).toContain('ServiceFamily');
    expect(cats).toContain('MonthName');
  });

  it('app-real-time-dashboards report binds Total Revenue → SUM(amount) over the seeded snapshot', async () => {
    const bundle = (await getBundle('app-real-time-dashboards')) as AppBundle;
    const binding = bindFromBundle(bundle);
    expect(binding, 'rt-dashboards report binds').not.toBeNull();
    expect(binding!.dataSource.kind).toBe('direct-query');
    expect(binding!.dataSource.sql).toContain('OPENROWSET');
    // orders → dim_region join on region.
    expect(binding!.dataSource.sql).toContain('LEFT JOIN');

    const values = valueWells(binding!);
    expect(values).toContainEqual({ table: DERIVED_TABLE, column: 'amount', aggregation: 'Sum' });

    const cats = categoryWells(binding!).map((c) => c.column);
    // Revenue-by-region axis (region_name from dim_region) + revenue-trend axis.
    expect(cats).toContain('region_name');
    expect(cats).toContain('event_time');
  });
});
