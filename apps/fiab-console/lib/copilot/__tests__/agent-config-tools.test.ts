import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Azure-backed clients so fetchSourceSchema's gate/non-network paths
// are unit-testable without live backends. The SQL/KQL/Search happy paths are
// covered by the live E2E receipt in the PR (per no-vaporware.md).
vi.mock('../../azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn(async () => ({ endpoint: 'https://aoai.example', deployment: 'gpt-4o', apiVersion: '2024-10-21' })),
  NoAoaiDeploymentError: class NoAoaiDeploymentError extends Error {},
}));
vi.mock('../../azure/cloud-endpoints', () => ({ cogScope: () => 'https://cognitiveservices.azure.com/.default' }));
vi.mock('../../azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(),
  dedicatedTarget: vi.fn(() => ({ server: 'd', database: 'dw' })),
  serverlessTarget: vi.fn((db: string) => ({ server: 's', database: db })),
}));
vi.mock('../../azure/kusto-client', () => ({
  listTableDetails: vi.fn(),
  getTableSchema: vi.fn(),
  kustoConfigGate: vi.fn(() => ({ missing: 'LOOM_KUSTO_CLUSTER_URI' })),
  defaultDatabase: vi.fn(() => 'db'),
  clusterUri: vi.fn(() => 'https://adx.example'),
}));
vi.mock('../../azure/search-index-client', () => ({
  getIndex: vi.fn(),
  searchConfigGate: vi.fn(() => ({ missing: 'LOOM_AI_SEARCH_SERVICE' })),
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));

import {
  parseSuggestion,
  buildUserMessage,
  fetchSourceSchema,
  mergeSuggestionIntoSources,
  mergeInstructions,
  descriptionsToBlock,
} from '../agent-config-tools';
import type { DataAgentSource } from '../../azure/data-agent-client';

const src = (over: Partial<DataAgentSource>): DataAgentSource => ({
  id: 's1', type: 'warehouse', name: 'dw', ...over,
});

describe('buildUserMessage', () => {
  it('includes the source type, name and the schema block', () => {
    const m = buildUserMessage(src({ type: 'kql', name: 'logs', tables: 'Events, Spans' }), 'Table Events: ts datetime, lvl string');
    expect(m).toContain('type: kql');
    expect(m).toContain('name: logs');
    expect(m).toContain('selected tables: Events, Spans');
    expect(m).toContain('## Schema');
    expect(m).toContain('Table Events: ts datetime');
  });
  it('marks all-tables when none selected', () => {
    expect(buildUserMessage(src({}), 'x')).toContain('selected tables: (all)');
  });
});

describe('parseSuggestion', () => {
  it('parses a fenced json block into examples + descriptions', () => {
    const content = 'Here you go.\n```json\n' +
      JSON.stringify({
        examples: [{ question: 'Total sales?', query: 'SELECT SUM(amount) FROM fact_sales' }],
        descriptions: { fact_sales: { amount: 'Line-item sale amount in USD.' } },
      }) + '\n```';
    const s = parseSuggestion(content, 'schema');
    expect(s.examples).toHaveLength(1);
    expect(s.examples[0].query).toContain('SELECT SUM');
    expect(s.descriptions.fact_sales.amount).toContain('USD');
    expect(s.schemaUsed).toBe('schema');
    expect(s.gate).toBeUndefined();
  });

  it('drops example pairs missing a question or query', () => {
    const content = '```json\n' + JSON.stringify({
      examples: [{ question: 'q', query: '' }, { question: '', query: 'SELECT 1' }, { question: 'ok', query: 'SELECT 2' }],
      descriptions: {},
    }) + '\n```';
    const s = parseSuggestion(content, 'sc');
    expect(s.examples).toHaveLength(1);
    expect(s.examples[0].question).toBe('ok');
  });

  it('returns a gate when the model emits {gate}', () => {
    const s = parseSuggestion('```json\n{"gate":"no schema"}\n```', 'sc');
    expect(s.gate).toBe('no schema');
    expect(s.examples).toHaveLength(0);
  });

  it('returns a non-crashing gate on malformed JSON', () => {
    const s = parseSuggestion('not json at all', 'sc');
    expect(s.gate).toBeTruthy();
    expect(s.examples).toHaveLength(0);
  });

  it('gates when there are neither examples nor descriptions', () => {
    const s = parseSuggestion('```json\n{"examples":[],"descriptions":{}}\n```', 'sc');
    expect(s.gate).toBeTruthy();
  });
});

describe('fetchSourceSchema gates (no network)', () => {
  it('gates semantic-model with a Power BI Verified Answers note', async () => {
    const r = await fetchSourceSchema(src({ type: 'semantic-model' }));
    expect(r.schemaText).toBe('');
    expect(r.gate).toMatch(/Verified Answers/i);
  });
  it('gates ontology / graph (no column schema)', async () => {
    for (const type of ['ontology', 'graph'] as const) {
      const r = await fetchSourceSchema(src({ type }));
      expect(r.gate).toMatch(/queried whole/i);
    }
  });
  it('gates KQL when ADX is not configured', async () => {
    const r = await fetchSourceSchema(src({ type: 'kql', name: 'logs' }));
    expect(r.gate).toMatch(/ADX not configured/i);
    expect(r.gate).toContain('LOOM_KUSTO_CLUSTER_URI');
  });
  it('gates AI Search when the service is not configured', async () => {
    const r = await fetchSourceSchema(src({ type: 'ai-search', name: 'idx' }));
    expect(r.gate).toMatch(/AI Search not configured/i);
    expect(r.gate).toContain('LOOM_AI_SEARCH_SERVICE');
  });
});

describe('fetchSourceSchema warehouse (mocked TDS)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('builds a compact table→columns schema text from INFORMATION_SCHEMA rows', async () => {
    const { executeQuery } = await import('../../azure/synapse-sql-client');
    (executeQuery as any).mockResolvedValue({
      columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH'],
      rows: [
        ['dbo', 'fact_sales', 'amount', 'decimal', null],
        ['dbo', 'fact_sales', 'region', 'varchar', 50],
      ],
      rowCount: 2,
    });
    const r = await fetchSourceSchema(src({ type: 'warehouse', name: 'dw', tables: 'fact_sales' }));
    expect(r.gate).toBeUndefined();
    expect(r.schemaText).toContain('Table fact_sales:');
    expect(r.schemaText).toContain('amount decimal');
    expect(r.schemaText).toContain('region varchar(50)');
    // filtered to the selected table
    const sql = (executeQuery as any).mock.calls[0][1] as string;
    expect(sql).toContain("TABLE_NAME IN ('fact_sales')");
  });
  it('gates when no columns are returned', async () => {
    const { executeQuery } = await import('../../azure/synapse-sql-client');
    (executeQuery as any).mockResolvedValue({ columns: [], rows: [], rowCount: 0 });
    const r = await fetchSourceSchema(src({ type: 'warehouse', name: 'dw' }));
    expect(r.gate).toMatch(/No tables\/columns/i);
  });
});

