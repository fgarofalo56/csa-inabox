'use client';

/**
 * Synapse Serverless SQL object explorer — left-panel tree for the
 * synapse-serverless-sql-editor. Mirrors the Synapse Studio "Workspace /
 * Database" object tree: Views, Stored procedures, Table-valued functions,
 * External tables and External data sources.
 *
 * Every node is wired: a single click inserts a runnable T-SQL snippet into
 * the editor; the context menu offers ALTER (loads the object definition into
 * the editor) and DROP (confirm dialog → real DROP DDL via /query).
 *
 * Data comes from GET /api/items/synapse-serverless-sql-pool/[id]/objects —
 * real sys.* catalog views over the TDS endpoint. No mock data.
 */

import { useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout, Caption1, Button, Tooltip, Spinner,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Eye20Regular, Form20Regular, MathFormula20Regular, DocumentTable20Regular,
  Database20Regular, ArrowSync16Regular, MoreHorizontal20Regular,
} from '@fluentui/react-icons';

export interface SqlObject {
  schema: string;
  name: string;
  definition: string;
}
export interface SqlFunction extends SqlObject {
  type: 'IF' | 'TF';
}
export interface ExternalTable {
  schema: string;
  name: string;
  dataSource: string;
  location: string;
}
export interface ObjectsResponse {
  ok: boolean;
  gated?: boolean;
  error?: string;
  warnings?: string[];
  database: string;
  endpoint?: string;
  views: SqlObject[];
  procedures: SqlObject[];
  functions: SqlFunction[];
  externalTables: ExternalTable[];
  columns: Record<string, { name: string; dataType: string }[]>;
}

const useStyles = makeStyles({
  pad: { padding: 8 },
  head: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' },
  headTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, flex: 1 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafLabel: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { padding: '4px 8px', color: tokens.colorNeutralForeground3 },
  dropName: { fontFamily: 'Consolas, monospace', fontWeight: tokens.fontWeightSemibold },
});

interface Props {
  database: string;
  objects: ObjectsResponse | null;
  loading: boolean;
  onRefresh: () => void;
  /** Insert runnable T-SQL into the editor (single-click / "Select TOP 100"). */
  onInsertSql: (sql: string) => void;
  /** Load an object definition into the editor (ALTER). */
  onLoadDefinition: (sql: string) => void;
  /** Run a DDL statement directly (DROP). Returns when the BFF responds. */
  onRunDdl: (sql: string) => Promise<void>;
}

type DropTarget = { kind: 'VIEW' | 'PROCEDURE' | 'FUNCTION'; schema: string; name: string } | null;

function qn(schema: string, name: string): string {
  return `[${schema}].[${name}]`;
}

