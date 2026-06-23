'use client';

/**
 * DataflowDiagram — a visual builder for Dataflow Gen2 (Power Query M).
 *
 * Unlike ADF / Synapse / Fabric pipelines (a DAG of *activities*), a Dataflow
 * Gen2 is a set of Power Query *queries*, each a `let … in …` chain of steps.
 * Faithful to that model, this surface:
 *
 *   - parses `shared <Name> = let … in …;` query declarations out of the M
 *     script and renders one node per query on the same drag-drop canvas used
 *     by the pipeline editors (so nodes are movable + the layout is real);
 *   - draws an edge between two queries when one references the other by name
 *     (the Power Query dependency graph);
 *   - offers a left palette of common transform sources/steps that append a
 *     ready-to-edit `shared <Name> = …;` query to the M script.
 *
 * It is a *projection* of the M text — the M script (edited in the Script tab)
 * stays the single source of truth that Save PUTs to Fabric. Adding a query
 * from the palette mutates the M; the diagram re-derives from it. This keeps
 * the editor honest (no phantom UI state divorced from what gets saved).
 */

import { useCallback, useMemo, useRef } from 'react';
import { Caption1, Subtitle2, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { PipelineCanvas, type CanvasHandle } from './canvas';
import type { PipelineActivity } from './types';

const useStyles = makeStyles({
  twoPane: {
    display: 'flex',
    flex: 1,
    minHeight: '420px',
    gap: tokens.spacingHorizontalM,
    width: '100%',
  },
  paletteCol: {
    flexShrink: 0,
    width: '240px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
  },
  centerCol: { flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS,
    padding: '6px 8px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'grab', fontSize: tokens.fontSizeBase200, textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, borderColor: tokens.colorBrandStroke1 },
  },
  tileLabel: { fontWeight: 600, color: tokens.colorNeutralForeground1 },
});

interface QueryStepDef {
  key: string;
  label: string;
  description: string;
  color: string;
  /** Returns the M body (after `=`) for a fresh query of this kind. */
  body: string;
}

// Common Power Query sources/transforms surfaced in the palette. Each appends
// a `shared <Name> = <body>;` declaration the user can then refine.
const QUERY_PALETTE: QueryStepDef[] = [
  { key: 'BlankQuery', label: 'Blank query', color: '#666',
    description: 'An empty let/in query you fill in.',
    body: 'let\n    Source = #table({"col1"}, {{"value"}})\nin\n    Source' },
  { key: 'SqlSource', label: 'SQL database', color: 'var(--loom-accent-blue)',
    description: 'Connect to a SQL Server / Azure SQL database.',
    body: 'let\n    Source = Sql.Database("server.database.windows.net", "db"),\n    Nav = Source{[Schema="dbo",Item="MyTable"]}[Data]\nin\n    Nav' },
  { key: 'LakehouseSource', label: 'Lakehouse table', color: 'var(--loom-accent-emerald)',
    description: 'Read a Fabric Lakehouse table.',
    body: 'let\n    Source = Lakehouse.Contents([]),\n    Nav = Source{[workspaceId=""]}[Data]\nin\n    Nav' },
  { key: 'CsvSource', label: 'CSV / text file', color: 'var(--loom-accent-teal)',
    description: 'Import from a delimited text file.',
    body: 'let\n    Source = Csv.Document(Web.Contents("https://example.com/data.csv"), [Delimiter=","]),\n    Headers = Table.PromoteHeaders(Source)\nin\n    Headers' },
  { key: 'FilterRows', label: 'Filter rows', color: 'var(--loom-accent-amber)',
    description: 'Keep rows matching a condition (references a prior query).',
    body: 'let\n    Source = PreviousQuery,\n    Filtered = Table.SelectRows(Source, each [col1] <> null)\nin\n    Filtered' },
  { key: 'GroupBy', label: 'Group by', color: 'var(--loom-accent-plum)',
    description: 'Aggregate rows by one or more columns.',
    body: 'let\n    Source = PreviousQuery,\n    Grouped = Table.Group(Source, {"col1"}, {{"Count", each Table.RowCount(_), Int64.Type}})\nin\n    Grouped' },
  { key: 'MergeQueries', label: 'Merge queries', color: 'var(--loom-accent-plum)',
    description: 'Join two queries on a key column.',
    body: 'let\n    Source = Table.NestedJoin(LeftQuery, {"key"}, RightQuery, {"key"}, "joined", JoinKind.Inner)\nin\n    Source' },
];

/** Parse `shared <Name> = … ;` query declarations out of an M section. */
export function parseQueries(m: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  // Match: shared Name = <body up to a top-level semicolon>;
  // We split on `shared` boundaries then take name + body to the trailing `;`.
  const re = /shared\s+([A-Za-z_#"][^\s=]*)\s*=\s*([\s\S]*?);(?=\s*(?:shared\b|section\b|$))/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(m)) !== null) {
    const name = mt[1].replace(/^#?"?|"?$/g, '');
    out.push({ name, body: mt[2].trim() });
  }
  return out;
}

/** Next free `Query<N>` name not already declared. */
function nextQueryName(existing: Set<string>): string {
  let n = 1;
  while (existing.has(`Query${n}`)) n += 1;
  return `Query${n}`;
}

export interface DataflowDiagramProps {
  /** The Power Query M script (single source of truth). */
  mScript: string;
  /** Emit the next M script when the user adds a query from the palette. */
  onChange: (nextM: string) => void;
  readOnly?: boolean;
}

export function DataflowDiagram({ mScript, onChange, readOnly = false }: DataflowDiagramProps) {
  const s = useStyles();
  const canvasRef = useRef<CanvasHandle>(null);

  const queries = useMemo(() => parseQueries(mScript), [mScript]);

  // Project queries → canvas nodes. A query "depends on" another when its body
  // references that query's name as an identifier (Power Query dependency).
  const activities = useMemo<PipelineActivity[]>(() => {
    const names = queries.map((q) => q.name);
    return queries.map((q) => {
      const deps = names
        .filter((other) => other !== q.name && new RegExp(`\\b${other}\\b`).test(q.body))
        .map((other) => ({ activity: other, dependencyConditions: ['Succeeded'] }));
      return {
        name: q.name,
        type: 'DataflowQuery',
        description: 'Power Query (M)',
        dependsOn: deps,
      } as PipelineActivity;
    });
  }, [queries]);

  const addQuery = useCallback((def: QueryStepDef) => {
    if (readOnly) return;
    const existing = new Set(queries.map((q) => q.name));
    const name = nextQueryName(existing);
    const decl = `\nshared ${name} = ${def.body};\n`;
    // Append before EOF; if the script has no `section`, prepend one.
    let next = mScript;
    if (!/^\s*section\s/m.test(next)) {
      next = `section Section1;\n${next}`;
    }
    onChange(`${next.replace(/\s*$/, '')}\n${decl}`);
  }, [mScript, queries, onChange, readOnly]);

  return (
    <div className={s.twoPane}>
      <div className={s.paletteCol} data-palette="dataflow-queries" role="navigation" aria-label="Power Query step palette">
        <Subtitle2>Get data &amp; transform</Subtitle2>
        {QUERY_PALETTE.map((d) => (
          <Tooltip key={d.key} content={d.description} relationship="description" positioning="after">
            <div
              className={s.tile}
              role="button"
              tabIndex={0}
              draggable
              data-palette-key={d.key}
              onDragStart={(e) => { e.dataTransfer.setData('application/x-fiab-activity', d.key); e.dataTransfer.effectAllowed = 'copy'; }}
              onClick={() => addQuery(d)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addQuery(d); } }}
            >
              <span className={s.tileLabel} style={{ borderLeft: `3px solid ${d.color}`, paddingLeft: 6 }}>{d.label}</span>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.description}</Caption1>
            </div>
          </Tooltip>
        ))}
        <Caption1 style={{ marginTop: 'auto', color: tokens.colorNeutralForeground3 }}>
          {queries.length} quer{queries.length === 1 ? 'y' : 'ies'} · click or drag to add a step
        </Caption1>
      </div>
      <div className={s.centerCol}>
        <PipelineCanvas
          ref={canvasRef}
          activities={activities}
          onSelect={() => { /* selection handled via Script tab for M */ }}
          onDropPaletteKey={(key) => {
            const def = QUERY_PALETTE.find((d) => d.key === key);
            if (def) addQuery(def);
          }}
        />
        <Caption1 style={{ color: tokens.colorNeutralForeground3, paddingLeft: tokens.spacingHorizontalXS }}>
          Diagram is a live projection of the Power Query script — edit step logic in the Script (M) tab.
        </Caption1>
      </div>
    </div>
  );
}
