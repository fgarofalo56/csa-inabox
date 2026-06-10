/**
 * Vitest — IQ MCP tool catalog + dispatcher (lib/azure/iq-mcp-tools.ts).
 *
 * Exercises the SERVER side of the unified Fabric IQ MCP surface without Cosmos
 * or ADX: the backend module (iq-mcp.ts) is mocked so we assert the catalog
 * shape, argument validation, tenant pass-through, and error mapping the route
 * relies on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the real backend so the dispatcher can be tested in isolation.
vi.mock('../iq-mcp', () => ({
  getIqOverview: vi.fn(async (tenantId: string) => ({ tenantId, ontologies: [], semanticModels: [], signals: { available: false }, generatedAt: 'now' })),
  listIqOntologies: vi.fn(async () => [{ id: 'o1', name: 'Ont', entityCount: 2, bindingCount: 0 }]),
  getIqOntology: vi.fn(async (_t: string, id: string) => (id === 'missing' ? null : { id, name: 'Ont', entityCount: 1, bindingCount: 0, entities: [], relationships: [], bindings: [] })),
  listIqSemanticModels: vi.fn(async () => [{ id: 's1', name: 'Model', tableCount: 3, measureCount: 5, relationshipCount: 1 }]),
  getIqSemanticModel: vi.fn(async (_t: string, id: string) => (id === 'missing' ? null : { id, name: 'Model', tableCount: 1, measureCount: 1, relationshipCount: 0, tables: [], measures: [], relationships: [] })),
  listIqSignalTables: vi.fn(async () => ({ database: 'db', tables: [{ name: 'Telemetry' }] })),
  queryIqSignals: vi.fn(async (kql: string) => ({ database: 'db', columns: ['c'], rows: [[1]], rowCount: 1, _echo: kql })),
  searchIq: vi.fn(async (_t: string, term: string) => [{ layer: 'ontology', kind: 'entity', name: term, itemId: 'o1', itemName: 'Ont' }]),
}));

import { IQ_MCP_TOOLS, callIqTool } from '../iq-mcp-tools';
import * as backend from '../iq-mcp';

const TENANT = 'tenant-abc';

function parse(res: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(res.content[0].text);
}

describe('IQ_MCP_TOOLS catalog', () => {
  it('exposes the unified ontology + semantic + signals tool surface', () => {
    const names = IQ_MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'iq_overview',
        'iq_search',
        'iq_list_ontologies',
        'iq_get_ontology',
        'iq_list_semantic_models',
        'iq_get_semantic_model',
        'iq_list_signal_tables',
        'iq_query_signals',
      ]),
    );
  });

  it('every tool has a description and a valid JSON-schema inputSchema', () => {
    for (const t of IQ_MCP_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.inputSchema.properties).toBe('object');
    }
  });

  it('id/term/kql tools declare their required args', () => {
    const byName = Object.fromEntries(IQ_MCP_TOOLS.map((t) => [t.name, t]));
    expect(byName.iq_get_ontology.inputSchema.required).toContain('id');
    expect(byName.iq_get_semantic_model.inputSchema.required).toContain('id');
    expect(byName.iq_search.inputSchema.required).toContain('term');
    expect(byName.iq_query_signals.inputSchema.required).toContain('kql');
  });
});

describe('callIqTool dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('iq_overview passes the tenant through to the backend', async () => {
    const out = parse(await callIqTool('iq_overview', {}, TENANT));
    expect(out.tenantId).toBe(TENANT);
    expect(backend.getIqOverview).toHaveBeenCalledWith(TENANT);
  });

  it('iq_list_ontologies returns the ontology summaries', async () => {
    const out = parse(await callIqTool('iq_list_ontologies', {}, TENANT));
    expect(out[0].id).toBe('o1');
  });

  it('iq_get_ontology requires an id', async () => {
    await expect(callIqTool('iq_get_ontology', {}, TENANT)).rejects.toThrow(/id is required/);
  });

  it('iq_get_ontology surfaces not-found as an error', async () => {
    await expect(callIqTool('iq_get_ontology', { id: 'missing' }, TENANT)).rejects.toThrow(/not found/);
  });

  it('iq_get_semantic_model returns detail for a known id', async () => {
    const out = parse(await callIqTool('iq_get_semantic_model', { id: 's1' }, TENANT));
    expect(out.id).toBe('s1');
  });

  it('iq_search requires a term and passes it through', async () => {
    await expect(callIqTool('iq_search', {}, TENANT)).rejects.toThrow(/term is required/);
    const out = parse(await callIqTool('iq_search', { term: 'customer' }, TENANT));
    expect(out[0].name).toBe('customer');
  });

  it('iq_query_signals requires kql and forwards it', async () => {
    await expect(callIqTool('iq_query_signals', {}, TENANT)).rejects.toThrow(/kql is required/);
    const out = parse(await callIqTool('iq_query_signals', { kql: 'Telemetry | count' }, TENANT));
    expect(out._echo).toBe('Telemetry | count');
  });

  it('rejects unknown tools', async () => {
    await expect(callIqTool('iq_nope', {}, TENANT)).rejects.toThrow(/unknown tool/);
  });
});
