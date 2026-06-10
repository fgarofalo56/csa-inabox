'use client';

/**
 * SqlSearchPanel — Full-Text Search (FTS) + native DiskANN vector-index
 * management for Azure SQL Database, one-for-one with the SSMS / portal query
 * editor surface but driven by guided dialogs with a live preview-SQL pane.
 *
 * Wizards (each: configure with sys.*-populated pickers → Preview generated
 * T-SQL → Execute over TDS + Entra token → receipt → list refresh):
 *
 *   - Full-text catalog   CREATE / DROP FULLTEXT CATALOG
 *   - Full-text index     CREATE / DROP FULLTEXT INDEX (KEY INDEX + columns)
 *   - Vector index        CREATE VECTOR INDEX (DiskANN) / DROP INDEX  (SQL 2025)
 *
 * Plus live state tables listing existing catalogs, FT indexes, and vector
 * indexes from the catalog views. The client never sends raw SQL — only
 * structured params; the BFF route builds the SQL server-side
 * (lib/sql/sql-search-builders.ts). No mock data: every list and receipt comes
 * from a real TDS round-trip, or an honest MessageBar gate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner,
  Dropdown, Option, Field, Input, Checkbox,
  TabList, Tab,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, DocumentSearch20Regular, Sparkle20Regular,
  Eye20Regular, Add20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  FT_CHANGE_TRACKING, ACCENT_SENSITIVITY, FT_LANGUAGES,
  VECTOR_METRICS, type FtChangeTracking, type AccentSensitivity, type VectorMetric,
} from '@/lib/sql/sql-search-builders';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 4, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 16,
    display: 'flex', flexDirection: 'column', gap: 12, backgroundColor: tokens.colorNeutralBackground1,
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  full: { width: '100%' },
});

// ------------------------------------------------------------------
// State shapes (mirror the route GET response)
// ------------------------------------------------------------------

interface FtCatalogRow { catalog_name: string; is_default: boolean; accent_sensitive: boolean; item_count?: number }
interface FtIndexRow { schema_name: string; table_name: string; catalog_name: string; is_enabled: boolean; change_tracking: string; key_index_name: string; columns: string }
interface VectorIndexRow { schema_name: string; table_name: string; index_name: string; distance_metric: string; vector_index_type: string }
interface Capabilities { majorVersion: number | null; productVersion: string | null; hasVectorType: boolean; ftsInstalled: boolean }

interface SearchState {
  ok: boolean;
  ftCatalogs: FtCatalogRow[];
  ftIndexes: FtIndexRow[];
  keyIndexesByTable: Record<string, string[]>;
  ftColumnsByTable: Record<string, { name: string; dataType: string }[]>;
  vectorColumnsByTable: Record<string, string[]>;
  vectorIndexes: VectorIndexRow[];
  capabilities: Capabilities;
  warnings?: string[];
}

type SearchTab = 'ft-catalog' | 'ft-index' | 'vector' | 'state';

export interface SqlSearchPanelProps {
  itemType: string;
  itemId: string;
  server?: string;
  database?: string;
}

interface ExecResult { ok: boolean; sql?: string; recordsAffected?: number; executionMs?: number; error?: string }

interface PanelCtx {
  base: string;
  qs: string;
  state: SearchState | null;
  reload: () => Promise<void>;
}

async function callWizard(base: string, qs: string, payload: any): Promise<ExecResult & { gated?: boolean }> {
  const r = await fetch(`${base}${qs}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

function PreviewPane({ sql }: { sql: string }) {
  if (!sql) return null;
  return (
    <Field label="Preview T-SQL (generated server-side — runs exactly this)">
      <MonacoTextarea value={sql} onChange={() => { /* read-only */ }} language="tsql" readOnly height={160} ariaLabel="Generated T-SQL preview" />
    </Field>
  );
}

