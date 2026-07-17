'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ShareExplorer — the in-Loom "Explore / Query" experience for a SUBSCRIBED
 * Delta Share's mounted, read-only Unity Catalog catalog.
 *
 * After a user subscribes to an inbound share it mounts as a read-only UC
 * catalog (POST …/sharing/providers/[name] {action:'mount'}). This panel is the
 * "use it" path Loom previously lacked: browse the catalog's schemas → tables,
 * click a table to load a 100-row preview, and run free-form read-only SQL —
 * all against the real Databricks SQL warehouse (LOOM_DATABRICKS_SQL_WAREHOUSE_ID).
 *
 *   Schema/table browse : GET  /api/catalog/browse?source=unity-catalog&path=host|catalog[|schema]
 *   Query / preview      : POST /api/marketplace/sharing/query { catalog, schema?, sql? }
 *
 * Honest gate (no-vaporware.md): when the warehouse isn't configured the query
 * route returns 503 { gate, missing } and a Fluent MessageBar names the exact
 * env var (LOOM_DATABRICKS_SQL_WAREHOUSE_ID) — the full surface still renders.
 *
 * Fluent v9 + Loom design tokens only (no hard-coded px/hex). Reuses Monaco
 * (MonacoTextarea, language 'sql') for the SQL editor and the shared results
 * table styling for the grid.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Tree, TreeItem,
  TreeItemLayout, Tooltip, Input, Field, Select,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions, DialogTrigger,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Table20Regular, FolderOpen20Regular,
  Play20Regular, ArrowSync20Regular, Search20Regular, ArrowDownload20Regular,
  Copy20Regular, DatabaseSearch24Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  header: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  // Two-pane: schema/table tree on the left, query + results on the right.
  split: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    minHeight: 0,
    flex: 1,
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  treePane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    maxHeight: '520px', overflow: 'auto', minWidth: 0,
  },
  queryPane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  editorBox: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden', boxShadow: tokens.shadow4,
  },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  resultsBox: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM,
  },
  tableWrap: {
    overflow: 'auto', maxHeight: '360px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
  },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  treeLeaf: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', minWidth: 0 },
});

interface QueryData {
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
}
interface Gate { error: string; missing?: string }

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
/** Copy text to the clipboard (best-effort; silent on older browsers). */
function copyText(text: string) {
  try { void navigator.clipboard?.writeText(text); } catch { /* noop */ }
}
function downloadCsv(filename: string, columns: string[], rows: unknown[][]) {
  const csv = [
    columns.map(csvEscape).join(','),
    ...rows.map((r) => columns.map((_, j) => csvEscape(r[j])).join(',')),
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/** Backtick-escape a UC identifier for SQL (double internal backticks). */
const bt = (id: string) => `\`${id.replace(/`/g, '``')}\``;

/**
 * ShareExplorerPanel — the inner content. Given a catalog name (the mounted
 * share) and the workspace host, browse + query it.
 */
