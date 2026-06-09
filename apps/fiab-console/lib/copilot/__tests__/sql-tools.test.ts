import { describe, it, expect } from 'vitest';
import {
  summarizeExplainXml,
  registerWarehouseTools,
  SYNAPSE_SCHEMA_SQL,
} from '../sql-tools';

describe('summarizeExplainXml', () => {
  it('returns empty string for empty/blank input', () => {
    expect(summarizeExplainXml('')).toBe('');
    expect(summarizeExplainXml('   ')).toBe('');
  });

  it('counts and names data-movement operations', () => {
    const xml = `<dsql_query>
      <dsql_operations>
        <dsql_operation operation_type="RND_ID"><operation_type>BroadcastMoveOperation</operation_type></dsql_operation>
        <dsql_operation operation_type="RND_ID"><operation_type>BroadcastMoveOperation</operation_type></dsql_operation>
        <dsql_operation operation_type="RND_ID"><operation_type>ShuffleMoveOperation</operation_type></dsql_operation>
        <dsql_operation operation_type="RND_ID"><operation_type>OnOperation</operation_type></dsql_operation>
        <dsql_operation operation_type="RND_ID"><operation_type>ReturnOperation</operation_type></dsql_operation>
      </dsql_operations>
    </dsql_query>`;
    const summary = summarizeExplainXml(xml);
    expect(summary).toContain('2x BroadcastMoveOperation');
    expect(summary).toContain('1x ShuffleMoveOperation');
    expect(summary).toContain('Total plan operations: 5');
  });

  it('notes the absence of data movement when there is none', () => {
    const xml = `<dsql_operations><operation_type>OnOperation</operation_type><operation_type>ReturnOperation</operation_type></dsql_operations>`;
    const summary = summarizeExplainXml(xml);
    expect(summary).toContain('No broadcast/shuffle data-movement steps detected');
    expect(summary).toContain('Total plan operations: 2');
  });
});

describe('SYNAPSE_SCHEMA_SQL', () => {
  it('reads the live catalog (sys.columns / sys.tables) — not a mock', () => {
    expect(SYNAPSE_SCHEMA_SQL).toContain('sys.columns');
    expect(SYNAPSE_SCHEMA_SQL).toContain('sys.tables');
    expect(SYNAPSE_SCHEMA_SQL).toContain('is_ms_shipped = 0');
  });
});

describe('registerWarehouseTools', () => {
  it('registers the three warehouse tools with valid JSON-schema params', () => {
    const registered: any[] = [];
    const fakeRegistry = { register: (t: any) => registered.push(t) } as any;
    registerWarehouseTools(fakeRegistry);

    const names = registered.map((t) => t.name);
    expect(names).toEqual([
      'warehouse_schema_read',
      'warehouse_explain_plan',
      'warehouse_run_query',
    ]);
    for (const t of registered) {
      expect(t.service).toBe('Warehouse');
      expect(typeof t.description).toBe('string');
      expect(t.parameters.type).toBe('object');
      expect(typeof t.handler).toBe('function');
    }
    // EXPLAIN + run tools require a sql argument.
    const explain = registered.find((t) => t.name === 'warehouse_explain_plan');
    expect(explain.parameters.required).toContain('sql');
    const run = registered.find((t) => t.name === 'warehouse_run_query');
    expect(run.parameters.required).toContain('sql');
  });
});
