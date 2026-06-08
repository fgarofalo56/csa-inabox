'use client';
/**
 * sql-intellisense — Monaco completion provider for the SQL / T-SQL editors.
 *
 * Registers a single global CompletionItemProvider for the 'sql' Monaco
 * language (all three editors map sql/tsql/sparksql → 'sql' in MonacoTextarea).
 * Completions are driven by a live SqlSchemaCache that each editor updates as
 * its catalog / INFORMATION_SCHEMA tree loads — so the dropdown suggests real
 * catalogs, schemas, tables and columns from the connected backend.
 *
 * Schema data sources (per no-fabric-dependency / no-vaporware — all Azure-native):
 *   - Databricks: SHOW CATALOGS / SHOW SCHEMAS / SHOW TABLES / DESCRIBE TABLE
 *     via /api/items/databricks-sql-warehouse/[id]/schema
 *   - Synapse Dedicated / Serverless / Warehouse: INFORMATION_SCHEMA.COLUMNS +
 *     sys.tables/sys.schemas via /api/items/.../schema
 *
 * No new endpoints / env vars are introduced — schema queries flow through the
 * existing BFF routes which already resolve cloud-correct hosts.
 */

export interface SqlSchemaCache {
  /** Top-level catalog/database names. */
  catalogs: string[];
  /** catalog -> schema names. */
  schemas: Map<string, string[]>;
  /** "catalog.schema" -> table names. */
  tables: Map<string, string[]>;
  /** "catalog.schema.table" (or "schema.table") -> column names. */
  columns: Map<string, string[]>;
}

export function createEmptyCache(): SqlSchemaCache {
  return { catalogs: [], schemas: new Map(), tables: new Map(), columns: new Map() };
}

/** Common SQL/T-SQL keywords offered when no qualified context is detected. */
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'LEFT JOIN',
  'INNER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'INSERT INTO', 'UPDATE', 'DELETE', 'CREATE TABLE', 'CREATE VIEW', 'DISTINCT', 'TOP',
  'LIMIT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'WITH', 'UNION', 'UNION ALL', 'OVER', 'PARTITION BY',
];

type IDisposable = { dispose(): void };

// The provider is global to the shared Monaco instance, so we register it once
// and route completions through whichever cache getter was set most recently.
// Only one SQL editor mounts per item page, so "most recent" == "the active
// editor" in practice.
let providerRegistered = false;
let activeCacheGetter: (() => SqlSchemaCache) | null = null;

/** Strip Databricks backticks / T-SQL brackets / quotes around an identifier. */
function unquote(id: string): string {
  return id.replace(/^[`"[]/, '').replace(/[`"\]]$/, '');
}

/**
 * Register the SQL completion provider once on the supplied monaco instance and
 * point it at this editor's cache getter. Returns an IDisposable; disposing it
 * clears this editor's getter (the provider itself stays registered for reuse).
 */
export function registerSqlIntelliSense(
  monaco: any,
  langId: string,
  getCache: () => SqlSchemaCache,
): IDisposable {
  activeCacheGetter = getCache;

  if (providerRegistered) {
    return { dispose: () => { if (activeCacheGetter === getCache) activeCacheGetter = null; } };
  }
  providerRegistered = true;

  const disposable = monaco.languages.registerCompletionItemProvider(langId, {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model: any, position: any) {
      const cache = activeCacheGetter ? activeCacheGetter() : null;
      if (!cache) return { suggestions: [] };

      const wordUntil = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: wordUntil.startColumn,
        endColumn: position.column,
      };

      const linePrefix: string = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const CK = monaco.languages.CompletionItemKind;
      const items: any[] = [];

      // Detect the dotted token immediately before the cursor.
      const tokensBefore = linePrefix.split(/[\s,()=<>!+\-*/;]+/).filter(Boolean);
      const lastToken = tokensBefore[tokensBefore.length - 1] || '';
      const parts = lastToken.split('.').map(unquote);

      if (parts.length <= 1 && !lastToken.endsWith('.')) {
        // Bare word — offer catalogs + keywords.
        for (const cat of cache.catalogs) {
          items.push({ label: cat, kind: CK.Module, insertText: cat, range, detail: 'catalog / database' });
        }
        for (const kw of KEYWORDS) {
          items.push({ label: kw, kind: CK.Keyword, insertText: kw, range, detail: 'keyword' });
        }
      } else if (parts.length === 2) {
        const schemas = cache.schemas.get(parts[0]) || [];
        for (const sch of schemas) {
          items.push({ label: sch, kind: CK.Module, insertText: sch, range, detail: `schema in ${parts[0]}` });
        }
        // Also offer 2-part schema.table columns (T-SQL "schema.table.").
        const cols2 = cache.columns.get(`${parts[0]}.${parts[1]}`);
        if (cols2) for (const c of cols2) {
          items.push({ label: c, kind: CK.Field, insertText: c, range, detail: `column of ${parts[1]}` });
        }
      } else if (parts.length === 3) {
        // Ambiguous between Databricks `catalog.schema.` (→ tables) and T-SQL
        // `schema.table.` (→ columns). Prefer columns if we cached them under
        // the 2-part schema.table key (T-SQL), else fall back to tables.
        const tsqlCols = cache.columns.get(`${parts[0]}.${parts[1]}`);
        if (tsqlCols && tsqlCols.length) {
          for (const c of tsqlCols) {
            items.push({ label: c, kind: CK.Field, insertText: c, range, detail: `column of ${parts[1]}` });
          }
        } else {
          const key2 = `${parts[0]}.${parts[1]}`;
          const tbls = cache.tables.get(key2) || [];
          for (const t of tbls) {
            items.push({ label: t, kind: CK.Class, insertText: t, range, detail: `table in ${key2}` });
          }
        }
      } else if (parts.length === 4) {
        const key3 = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const cols = cache.columns.get(key3) || [];
        for (const c of cols) {
          items.push({ label: c, kind: CK.Field, insertText: c, range, detail: `column of ${parts[2]}` });
        }
      }

      return { suggestions: items };
    },
  });

  return {
    dispose: () => {
      if (activeCacheGetter === getCache) activeCacheGetter = null;
      try { disposable.dispose(); } catch { /* monaco gone */ }
      providerRegistered = false;
    },
  };
}
