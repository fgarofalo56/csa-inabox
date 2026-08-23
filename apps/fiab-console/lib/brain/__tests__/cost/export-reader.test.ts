/**
 * LOOM BRAIN cost — reading a Cost Management export.
 *
 * The four ways this reader could lie, each with a test that fails when the
 * defence is removed:
 *
 *   PARTIAL READ   exports are ALWAYS partitioned; a run is N blobs plus a
 *                  manifest. Summing a subset gives a confident, low, wrong
 *                  total — this repo's most repeated failure. Completeness is
 *                  `'unknown'` without a manifest and `'incomplete'` when the
 *                  manifest names a blob that was not supplied or a row count
 *                  that does not match.
 *   WRONG COLUMN   `BilledCost` / `CostInBillingCurrency` / `Cost` are the same
 *                  role under three agreements. A reader hard-coded to one
 *                  returns ZERO for the others — silent, total, plausible.
 *   WRONG CURRENCY every Brain figure is `amountUsd`. Copying a EUR amount into
 *                  it mislabels the unit and looks completely normal.
 *   NAIVE SPLIT    the `Tags` column is quoted and contains commas.
 *                  `line.split(',')` shifts every later column, so `ResourceId`
 *                  becomes a fragment of a tag value and the row attributes to
 *                  nothing at all.
 *
 * PUBLIC REPO: every id below is a synthetic placeholder. See `./fixtures.ts`.
 */

import { describe, expect, it } from 'vitest';
import { azureResourceNodeId } from '../../graph/node-id';
import {
  ASOF_NOT_ESTABLISHED,
  bindColumns,
  parseCsvFields,
  parseManifest,
  readCostExport,
  schemaOf,
  splitCsvRecords,
} from '../../cost/export-reader';
import { BILLED_MARKER, renderCost } from '../../cost/figure';
import { containerAppArmId, SUB_A } from './fixtures';

const BROKER_ARM = containerAppArmId(SUB_A, 'rg-loom', 'loom-capacity-broker');
const CONSOLE_ARM = containerAppArmId(SUB_A, 'rg-loom', 'loom-console');
const BROKER_ID = azureResourceNodeId(BROKER_ARM);
const CONSOLE_ID = azureResourceNodeId(CONSOLE_ARM);

/** EA / MCA current schema, WITH a quoted Tags column containing commas. */
const EA_CSV = [
  'Date,ResourceId,ResourceName,Tags,CostInBillingCurrency,BillingCurrencyCode,ConsumedService',
  `2026-08-22,${BROKER_ARM},loom-capacity-broker,"{""env"":""prod"",""owner"":""loom"",""band"":""a""}",12.34,USD,Microsoft.App`,
  `2026-08-22,${CONSOLE_ARM},loom-console,"{""env"":""prod"",""tier"":""ui""}",40.00,USD,Microsoft.App`,
].join('\r\n');

const EA_MANIFEST = JSON.stringify({
  manifestVersion: '2023-08-01',
  blobCount: 1,
  dataRowCount: 2,
  exportConfig: { exportName: 'loom-brain-daily', type: 'ActualCost' },
  runInfo: { executionType: 'Scheduled', endDate: '2026-08-22T23:59:59Z' },
  blobs: [{ blobName: 'loom-brain/part_0_0001.csv', dataRowCount: 2 }],
});

function eaRun(overrides?: { manifest?: string; partitions?: { blobName: string; csv: string }[] }) {
  return readCostExport({
    exportName: 'loom-brain-daily',
    manifest:
      overrides?.manifest === undefined
        ? { blobName: 'loom-brain/manifest.json', json: EA_MANIFEST }
        : { blobName: 'loom-brain/manifest.json', json: overrides.manifest },
    partitions: overrides?.partitions ?? [{ blobName: 'part_0_0001.csv', csv: EA_CSV }],
  });
}

