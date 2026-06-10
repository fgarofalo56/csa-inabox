'use client';

/**
 * Full-text search (FTS) + SQL Server 2025 vector-index management panels for
 * the AzureSqlDatabaseEditor (Fabric Build 2026 #23).
 *
 * Two self-contained panels — <FullTextSearchPanel> and <VectorIndexPanel> —
 * each render an inventory grid (live sys.* reads) plus guided create/drop
 * dialogs. Every dropdown is sourced from the database catalog; nothing is
 * free-typed JSON. All actions POST to
 *   /api/items/azure-sql-database/[id]/search-management
 * which builds + executes the DDL over real TDS. NO Microsoft Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Field, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Switch, Checkbox,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular, DocumentSearch20Regular,
  Sparkle20Regular, Play20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  panel: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { marginLeft: 'auto' },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  code: { fontFamily: 'Consolas, monospace', fontSize: 12 },
  ddlPreview: {
    fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap',
    background: tokens.colorNeutralBackground3, padding: 10, borderRadius: 4,
    border: `1px solid ${tokens.colorNeutralStroke2}`, marginTop: 8,
  },
  dialogGrid: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 460 },
  rowActions: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' },
  colList: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' },
  colRow: { display: 'flex', gap: 8, alignItems: 'center' },
  colLang: { minWidth: 160 },
  bgRunning: { color: tokens.colorNeutralForeground3 },
  dialogWide: { maxWidth: 640, width: '92vw' },
  dialogMed: { maxWidth: 560, width: '92vw' },
});

// Common LCIDs for the FTS column-language dropdown (grounded in sys.fulltext_languages).
const FTS_LANGUAGES = [
  { lcid: '', label: 'Server default' },
  { lcid: '1033', label: 'English — US (1033)' },
  { lcid: '2057', label: 'English — UK (2057)' },
  { lcid: '1031', label: 'German (1031)' },
  { lcid: '1036', label: 'French (1036)' },
  { lcid: '3082', label: 'Spanish (3082)' },
  { lcid: '1041', label: 'Japanese (1041)' },
  { lcid: '2052', label: 'Chinese — Simplified (2052)' },
  { lcid: '1046', label: 'Portuguese — Brazil (1046)' },
  { lcid: '1049', label: 'Russian (1049)' },
  { lcid: '0', label: 'Neutral (0)' },
];

const VECTOR_METRICS = ['cosine', 'euclidean', 'dot'] as const;

interface Row { [k: string]: unknown }
interface Inventory {
  catalogs: Row[];
  ftsIndexes: Row[];
  vectorIndexes: Row[];
  vectorNote?: string;
  tables: Row[];
  ftsColumns: Row[];
  vectorColumns: Row[];
  keyIndexes: Row[];
}

function str(v: unknown): string { return v == null ? '' : String(v); }
function tkey(schema: unknown, table: unknown): string { return `${str(schema)}.${str(table)}`; }

/** Shared loader hook for the search-management inventory. */
function useInventory(id: string, server: string, database: string) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!server || !database) { setInv(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/search-management?server=${encodeURIComponent(server)}&database=${encodeURIComponent(database)}&kind=inventory`);
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setInv(null); }
        else {
          setInv({
            catalogs: j.catalogs || [], ftsIndexes: j.ftsIndexes || [],
            vectorIndexes: j.vectorIndexes || [], vectorNote: j.vectorNote,
            tables: j.tables || [], ftsColumns: j.ftsColumns || [],
            vectorColumns: j.vectorColumns || [], keyIndexes: j.keyIndexes || [],
          });
        }
      } catch (e: any) { if (!cancelled) { setError(e?.message || String(e)); } }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [id, server, database, tick]);
  return { inv, error, loading, refresh };
}

async function postAction(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; ddl?: string; sqlNumber?: number }> {
  const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/search-management`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

// ============================================================
// Full-text search panel
// ============================================================
export function FullTextSearchPanel({ id, server, database }: { id: string; server: string; database: string }) {
  const s = useStyles();
  const { inv, error, loading, refresh } = useInventory(id, server, database);

  // Catalog dialog
  const [catOpen, setCatOpen] = useState(false);
  const [catName, setCatName] = useState('');
  const [catAccent, setCatAccent] = useState(true);
  const [catDefault, setCatDefault] = useState(false);

  // FTS index dialog
  const [ftsOpen, setFtsOpen] = useState(false);
  const [ftsTable, setFtsTable] = useState('');
  const [ftsCols, setFtsCols] = useState<Record<string, string>>({}); // column -> lcid
  const [ftsKeyIndex, setFtsKeyIndex] = useState('');
  const [ftsCatalog, setFtsCatalog] = useState('');
  const [ftsTracking, setFtsTracking] = useState('AUTO');

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<{ schema: string; table: string } | null>(null);

  const ready = !!server && !!database;

  const tableOptions = useMemo(() => (inv?.tables || []).map((t) => tkey(t.schema_name, t.table_name)), [inv]);
  const colsForTable = useMemo(() => {
    if (!ftsTable || !inv) return [] as Row[];
    const [schema, table] = ftsTable.split('.');
    return inv.ftsColumns.filter((c) => str(c.schema_name) === schema && str(c.table_name) === table);
  }, [ftsTable, inv]);
  const keyIndexesForTable = useMemo(() => {
    if (!ftsTable || !inv) return [] as Row[];
    const [schema, table] = ftsTable.split('.');
    return inv.keyIndexes.filter((k) => str(k.schema_name) === schema && str(k.table_name) === table);
  }, [ftsTable, inv]);

  const openFtsDialog = useCallback(() => {
    setFtsTable(''); setFtsCols({}); setFtsKeyIndex(''); setFtsTracking('AUTO');
    setFtsCatalog(str(inv?.catalogs?.find((c) => c.is_default)?.name) || str(inv?.catalogs?.[0]?.name) || '');
    setActionError(null); setActionOk(null); setFtsOpen(true);
  }, [inv]);

  const ftsDdlPreview = useMemo(() => {
    if (!ftsTable) return '';
    const [schema, table] = ftsTable.split('.');
    const selected = Object.keys(ftsCols);
    if (selected.length === 0) return '-- select at least one column';
    const colLines = selected.map((c) => `  [${c}]${ftsCols[c] ? ` LANGUAGE ${ftsCols[c]}` : ''}`).join(',\n');
    const onCat = ftsCatalog ? ` ON [${ftsCatalog}]` : '';
    return `CREATE FULLTEXT INDEX ON [${schema}].[${table}] (\n${colLines}\n) KEY INDEX [${ftsKeyIndex || '<key index>'}]${onCat}\nWITH CHANGE_TRACKING ${ftsTracking};`;
  }, [ftsTable, ftsCols, ftsKeyIndex, ftsCatalog, ftsTracking]);

  const submitCatalog = useCallback(async () => {
    setBusy(true); setActionError(null); setActionOk(null);
    const j = await postAction(id, { server, database, action: 'create-catalog', name: catName.trim(), accentSensitivity: catAccent, asDefault: catDefault });
    setBusy(false);
    if (!j.ok) { setActionError(j.error || 'failed'); return; }
    setActionOk(`Full-text catalog ${catName} created.`); setCatOpen(false); setCatName(''); refresh();
  }, [id, server, database, catName, catAccent, catDefault, refresh]);

  const submitFts = useCallback(async () => {
    const [schema, table] = ftsTable.split('.');
    const columns = Object.keys(ftsCols).map((name) => ({ name, language: ftsCols[name] || undefined }));
    setBusy(true); setActionError(null); setActionOk(null);
    const j = await postAction(id, { server, database, action: 'create-fts', schema, table, columns, keyIndex: ftsKeyIndex, catalog: ftsCatalog || undefined, changeTracking: ftsTracking });
    setBusy(false);
    if (!j.ok) { setActionError(j.error || 'failed'); return; }
    setActionOk(`Full-text index created on ${ftsTable}.`); setFtsOpen(false); refresh();
  }, [id, server, database, ftsTable, ftsCols, ftsKeyIndex, ftsCatalog, ftsTracking, refresh]);

  const populate = useCallback(async (schema: string, table: string, mode: string) => {
    setBusy(true); setActionError(null); setActionOk(null);
    const j = await postAction(id, { server, database, action: 'populate-fts', schema, table, mode });
    setBusy(false);
    if (!j.ok) { setActionError(j.error || 'failed'); return; }
    setActionOk(`Population (${mode}) requested on ${schema}.${table}.`); refresh();
  }, [id, server, database, refresh]);

  const dropFts = useCallback(async (schema: string, table: string) => {
    setBusy(true); setActionError(null); setActionOk(null);
    const j = await postAction(id, { server, database, action: 'drop-fts', schema, table });
    setBusy(false);
    if (!j.ok) { setActionError(j.error || 'failed'); return; }
    setActionOk(`Full-text index dropped on ${schema}.${table}.`); refresh();
  }, [id, server, database, refresh]);

  if (!ready) {
    return <MessageBar intent="info"><MessageBarBody><MessageBarTitle>Pick a server and database</MessageBarTitle>Select an Azure SQL server and database in the left pane to manage full-text catalogs and indexes.</MessageBarBody></MessageBar>;
  }

  return (
    <div className={s.panel}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Full-text search</MessageBarTitle>
          Create and populate <code>CREATE FULLTEXT CATALOG</code> / <code>CREATE FULLTEXT INDEX</code> on this
          database over live TDS. The console identity needs <code>db_owner</code> or <code>db_ddladmin</code>.
          Query the index with <code>CONTAINS</code> / <code>FREETEXT</code> on the Query tab.
        </MessageBarBody>
      </MessageBar>

      <div className={s.toolbar}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => { setCatName(''); setCatAccent(true); setCatDefault(false); setActionError(null); setCatOpen(true); }}>New catalog</Button>
        <Button appearance="primary" icon={<DocumentSearch20Regular />} onClick={openFtsDialog} disabled={(inv?.tables?.length ?? 0) === 0}>New full-text index</Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={refresh} disabled={loading}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
      </div>

      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Inventory failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Action failed</MessageBarTitle>{actionError}</MessageBarBody></MessageBar>}
      {actionOk && <MessageBar intent="success"><MessageBarBody>{actionOk}</MessageBarBody></MessageBar>}

      <Subtitle2>Full-text catalogs ({inv?.catalogs?.length ?? 0})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Full-text catalogs">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Default</TableHeaderCell>
            <TableHeaderCell>Accent sensitive</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {(inv?.catalogs || []).length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No full-text catalogs.</Caption1></TableCell></TableRow>}
            {(inv?.catalogs || []).map((c) => (
              <TableRow key={str(c.name)}>
                <TableCell><strong>{str(c.name)}</strong></TableCell>
                <TableCell>{c.is_default ? <Badge color="brand" appearance="tint">default</Badge> : '—'}</TableCell>
                <TableCell>{c.is_accent_sensitivity_on ? 'Yes' : 'No'}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy}
                    onClick={async () => { setBusy(true); const j = await postAction(id, { server, database, action: 'drop-catalog', name: str(c.name) }); setBusy(false); if (!j.ok) setActionError(j.error || 'failed'); else { setActionOk(`Catalog ${str(c.name)} dropped.`); refresh(); } }}>Drop</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Full-text indexes ({inv?.ftsIndexes?.length ?? 0})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Full-text indexes">
          <TableHeader><TableRow>
            <TableHeaderCell>Table</TableHeaderCell><TableHeaderCell>Columns</TableHeaderCell>
            <TableHeaderCell>Catalog</TableHeaderCell><TableHeaderCell>Change tracking</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {(inv?.ftsIndexes || []).length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No full-text indexes.</Caption1></TableCell></TableRow>}
            {(inv?.ftsIndexes || []).map((f) => {
              const schema = str(f.schema_name), table = str(f.table_name);
              return (
                <TableRow key={tkey(schema, table)}>
                  <TableCell><strong>{schema}.{table}</strong></TableCell>
                  <TableCell className={s.code}>{str(f.columns)}</TableCell>
                  <TableCell>{str(f.catalog_name)}</TableCell>
                  <TableCell>{str(f.change_tracking)}</TableCell>
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button size="small" appearance="subtle" icon={<Play20Regular />} disabled={busy} onClick={() => populate(schema, table, 'START FULL')}>Full pop</Button>
                      <Button size="small" appearance="subtle" disabled={busy} onClick={() => populate(schema, table, 'START INCREMENTAL')}>Incr</Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => setConfirmDrop({ schema, table })}>Drop</Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* New catalog dialog */}
      <Dialog open={catOpen} onOpenChange={(_, d) => setCatOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New full-text catalog</DialogTitle>
            <DialogContent>
              <div className={s.dialogGrid}>
                <Field label="Catalog name" required><Input value={catName} onChange={(_, d) => setCatName(d.value)} placeholder="ftcat_main" /></Field>
                <Switch checked={catAccent} onChange={(_, d) => setCatAccent(d.checked)} label="Accent sensitivity ON" />
                <Switch checked={catDefault} onChange={(_, d) => setCatDefault(d.checked)} label="Set as the database default catalog" />
                {actionError && <MessageBar intent="error"><MessageBarBody>{actionError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCatOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCatalog} disabled={busy || !catName.trim()}>{busy ? 'Creating…' : 'Create catalog'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* New FTS index dialog */}
      <Dialog open={ftsOpen} onOpenChange={(_, d) => setFtsOpen(d.open)}>
        <DialogSurface className={s.dialogWide}>
          <DialogBody>
            <DialogTitle>New full-text index</DialogTitle>
            <DialogContent>
              <div className={s.dialogGrid}>
                <Field label="Table" required>
                  <Dropdown selectedOptions={ftsTable ? [ftsTable] : []} value={ftsTable} placeholder="Select a table"
                    onOptionSelect={(_, d) => { setFtsTable(d.optionValue || ''); setFtsCols({}); setFtsKeyIndex(''); }}>
                    {tableOptions.map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
                {ftsTable && (
                  <>
                    <Field label="Columns to index (text columns)" required>
                      <div className={s.colList}>
                        {colsForTable.length === 0 && <Caption1>No FTS-eligible (char/varchar/text/xml/varbinary) columns on this table.</Caption1>}
                        {colsForTable.map((c) => {
                          const name = str(c.column_name);
                          const checked = name in ftsCols;
                          return (
                            <div key={name} className={s.colRow}>
                              <Checkbox checked={checked} label={`${name} (${str(c.data_type)})`}
                                onChange={(_, d) => setFtsCols((prev) => { const next = { ...prev }; if (d.checked) next[name] = ''; else delete next[name]; return next; })} />
                              {checked && (
                                <Dropdown size="small" className={s.colLang} selectedOptions={[ftsCols[name]]} value={FTS_LANGUAGES.find((l) => l.lcid === ftsCols[name])?.label || 'Server default'}
                                  onOptionSelect={(_, d) => setFtsCols((prev) => ({ ...prev, [name]: d.optionValue || '' }))} aria-label={`Language for ${name}`}>
                                  {FTS_LANGUAGES.map((l) => <Option key={l.lcid} value={l.lcid}>{l.label}</Option>)}
                                </Dropdown>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </Field>
                    <Field label="KEY INDEX (single-column unique, non-null)" required hint={keyIndexesForTable.length === 0 ? 'No eligible unique index — create one on the table first.' : undefined}>
                      <Dropdown selectedOptions={ftsKeyIndex ? [ftsKeyIndex] : []} value={ftsKeyIndex} placeholder="Select the unique key index"
                        onOptionSelect={(_, d) => setFtsKeyIndex(d.optionValue || '')}>
                        {keyIndexesForTable.map((k) => <Option key={str(k.index_name)} value={str(k.index_name)}>{str(k.index_name)}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Catalog">
                      <Dropdown selectedOptions={ftsCatalog ? [ftsCatalog] : []} value={ftsCatalog} placeholder="Default catalog"
                        onOptionSelect={(_, d) => setFtsCatalog(d.optionValue || '')}>
                        {(inv?.catalogs || []).map((c) => <Option key={str(c.name)} value={str(c.name)}>{`${str(c.name)}${c.is_default ? ' (default)' : ''}`}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Change tracking">
                      <Dropdown selectedOptions={[ftsTracking]} value={ftsTracking} onOptionSelect={(_, d) => setFtsTracking(d.optionValue || 'AUTO')}>
                        {['AUTO', 'MANUAL', 'OFF'].map((m) => <Option key={m} value={m}>{m}</Option>)}
                      </Dropdown>
                    </Field>
                    <div className={s.ddlPreview}>{ftsDdlPreview}</div>
                  </>
                )}
                {actionError && <MessageBar intent="error"><MessageBarBody>{actionError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setFtsOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitFts} disabled={busy || !ftsTable || Object.keys(ftsCols).length === 0 || !ftsKeyIndex}>{busy ? 'Creating…' : 'Create full-text index'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Drop FTS confirm */}
      <Dialog open={!!confirmDrop} onOpenChange={(_, d) => { if (!d.open) setConfirmDrop(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Drop full-text index?</DialogTitle>
            <DialogContent>
              <Body1>This drops the full-text index on <code>{confirmDrop?.schema}.{confirmDrop?.table}</code>. This cannot be undone.</Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDrop(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" disabled={busy} onClick={async () => { const c = confirmDrop; setConfirmDrop(null); if (c) await dropFts(c.schema, c.table); }}>{busy ? 'Dropping…' : 'Drop index'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ============================================================
// Vector index panel (SQL Server 2025)
// ============================================================
export function VectorIndexPanel({ id, server, database }: { id: string; server: string; database: string }) {
  const s = useStyles();
  const { inv, error, loading, refresh } = useInventory(id, server, database);

  const [open, setOpen] = useState(false);
  const [table, setTable] = useState('');
  const [column, setColumn] = useState('');
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<typeof VECTOR_METRICS[number]>('cosine');
  const [maxdop, setMaxdop] = useState('');

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<{ schema: string; table: string; name: string } | null>(null);

  const ready = !!server && !!database;

  const tablesWithVectorCols = useMemo(() => {
    if (!inv) return [] as string[];
    const set = new Set(inv.vectorColumns.map((c) => tkey(c.schema_name, c.table_name)));
    return Array.from(set);
  }, [inv]);
  const colsForTable = useMemo(() => {
    if (!table || !inv) return [] as Row[];
    const [schema, t] = table.split('.');
    return inv.vectorColumns.filter((c) => str(c.schema_name) === schema && str(c.table_name) === t);
  }, [table, inv]);

  const ddlPreview = useMemo(() => {
    if (!table || !column || !name) return '';
    const [schema, t] = table.split('.');
    const md = maxdop.trim() ? `, MAXDOP = ${maxdop.trim()}` : '';
    return `CREATE VECTOR INDEX [${name}]\n  ON [${schema}].[${t}] ([${column}])\n  WITH (METRIC = '${metric}', TYPE = 'DiskANN'${md});`;
  }, [table, column, name, metric, maxdop]);

  const openDialog = useCallback(() => {
    setTable(''); setColumn(''); setName(''); setMetric('cosine'); setMaxdop('');
    setActionError(null); setActionOk(null); setOpen(true);
  }, []);

  const submit = useCallback(async () => {
    const [schema, t] = table.split('.');
    setBusy(true); setActionError(null); setActionOk(null);
    const j = await postAction(id, { server, database, action: 'create-vector', schema, table: t, column, name, metric, maxdop: maxdop.trim() || undefined });
    setBusy(false);
    if (!j.ok) { setActionError(j.error || 'failed'); return; }
    setActionOk(`Vector index ${name} created on ${table}.`); setOpen(false); refresh();
  }, [id, server, database, table, column, name, metric, maxdop, refresh]);

  const drop = useCallback(async (schema: string, t: string, idxName: string) => {
    setBusy(true); setActionError(null); setActionOk(null);
    const j = await postAction(id, { server, database, action: 'drop-vector', schema, table: t, name: idxName });
    setBusy(false);
    if (!j.ok) { setActionError(j.error || 'failed'); return; }
    setActionOk(`Vector index ${idxName} dropped.`); refresh();
  }, [id, server, database, refresh]);

  if (!ready) {
    return <MessageBar intent="info"><MessageBarBody><MessageBarTitle>Pick a server and database</MessageBarTitle>Select an Azure SQL server and database in the left pane to manage vector indexes.</MessageBarBody></MessageBar>;
  }

  return (
    <div className={s.panel}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Vector indexes <Badge appearance="tint" color="brand">SQL 2025 / Azure SQL DB</Badge></MessageBarTitle>
          DiskANN <code>CREATE VECTOR INDEX</code> over a <code>vector(N)</code> column. Available on Azure SQL Database and
          SQL Server 2025 (major ≥ 17). Search the index with <code>VECTOR_SEARCH</code> on the Query tab.
          {inv?.vectorNote && <><br /><Caption1>{inv.vectorNote}</Caption1></>}
        </MessageBarBody>
      </MessageBar>

      <div className={s.toolbar}>
        <Button appearance="primary" icon={<Sparkle20Regular />} onClick={openDialog} disabled={(inv?.vectorColumns?.length ?? 0) === 0}
          title={(inv?.vectorColumns?.length ?? 0) === 0 ? 'No vector(N) columns found — add one with ALTER TABLE on the Query tab first' : undefined}>
          New vector index
        </Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={refresh} disabled={loading}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
      </div>

      {(inv?.vectorColumns?.length ?? 0) === 0 && !loading && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>No vector columns found</MessageBarTitle>
          Add a vector column first, e.g. <code>ALTER TABLE dbo.docs ADD embedding VECTOR(1536);</code> on the Query tab,
          then refresh.
        </MessageBarBody></MessageBar>
      )}

      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Inventory failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Action failed</MessageBarTitle>{actionError}</MessageBarBody></MessageBar>}
      {actionOk && <MessageBar intent="success"><MessageBarBody>{actionOk}</MessageBarBody></MessageBar>}

      <Subtitle2>Vector indexes ({inv?.vectorIndexes?.length ?? 0})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Vector indexes">
          <TableHeader><TableRow>
            <TableHeaderCell>Index</TableHeaderCell><TableHeaderCell>Table</TableHeaderCell>
            <TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell>
            <TableHeaderCell>Action</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {(inv?.vectorIndexes || []).length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No vector indexes.</Caption1></TableCell></TableRow>}
            {(inv?.vectorIndexes || []).map((v) => {
              const schema = str(v.schema_name), t = str(v.table_name), n = str(v.index_name);
              return (
                <TableRow key={`${schema}.${t}.${n}`}>
                  <TableCell><strong>{n}</strong></TableCell>
                  <TableCell>{schema}.{t}</TableCell>
                  <TableCell>{str(v.metric) || '—'}</TableCell>
                  <TableCell>{str(v.version) || '—'}</TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => setConfirmDrop({ schema, table: t, name: n })}>Drop</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* New vector index dialog */}
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface className={s.dialogMed}>
          <DialogBody>
            <DialogTitle>New vector index</DialogTitle>
            <DialogContent>
              <div className={s.dialogGrid}>
                <Field label="Table" required>
                  <Dropdown selectedOptions={table ? [table] : []} value={table} placeholder="Select a table with a vector column"
                    onOptionSelect={(_, d) => { setTable(d.optionValue || ''); setColumn(''); }}>
                    {tablesWithVectorCols.map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Vector column" required>
                  <Dropdown selectedOptions={column ? [column] : []} value={column} placeholder="Select the vector(N) column"
                    onOptionSelect={(_, d) => { setColumn(d.optionValue || ''); if (!name && d.optionValue) { const [, t] = table.split('.'); setName(`vec_${t}_${d.optionValue}`); } }}>
                    {colsForTable.map((c) => <Option key={str(c.column_name)} value={str(c.column_name)}>{str(c.column_name)}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Index name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="vec_docs_embedding" /></Field>
                <Field label="Distance metric" required>
                  <Dropdown selectedOptions={[metric]} value={metric} onOptionSelect={(_, d) => setMetric((d.optionValue as any) || 'cosine')}>
                    {VECTOR_METRICS.map((m) => <Option key={m} value={m}>{m}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="MAXDOP (optional, 0-64)"><Input type="number" value={maxdop} onChange={(_, d) => setMaxdop(d.value)} placeholder="server default" /></Field>
                {ddlPreview && <div className={s.ddlPreview}>{ddlPreview}</div>}
                {actionError && <MessageBar intent="error"><MessageBarBody>{actionError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submit} disabled={busy || !table || !column || !name.trim()}>{busy ? 'Creating…' : 'Create vector index'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Drop vector confirm */}
      <Dialog open={!!confirmDrop} onOpenChange={(_, d) => { if (!d.open) setConfirmDrop(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Drop vector index?</DialogTitle>
            <DialogContent>
              <Body1>This drops <code>{confirmDrop?.name}</code> on <code>{confirmDrop?.schema}.{confirmDrop?.table}</code>. This cannot be undone.</Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDrop(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" disabled={busy} onClick={async () => { const c = confirmDrop; setConfirmDrop(null); if (c) await drop(c.schema, c.table, c.name); }}>{busy ? 'Dropping…' : 'Drop index'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