export function ShareExplorerPanel({ catalog, host, providerName, shareName }: {
  catalog: string; host: string | null;
  /** When set (mounted-share coordinates), the selected table gains "Create lakehouse shortcut". */
  providerName?: string; shareName?: string;
}) {
  const s = useStyles();

  const [scOpen, setScOpen] = useState(false);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [browseErr, setBrowseErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, { tables: string[] | null; err?: string }>>({});
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);

  const [sql, setSql] = useState('');
  const [result, setResult] = useState<QueryData | null>(null);
  const [running, setRunning] = useState(false);
  const [queryErr, setQueryErr] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [filter, setFilter] = useState('');

  // --- browse: schemas in the catalog ---
  const loadSchemas = useCallback(async () => {
    if (!host) { setBrowseErr('No workspace host bound.'); setSchemas([]); return; }
    setBrowseErr(null); setSchemas(null);
    try {
      const r = await clientFetch(`/api/catalog/browse?source=unity-catalog&path=${encodeURIComponent([host, catalog].join('|'))}`);
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setBrowseErr(j.error || `HTTP ${r.status}`); setSchemas([]); return; }
      setSchemas((j.nodes || []).map((n: any) => n.id as string));
    } catch (e: any) {
      setBrowseErr(String(e?.message || e)); setSchemas([]);
    }
  }, [host, catalog]);

  useEffect(() => { void loadSchemas(); }, [loadSchemas]);

  // --- browse: tables in a schema (lazy on expand) ---
  const loadTables = useCallback(async (schema: string) => {
    if (!host) return;
    setExpanded((prev) => ({ ...prev, [schema]: { tables: null } }));
    try {
      const r = await clientFetch(`/api/catalog/browse?source=unity-catalog&path=${encodeURIComponent([host, catalog, schema].join('|'))}`);
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setExpanded((prev) => ({ ...prev, [schema]: { tables: [], err: j.error || `HTTP ${r.status}` } })); return; }
      const tables = (j.nodes || []).filter((n: any) => n.kind === 'table').map((n: any) => n.label as string);
      setExpanded((prev) => ({ ...prev, [schema]: { tables } }));
    } catch (e: any) {
      setExpanded((prev) => ({ ...prev, [schema]: { tables: [], err: String(e?.message || e) } }));
    }
  }, [host, catalog]);

  // --- query: run SQL (or a built table preview) against the warehouse ---
  const runSql = useCallback(async (statement: string, schema?: string) => {
    setRunning(true); setQueryErr(null); setGate(null); setFilter('');
    try {
      const r = await clientFetch('/api/marketplace/sharing/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalog, schema, sql: statement }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gate) { setGate({ error: j.error, missing: j.missing }); setResult(null); return; }
      if (!j.ok) { setQueryErr(j.error || `HTTP ${r.status}`); setResult(null); return; }
      setResult(j.data as QueryData);
    } catch (e: any) {
      setQueryErr(String(e?.message || e)); setResult(null);
    } finally {
      setRunning(false);
    }
  }, [catalog]);

  // Click a table → load a 100-row preview and seed the editor with the query.
  const previewTable = useCallback((schema: string, table: string) => {
    setSelected({ schema, table });
    const preview = `SELECT * FROM ${bt(catalog)}.${bt(schema)}.${bt(table)} LIMIT 100`;
    setSql(preview);
    void runSql(preview, schema);
  }, [catalog, runSql]);

  const filteredRows = useMemo(() => {
    if (!result) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return result.rows;
    return result.rows.filter((row) => row.some((cell) => fmtCell(cell).toLowerCase().includes(needle)));
  }, [result, filter]);

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Database20Regular />
        <Subtitle2>{catalog}</Subtitle2>
        <Badge appearance="tint" color="brand">Subscribed share · read-only</Badge>
        <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={() => { void loadSchemas(); }}>
          Refresh
        </Button>
        {host && <Caption1 className={s.hint}>Workspace: {host}</Caption1>}
      </div>
      <TeachingBanner
        surfaceKey="marketplace-share-explorer"
        title="Explore a subscribed share"
        message="Browse this share's schemas and tables, preview data, or run read-only SQL — all live against the Databricks SQL warehouse. No data is copied to Loom."
        icon={DatabaseSearch24Regular}
        accent={LOOM_ACCENT.teal}
      />

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>SQL warehouse not configured</MessageBarTitle>
            {gate.error}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.split}>
        {/* LEFT: schema → table tree */}
        <div className={s.treePane}>
          <div className={s.header}>
            <FolderOpen20Regular />
            <Caption1><b>Schemas</b></Caption1>
          </div>
          {browseErr && <MessageBar intent="error"><MessageBarBody>{browseErr}</MessageBarBody></MessageBar>}
          {schemas === null && <Spinner size="tiny" label="Loading schemas…" labelPosition="after" />}
          {schemas && schemas.length === 0 && !browseErr && (
            <Caption1 className={s.hint}>No schemas in this catalog.</Caption1>
          )}
          {schemas && schemas.length > 0 && (
            <Tree aria-label="Catalog schemas and tables">
              {schemas.map((schema) => {
                const node = expanded[schema];
                return (
                  <TreeItem
                    key={schema} itemType="branch" value={schema}
                    onOpenChange={(_, d) => { if (d.open && !expanded[schema]) void loadTables(schema); }}
                  >
                    <TreeItemLayout iconBefore={<Database20Regular />}>{schema}</TreeItemLayout>
                    <Tree>
                      {node?.tables === null && (
                        <TreeItem itemType="leaf" value={`${schema}::loading`}>
                          <TreeItemLayout><Spinner size="tiny" /></TreeItemLayout>
                        </TreeItem>
                      )}
                      {node?.err && (
                        <TreeItem itemType="leaf" value={`${schema}::err`}>
                          <TreeItemLayout><Caption1 className={s.hint}>{node.err}</Caption1></TreeItemLayout>
                        </TreeItem>
                      )}
                      {node?.tables && node.tables.length === 0 && !node.err && (
                        <TreeItem itemType="leaf" value={`${schema}::empty`}>
                          <TreeItemLayout><Caption1 className={s.hint}>No tables</Caption1></TreeItemLayout>
                        </TreeItem>
                      )}
                      {(node?.tables || []).map((table) => (
                        <TreeItem key={`${schema}.${table}`} itemType="leaf" value={`${schema}.${table}`}>
                          <TreeItemLayout
                            iconBefore={<Table20Regular />}
                            onClick={() => previewTable(schema, table)}
                            aria-label={`Preview ${schema}.${table}`}
                          >
                            <span className={s.treeLeaf}>
                              {table}
                              {selected?.schema === schema && selected?.table === table && (
                                <Badge size="extra-small" appearance="tint" color="brand">preview</Badge>
                              )}
                            </span>
                          </TreeItemLayout>
                        </TreeItem>
                      ))}
                    </Tree>
                  </TreeItem>
                );
              })}
            </Tree>
          )}
        </div>

        {/* RIGHT: SQL editor + results */}
        <div className={s.queryPane}>
          <div className={s.toolbar}>
            <Body1><b>SQL</b></Body1>
            <Caption1 className={s.hint}>Read-only — SELECT / SHOW / DESCRIBE</Caption1>
            <div className={s.spacer} style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
              <Tooltip content="Copy a PySpark cell that reads the selected table — paste into any notebook" relationship="label">
                <Button
                  appearance="subtle" icon={<Copy20Regular />}
                  disabled={!selected}
                  onClick={() => { if (selected) copyText(`# ${catalog}.${selected.schema}.${selected.table} (live Delta share)\ndf = spark.read.table("${catalog}.${selected.schema}.${selected.table}")\ndisplay(df)\n`); }}
                >
                  Copy Spark read
                </Button>
              </Tooltip>
              <Tooltip content="Copy the current SQL to run elsewhere" relationship="label">
                <Button appearance="subtle" icon={<Copy20Regular />} disabled={!sql.trim()} onClick={() => copyText(sql)}>
                  Copy SQL
                </Button>
              </Tooltip>
              {providerName && shareName && (
                <Tooltip content="Register the selected shared table in one of your lakehouses — reuses the provider credential stored when the share was added" relationship="label">
                  <Button appearance="subtle" disabled={!selected} onClick={() => setScOpen(true)}>
                    Create lakehouse shortcut
                  </Button>
                </Tooltip>
              )}
              {providerName && shareName && selected && (
                <ShareShortcutDialog
                  open={scOpen}
                  onClose={() => setScOpen(false)}
                  providerName={providerName}
                  shareName={shareName}
                  schema={selected.schema}
                  table={selected.table}
                />
              )}
              <Button
                appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play20Regular />}
                disabled={running || !sql.trim()}
                onClick={() => { void runSql(sql, selected?.schema); }}
              >
                {running ? 'Running…' : 'Run'}
              </Button>
            </div>
          </div>
          <div className={s.editorBox}>
            <MonacoTextarea
              value={sql}
              onChange={setSql}
              language="sql"
              height={160}
              ariaLabel="SQL query editor"
              minimap={false}
            />
          </div>

          <div className={s.resultsBox}>
            {queryErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{queryErr}</MessageBarBody></MessageBar>}

            {running && !result && (
              <Spinner size="small" label="Executing…" labelPosition="after" />
            )}

            {!running && !result && !queryErr && !gate && (
              <GuidedEmptyState
                variant="block"
                heroIcon={DatabaseSearch24Regular}
                title="Explore this share"
                intro="Pick a table on the left to preview it, or start from one of these."
                ariaLabel="Share exploration starting points"
                paths={[
                  {
                    key: 'schemas',
                    title: 'List schemas',
                    body: 'Run SHOW SCHEMAS to see everything in this share.',
                    icon: FolderOpen20Regular,
                    onClick: () => { const q = `SHOW SCHEMAS IN ${bt(catalog)}`; setSql(q); void runSql(q); },
                  },
                  {
                    key: 'sample',
                    title: 'Sample a table',
                    body: 'Seed a SELECT … LIMIT 100 template, fill in the table, then Run.',
                    icon: Table20Regular,
                    onClick: () => setSql(`SELECT * FROM ${bt(catalog)}.\`schema\`.\`table\` LIMIT 100`),
                  },
                ]}
              />
            )}

            {result && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="success">{result.rowCount.toLocaleString()} rows</Badge>
                  {result.truncated && (
                    <Badge appearance="outline" color="warning">
                      Showing first {result.rows.length.toLocaleString()} of {result.rowCount.toLocaleString()}
                    </Badge>
                  )}
                  <Caption1 className={s.hint}>· {result.executionMs} ms · {result.columns.length} cols</Caption1>
                  {filter.trim() && <Caption1 className={s.hint}>· {filteredRows.length.toLocaleString()} match filter</Caption1>}
                  <div className={s.spacer}>
                    <Input
                      size="small" contentBefore={<Search20Regular />} placeholder="Filter rows…"
                      value={filter} onChange={(_, d) => setFilter(d.value)} aria-label="Filter result rows"
                    />
                    <Tooltip content="Download results as CSV" relationship="label">
                      <Button
                        size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                        disabled={!result.columns.length}
                        onClick={() => downloadCsv(`${catalog}-query-${stamp()}.csv`, result.columns, result.rows)}
                      >CSV</Button>
                    </Tooltip>
                    <Tooltip content="Copy column names + data (TSV)" relationship="label">
                      <Button
                        size="small" appearance="subtle" icon={<Copy20Regular />}
                        disabled={!result.columns.length}
                        onClick={() => {
                          const lines = [result.columns.join('\t'),
                            ...filteredRows.map((r) => result.columns.map((_, j) => fmtCell(r[j])).join('\t'))];
                          navigator.clipboard?.writeText(lines.join('\n')).catch(() => { /* clipboard blocked */ });
                        }}
                      >Copy</Button>
                    </Tooltip>
                  </div>
                </div>

                {result.rowCount === 0 || result.columns.length === 0 ? (
                  <Caption1 className={s.hint}>Statement completed — no rows returned.</Caption1>
                ) : (
                  <div className={s.tableWrap}>
                    <Table aria-label="Query results" size="small">
                      <TableHeader>
                        <TableRow>{result.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredRows.map((row, i) => (
                          <TableRow key={i}>
                            {result.columns.map((_, j) => <TableCell key={j} className={s.cell}>{fmtCell(row[j])}</TableCell>)}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * ShareExplorerDialog — wraps {@link ShareExplorerPanel} in a Fluent Dialog so a
 * "Explore" / "Query" action anywhere in the Data shares surface can open the
 * full experience scoped to a single mounted catalog.
 */
export function ShareExplorerDialog({
  open, setOpen, catalog, host, providerName, shareName,
}: {
  open: boolean; setOpen: (b: boolean) => void; catalog: string | null; host: string | null;
  /** Provider + share coordinates of the mounted catalog — enable "Create lakehouse shortcut" when present. */
  providerName?: string; shareName?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface style={{ maxWidth: '1100px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>Explore &amp; query — {catalog}</DialogTitle>
          <DialogContent>
            {catalog
              ? <ShareExplorerPanel catalog={catalog} host={host} providerName={providerName} shareName={shareName} />
              : <Caption1>No catalog selected.</Caption1>}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * ShareShortcutDialog — register a shared table as a Tables shortcut in one of
 * the user's lakehouses. targetUri = delta-sharing://<share>/<schema>/<table>;
 * credentialRef reuses the provider activation credential stored at add time
 * (KV secret loom-dsp-<provider>) so nothing is re-pasted. The shortcuts route
 * validates the credential against the share server and (with Databricks
 * configured) registers a real delta_sharing UC table; otherwise it answers
 * with the honest engine gate, which is surfaced verbatim.
 */
function ShareShortcutDialog({ open, onClose, providerName, shareName, schema, table }: {
  open: boolean; onClose: () => void;
  providerName: string; shareName: string; schema: string; table: string;
}) {
  const [wsList, setWsList] = useState<{ id: string; displayName: string }[] | null>(null);
  const [wsId, setWsId] = useState('');
  const [lhList, setLhList] = useState<{ id: string; displayName: string }[] | null>(null);
  const [lhId, setLhId] = useState('');
  const [name, setName] = useState(table);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null); setDone(null); setName(table);
    clientFetch('/api/workspaces').then((r) => r.json()).then((d: any) => {
      const list = (Array.isArray(d) ? d : (d?.workspaces || [])).map((w: any) => ({ id: w.id, displayName: w.displayName || w.name || w.id }));
      setWsList(list);
      if (list.length) setWsId(list[0].id);
    }).catch((e) => { setErr(String(e?.message || e)); setWsList([]); });
  }, [open, table]);

  useEffect(() => {
    if (!open || !wsId) return;
    setLhList(null); setLhId('');
    clientFetch(`/api/workspaces/${encodeURIComponent(wsId)}/items`).then((r) => r.json()).then((d: any) => {
      const items = (Array.isArray(d) ? d : (d?.items || []))
        .filter((it: any) => it.itemType === 'lakehouse')
        .map((it: any) => ({ id: it.id, displayName: it.displayName || it.id }));
      setLhList(items);
      if (items.length) setLhId(items[0].id);
    }).catch(() => setLhList([]));
  }, [open, wsId]);

  const create = useCallback(async () => {
    if (!lhId) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await clientFetch('/api/lakehouse/shortcuts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lakehouseId: lhId,
          name: (name.trim() || table).replace(/[^A-Za-z0-9 _.-]/g, '_'),
          kind: 'tables',
          targetType: 'delta_sharing',
          targetUri: `delta-sharing://${shareName}/${schema}/${table}`,
          credentialRef: { kind: 'deltaSharing', keyVaultSecret: `loom-dsp-${providerName}` },
          format: 'delta',
        }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setErr(j?.hint || j?.error || `HTTP ${r.status}`); return; }
      setDone(`Shortcut "${j.data?.name || name}" created — the shared table now appears under the lakehouse's Tables.`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [lhId, name, providerName, shareName, schema, table]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Shortcut “{schema}.{table}” into a lakehouse</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1>
                Registers the shared table as a Tables shortcut — live, no copy. Reuses the credential stored
                when provider “{providerName}” was added.
              </Caption1>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              {done && <MessageBar intent="success"><MessageBarBody>{done}</MessageBarBody></MessageBar>}
              <Field label="Workspace" required>
                {wsList === null ? <Spinner size="tiny" /> : (
                  <Select value={wsId} onChange={(_, d) => setWsId(d.value)}>
                    {wsList.map((w) => <option key={w.id} value={w.id}>{w.displayName}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Lakehouse" required>
                {lhList === null ? <Spinner size="tiny" /> : lhList.length === 0 ? (
                  <Caption1>No lakehouse in this workspace — pick another workspace or create a lakehouse first.</Caption1>
                ) : (
                  <Select value={lhId} onChange={(_, d) => setLhId(d.value)}>
                    {lhList.map((l) => <option key={l.id} value={l.id}>{l.displayName}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Shortcut name" required>
                <Input value={name} onChange={(_, d) => setName(d.value)} />
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
            <Button appearance="primary" disabled={busy || !lhId || !name.trim() || !!done} icon={busy ? <Spinner size="tiny" /> : undefined} onClick={() => { void create(); }}>
              {busy ? 'Creating…' : 'Create shortcut'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default ShareExplorerPanel;
