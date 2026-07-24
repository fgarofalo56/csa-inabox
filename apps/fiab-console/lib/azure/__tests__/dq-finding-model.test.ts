import { describe, it, expect } from 'vitest';
import {
  buildDqFinding,
  findingId,
  findingKey,
  severityForRule,
  DQ_FINDING_SCHEMA_VERSION,
  type BuildFindingInput,
} from '../dq-finding-model';

const base: BuildFindingInput = {
  tenantId: 't1',
  itemId: 'item1',
  itemType: 'data-quality',
  runId: 'run-1',
  source: 'rule-check',
  severity: 'error',
  checkKey: 'chk-1',
  target: { engine: 'synapse', table: 'orders', column: 'id' },
  title: 'x',
  detail: 'y',
  createdBy: 'me@example.com',
};

describe('findingId / findingKey', () => {
  it('is deterministic and idempotent per run+source+check', () => {
    expect(findingId('run-1', 'rule-check', 'chk-1')).toBe(findingId('run-1', 'rule-check', 'chk-1'));
    expect(findingKey('anomaly', 'chk 1/2')).toBe('anomaly:chk_1_2');
  });

  it('separates sources of the same check into distinct findings', () => {
    expect(findingId('run-1', 'rule-check', 'chk-1')).not.toBe(findingId('run-1', 'anomaly', 'chk-1'));
  });
});

describe('buildDqFinding', () => {
  it('stamps the current schema version and status open', () => {
    const f = buildDqFinding(base);
    expect(f.schemaVersion).toBe(DQ_FINDING_SCHEMA_VERSION);
    expect(f.status).toBe('open');
    expect(f.docType).toBe('dq-finding');
    expect(f.id).toBe(findingId('run-1', 'rule-check', 'chk-1'));
  });

  it('is idempotent — same inputs produce the same id (upsert, not duplicate)', () => {
    expect(buildDqFinding(base).id).toBe(buildDqFinding({ ...base, at: '2020-01-01T00:00:00Z' }).id);
  });

  it('carries the metric snapshot N17 consumes', () => {
    const f = buildDqFinding({ ...base, source: 'anomaly', metric: { name: 'violation-rows', value: 40, baselineMean: 0.4, zScore: 80 } });
    expect(f.metric?.value).toBe(40);
    expect(f.metric?.zScore).toBe(80);
  });
});

describe('severityForRule', () => {
  it('maps rule severities', () => {
    expect(severityForRule('error')).toBe('error');
    expect(severityForRule('warning')).toBe('warning');
  });
});
