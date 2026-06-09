/**
 * Unit tests for the per-pane Copilot persona registry.
 *
 * Scope: the PURE registry (copilot-personas.ts has zero runtime deps). The
 * orchestrator's use of it (system message = persona.systemPrompt(payload),
 * tools filtered to persona.toolCatalog) is type-checked by tsc and exercised
 * live; it is NOT imported here because copilot-orchestrator constructs an
 * Azure credential at module load, which can't run in a unit-test process.
 *
 * These assertions cover the acceptance criteria directly:
 *   - distinct tool catalogs per slug,
 *   - the warehouse persona injects the EXACT active query (→ a warehouse-
 *     flavored answer grounded in real text, never a hard-coded reply),
 *   - pane titles reflect the persona,
 *   - unknown slugs fall back to the default persona.
 */

import { describe, it, expect } from 'vitest';

import { PERSONA_REGISTRY, getPersona, VALID_CONTEXT_SLUGS } from '../copilot-personas';

describe('PERSONA_REGISTRY', () => {
  it('every persona has a non-empty title, greeting, ≥1 suggested prompt, and a fn systemPrompt', () => {
    for (const entry of Object.values(PERSONA_REGISTRY)) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.greeting.length).toBeGreaterThan(0);
      expect(entry.suggestedPrompts.length).toBeGreaterThan(0);
      expect(typeof entry.systemPrompt).toBe('function');
    }
  });

  it('pane titles reflect the persona (Warehouse / Notebook Copilot)', () => {
    expect(PERSONA_REGISTRY.warehouse.title).toBe('Warehouse Copilot');
    expect(PERSONA_REGISTRY.notebook.title).toBe('Notebook Copilot');
    expect(PERSONA_REGISTRY.default.title).toBe('Copilot');
  });

  it('warehouse and notebook expose DISTINCT tool catalogs', () => {
    expect(PERSONA_REGISTRY.warehouse.toolCatalog).not.toEqual(
      PERSONA_REGISTRY.notebook.toolCatalog,
    );
  });

  it('each focused persona has a distinct tool-catalog signature', () => {
    const focused = (Object.keys(PERSONA_REGISTRY) as Array<keyof typeof PERSONA_REGISTRY>).filter(
      (k) => PERSONA_REGISTRY[k].toolCatalog.length > 0,
    );
    const sigs = focused.map((k) => [...PERSONA_REGISTRY[k].toolCatalog].sort().join(','));
    expect(new Set(sigs).size).toBe(focused.length);
  });

  it('warehouse toolCatalog contains synapse_dedicated_query but NOT apim_list_apis', () => {
    expect(PERSONA_REGISTRY.warehouse.toolCatalog).toContain('synapse_dedicated_query');
    expect(PERSONA_REGISTRY.warehouse.toolCatalog).not.toContain('apim_list_apis');
  });

  it('kql persona uses ADX tools, not SQL tools', () => {
    expect(PERSONA_REGISTRY['kql-database'].toolCatalog).toContain('adx_query');
    expect(PERSONA_REGISTRY['kql-database'].toolCatalog).not.toContain('synapse_dedicated_query');
  });

  it('default persona toolCatalog is empty ([] = all tools)', () => {
    expect(PERSONA_REGISTRY.default.toolCatalog).toEqual([]);
  });

  it('warehouse systemPrompt injects the EXACT active query text (no hard-coded reply)', () => {
    const p = PERSONA_REGISTRY.warehouse.systemPrompt({
      activeQuery: 'SELECT region FROM gold.sales',
    });
    expect(p).toContain('SELECT region FROM gold.sales');
    expect(p).toContain('Warehouse Copilot');
  });

  it('systemPrompt injects schema + workspace id when supplied', () => {
    const p = PERSONA_REGISTRY.warehouse.systemPrompt({
      activeQuery: 'SELECT 1',
      schema: 'gold.sales(region STRING, amount DECIMAL)',
      workspaceId: 'ws-123',
    });
    expect(p).toContain('gold.sales(region STRING, amount DECIMAL)');
    expect(p).toContain('ws-123');
  });

  it('systemPrompt omits the pane-context block when payload is empty', () => {
    const p = PERSONA_REGISTRY.warehouse.systemPrompt({});
    expect(p).not.toContain('--- Pane context ---');
  });

  it('two panes with the same prompt produce DIFFERENT system messages (persona-flavored)', () => {
    const payload = { activeQuery: 'SELECT 1' };
    const wh = PERSONA_REGISTRY.warehouse.systemPrompt(payload);
    const nb = PERSONA_REGISTRY.notebook.systemPrompt(payload);
    expect(wh).not.toBe(nb);
    expect(wh).toContain('Warehouse Copilot');
    expect(nb).toContain('Notebook Copilot');
  });

  it('every persona system prompt carries the no-Fabric framing (CSA Loom, NOT Microsoft Fabric)', () => {
    for (const entry of Object.values(PERSONA_REGISTRY)) {
      const text = entry.systemPrompt({ activeQuery: 'SELECT 1' });
      expect(text).toContain('CSA Loom');
      expect(text).toMatch(/NOT Microsoft Fabric/i);
    }
  });
});

describe('getPersona', () => {
  it('resolves a known slug', () => {
    expect(getPersona('warehouse')).toBe(PERSONA_REGISTRY.warehouse);
  });

  it('falls back to default for an unknown slug', () => {
    expect(getPersona('not-a-real-slug')).toBe(PERSONA_REGISTRY.default);
  });

  it('falls back to default for undefined / null', () => {
    expect(getPersona(undefined)).toBe(PERSONA_REGISTRY.default);
    expect(getPersona(null)).toBe(PERSONA_REGISTRY.default);
  });

  it('VALID_CONTEXT_SLUGS contains exactly the registry keys', () => {
    expect([...VALID_CONTEXT_SLUGS].sort()).toEqual(Object.keys(PERSONA_REGISTRY).sort());
  });
});
