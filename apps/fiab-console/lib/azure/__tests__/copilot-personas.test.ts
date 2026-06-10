import { describe, it, expect } from 'vitest';
import {
  computeDynamicPrompts,
  getPersonaPrompts,
  extractSqlTableNames,
  STATIC_PROMPTS,
} from '../copilot-personas';

describe('computeDynamicPrompts', () => {
  it('notebook: produces real lakehouse-name prompts from attachedSourceNames', () => {
    const prompts = computeDynamicPrompts({
      persona: 'notebook',
      attachedSourceNames: ['bronze-sales', 'gold-customers'],
      defaultLang: 'pyspark',
    });
    expect(prompts.some((p) => p.prompt.includes('bronze-sales'))).toBe(true);
    expect(prompts.some((p) => p.prompt.includes('gold-customers'))).toBe(true);
  });

  it('notebook: SQL language yields a Spark SQL read prompt', () => {
    const prompts = computeDynamicPrompts({
      persona: 'notebook',
      attachedSourceNames: ['silver'],
      defaultLang: 'sparksql',
    });
    expect(prompts.some((p) => p.prompt.includes('Spark SQL'))).toBe(true);
  });

  it('warehouse: embeds real table names in chip prompt', () => {
    const prompts = computeDynamicPrompts({
      persona: 'warehouse',
      tableNames: ['gold.sales', 'gold.customers'],
      currentSqlSnippet: 'SELECT region FROM gold.sales',
    });
    expect(prompts.some((p) => p.prompt.includes('gold.sales'))).toBe(true);
    expect(prompts.some((p) => p.prompt.includes('SELECT TOP 10 * FROM gold.sales'))).toBe(true);
  });

  it('returns empty array with no context for non-dynamic personas', () => {
    expect(computeDynamicPrompts({ persona: 'pipeline' })).toHaveLength(0);
  });
});

describe('getPersonaPrompts', () => {
  it('caps at 6 chips', () => {
    const result = getPersonaPrompts({
      persona: 'notebook',
      attachedSourceNames: ['a', 'b', 'c'],
      defaultLang: 'pyspark',
    });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('dynamic prompts appear before static prompts', () => {
    const result = getPersonaPrompts({
      persona: 'warehouse',
      tableNames: ['dbo.orders'],
    });
    expect(result[0].id.startsWith('wh-dyn-')).toBe(true);
  });

  it('falls back to default persona prompts when no dynamic context', () => {
    const result = getPersonaPrompts({ persona: 'default' });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(STATIC_PROMPTS.default.slice(0, result.length));
  });

  it('notebook with no context returns the static notebook prompts', () => {
    const result = getPersonaPrompts({ persona: 'notebook' });
    expect(result[0].id).toBe('nb-explain');
  });
});

describe('extractSqlTableNames', () => {
  it('extracts FROM and JOIN table names', () => {
    const sql = 'SELECT * FROM gold.sales s JOIN gold.customers c ON s.cid = c.id';
    expect(extractSqlTableNames(sql)).toEqual(
      expect.arrayContaining(['gold.sales', 'gold.customers']),
    );
  });

  it('handles bracketed and bare names', () => {
    expect(extractSqlTableNames('SELECT * FROM [dbo].[orders]')).toContain('dbo.orders');
    expect(extractSqlTableNames('SELECT * FROM sales WHERE 1=1')).toContain('sales');
  });

  it('dedupes and caps at 5 names', () => {
    const sql =
      'FROM a JOIN b JOIN c JOIN d JOIN e JOIN f JOIN g FROM a';
    const out = extractSqlTableNames(sql);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(new Set(out).size).toBe(out.length);
  });
});

// ---------------------------------------------------------------------------
// Per-pane Copilot persona registry (PERSONA_REGISTRY / getPanePersona) — #1006.
// ---------------------------------------------------------------------------
import { PERSONA_REGISTRY, getPanePersona, VALID_CONTEXT_SLUGS } from '../copilot-personas';

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

describe('getPanePersona', () => {
  it('resolves a known slug', () => {
    expect(getPanePersona('warehouse')).toBe(PERSONA_REGISTRY.warehouse);
  });

  it('falls back to default for an unknown slug', () => {
    expect(getPanePersona('not-a-real-slug')).toBe(PERSONA_REGISTRY.default);
  });

  it('falls back to default for undefined / null', () => {
    expect(getPanePersona(undefined)).toBe(PERSONA_REGISTRY.default);
    expect(getPanePersona(null)).toBe(PERSONA_REGISTRY.default);
  });

  it('VALID_CONTEXT_SLUGS contains exactly the registry keys', () => {
    expect([...VALID_CONTEXT_SLUGS].sort()).toEqual(Object.keys(PERSONA_REGISTRY).sort());
  });
});
