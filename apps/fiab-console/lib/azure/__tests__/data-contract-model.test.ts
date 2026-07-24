/**
 * N6 — ODCS 3.1 model: validate / convert / import round-trip.
 *
 * These assert BEHAVIOUR the operator relies on:
 *   • a Loom-authored contract exports as a VALID ODCS 3.1 document;
 *   • an export→import round-trip preserves every column, quality expectation,
 *     and SLA commitment (including the rules ODCS has no library primitive for);
 *   • an INVALID document is rejected with a PRECISE per-field error naming the
 *     exact offending path — never silently accepted.
 *
 * Pure module (node env) — no Cosmos, no Azure.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENFORCEMENT_MODE,
  ODCS_API_VERSION,
  ODCS_KIND,
  bindingMatches,
  contractTrend,
  dataContractDocId,
  emptyDataContractDoc,
  fromOdcs,
  normalizeBindingKind,
  normalizeEnforcementMode,
  toOdcs,
  validateOdcs,
  withRun,
  type DataContractBinding,
  type EnforcementRun,
} from '../data-contract-model';
import type { DataContract } from '@/lib/dataproducts/contract';

const LOOM_CONTRACT: DataContract = {
  version: '2.1.0',
  schema: [
    { name: 'order_id', type: 'bigint', primaryKey: true, description: 'Order key' },
    { name: 'customer_email', type: 'string', classification: 'PII' },
    { name: 'amount', type: 'decimal' },
    { name: 'status', type: 'string' },
    { name: 'ordered_at', type: 'timestamp', nullable: true },
  ],
  slo: {
    freshness: 'Hourly',
    availability: '99.9%',
    retention: '7 years',
    supportResponse: '4 hours',
  },
  quality: [
    { id: 'q1', column: 'order_id', rule: 'primary_key', severity: 'error' },
    { id: 'q2', column: 'customer_email', rule: 'regex', value: '^[^@]+@[^@]+$', severity: 'error' },
    { id: 'q3', column: 'amount', rule: 'min', value: '0', severity: 'error' },
    { id: 'q4', column: 'status', rule: 'accepted_values', value: 'new,paid,shipped', severity: 'warning' },
    { id: 'q5', rule: 'row_count', value: '1', severity: 'error' },
  ],
};

const META = { id: 'contract-orders', name: 'Orders contract', objectName: 'dbo.Orders' };

describe('toOdcs — a Loom contract exports as a valid ODCS 3.1 document', () => {
  it('emits the required fundamentals', () => {
    const odcs = toOdcs(LOOM_CONTRACT, META);
    expect(odcs.apiVersion).toBe(ODCS_API_VERSION);
    expect(odcs.kind).toBe(ODCS_KIND);
    expect(odcs.id).toBe('contract-orders');
    expect(odcs.version).toBe('2.1.0');
    expect(odcs.status).toBe('draft');
  });

  it('passes its own validator', () => {
    const result = validateOdcs(toOdcs(LOOM_CONTRACT, META));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('maps columns onto ODCS properties with logical + physical types', () => {
    const odcs = toOdcs(LOOM_CONTRACT, META);
    const props = odcs.schema?.[0]?.properties ?? [];
    expect(props.map((p) => p.name)).toEqual(['order_id', 'customer_email', 'amount', 'status', 'ordered_at']);
    const orderId = props.find((p) => p.name === 'order_id')!;
    expect(orderId.logicalType).toBe('integer');
    expect(orderId.physicalType).toBe('bigint');
    expect(orderId.primaryKey).toBe(true);
    // ODCS `required` is the inverse of the designer's `nullable`.
    expect(orderId.required).toBe(true);
    expect(props.find((p) => p.name === 'ordered_at')!.required).toBe(false);
    expect(props.find((p) => p.name === 'customer_email')!.classification).toBe('PII');
  });

  it('uses ODCS library rules where one maps exactly and `custom` otherwise', () => {
    const odcs = toOdcs(LOOM_CONTRACT, META);
    const props = odcs.schema?.[0]?.properties ?? [];
    const statusRule = props.find((p) => p.name === 'status')!.quality![0];
    expect(statusRule.type).toBe('library');
    expect(statusRule.rule).toBe('invalidValues');
    expect(statusRule.validValues).toEqual(['new', 'paid', 'shipped']);

    const emailRule = props.find((p) => p.name === 'customer_email')!.quality![0];
    expect(emailRule.type).toBe('custom');
    expect(emailRule.engine).toBe('loom');
    expect(emailRule.implementation).toBe('regex:^[^@]+@[^@]+$');
  });

  it('puts table-scoped expectations on the schema object, not a property', () => {
    const odcs = toOdcs(LOOM_CONTRACT, META);
    const objectRules = odcs.schema?.[0]?.quality ?? [];
    expect(objectRules).toHaveLength(1);
    expect(objectRules[0].rule).toBe('rowCount');
  });

  it('emits slaProperties for every committed SLO', () => {
    const odcs = toOdcs(LOOM_CONTRACT, META);
    const byProp = Object.fromEntries((odcs.slaProperties ?? []).map((s) => [s.property, s.value]));
    expect(byProp.frequency).toBe('Hourly');
    expect(byProp.availability).toBe('99.9%');
    expect(byProp.retention).toBe('7 years');
    expect(byProp.supportResponse).toBe('4 hours');
    expect(byProp.latency).toBeUndefined();
  });
});

describe('fromOdcs — import round-trip is lossless', () => {
  it('restores every column, expectation, and SLO', () => {
    const odcs = toOdcs(LOOM_CONTRACT, META);
    const back = fromOdcs(odcs);

    expect(back.version).toBe('2.1.0');
    expect(back.schema?.map((c) => `${c.name}:${c.type}`)).toEqual([
      'order_id:bigint', 'customer_email:string', 'amount:decimal', 'status:string', 'ordered_at:timestamp',
    ]);
    expect(back.schema?.find((c) => c.name === 'order_id')?.primaryKey).toBe(true);
    expect(back.schema?.find((c) => c.name === 'ordered_at')?.nullable).toBe(true);
    expect(back.schema?.find((c) => c.name === 'customer_email')?.classification).toBe('PII');

    const rules = (back.quality ?? []).map((q) => `${q.column ?? ''}|${q.rule}|${q.value ?? ''}|${q.severity}`).sort();
    expect(rules).toEqual([
      'amount|min|0|error',
      'customer_email|regex|^[^@]+@[^@]+$|error',
      'order_id|primary_key||error',
      'status|accepted_values|new,paid,shipped|warning',
      // Table-scoped expectation — no column, so it sorts last ('|' > letters).
      '|row_count|1|error',
    ]);

    expect(back.slo).toMatchObject({
      freshness: 'Hourly', availability: '99.9%', retention: '7 years', supportResponse: '4 hours',
    });
  });

  it('recovers Loom rules from a third-party document with no Loom customProperties', () => {
    const back = fromOdcs({
      apiVersion: ODCS_API_VERSION,
      kind: ODCS_KIND,
      id: 'external',
      version: '1.0.0',
      status: 'active',
      schema: [{
        name: 'tbl',
        logicalType: 'object',
        properties: [
          { name: 'a', logicalType: 'string', quality: [{ type: 'library', rule: 'nullValues', mustBe: 0, severity: 'error' }] },
          { name: 'b', logicalType: 'string', quality: [{ type: 'library', rule: 'invalidValues', validValues: ['x', 'y'] }] },
        ],
      }],
    });
    const rules = (back.quality ?? []).map((q) => `${q.column}|${q.rule}|${q.value ?? ''}`);
    expect(rules).toContain('a|not_null|');
    expect(rules).toContain('b|accepted_values|x,y');
  });
});

describe('validateOdcs — never silently accepts', () => {
  it('rejects a non-object document', () => {
    const r = validateOdcs('not a contract');
    expect(r.ok).toBe(false);
    expect(r.contract).toBeUndefined();
    expect(r.errors[0].message).toMatch(/must be a JSON object/);
  });

  it('names every missing required fundamental', () => {
    const r = validateOdcs({});
    expect(r.ok).toBe(false);
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['apiVersion', 'kind', 'id', 'version', 'status']));
  });

  it('rejects a non-v3 apiVersion and a wrong kind with a precise message', () => {
    const r = validateOdcs({ apiVersion: 'v2.2.2', kind: 'DataProduct', id: 'x', version: '1.0.0', status: 'active' });
    const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e.message]));
    expect(byPath.apiVersion).toMatch(/v3\.x/);
    expect(byPath.kind).toMatch(/DataContract/);
  });

  it('rejects a non-semver version and an unknown status, listing the allowed statuses', () => {
    const r = validateOdcs({ apiVersion: ODCS_API_VERSION, kind: ODCS_KIND, id: 'x', version: 'one', status: 'live' });
    const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e.message]));
    expect(byPath.version).toMatch(/MAJOR\.MINOR\.PATCH/);
    expect(byPath.status).toMatch(/proposed, draft, active, deprecated, retired/);
  });

  it('points at the exact property that carries an invalid logical type', () => {
    const r = validateOdcs({
      apiVersion: ODCS_API_VERSION, kind: ODCS_KIND, id: 'x', version: '1.0.0', status: 'draft',
      schema: [{
        name: 'tbl', logicalType: 'object',
        properties: [
          { name: 'ok', logicalType: 'string' },
          { name: 'bad', logicalType: 'varchar' },
        ],
      }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].path).toBe('schema[0].properties[1].logicalType');
    expect(r.errors[0].message).toMatch(/'varchar' is not a valid ODCS logical type/);
  });

  it('requires `rule` on a library quality entry and names its path', () => {
    const r = validateOdcs({
      apiVersion: ODCS_API_VERSION, kind: ODCS_KIND, id: 'x', version: '1.0.0', status: 'draft',
      schema: [{ name: 't', logicalType: 'object', properties: [{ name: 'c', logicalType: 'string', quality: [{ type: 'library' }] }] }],
    });
    expect(r.errors.map((e) => e.path)).toContain('schema[0].properties[0].quality[0].rule');
  });

  it('requires a value on every SLA property and names its index', () => {
    const r = validateOdcs({
      apiVersion: ODCS_API_VERSION, kind: ODCS_KIND, id: 'x', version: '1.0.0', status: 'draft',
      slaProperties: [{ property: 'latency', value: 4, unit: 'd' }, { property: 'retention' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].path).toBe('slaProperties[1].value');
    expect(r.errors[0].message).toMatch(/retention/);
  });

  it('accepts a well-formed third-party document and normalizes it', () => {
    const r = validateOdcs({
      apiVersion: 'v3.1.0', kind: 'DataContract', id: '  orders  ', version: '1.2.3', status: 'active',
      name: 'Orders', domain: 'sales', description: { purpose: 'Sell things' },
      slaProperties: [{ property: 'latency', value: 4, unit: 'd', element: 'tbl.ts' }],
      schema: [{ name: 'tbl', logicalType: 'object', properties: [{ name: 'c', logicalType: 'date', required: true }] }],
      tags: ['gold'],
    });
    expect(r.ok).toBe(true);
    expect(r.contract!.id).toBe('orders');
    expect(r.contract!.domain).toBe('sales');
    expect(r.contract!.description).toEqual({ purpose: 'Sell things' });
    expect(r.contract!.slaProperties![0]).toEqual({ property: 'latency', value: 4, unit: 'd', element: 'tbl.ts' });
    expect(r.contract!.tags).toEqual(['gold']);
  });
});

describe('registry doc helpers', () => {
  it('defaults a brand-new contract to enforcement ON in the SAFE mode', () => {
    const doc = emptyDataContractDoc('oid-1', 'item-1', 'Orders', 'a@b.c');
    expect(doc.id).toBe(dataContractDocId('item-1'));
    expect(doc.enforcement.enabled).toBe(true);
    expect(doc.enforcement.mode).toBe('warn-quarantine');
    expect(doc.enforcement.mode).toBe(DEFAULT_ENFORCEMENT_MODE);
  });

  it('coerces an unknown enforcement mode back to the SAFE default', () => {
    expect(normalizeEnforcementMode('hard-reject')).toBe('hard-reject');
    expect(normalizeEnforcementMode('drop-everything')).toBe('warn-quarantine');
    expect(normalizeEnforcementMode(undefined)).toBe('warn-quarantine');
  });

  it('only recognizes the three real ingestion paths as binding kinds', () => {
    expect(normalizeBindingKind('mirrored-database')).toBe('mirrored-database');
    expect(normalizeBindingKind('data-pipeline')).toBe('data-pipeline');
    expect(normalizeBindingKind('eventstream')).toBe('eventstream');
    expect(normalizeBindingKind('lakehouse')).toBeNull();
  });

  it('matches a binding by kind + target + dataset, with `*` as every dataset', () => {
    const base: DataContractBinding = {
      id: 'b1', kind: 'mirrored-database', targetItemId: 'mir-1', dataset: 'dbo.Orders',
      enabled: true, boundAt: '', boundBy: '',
    };
    expect(bindingMatches(base, 'mirrored-database', 'mir-1', 'dbo.Orders')).toBe(true);
    expect(bindingMatches(base, 'mirrored-database', 'mir-1', 'DBO.ORDERS')).toBe(true);
    expect(bindingMatches(base, 'mirrored-database', 'mir-1', 'dbo.Customers')).toBe(false);
    expect(bindingMatches(base, 'eventstream', 'mir-1', 'dbo.Orders')).toBe(false);
    expect(bindingMatches({ ...base, dataset: '*' }, 'mirrored-database', 'mir-1', 'anything')).toBe(true);
    expect(bindingMatches({ ...base, enabled: false }, 'mirrored-database', 'mir-1', 'dbo.Orders')).toBe(false);
  });

  it('computes the pass/fail trend from the run history', () => {
    const run = (decision: EnforcementRun['decision'], evaluated: number, rejected: number): EnforcementRun => ({
      id: `${decision}-${evaluated}`, at: new Date().toISOString(), source: 'mirrored-database',
      targetItemId: 'm', dataset: 'dbo.Orders', mode: 'warn-quarantine',
      evaluated, accepted: evaluated - rejected, rejected, decision, alerted: rejected > 0,
    });
    let doc = emptyDataContractDoc('oid', 'item', 'Orders', 'a@b.c');
    doc = withRun(doc, run('landed', 100, 0));
    doc = withRun(doc, run('landed-with-quarantine', 100, 10));
    doc = withRun(doc, run('rejected-batch', 100, 100));

    const trend = contractTrend(doc);
    expect(trend.runs).toBe(3);
    expect(trend.clean).toBe(1);
    expect(trend.quarantined).toBe(1);
    expect(trend.rejected).toBe(1);
    expect(trend.rowsEvaluated).toBe(300);
    expect(trend.rowsRejected).toBe(110);
    expect(trend.passRate).toBeCloseTo(190 / 300, 5);
    // Newest first.
    expect(doc.runs[0].decision).toBe('rejected-batch');
  });
});