describe('mergeInstructions + descriptionsToBlock', () => {
  it('appends a descriptions block under markers', () => {
    const out = mergeInstructions('## General knowledge\nfoo', { t: { c: 'desc' } });
    expect(out).toContain('loom:field-descriptions:start');
    expect(out).toContain('### t');
    expect(out).toContain('- c: desc');
    expect(out).toContain('## General knowledge');
  });
  it('replaces a prior descriptions block (idempotent re-merge)', () => {
    const first = mergeInstructions('base', { t: { a: 'old' } });
    const second = mergeInstructions(first, { t: { a: 'new' } });
    expect(second).toContain('- a: new');
    expect(second).not.toContain('- a: old');
    // only one block
    expect(second.match(/loom:field-descriptions:start/g)).toHaveLength(1);
  });
  it('descriptionsToBlock renders tables + columns', () => {
    const b = descriptionsToBlock({ Orders: { id: 'pk', total: 'amount' } });
    expect(b).toContain('### Orders');
    expect(b).toContain('- id: pk');
    expect(b).toContain('- total: amount');
  });
});

describe('mergeSuggestionIntoSources', () => {
  const sources = [
    { id: 's1', type: 'warehouse', name: 'dw', instructions: 'keep', examples: [] },
    { id: 's2', type: 'kql', name: 'logs' },
  ];
  it('applies examples + descriptions to the matching source only', () => {
    const out = mergeSuggestionIntoSources(sources, 's1', {
      examples: [{ question: 'q', query: 'SELECT 1' }],
      descriptions: { fact: { col: 'a column' } },
    });
    const s1: any = out.find((s) => (s as any).id === 's1');
    const s2: any = out.find((s) => (s as any).id === 's2');
    expect(s1.examples).toEqual([{ question: 'q', query: 'SELECT 1' }]);
    expect(s1.instructions).toContain('- col: a column');
    expect(s1.fieldDescriptions).toEqual({ fact: { col: 'a column' } });
    // untouched source
    expect(s2.name).toBe('logs');
    expect(s2.examples).toBeUndefined();
  });
  it('drops empty example pairs on merge', () => {
    const out = mergeSuggestionIntoSources(sources, 's1', {
      examples: [{ question: '', query: 'x' }, { question: 'ok', query: 'SELECT 2' }],
    });
    const s1: any = out.find((s) => (s as any).id === 's1');
    expect(s1.examples).toHaveLength(1);
    expect(s1.examples[0].question).toBe('ok');
  });
});
