import { describe, it, expect, afterEach } from 'vitest';
import {
  translateDaxToSql,
  extractContent,
  resolveBackend,
  TabularError,
} from '../tabular-model';
import { aasScope, aasXmlaUrl } from '../cloud-endpoints';
import type { WorkspaceItem } from '@/lib/types/workspace';

const ORIG_LOOM = process.env.LOOM_CLOUD;
const ORIG_AZURE = process.env.AZURE_CLOUD;
const ORIG_BACKEND = process.env.LOOM_SEMANTIC_BACKEND;
const ORIG_SERVER = process.env.LOOM_AAS_SERVER;

afterEach(() => {
  for (const [k, v] of [
    ['LOOM_CLOUD', ORIG_LOOM],
    ['AZURE_CLOUD', ORIG_AZURE],
    ['LOOM_SEMANTIC_BACKEND', ORIG_BACKEND],
    ['LOOM_AAS_SERVER', ORIG_SERVER],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function commercial() {
  process.env.LOOM_CLOUD = 'Commercial';
  delete process.env.AZURE_CLOUD;
}

describe('translateDaxToSql — constrained DAX → T-SQL', () => {
  it('EVALUATE <Table> → SELECT TOP 1000 *', () => {
    expect(translateDaxToSql('EVALUATE Sales')).toBe('SELECT TOP 1000 * FROM [Sales]');
  });
  it("EVALUATE 'Quoted Table' → bracketed name", () => {
    expect(translateDaxToSql("EVALUATE 'Fact Sales'")).toBe('SELECT TOP 1000 * FROM [Fact Sales]');
  });
  it('EVALUATE TOPN(N, Table) → SELECT TOP N *', () => {
    expect(translateDaxToSql('EVALUATE TOPN(5, Customers)')).toBe('SELECT TOP 5 * FROM [Customers]');
  });
  it('EVALUATE ROW("Total", CALCULATE(SUM(Sales[Amount]))) → SUM aggregate', () => {
    expect(translateDaxToSql('EVALUATE ROW("Total", CALCULATE(SUM(Sales[Amount])))')).toBe(
      'SELECT SUM([Amount]) AS [Total] FROM [Sales]',
    );
  });
  it('AVERAGE maps to SQL AVG', () => {
    expect(translateDaxToSql('EVALUATE ROW("Avg", CALCULATE(AVERAGE(Sales[Price])))')).toBe(
      'SELECT AVG([Price]) AS [Avg] FROM [Sales]',
    );
  });
  it('COUNT/MIN/MAX pass through', () => {
    expect(translateDaxToSql('EVALUATE ROW("C", CALCULATE(COUNT(T[X])))')).toBe('SELECT COUNT([X]) AS [C] FROM [T]');
    expect(translateDaxToSql('EVALUATE ROW("m", CALCULATE(MIN(T[X])))')).toBe('SELECT MIN([X]) AS [m] FROM [T]');
    expect(translateDaxToSql('EVALUATE ROW("M", CALCULATE(MAX(T[X])))')).toBe('SELECT MAX([X]) AS [M] FROM [T]');
  });
  it('returns null for unsupported DAX (FILTER, measure refs)', () => {
    expect(translateDaxToSql('EVALUATE FILTER(Sales, Sales[Amount] > 100)')).toBeNull();
    expect(translateDaxToSql('EVALUATE SUMMARIZECOLUMNS(Sales[Region], "T", [Total])')).toBeNull();
    expect(translateDaxToSql('')).toBeNull();
  });
});

describe('extractContent — read tables + measures from state.content', () => {
  function modelItem(content: unknown): WorkspaceItem {
    return {
      id: 'm1',
      workspaceId: 'ws1',
      itemType: 'semantic-model',
      displayName: 'Sales Model',
      state: { content },
      createdBy: 'u',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as WorkspaceItem;
  }

  it('reads tables + columns + top-level measures keyed by table', () => {
    const item = modelItem({
      kind: 'semantic-model',
      tables: [
        { name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }, { name: 'Region', dataType: 'string' }] },
        { name: 'Date', columns: [{ name: 'Year', dataType: 'int64' }] },
      ],
      measures: [
        { name: 'Total Sales', table: 'Sales', expression: 'SUM(Sales[Amount])', formatString: '\\$#,0' },
        { name: 'Years', table: 'Date', expression: 'COUNT(Date[Year])' },
      ],
    });
    const { tables, measures } = extractContent(item);
    expect(tables.map((t) => t.name)).toEqual(['Sales', 'Date']);
    expect(tables[0].columns).toEqual([
      { name: 'Amount', dataType: 'decimal' },
      { name: 'Region', dataType: 'string' },
    ]);
    expect(measures).toHaveLength(2);
    expect(measures[0]).toMatchObject({ name: 'Total Sales', table: 'Sales', formatString: '\\$#,0' });
  });

  it('folds in per-table measures (alternate shape) without duplicating', () => {
    const item = modelItem({
      kind: 'semantic-model',
      tables: [
        {
          name: 'Sales',
          columns: [{ name: 'Amount', dataType: 'decimal' }],
          measures: [{ name: 'Total', expression: 'SUM(Sales[Amount])' }],
        },
      ],
      measures: [{ name: 'Total', table: 'Sales', expression: 'SUM(Sales[Amount])' }],
    });
    const { measures } = extractContent(item);
    expect(measures).toHaveLength(1);
    expect(measures[0].name).toBe('Total');
  });

  it('tolerates a missing/empty content shape', () => {
    const { tables, measures } = extractContent(modelItem(undefined));
    expect(tables).toEqual([]);
    expect(measures).toEqual([]);
  });
});

describe('resolveBackend — default loom-native, AAS opt-in, gov forced', () => {
  it('defaults to loom-native (no Power BI) when nothing is set', () => {
    commercial();
    delete process.env.LOOM_SEMANTIC_BACKEND;
    expect(resolveBackend()).toBe('loom-native');
  });
  it('selects analysis-services when opted in with a server (Commercial)', () => {
    commercial();
    process.env.LOOM_SEMANTIC_BACKEND = 'analysis-services';
    process.env.LOOM_AAS_SERVER = 'asazure://eastus.asazure.windows.net/loomaas';
    expect(resolveBackend()).toBe('analysis-services');
  });
  it('throws an honest error when analysis-services is chosen with no server', () => {
    commercial();
    process.env.LOOM_SEMANTIC_BACKEND = 'analysis-services';
    delete process.env.LOOM_AAS_SERVER;
    expect(() => resolveBackend()).toThrow(TabularError);
  });
  it('forces loom-native in Azure Government even if AAS is configured', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    delete process.env.AZURE_CLOUD;
    process.env.LOOM_SEMANTIC_BACKEND = 'analysis-services';
    process.env.LOOM_AAS_SERVER = 'asazure://eastus.asazure.windows.net/loomaas';
    expect(resolveBackend()).toBe('loom-native');
  });
});

describe('aasScope / aasXmlaUrl — Azure-native (NOT Power BI) endpoints', () => {
  it('derives the .default scope from the AAS server host (Commercial)', () => {
    commercial();
    expect(aasScope('asazure://eastus.asazure.windows.net/loomaas')).toBe(
      'https://eastus.asazure.windows.net/.default',
    );
  });
  it('builds the XMLA POST url from an asazure:// uri', () => {
    expect(aasXmlaUrl('asazure://eastus.asazure.windows.net/loomaas', 'SalesModel')).toBe(
      'https://eastus.asazure.windows.net/servers/loomaas/models/SalesModel/xmla',
    );
  });
  it('passes through an https XMLA url (appending /xmla if absent)', () => {
    expect(aasXmlaUrl('https://eastus.asazure.windows.net/servers/loomaas/models/m', 'm')).toBe(
      'https://eastus.asazure.windows.net/servers/loomaas/models/m/xmla',
    );
  });
  it('throws in Azure Government (AAS unavailable)', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    delete process.env.AZURE_CLOUD;
    expect(() => aasScope('asazure://usgovvirginia.asazure.windows.net/loomaas')).toThrow();
  });
  it('never references api.powerbi.com', () => {
    commercial();
    expect(aasScope('asazure://eastus.asazure.windows.net/loomaas')).not.toContain('powerbi');
    expect(aasXmlaUrl('asazure://eastus.asazure.windows.net/loomaas', 'm')).not.toContain('powerbi');
  });
});
