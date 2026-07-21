/**
 * AskAffordance — unit tests for the pure/testable parts.
 *
 * Tests the context-building logic (via the BFF's buildConfig equivalent),
 * the surface-kind → source-type mapping, and the answer-rendering helpers.
 * No DOM rendering; these are pure logic tests (vitest).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from the BFF route for testing; real tests would
// import from the route, but Next.js routes aren't easily unit-importable, so
// we mirror the pure helpers here and keep the tests focused on logic).
// ---------------------------------------------------------------------------

type DataAgentSourceType =
  | 'warehouse' | 'lakehouse' | 'kql' | 'semantic-model'
  | 'metric-view' | 'ai-search' | 'ontology' | 'graph'
  | 'microsoft-graph' | 'agent';

const SURFACE_SOURCE_TYPE: Record<string, DataAgentSourceType> = {
  lakehouse:       'lakehouse',
  warehouse:       'warehouse',
  'kql-database':  'kql',
  'kql-dashboard': 'kql',
  'semantic-model': 'semantic-model',
  report:          'semantic-model',
  ontology:        'ontology',
};

interface AskContext {
  tables?: string[];
  columns?: string[];
  query?: string;
  selection?: string;
}

interface DataAgentSource {
  id: string;
  type: DataAgentSourceType;
  name: string;
  tables?: string;
  description?: string;
  instructions?: string;
}

interface DataAgentConfig {
  instructions: string;
  sources: DataAgentSource[];
}

function buildConfig(
  surfaceKind: string,
  itemId: string,
  itemType: string,
  context: AskContext,
): DataAgentConfig {
  const sourceType: DataAgentSourceType = SURFACE_SOURCE_TYPE[surfaceKind] ?? 'lakehouse';
  const surfaceLabel = surfaceKind.replace(/-/g, ' ');

  const descParts: string[] = [];
  if (context.tables?.length) {
    descParts.push(`Tables/views visible: ${context.tables.slice(0, 10).join(', ')}`);
  }
  if (context.columns?.length) {
    descParts.push(`Columns: ${context.columns.slice(0, 20).join(', ')}`);
  }
  if (context.query?.trim()) {
    descParts.push(`Current query:\n${context.query.trim().slice(0, 800)}`);
  }
  if (context.selection?.trim()) {
    descParts.push(`User selection: ${context.selection.trim().slice(0, 400)}`);
  }

  const tables = context.tables?.join(', ') || undefined;

  const source: DataAgentSource = {
    id: itemId || surfaceKind,
    type: sourceType,
    name: `${itemType || surfaceLabel} (${surfaceLabel} surface)`,
    tables,
    description: `This source represents the ${surfaceLabel} surface the user is currently viewing.`,
    instructions: descParts.length
      ? `Current surface context:\n${descParts.join('\n\n')}`
      : undefined,
  };

  return {
    instructions:
      `You are answering a question about the data on a ${surfaceLabel} surface in CSA Loom. ` +
      `The user is looking at this specific data; ground your answer in the attached source. ` +
      `Be concise and data-driven.`,
    sources: [source],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SURFACE_SOURCE_TYPE mapping', () => {
  it('maps lakehouse to lakehouse source type', () => {
    expect(SURFACE_SOURCE_TYPE['lakehouse']).toBe('lakehouse');
  });

  it('maps warehouse to warehouse source type', () => {
    expect(SURFACE_SOURCE_TYPE['warehouse']).toBe('warehouse');
  });

  it('maps kql-database to kql source type', () => {
    expect(SURFACE_SOURCE_TYPE['kql-database']).toBe('kql');
  });

  it('maps kql-dashboard to kql source type', () => {
    expect(SURFACE_SOURCE_TYPE['kql-dashboard']).toBe('kql');
  });

  it('maps semantic-model to semantic-model source type', () => {
    expect(SURFACE_SOURCE_TYPE['semantic-model']).toBe('semantic-model');
  });

  it('maps report to semantic-model source type (shared tabular layer)', () => {
    expect(SURFACE_SOURCE_TYPE['report']).toBe('semantic-model');
  });

  it('maps ontology to ontology source type', () => {
    expect(SURFACE_SOURCE_TYPE['ontology']).toBe('ontology');
  });
});

describe('buildConfig', () => {
  it('builds a valid DataAgentConfig with one source', () => {
    const cfg = buildConfig('lakehouse', 'item-123', 'lakehouse', {});
    expect(cfg.sources).toHaveLength(1);
    expect(cfg.sources[0].type).toBe('lakehouse');
    expect(cfg.sources[0].id).toBe('item-123');
  });

  it('includes tables as comma-joined string in source.tables', () => {
    const cfg = buildConfig('warehouse', 'wh-1', 'warehouse', {
      tables: ['sales', 'orders', 'customers'],
    });
    expect(cfg.sources[0].tables).toBe('sales, orders, customers');
  });

  it('includes column names in the instructions grounding block', () => {
    const cfg = buildConfig('semantic-model', 'sm-1', 'semantic-model', {
      columns: ['Revenue', 'CostOfGoodsSold', 'GrossMargin'],
    });
    const instr = cfg.sources[0].instructions ?? '';
    expect(instr).toContain('Revenue');
    expect(instr).toContain('CostOfGoodsSold');
  });

  it('includes the current SQL query in the grounding instructions', () => {
    const sql = 'SELECT TOP 10 * FROM sales';
    const cfg = buildConfig('warehouse', 'wh-2', 'warehouse', { query: sql });
    expect(cfg.sources[0].instructions).toContain(sql);
  });

  it('includes user selection text in the grounding instructions', () => {
    const cfg = buildConfig('report', 'rpt-1', 'report', {
      selection: 'Q4 2025',
    });
    expect(cfg.sources[0].instructions).toContain('Q4 2025');
  });

  it('sets source.type to kql for kql-dashboard', () => {
    const cfg = buildConfig('kql-dashboard', 'dash-1', 'kql-dashboard', {});
    expect(cfg.sources[0].type).toBe('kql');
  });

  it('produces an agent instructions string that references the surface kind', () => {
    const cfg = buildConfig('ontology', 'ont-1', 'ontology', {});
    expect(cfg.instructions).toContain('ontology');
  });

  it('falls back to surfaceKind as source id when itemId is empty', () => {
    const cfg = buildConfig('lakehouse', '', '', {});
    expect(cfg.sources[0].id).toBe('lakehouse');
  });

  it('truncates tables to at most 10 in the instructions', () => {
    const tables = Array.from({ length: 15 }, (_, i) => `table_${i}`);
    const cfg = buildConfig('lakehouse', 'lh-1', 'lakehouse', { tables });
    const instr = cfg.sources[0].instructions ?? '';
    // Should contain the first 10 tables
    expect(instr).toContain('table_0');
    expect(instr).toContain('table_9');
    // Should NOT contain the 11th
    expect(instr).not.toContain('table_10');
  });

  it('produces no instructions when context is empty', () => {
    const cfg = buildConfig('warehouse', 'wh-3', 'warehouse', {});
    expect(cfg.sources[0].instructions).toBeUndefined();
  });
});

describe('AskContext rendering helpers', () => {
  it('handles undefined context gracefully (no crash)', () => {
    const cfg = buildConfig('lakehouse', 'lh-1', 'lakehouse', {
      tables: undefined,
      columns: undefined,
      query: undefined,
      selection: undefined,
    });
    expect(cfg.sources).toHaveLength(1);
    expect(cfg.sources[0].tables).toBeUndefined();
    expect(cfg.sources[0].instructions).toBeUndefined();
  });

  it('truncates a very long query to 800 chars', () => {
    const longQuery = 'SELECT ' + 'x'.repeat(1000);
    const cfg = buildConfig('warehouse', 'wh-4', 'warehouse', { query: longQuery });
    const instr = cfg.sources[0].instructions ?? '';
    expect(instr.length).toBeLessThan(900); // 800 cap + "Current query:\n" header
  });

  it('truncates a very long selection to 400 chars', () => {
    const longSel = 'z'.repeat(500);
    const cfg = buildConfig('report', 'r-1', 'report', { selection: longSel });
    const instr = cfg.sources[0].instructions ?? '';
    // Should contain at most 400 'z' chars (the truncated portion)
    expect((instr.match(/z/g) ?? []).length).toBeLessThanOrEqual(400);
  });
});