export function SynapseServerlessSqlObjectExplorer({
  database, objects, loading, onRefresh, onInsertSql, onLoadDefinition, onRunDdl,
}: Props) {
  const s = useStyles();
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [dropping, setDropping] = useState(false);

  const views = objects?.views ?? [];
  const procedures = objects?.procedures ?? [];
  const functions = objects?.functions ?? [];
  const externalTables = objects?.externalTables ?? [];
  // Distinct data sources (from external tables) for the Data sources branch.
  const dataSources = Array.from(
    new Map(externalTables.filter((t) => t.dataSource).map((t) => [t.dataSource, t.location])).entries(),
  ).map(([name, location]) => ({ name, location }));

  async function confirmDrop() {
    if (!dropTarget) return;
    setDropping(true);
    try {
      await onRunDdl(`DROP ${dropTarget.kind} IF EXISTS ${qn(dropTarget.schema, dropTarget.name)};`);
      setDropTarget(null);
      onRefresh();
    } finally {
      setDropping(false);
    }
  }

  function ObjectMenu({ kind, schema, name, alterSql }: {
    kind: 'VIEW' | 'PROCEDURE' | 'FUNCTION'; schema: string; name: string; alterSql: string;
  }) {
    return (
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Tooltip content="Actions" relationship="label">
            <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${name}`} />
          </Tooltip>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => onLoadDefinition(alterSql)}>Alter (edit definition)</MenuItem>
            <MenuItem onClick={() => setDropTarget({ kind, schema, name })}>Drop…</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }

  function alterSqlFor(o: SqlObject): string {
    // Prefer the live module definition rewritten to CREATE OR ALTER; fall back
    // to a header if the catalog didn't return a definition.
    if (o.definition) {
      return o.definition.replace(/^\s*CREATE\s+(OR\s+ALTER\s+)?/i, 'CREATE OR ALTER ');
    }
    return `-- No cached definition for ${qn(o.schema, o.name)}. Re-create with CREATE OR ALTER.`;
  }

  return (
    <div className={s.pad}>
      <div className={s.head}>
        <Database20Regular />
        <span className={s.headTitle}>{database}</span>
        <Tooltip content="Refresh objects" relationship="label">
          <Button appearance="subtle" size="small" icon={loading ? <Spinner size="tiny" /> : <ArrowSync16Regular />}
            aria-label="Refresh objects" onClick={onRefresh} disabled={loading} />
        </Tooltip>
      </div>

      <Tree aria-label="SQL objects" defaultOpenItems={['views', 'procs', 'funcs', 'ext', 'ds']}>
        {/* Views */}
        <TreeItem itemType="branch" value="views">
          <TreeItemLayout iconBefore={<Eye20Regular />}>Views ({views.length})</TreeItemLayout>
          <Tree>
            {views.length === 0 && <TreeItem itemType="leaf" value="v-empty"><TreeItemLayout><Caption1 className={s.empty}>No views</Caption1></TreeItemLayout></TreeItem>}
            {views.map((v) => (
              <TreeItem key={`v-${v.schema}.${v.name}`} itemType="leaf" value={`v-${v.schema}.${v.name}`}>
                <TreeItemLayout
                  iconBefore={<Eye20Regular />}
                  actions={<ObjectMenu kind="VIEW" schema={v.schema} name={v.name} alterSql={alterSqlFor(v)} />}
                  onClick={() => onInsertSql(`SELECT TOP 100 * FROM ${qn(v.schema, v.name)};`)}
                >
                  {v.schema}.{v.name}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* Stored procedures */}
        <TreeItem itemType="branch" value="procs">
          <TreeItemLayout iconBefore={<Form20Regular />}>Stored procedures ({procedures.length})</TreeItemLayout>
          <Tree>
            {procedures.length === 0 && <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1 className={s.empty}>No procedures</Caption1></TreeItemLayout></TreeItem>}
            {procedures.map((p) => (
              <TreeItem key={`p-${p.schema}.${p.name}`} itemType="leaf" value={`p-${p.schema}.${p.name}`}>
                <TreeItemLayout
                  iconBefore={<Form20Regular />}
                  actions={<ObjectMenu kind="PROCEDURE" schema={p.schema} name={p.name} alterSql={alterSqlFor(p)} />}
                  onClick={() => onInsertSql(`EXEC ${qn(p.schema, p.name)};`)}
                >
                  {p.schema}.{p.name}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* Table-valued functions (iTVF + multi-statement TVF; serverless has no scalar UDFs) */}
        <TreeItem itemType="branch" value="funcs">
          <TreeItemLayout iconBefore={<MathFormula20Regular />}>Table-valued functions ({functions.length})</TreeItemLayout>
          <Tree>
            {functions.length === 0 && <TreeItem itemType="leaf" value="f-empty"><TreeItemLayout><Caption1 className={s.empty}>No functions</Caption1></TreeItemLayout></TreeItem>}
            {functions.map((f) => (
              <TreeItem key={`f-${f.schema}.${f.name}`} itemType="leaf" value={`f-${f.schema}.${f.name}`}>
                <TreeItemLayout
                  iconBefore={<MathFormula20Regular />}
                  actions={<ObjectMenu kind="FUNCTION" schema={f.schema} name={f.name} alterSql={alterSqlFor(f)} />}
                  onClick={() => onInsertSql(`SELECT TOP 100 * FROM ${qn(f.schema, f.name)}();`)}
                >
                  {f.schema}.{f.name} <Caption1>· {f.type === 'IF' ? 'inline TVF' : 'TVF'}</Caption1>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* External tables (read-only — usually back the lakehouse) */}
        <TreeItem itemType="branch" value="ext">
          <TreeItemLayout iconBefore={<DocumentTable20Regular />}>External tables ({externalTables.length})</TreeItemLayout>
          <Tree>
            {externalTables.length === 0 && <TreeItem itemType="leaf" value="e-empty"><TreeItemLayout><Caption1 className={s.empty}>No external tables</Caption1></TreeItemLayout></TreeItem>}
            {externalTables.map((t) => (
              <TreeItem key={`e-${t.schema}.${t.name}`} itemType="leaf" value={`e-${t.schema}.${t.name}`}
                onClick={() => onInsertSql(`SELECT TOP 100 * FROM ${qn(t.schema, t.name)};`)}>
                <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                  {t.schema}.{t.name}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>

        {/* External data sources */}
        <TreeItem itemType="branch" value="ds">
          <TreeItemLayout iconBefore={<Database20Regular />}>Data sources ({dataSources.length})</TreeItemLayout>
          <Tree>
            {dataSources.length === 0 && <TreeItem itemType="leaf" value="d-empty"><TreeItemLayout><Caption1 className={s.empty}>No data sources</Caption1></TreeItemLayout></TreeItem>}
            {dataSources.map((d) => (
              <TreeItem key={`d-${d.name}`} itemType="leaf" value={`d-${d.name}`}
                onClick={() => onInsertSql(`-- External data source: ${d.name}\n--   location: ${d.location}`)}>
                <TreeItemLayout iconBefore={<Database20Regular />}>{d.name}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </TreeItem>
      </Tree>

      {/* DROP confirm dialog */}
      <Dialog open={dropTarget !== null} onOpenChange={(_, d) => { if (!d.open) setDropTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Drop {dropTarget?.kind.toLowerCase()}</DialogTitle>
            <DialogContent>
              This permanently drops <span className={s.dropName}>{dropTarget && qn(dropTarget.schema, dropTarget.name)}</span> from <strong>{database}</strong>.
              This cannot be undone.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDropTarget(null)} disabled={dropping}>Cancel</Button>
              <Button appearance="primary" onClick={confirmDrop} disabled={dropping}>
                {dropping ? 'Dropping…' : 'Drop'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export default SynapseServerlessSqlObjectExplorer;