describe('the quoted Tags column does not shift the resource id (naive-split guard)', () => {
  it('attributes to the RIGHT resource despite commas inside Tags', () => {
    const read = eaRun();
    expect(read.byResource.has(BROKER_ID)).toBe(true);
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(12.34, 6);
  });

  it('parseCsvFields keeps a quoted comma inside its field', () => {
    const fields = parseCsvFields('a,"b,c",d');
    expect(fields).toEqual(['a', 'b,c', 'd']);
  });

  it('parseCsvFields unescapes a doubled quote', () => {
    expect(parseCsvFields('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('splitCsvRecords keeps a quoted NEWLINE inside its field', () => {
    const records = splitCsvRecords('h1,h2\r\nv1,"line1\nline2"\r\nv3,v4');
    expect(records).toHaveLength(3);
    expect(parseCsvFields(records[1])[1]).toBe('line1\nline2');
  });

  it('splitCsvRecords strips a UTF-8 BOM so the first header still matches', () => {
    const withBom = `﻿Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode\r\n2026-08-22,${BROKER_ARM},1.00,USD`;
    const read = readCostExport({
      exportName: 'bom',
      partitions: [{ blobName: 'p.csv', csv: withBom }],
    });
    expect(read.schema).toBe('ea-mca');
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(1.0, 6);
  });
});

describe('column binding across agreements — no schema is silently zero', () => {
  it('binds the EA / MCA current schema', () => {
    const read = eaRun();
    expect(read.schema).toBe('ea-mca');
    expect(read.columns.cost).toBe('CostInBillingCurrency');
    expect(read.columns.resourceId).toBe('ResourceId');
  });

  it('binds the FOCUS schema and PREFERS its explicit USD column', () => {
    // Billing currency is EUR; x_BilledCostInUsd is the USD truth. A reader that
    // took BilledCost would record 10.00 EUR as 10.00 USD.
    const csv = [
      'ChargePeriodStart,ResourceId,BilledCost,EffectiveCost,BillingCurrency,x_BilledCostInUsd',
      `2026-08-22T00:00:00Z,${BROKER_ARM},10.00,10.00,EUR,11.50`,
    ].join('\n');
    const read = readCostExport({ exportName: 'focus', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.schema).toBe('focus');
    expect(read.columns.usdCost).toBe('x_BilledCostInUsd');
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(11.5, 6);
    expect(read.currencyResolution).toContain('explicit USD column');
  });

  it('binds the legacy EA schema (InstanceId / Cost / Currency)', () => {
    const csv = ['Date,InstanceId,Cost,Currency', `08/22/2026,${BROKER_ARM},5.00,USD`].join('\n');
    const read = readCostExport({ exportName: 'legacy', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.schema).toBe('legacy-ea');
    expect(read.columns.resourceId).toBe('InstanceId');
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(5.0, 6);
  });

  it('an UNRECOGNISED header is blind, not zero-cost', () => {
    const csv = ['Alpha,Beta,Gamma', '1,2,3', '4,5,6'].join('\n');
    const read = readCostExport({ exportName: 'weird', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.schema).toBe('unrecognized');
    expect(read.byResource.size).toBe(0);
    // The rows WERE examined — that is the difference between "unrecognised" and
    // "empty", and it is what stops a $0.00 being quoted over real data.
    expect(read.population.examined).toBe(2);
    expect(read.rowsSkipped).toBe(2);
    const detail = read.skipped.find((s) => s.subject === 'p.csv')?.reason ?? '';
    expect(detail).toContain('UNRECOGNISED, not zero-cost');
    // BOTH missing roles are named in one message, not just the first.
    expect(detail).toContain('no resource-id column');
    expect(detail).toContain('no cost column');
    // The header is echoed, so a reader can see what the file actually had.
    expect(detail).toContain('Alpha, Beta, Gamma');
  });

  it('names ONLY the missing role when the other one bound', () => {
    // A resource-id column present, no cost column: the message must not claim
    // the resource-id column is missing too.
    const csv = ['ResourceId,Alpha', `${BROKER_ARM},1`].join('\n');
    const read = readCostExport({ exportName: 'halfway', partitions: [{ blobName: 'p.csv', csv }] });
    const detail = read.skipped.find((s) => s.subject === 'p.csv')?.reason ?? '';
    expect(detail).toContain('no cost column');
    expect(detail).not.toContain('no resource-id column');
  });

  it('bindColumns / schemaOf are directly testable over a bare header', () => {
    expect(schemaOf(bindColumns(['ResourceId', 'BilledCost']))).toBe('focus');
    expect(schemaOf(bindColumns(['ResourceId', 'CostInBillingCurrency']))).toBe('ea-mca');
    expect(schemaOf(bindColumns(['InstanceId', 'PreTaxCost']))).toBe('legacy-ea');
    expect(schemaOf(bindColumns(['Nope']))).toBe('unrecognized');
  });
});

describe('currency — no conversion, and no mislabelling', () => {
  // POPULATION > 1, ON PURPOSE. The first version of this block tested EUR and
  // nothing else, and the mutation harness proved that was not enough: a NARROW
  // exemption — `currency === 'USD' || currency === 'GBP'` — passed the entire
  // 129-test suite (`N1-currency-exemption-for-one-currency`, SURVIVED). A guard
  // whose test has a population of one is a guard against one input. The list
  // below is what makes the mutation die.
  const NON_USD = ['EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'INR'];

  it.each(NON_USD)('SKIPS a %s row with no USD column, naming the currency', (currency) => {
    const csv = [
      'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
      `2026-08-22,${BROKER_ARM},9.99,${currency}`,
    ].join('\n');
    const read = readCostExport({
      exportName: `cur-${currency}`,
      partitions: [{ blobName: 'p.csv', csv }],
    });
    expect(read.byResource.size).toBe(0);
    expect(read.rowsSkipped).toBe(1);
    expect(read.skipped[0].reason).toContain(`'${currency}'`);
    expect(read.skipped[0].reason).toContain('refusing to convert');
  });

  it('accepts USD in any casing, so the rejection is about the CURRENCY not the spelling', () => {
    const csv = [
      'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
      `2026-08-22,${BROKER_ARM},9.99,usd`,
    ].join('\n');
    const read = readCostExport({ exportName: 'lower', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(9.99, 6);
  });

  it('SKIPS when the currency cannot be established at all', () => {
    const csv = ['Date,ResourceId,CostInBillingCurrency', `2026-08-22,${BROKER_ARM},9.99`].join('\n');
    const read = readCostExport({ exportName: 'nocur', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.byResource.size).toBe(0);
    expect(read.skipped[0].reason).toContain('billing currency not established');
  });

  it('accepts a currency-less export ONLY on explicit caller opt-in, and records it', () => {
    const csv = ['Date,ResourceId,CostInBillingCurrency', `2026-08-22,${BROKER_ARM},9.99`].join('\n');
    const read = readCostExport({
      exportName: 'nocur',
      partitions: [{ blobName: 'p.csv', csv }],
      assumeUsdWhenCurrencyAbsent: true,
    });
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(9.99, 6);
    expect(read.currencyResolution).toContain('explicit caller opt-in');
  });

  it('a non-finite cost value is skipped, not coerced to 0', () => {
    const csv = [
      'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
      `2026-08-22,${BROKER_ARM},n/a,USD`,
    ].join('\n');
    const read = readCostExport({ exportName: 'nan', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.byResource.size).toBe(0);
    expect(read.skipped[0].reason).toContain('not a finite number');
  });

  it('a row with no resource id is recorded as unattributable, not dropped silently', () => {
    const csv = [
      'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
      '2026-08-22,,120.00,USD',
    ].join('\n');
    const read = readCostExport({ exportName: 'purchase', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.byResource.size).toBe(0);
    expect(read.rowsSkipped).toBe(1);
    expect(read.skipped[0].reason).toContain('no resource id');
  });
});

describe('completeness — a partial read never reports as whole', () => {
  it("a manifest whose partitions were ALL supplied reports 'complete'", () => {
    const read = eaRun();
    expect(read.completeness).toBe('complete');
    expect(read.completenessDetail).toContain('all 1 manifest partition(s) supplied');
  });

  it("NO manifest reports 'unknown', never 'complete'", () => {
    const read = readCostExport({
      exportName: 'loom-brain-daily',
      partitions: [{ blobName: 'part_0_0001.csv', csv: EA_CSV }],
    });
    expect(read.completeness).toBe('unknown');
    expect(read.completenessDetail).toContain('UNKNOWN fraction');
  });

  it("a MISSING partition reports 'incomplete' and NAMES it", () => {
    const manifest = JSON.stringify({
      dataRowCount: 4,
      blobs: [
        { blobName: 'loom-brain/part_0_0001.csv' },
        { blobName: 'loom-brain/part_0_0002.csv' },
      ],
      runInfo: { endDate: '2026-08-22T23:59:59Z' },
    });
    const read = eaRun({ manifest });
    expect(read.completeness).toBe('incomplete');
    expect(read.completenessDetail).toContain('1 MISSING');
    expect(read.completenessDetail).toContain('part_0_0002.csv');
    expect(read.completenessDetail).toContain('PARTIAL read');
  });

  it('a ROW-COUNT mismatch downgrades an otherwise-complete run (truncated blob)', () => {
    // Every named partition supplied, but the manifest says 99 rows and 2 were
    // parsed. Name-matching alone would have called this complete.
    const manifest = JSON.stringify({
      dataRowCount: 99,
      blobs: [{ blobName: 'loom-brain/part_0_0001.csv' }],
      runInfo: { endDate: '2026-08-22T23:59:59Z' },
    });
    const read = eaRun({ manifest });
    expect(read.completeness).toBe('incomplete');
    expect(read.completenessDetail).toContain('99 data row(s) and 2 were parsed');
  });

  // POPULATION NOTE — this block exists because the case above was, on its own,
  // the ENTIRE population of the row-count cross-check, at a delta of 97.
  // (The `dataRowCount: 4` case in the missing-partition test never reaches this
  // branch: the name check has already set `incomplete`, and the cross-check is
  // guarded by `completeness === 'complete'`.) Measured 2026-08-23: relaxing the
  // check to `Math.abs(declared - parsed) > 1` — i.e. tolerating an off-by-one —
  // passed all 136 tests, RC=0. A blob truncated mid-record loses EXACTLY ONE
  // row, so delta 1 is the PRODUCTION cardinality of the partial read this
  // defence is named for, and it was the one delta never exercised.
  //
  // Parametrised rather than adding a single case, so the population is stated
  // and a future narrowing has to delete visible rows to shrink it.
  const PARSED_ROWS = 2;
  it.each([
    [1, 'one row FEWER than parsed — a manifest written before a late record'],
    [3, 'one row MORE than parsed — a blob TRUNCATED MID-RECORD (production shape)'],
    [4, 'two rows more'],
    [99, 'far more'],
  ])(
    'declared %i vs 2 parsed is INCOMPLETE (%s)',
    (declared, _why) => {
      const manifest = JSON.stringify({
        dataRowCount: declared,
        blobs: [{ blobName: 'loom-brain/part_0_0001.csv' }],
        runInfo: { endDate: '2026-08-22T23:59:59Z' },
      });
      const read = eaRun({ manifest });
      expect(read.completeness).toBe('incomplete');
      expect(read.completenessDetail).toContain(
        `${declared} data row(s) and ${PARSED_ROWS} were parsed`,
      );
      expect(read.completenessDetail).toContain('PARTIAL read');
    },
  );

  it('declared === parsed is the ONLY count that stays complete', () => {
    // The control for the block above: without this, a mutation that made the
    // cross-check always fire would look identical to a correct one.
    const manifest = JSON.stringify({
      dataRowCount: PARSED_ROWS,
      blobs: [{ blobName: 'loom-brain/part_0_0001.csv' }],
      runInfo: { endDate: '2026-08-22T23:59:59Z' },
    });
    const read = eaRun({ manifest });
    expect(read.completeness).toBe('complete');
  });

  it("an UNPARSEABLE manifest degrades to 'unknown' and does not abort the read", () => {
    const read = eaRun({ manifest: '{not json' });
    expect(read.completeness).toBe('unknown');
    expect(read.completenessDetail).toContain('did not parse');
    // The rows were still read — a bad manifest must not destroy usable data.
    expect(read.byResource.size).toBe(2);
  });

  it("a manifest with no blobs[] degrades to 'unknown'", () => {
    const read = eaRun({ manifest: JSON.stringify({ dataRowCount: 2 }) });
    expect(read.completeness).toBe('unknown');
    expect(read.completenessDetail).toContain('no blobs[] list');
  });

  it('an extra partition not listed in the manifest is also incomplete-worthy', () => {
    const read = eaRun({
      partitions: [
        { blobName: 'part_0_0001.csv', csv: EA_CSV },
        { blobName: 'part_0_9999.csv', csv: EA_CSV },
      ],
    });
    expect(read.completeness).toBe('incomplete');
    expect(read.completenessDetail).toContain('supplied but not listed');
  });

  it('completenessDetail is populated even on the happy path — a verdict never travels alone', () => {
    expect(eaRun().completenessDetail.length).toBeGreaterThan(0);
  });
});

describe('population (PRP §3.2)', () => {
  it('reports rows examined and partitions examined as SEPARATE populations', () => {
    const read = eaRun();
    expect(read.population.subject).toBe('rows');
    expect(read.population.examined).toBe(2);
    expect(read.population.blind).toBe(false);
    expect(read.partitionPopulation.subject).toBe('partitions');
    expect(read.partitionPopulation.examined).toBe(1);
  });

  it('ZERO partitions is BLIND on both populations', () => {
    const read = readCostExport({ exportName: 'nothing', partitions: [] });
    expect(read.population.blind).toBe(true);
    expect(read.partitionPopulation.blind).toBe(true);
    expect(read.byResource.size).toBe(0);
  });

  it('a partition with a header and no data rows is examined-zero, not an error', () => {
    const read = readCostExport({
      exportName: 'headeronly',
      partitions: [{ blobName: 'p.csv', csv: 'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode' }],
    });
    expect(read.population.examined).toBe(0);
    expect(read.population.blind).toBe(true);
    expect(read.partitionPopulation.blind).toBe(false);
  });

  it('rowsAttributed + rowsSkipped accounts for every row examined', () => {
    const csv = [
      'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
      `2026-08-22,${BROKER_ARM},1.00,USD`,
      `2026-08-22,${CONSOLE_ARM},2.00,EUR`,
      '2026-08-22,,3.00,USD',
    ].join('\n');
    const read = readCostExport({ exportName: 'mixed', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.population.examined).toBe(3);
    expect(read.rowsAttributed + read.rowsSkipped).toBe(read.population.examined);
  });
});

describe('the figures produced are BILLED and carry their run date', () => {
  it('every figure is source=billed', () => {
    for (const f of eaRun().byResource.values()) expect(f.source).toBe('billed');
  });

  it('renders with the billed marker', () => {
    const f = eaRun().byResource.get(BROKER_ID)!;
    expect(renderCost(f)).toContain(BILLED_MARKER);
  });

  it('carries the export name, schema and completeness in the basis', () => {
    const f = eaRun().byResource.get(BROKER_ID)!;
    expect(f.basis).toContain('loom-brain-daily');
    expect(f.basis).toContain('schema=ea-mca');
    expect(f.basis).toContain('completeness=complete');
  });

  it('states the ~24h latency rather than implying the number is live', () => {
    const f = eaRun().byResource.get(BROKER_ID)!;
    expect(f.basis).toContain('not a live feed');
    expect(f.basis).toContain('~24h');
  });

  it('takes asOf from the manifest run date', () => {
    const read = eaRun();
    expect(read.asOf).toBe('2026-08-22T23:59:59Z');
    expect(read.byResource.get(BROKER_ID)?.asOf).toBe('2026-08-22T23:59:59Z');
  });

  it('uses a LOUD marker, not a blank, when the run date was not established', () => {
    const read = readCostExport({
      exportName: 'nodate',
      partitions: [{ blobName: 'p.csv', csv: EA_CSV }],
    });
    expect(read.asOf).toBeNull();
    expect(read.byResource.get(BROKER_ID)?.asOf).toBe(ASOF_NOT_ESTABLISHED);
    expect(read.byResource.get(BROKER_ID)?.basis).toContain('run date NOT ESTABLISHED');
  });

  it('SUMS multiple rows for the same resource across partitions', () => {
    const p1 = ['Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode', `2026-08-21,${BROKER_ARM},1.00,USD`].join('\n');
    const p2 = ['Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode', `2026-08-22,${BROKER_ARM},2.50,USD`].join('\n');
    const read = readCostExport({
      exportName: 'multi',
      partitions: [
        { blobName: 'p1.csv', csv: p1 },
        { blobName: 'p2.csv', csv: p2 },
      ],
    });
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(3.5, 6);
    expect(read.byResource.get(BROKER_ID)?.basis).toContain('2 row(s) summed');
  });

  it('canonicalises resource ids so ARM casing drift does not split a resource in two', () => {
    const upper = BROKER_ARM.replace('/subscriptions/', '/SUBSCRIPTIONS/').replace(
      '/resourceGroups/',
      '/RESOURCEGROUPS/',
    );
    const csv = [
      'Date,ResourceId,CostInBillingCurrency,BillingCurrencyCode',
      `2026-08-22,${BROKER_ARM},1.00,USD`,
      `2026-08-22,${upper},2.00,USD`,
    ].join('\n');
    const read = readCostExport({ exportName: 'casing', partitions: [{ blobName: 'p.csv', csv }] });
    expect(read.byResource.size).toBe(1);
    expect(read.byResource.get(BROKER_ID)?.amountUsd).toBeCloseTo(3.0, 6);
  });
});

describe('parseManifest never throws and never invents', () => {
  it('reports a parse error rather than raising', () => {
    const facts = parseManifest('{{{');
    expect(facts.parseError).toBeTruthy();
    expect(facts.blobNames).toBeNull();
    expect(facts.dataRowCount).toBeNull();
  });

  it('returns null for every field a manifest did not carry', () => {
    const facts = parseManifest('{}');
    expect(facts.parseError).toBeNull();
    expect(facts.blobNames).toBeNull();
    expect(facts.dataRowCount).toBeNull();
    expect(facts.asOf).toBeNull();
  });

  it('falls back to submittedTime when endDate is absent', () => {
    const facts = parseManifest(JSON.stringify({ runInfo: { submittedTime: '2026-08-22T01:02:03Z' } }));
    expect(facts.asOf).toBe('2026-08-22T01:02:03Z');
  });

  it('reads blob names and the declared row count', () => {
    const facts = parseManifest(EA_MANIFEST);
    expect(facts.blobNames).toEqual(['loom-brain/part_0_0001.csv']);
    expect(facts.dataRowCount).toBe(2);
  });

  it('rejects a JSON scalar as a manifest', () => {
    expect(parseManifest('42').parseError).toContain('not a JSON object');
  });
});