function ResultBar({ result }: { result: ExecResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Execution failed</MessageBarTitle>{result.error}</MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="success">
      <MessageBarBody>
        <MessageBarTitle>Executed</MessageBarTitle>
        {typeof result.recordsAffected === 'number' ? `${result.recordsAffected} row(s) affected · ` : ''}
        {typeof result.executionMs === 'number' ? `${result.executionMs} ms` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}

export function SqlSearchPanel({ itemType, itemId, server, database }: SqlSearchPanelProps) {
  const s = useStyles();
  const [state, setState] = useState<SearchState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [tab, setTab] = useState<SearchTab>('ft-catalog');

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (server) p.set('server', server);
    if (database) p.set('database', database);
    const str = p.toString();
    return str ? `?${str}` : '';
  }, [server, database]);

  const base = `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/sql-search`;

  const reload = useCallback(async () => {
    setLoading(true); setLoadError(null); setGate(null);
    try {
      const r = await fetch(`${base}${qs}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setState(null); }
      else if (!j.ok) { setLoadError(j.error || 'failed to load search state'); setState(null); }
      else setState(j as SearchState);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base, qs]);

  useEffect(() => { reload(); }, [reload]);

  const ctx: PanelCtx = { base, qs, state, reload };
  const caps = state?.capabilities;
  const vectorReady = !!caps?.hasVectorType;

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<Search20Regular />}>Search · FTS + Vector</Badge>
        {caps?.productVersion && <Badge appearance="outline">Engine {caps.productVersion}</Badge>}
        {caps?.ftsInstalled && <Badge appearance="outline" color="success">Full-Text installed</Badge>}
        {vectorReady && <Badge appearance="outline" color="success">Vector type available</Badge>}
        <Badge appearance="outline" color="success">Microsoft Entra auth only</Badge>
        <Button size="small" appearance="outline" onClick={reload} disabled={loading}>Refresh</Button>
        {loading && <Spinner size="tiny" label="Reading catalog…" labelPosition="after" />}
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load search state</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}
      {state?.warnings?.length ? (
        <MessageBar intent="info">
          <MessageBarBody><MessageBarTitle>Partial catalog read</MessageBarTitle>{state.warnings.join(' · ')}</MessageBarBody>
        </MessageBar>
      ) : null}

      {state && (
        <>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as SearchTab)}>
            <Tab value="ft-catalog" icon={<DocumentSearch20Regular />}>Full-text catalog</Tab>
            <Tab value="ft-index" icon={<DocumentSearch20Regular />}>Full-text index</Tab>
            <Tab value="vector" icon={<Sparkle20Regular />}>Vector index</Tab>
            <Tab value="state" icon={<Eye20Regular />}>Existing objects</Tab>
          </TabList>

          {tab === 'ft-catalog' && <FtCatalogWizard ctx={ctx} />}
          {tab === 'ft-index' && <FtIndexWizard ctx={ctx} />}
          {tab === 'vector' && <VectorIndexWizard ctx={ctx} vectorReady={vectorReady} caps={caps} />}
          {tab === 'state' && <ExistingObjects state={state} ctx={ctx} />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Wizard 1 — Full-text catalog
// ------------------------------------------------------------------

function FtCatalogWizard({ ctx }: { ctx: PanelCtx }) {
  const s = useStyles();
  const [catalogName, setCatalogName] = useState('ftCatalog');
  const [accent, setAccent] = useState<AccentSensitivity>('ON');
  const [asDefault, setAsDefault] = useState(false);
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);

  const params = { catalogName, accentSensitivity: accent, asDefault };
  const ready = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(catalogName);

  const doPreview = async () => {
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'ft-catalog', params, preview: true });
    setSql(r.sql || ''); if (!r.ok) setResult(r);
    setBusy(false);
  };
  const doExecute = async () => {
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'ft-catalog', params, preview: false });
    setSql(r.sql || sql); setResult(r);
    if (r.ok) await ctx.reload();
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Create a full-text catalog</Subtitle2>
      <Body1>A catalog is a logical container for one or more full-text indexes. Create one before creating a full-text index.</Body1>
      <div className={s.grid2}>
        <Field label="Catalog name" required validationMessage={ready ? undefined : 'Letters, digits and underscore; must start with a letter or underscore.'} validationState={ready ? 'none' : 'error'}>
          <Input value={catalogName} onChange={(_, d) => setCatalogName(d.value)} placeholder="ftCatalog" />
        </Field>
        <Field label="Accent sensitivity">
          <Dropdown className={s.full} selectedOptions={[accent]} value={accent} onOptionSelect={(_, d) => setAccent((d.optionValue as AccentSensitivity) || 'ON')} aria-label="Accent sensitivity">
            {ACCENT_SENSITIVITY.map((a) => <Option key={a} value={a}>{a}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Checkbox label="Set as the database's default full-text catalog (AS DEFAULT)" checked={asDefault} onChange={(_, d) => setAsDefault(!!d.checked)} />
      <PreviewPane sql={sql} />
      <div className={s.actions}>
        <Button appearance="secondary" icon={<Eye20Regular />} onClick={doPreview} disabled={busy || !ready}>Preview</Button>
        <Button appearance="primary" icon={<Add20Regular />} onClick={doExecute} disabled={busy || !ready}>Create catalog</Button>
        {busy && <Spinner size="tiny" />}
      </div>
      <ResultBar result={result} />
    </div>
  );
}

// ------------------------------------------------------------------
// Wizard 2 — Full-text index
// ------------------------------------------------------------------

function FtIndexWizard({ ctx }: { ctx: PanelCtx }) {
  const s = useStyles();
  const state = ctx.state;
  const tableKeys = useMemo(() => Object.keys(state?.ftColumnsByTable || {}).sort(), [state]);
  const [tableKey, setTableKey] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [language, setLanguage] = useState<number>(1033);
  const [keyIndex, setKeyIndex] = useState('');
  const [catalog, setCatalog] = useState('');
  const [changeTracking, setChangeTracking] = useState<FtChangeTracking>('AUTO');
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);

  const availCols = (tableKey && state?.ftColumnsByTable[tableKey]) || [];
  const availKeyIdx = (tableKey && state?.keyIndexesByTable[tableKey]) || [];
  const catalogs = state?.ftCatalogs || [];
  const [schema, tableName] = tableKey ? tableKey.split('.') : ['', ''];

  const params = {
    schema, tableName,
    columns: columns.map((c) => ({ column: c, languageLcid: language })),
    keyIndex, catalogName: catalog, changeTracking,
  };
  const ready = !!tableKey && columns.length > 0 && !!keyIndex && !!catalog;

  const toggleCol = (c: string, on: boolean) =>
    setColumns((cur) => (on ? [...new Set([...cur, c])] : cur.filter((x) => x !== c)));

  const doPreview = async () => {
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'ft-index', params, preview: true });
    setSql(r.sql || ''); if (!r.ok) setResult(r);
    setBusy(false);
  };
  const doExecute = async () => {
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'ft-index', params, preview: false });
    setSql(r.sql || sql); setResult(r);
    if (r.ok) await ctx.reload();
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Create a full-text index</Subtitle2>
      <Body1>One full-text index per table. It needs a unique, single-column, non-nullable index as its KEY INDEX and must belong to a catalog.</Body1>
      {catalogs.length === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>No full-text catalog yet</MessageBarTitle>Create one on the Full-text catalog tab first.</MessageBarBody>
        </MessageBar>
      )}
      <div className={s.grid2}>
        <Field label="Table" required>
          <Dropdown className={s.full} selectedOptions={tableKey ? [tableKey] : []} value={tableKey} placeholder="Select a table"
            onOptionSelect={(_, d) => { setTableKey(d.optionValue || ''); setColumns([]); setKeyIndex(''); }} aria-label="Table">
            {tableKeys.map((k) => <Option key={k} value={k}>{k}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Catalog" required>
          <Dropdown className={s.full} selectedOptions={catalog ? [catalog] : []} value={catalog} placeholder="Select a catalog"
            onOptionSelect={(_, d) => setCatalog(d.optionValue || '')} aria-label="Catalog">
            {catalogs.map((c) => <Option key={c.catalog_name} value={c.catalog_name}>{`${c.catalog_name}${c.is_default ? ' (default)' : ''}`}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label="Columns to index (char / varchar / text / xml / varbinary)" required>
        {!tableKey && <Caption1>Pick a table to choose columns.</Caption1>}
        <div className={s.actions}>
          {availCols.map((c) => (
            <Checkbox key={c.name} label={`${c.name} (${c.dataType})`} checked={columns.includes(c.name)} onChange={(_, d) => toggleCol(c.name, !!d.checked)} />
          ))}
          {tableKey && availCols.length === 0 && <Caption1>No full-text-indexable columns on this table.</Caption1>}
        </div>
      </Field>
      <div className={s.grid2}>
        <Field label="KEY INDEX (unique, single-column, non-nullable)" required>
          <Dropdown className={s.full} selectedOptions={keyIndex ? [keyIndex] : []} value={keyIndex} placeholder={tableKey ? 'Select a key index' : 'Pick a table first'}
            onOptionSelect={(_, d) => setKeyIndex(d.optionValue || '')} aria-label="Key index" disabled={!tableKey}>
            {availKeyIdx.map((k) => <Option key={k} value={k}>{k}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Language">
          <Dropdown className={s.full} selectedOptions={[String(language)]} value={FT_LANGUAGES.find((l) => l.lcid === language)?.label || String(language)}
            onOptionSelect={(_, d) => setLanguage(Number(d.optionValue || '1033'))} aria-label="Language">
            {FT_LANGUAGES.map((l) => <Option key={l.lcid} value={String(l.lcid)}>{l.label}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label="Change tracking (population)">
        <Dropdown className={s.full} selectedOptions={[changeTracking]} value={changeTracking}
          onOptionSelect={(_, d) => setChangeTracking((d.optionValue as FtChangeTracking) || 'AUTO')} aria-label="Change tracking">
          {FT_CHANGE_TRACKING.map((c) => <Option key={c} value={c}>{c}</Option>)}
        </Dropdown>
      </Field>
      {tableKey && availKeyIdx.length === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>No eligible KEY INDEX</MessageBarTitle>This table has no unique, single-column, non-nullable index. Create one (e.g. <code>CREATE UNIQUE INDEX ...</code>) on the Query tab, then refresh.</MessageBarBody>
        </MessageBar>
      )}
      <PreviewPane sql={sql} />
      <div className={s.actions}>
        <Button appearance="secondary" icon={<Eye20Regular />} onClick={doPreview} disabled={busy || !ready}>Preview</Button>
        <Button appearance="primary" icon={<Add20Regular />} onClick={doExecute} disabled={busy || !ready}>Create index</Button>
        {busy && <Spinner size="tiny" />}
      </div>
      <ResultBar result={result} />
    </div>
  );
}

// ------------------------------------------------------------------
// Wizard 3 — Vector index (SQL Server 2025 DiskANN)
// ------------------------------------------------------------------

function VectorIndexWizard({ ctx, vectorReady, caps }: { ctx: PanelCtx; vectorReady: boolean; caps?: Capabilities }) {
  const s = useStyles();
  const state = ctx.state;
  const tableKeys = useMemo(() => Object.keys(state?.vectorColumnsByTable || {}).sort(), [state]);
  const [tableKey, setTableKey] = useState('');
  const [vectorColumn, setVectorColumn] = useState('');
  const [indexName, setIndexName] = useState('');
  const [metric, setMetric] = useState<VectorMetric>('cosine');
  const [maxdop, setMaxdop] = useState<number>(0);
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);

  const availCols = (tableKey && state?.vectorColumnsByTable[tableKey]) || [];
  const [schema, tableName] = tableKey ? tableKey.split('.') : ['', ''];
  const params = { indexName, schema, tableName, vectorColumn, metric, type: 'DiskANN' as const, maxdop };
  const ready = !!tableKey && !!vectorColumn && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(indexName);

  const doPreview = async () => {
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'vector-index', params, preview: true });
    setSql(r.sql || ''); if (!r.ok) setResult(r);
    setBusy(false);
  };
  const doExecute = async () => {
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'vector-index', params, preview: false });
    setSql(r.sql || sql); setResult(r);
    if (r.ok) await ctx.reload();
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Create a DiskANN vector index</Subtitle2>
      <Body1>Native <code>CREATE VECTOR INDEX</code> builds a DiskANN graph over a <code>vector</code> column for approximate nearest-neighbour search (<code>VECTOR_SEARCH</code>). Available on Azure SQL Database / SQL Server 2025.</Body1>
      {!vectorReady && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Vector type not available on this engine</MessageBarTitle>
            No <code>vector</code> type found{caps?.productVersion ? ` (engine ${caps.productVersion})` : ''}. Native vector indexes require Azure SQL Database or SQL Server 2025 (major version ≥ 17). The wizard still builds and previews the exact DDL, but Execute will fail on an older engine.
          </MessageBarBody>
        </MessageBar>
      )}
      {vectorReady && tableKeys.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody><MessageBarTitle>No vector columns found</MessageBarTitle>Add a <code>vector(n)</code> column to a table first (e.g. <code>ALTER TABLE dbo.docs ADD embedding vector(1536);</code>), then refresh.</MessageBarBody>
        </MessageBar>
      )}
      <div className={s.grid2}>
        <Field label="Table" required>
          <Dropdown className={s.full} selectedOptions={tableKey ? [tableKey] : []} value={tableKey} placeholder="Select a table"
            onOptionSelect={(_, d) => { setTableKey(d.optionValue || ''); setVectorColumn(''); }} aria-label="Table">
            {tableKeys.map((k) => <Option key={k} value={k}>{k}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Vector column" required>
          <Dropdown className={s.full} selectedOptions={vectorColumn ? [vectorColumn] : []} value={vectorColumn} placeholder={tableKey ? 'Select a vector column' : 'Pick a table first'}
            onOptionSelect={(_, d) => setVectorColumn(d.optionValue || '')} aria-label="Vector column" disabled={!tableKey}>
            {availCols.map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <div className={s.grid2}>
        <Field label="Index name" required validationMessage={/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(indexName) || !indexName ? undefined : 'Letters, digits and underscore; must start with a letter or underscore.'} validationState={!indexName || /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(indexName) ? 'none' : 'error'}>
          <Input value={indexName} onChange={(_, d) => setIndexName(d.value)} placeholder="vec_idx" />
        </Field>
        <Field label="Distance metric">
          <Dropdown className={s.full} selectedOptions={[metric]} value={metric} onOptionSelect={(_, d) => setMetric((d.optionValue as VectorMetric) || 'cosine')} aria-label="Distance metric">
            {VECTOR_METRICS.map((m) => <Option key={m} value={m}>{m}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label="MAXDOP (0 = server default)">
        <Dropdown className={s.full} selectedOptions={[String(maxdop)]} value={String(maxdop)} onOptionSelect={(_, d) => setMaxdop(Number(d.optionValue || '0'))} aria-label="MAXDOP">
          {[0, 1, 2, 4, 8, 16].map((n) => <Option key={n} value={String(n)}>{n === 0 ? '0 (server default)' : String(n)}</Option>)}
        </Dropdown>
      </Field>
      <PreviewPane sql={sql} />
      <div className={s.actions}>
        <Button appearance="secondary" icon={<Eye20Regular />} onClick={doPreview} disabled={busy || !ready}>Preview</Button>
        <Button appearance="primary" icon={<Add20Regular />} onClick={doExecute} disabled={busy || !ready}>Create vector index</Button>
        {busy && <Spinner size="tiny" />}
      </div>
      <ResultBar result={result} />
    </div>
  );
}

// ------------------------------------------------------------------
// Existing objects — live state tables + drop actions
// ------------------------------------------------------------------

function ExistingObjects({ state, ctx }: { state: SearchState; ctx: PanelCtx }) {
  const s = useStyles();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);

  const drop = async (wizard: string, params: any, key: string) => {
    setBusy(key); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard, params, preview: false });
    setResult(r);
    if (r.ok) await ctx.reload();
    setBusy(null);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Full-text catalogs</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Full-text catalogs">
          <TableHeader><TableRow>
            <TableHeaderCell>Catalog</TableHeaderCell><TableHeaderCell>Default</TableHeaderCell>
            <TableHeaderCell>Accent sensitive</TableHeaderCell><TableHeaderCell>Items</TableHeaderCell><TableHeaderCell>Drop</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {state.ftCatalogs.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No full-text catalogs.</Caption1></TableCell></TableRow>}
            {state.ftCatalogs.map((c) => (
              <TableRow key={c.catalog_name}>
                <TableCell>{c.catalog_name}</TableCell>
                <TableCell>{c.is_default ? 'Yes' : 'No'}</TableCell>
                <TableCell>{c.accent_sensitive ? 'Yes' : 'No'}</TableCell>
                <TableCell>{c.item_count ?? '—'}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={!!busy}
                    onClick={() => drop('ft-catalog-drop', { catalogName: c.catalog_name }, `cat:${c.catalog_name}`)}>Drop</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Full-text indexes</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Full-text indexes">
          <TableHeader><TableRow>
            <TableHeaderCell>Table</TableHeaderCell><TableHeaderCell>Columns</TableHeaderCell>
            <TableHeaderCell>Catalog</TableHeaderCell><TableHeaderCell>Change tracking</TableHeaderCell>
            <TableHeaderCell>Enabled</TableHeaderCell><TableHeaderCell>Drop</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {state.ftIndexes.length === 0 && <TableRow><TableCell colSpan={6}><Caption1>No full-text indexes.</Caption1></TableCell></TableRow>}
            {state.ftIndexes.map((fi) => (
              <TableRow key={`${fi.schema_name}.${fi.table_name}`}>
                <TableCell>{fi.schema_name}.{fi.table_name}</TableCell>
                <TableCell>{fi.columns}</TableCell>
                <TableCell>{fi.catalog_name}</TableCell>
                <TableCell>{fi.change_tracking}</TableCell>
                <TableCell>{fi.is_enabled ? 'Yes' : 'No'}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={!!busy}
                    onClick={() => drop('ft-index-drop', { schema: fi.schema_name, tableName: fi.table_name }, `fti:${fi.schema_name}.${fi.table_name}`)}>Drop</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Vector indexes</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Vector indexes">
          <TableHeader><TableRow>
            <TableHeaderCell>Table</TableHeaderCell><TableHeaderCell>Index</TableHeaderCell>
            <TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Drop</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {state.vectorIndexes.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No vector indexes.</Caption1></TableCell></TableRow>}
            {state.vectorIndexes.map((vi) => (
              <TableRow key={`${vi.schema_name}.${vi.table_name}.${vi.index_name}`}>
                <TableCell>{vi.schema_name}.{vi.table_name}</TableCell>
                <TableCell>{vi.index_name}</TableCell>
                <TableCell>{vi.distance_metric}</TableCell>
                <TableCell>{vi.vector_index_type}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={!!busy}
                    onClick={() => drop('vector-index-drop', { indexName: vi.index_name, schema: vi.schema_name, tableName: vi.table_name }, `vi:${vi.index_name}`)}>Drop</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ResultBar result={result} />
    </div>
  );
}
