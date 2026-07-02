'use client';

/**
 * UcSecurityPanel — the Unity Catalog granular-security surface for Databricks
 * SQL Warehouse items. The Databricks-side companion to {@link SqlSecurityPanel}
 * (Synapse object/column GRANT + RLS + DDM). One-for-one with the column-mask /
 * row-filter DDL you'd hand-write in a Databricks SQL editor, but driven by
 * guided wizards with a live preview-SQL pane.
 *
 * Three tabs, each populated from `information_schema` (no mock data):
 *   - Column mask  CREATE FUNCTION (CASE … IS_ACCOUNT_GROUP_MEMBER) + ALTER TABLE
 *                  ALTER COLUMN … SET MASK
 *   - Row filter   CREATE FUNCTION (CURRENT_USER() = col OR group) + ALTER TABLE
 *                  SET ROW FILTER … ON (col)
 *   - Current      live information_schema.column_masks + .row_filters
 *
 * The client never sends raw SQL — only structured params; the BFF route builds
 * the SQL server-side (lib/sql/uc-security-builders.ts) and executes it over the
 * Databricks Statement Execution API. The only non-functional state is an honest
 * MessageBar gate (Databricks not configured / Gov boundary).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner,
  Dropdown, Option, Field, Input,
  TabList, Tab,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldKeyhole20Regular, Play20Regular, Eye20Regular, Beaker20Regular,
  Filter20Regular, Add20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalXS, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, backgroundColor: tokens.colorNeutralBackground1,
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: '320px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
});

// ------------------------------------------------------------------
// State shapes (mirror the route GET response)
// ------------------------------------------------------------------

interface SchemaRow { schema_name: string }
interface TableRowT { table_schema: string; table_name: string }
interface ColumnRow { column_name: string; data_type: string; is_nullable?: string }

interface UcState {
  ok: boolean;
  backend: 'databricks-uc';
  catalog: string | null;
  schema: string | null;
  table: string | null;
  columnMasks: Record<string, any>[];
  rowFilters: Record<string, any>[];
  schemas: SchemaRow[];
  tables: TableRowT[];
  columns: ColumnRow[];
  warnings?: string[];
  needsCatalog?: boolean;
}

type UcTab = 'mask' | 'filter' | 'policy' | 'current';

export interface UcSecurityPanelProps {
  itemType: string;
  itemId: string;
  /** Active SQL warehouse id from the editor's warehouse picker. */
  warehouseId?: string;
  /** Active catalog from the editor's UC tree (seeds the catalog field). */
  catalog?: string;
}

export function UcSecurityPanel({ itemType, itemId, warehouseId, catalog: catalogProp }: UcSecurityPanelProps) {
  const s = useStyles();
  const base = `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/security`;

  const [catalog, setCatalog] = useState(catalogProp || '');
  const [catalogInput, setCatalogInput] = useState(catalogProp || '');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [sec, setSec] = useState<UcState | null>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<UcTab>('mask');

  useEffect(() => { if (catalogProp) { setCatalog(catalogProp); setCatalogInput(catalogProp); } }, [catalogProp]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (warehouseId) p.set('warehouseId', warehouseId);
    if (catalog) p.set('catalog', catalog);
    if (schema) p.set('schema', schema);
    if (table) p.set('table', table);
    const str = p.toString();
    return str ? `?${str}` : '';
  }, [warehouseId, catalog, schema, table]);

  const reload = useCallback(async () => {
    setLoading(true); setLoadError(null); setGate(null);
    try {
      const r = await fetch(`${base}${qs}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setSec(null); }
      else if (!j.ok) { setLoadError(j.error || 'failed to load UC security state'); setSec(null); }
      else setSec(j as UcState);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base, qs]);

  useEffect(() => { reload(); }, [reload]);

  const ctx: WizardCtx = {
    base, warehouseId, catalog, schema, table,
    setSchema: (v) => { setSchema(v); setTable(''); },
    setTable,
    sec, reload,
  };

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<ShieldKeyhole20Regular />}>Unity Catalog security</Badge>
        <Badge appearance="outline" color="success">Microsoft Entra UPN principals</Badge>
        {sec?.catalog && <Badge appearance="outline">{sec.catalog}</Badge>}
        <Button size="small" appearance="outline" onClick={reload} disabled={loading}>Refresh</Button>
        {loading && <Spinner size="tiny" label="Reading information_schema…" labelPosition="after" />}
      </div>

      <div className={s.row}>
        <Field label="Catalog" required style={{ minWidth: 240 }} hint="The UC catalog whose information_schema is read">
          <Input
            value={catalogInput}
            onChange={(_, d) => setCatalogInput(d.value)}
            onBlur={() => setCatalog(catalogInput.trim())}
            placeholder="main"
          />
        </Field>
        <Button appearance="outline" onClick={() => setCatalog(catalogInput.trim())} disabled={!catalogInput.trim()}>Load catalog</Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Configuration required</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load UC security state</MessageBarTitle>
            {loadError}
          </MessageBarBody>
        </MessageBar>
      )}
      {sec?.warnings?.length ? (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Partial catalog read</MessageBarTitle>
            {sec.warnings.join(' · ')}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {sec?.needsCatalog && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Pick a catalog</MessageBarTitle>
            Enter a Unity Catalog catalog name above and click Load catalog to list its schemas, masks and filters.
          </MessageBarBody>
        </MessageBar>
      )}

      {sec && !sec.needsCatalog && (
        <>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as UcTab)}>
            <Tab value="mask" icon={<ShieldKeyhole20Regular />}>Column mask</Tab>
            <Tab value="filter" icon={<ShieldKeyhole20Regular />}>Row filter</Tab>
            <Tab value="policy" icon={<Filter20Regular />}>ABAC policies</Tab>
            <Tab value="current" icon={<Eye20Regular />}>Current security</Tab>
          </TabList>

          {tab === 'mask' && <ColumnMaskWizard ctx={ctx} />}
          {tab === 'filter' && <RowFilterWizard ctx={ctx} />}
          {tab === 'policy' && <AbacPolicyPanel ctx={ctx} />}
          {tab === 'current' && <CurrentUcSecurity sec={sec} />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Shared wizard plumbing
// ------------------------------------------------------------------

interface WizardCtx {
  base: string;
  warehouseId?: string;
  catalog: string;
  schema: string;
  table: string;
  setSchema: (v: string) => void;
  setTable: (v: string) => void;
  sec: UcState | null;
  reload: () => Promise<void>;
}

interface ExecResult {
  ok: boolean; sql?: string; functionName?: string; executionMs?: number; error?: string; stage?: string;
}

async function callRoute(base: string, payload: any): Promise<any> {
  const r = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

function PreviewPane({ sql }: { sql: string }) {
  if (!sql) return null;
  return (
    <Field label="Preview SQL (generated server-side — runs exactly this)">
      <MonacoTextarea value={sql} onChange={() => { /* read-only */ }} language="sql" readOnly height={170} ariaLabel="Generated Databricks SQL preview" />
    </Field>
  );
}

function ResultBar({ result }: { result: ExecResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Execution failed{result.stage ? ` (${result.stage})` : ''}</MessageBarTitle>
          {result.error}
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="success">
      <MessageBarBody>
        <MessageBarTitle>Applied</MessageBarTitle>
        {result.functionName ? `${result.functionName} · ` : ''}
        {typeof result.executionMs === 'number' ? `${result.executionMs} ms` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}

interface VerifyData {
  adminView: { columns: string[]; rows: unknown[][]; rowCount: number };
  masksApplied: Record<string, any>[];
  rowFiltersApplied: Record<string, any>[];
  note: string;
}

function VerifyResult({ data }: { data: VerifyData | null }) {
  const s = useStyles();
  if (!data) return null;
  return (
    <div className={s.card} style={{ gap: tokens.spacingVerticalS }}>
      <Subtitle2>Verification — admin (Console UAMI) view</Subtitle2>
      <Caption1>
        Bound masks: {data.masksApplied.length} · bound row filters: {data.rowFiltersApplied.length} ·
        {' '}{data.adminView.rowCount} row(s) (unfiltered, unmasked — admin view)
      </Caption1>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Admin view of the table">
          <TableHeader><TableRow>{data.adminView.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
          <TableBody>
            {data.adminView.rows.length === 0 && <TableRow><TableCell colSpan={Math.max(1, data.adminView.columns.length)}><Caption1>0 rows.</Caption1></TableCell></TableRow>}
            {data.adminView.rows.map((row, i) => (
              <TableRow key={i}>{data.adminView.columns.map((_, j) => <TableCell key={j} className={s.mono}>{String(row[j] ?? '∅')}</TableCell>)}</TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <MessageBar intent="info"><MessageBarBody>{data.note}</MessageBarBody></MessageBar>
    </div>
  );
}

/** Schema + table pickers shared by both wizards. */
function TargetPickers({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const schemas = ctx.sec?.schemas || [];
  const tables = ctx.sec?.tables || [];
  return (
    <div className={s.grid2}>
      <Field label="Schema" required>
        <Dropdown placeholder="Pick a schema" value={ctx.schema} selectedOptions={ctx.schema ? [ctx.schema] : []}
          onOptionSelect={(_, d) => ctx.setSchema(d.optionValue || '')}>
          {schemas.map((sc) => <Option key={sc.schema_name} value={sc.schema_name} text={sc.schema_name}>{sc.schema_name}</Option>)}
        </Dropdown>
      </Field>
      <Field label={`Table (${tables.length} in schema)`} required>
        <Dropdown placeholder={ctx.schema ? 'Pick a table' : 'Pick a schema first'} value={ctx.table} selectedOptions={ctx.table ? [ctx.table] : []}
          onOptionSelect={(_, d) => ctx.setTable(d.optionValue || '')}>
          {tables.map((t) => <Option key={t.table_name} value={t.table_name} text={t.table_name}>{t.table_name}</Option>)}
        </Dropdown>
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------
// Column mask wizard
// ------------------------------------------------------------------

function ColumnMaskWizard({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const columns = ctx.sec?.columns || [];
  const [column, setColumn] = useState('');
  const [maskMode, setMaskMode] = useState<'null' | 'literal'>('null');
  const [maskLiteral, setMaskLiteral] = useState('***');
  const [allowedGroup, setAllowedGroup] = useState('');
  const [maskSchema, setMaskSchema] = useState('');
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [verify, setVerify] = useState<VerifyData | null>(null);

  const col = columns.find((c) => c.column_name === column);
  const isStringCol = !!col && /^string|^varchar|^char/i.test(col.data_type);
  const ready = !!ctx.schema && !!ctx.table && !!column && !!col && !!allowedGroup.trim()
    && (maskMode === 'null' || isStringCol);

  const params = col ? {
    catalog: ctx.catalog, schema: ctx.schema, tableName: ctx.table,
    columnName: column, columnType: col.data_type,
    maskSchema: maskSchema.trim() || undefined,
    maskMode, maskLiteral: maskMode === 'literal' ? maskLiteral : undefined,
    allowedGroup: allowedGroup.trim(),
  } : null;

  const post = async (preview: boolean) => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callRoute(ctx.base, { wizard: 'column-mask', params, preview, warehouseId: ctx.warehouseId, catalog: ctx.catalog });
    setSql(r.sql || (preview ? '' : sql));
    if (!preview || !r.ok) setResult(r);
    if (!preview && r.ok) ctx.reload();
    setBusy(false);
  };
  const doDrop = async () => {
    if (!ctx.table || !column) return;
    setBusy(true); setResult(null);
    const r = await callRoute(ctx.base, {
      action: 'drop-mask',
      params: { catalog: ctx.catalog, schema: ctx.schema, tableName: ctx.table, columnName: column },
      warehouseId: ctx.warehouseId, catalog: ctx.catalog,
    });
    setSql(r.sql || sql); setResult(r); if (r.ok) ctx.reload();
    setBusy(false);
  };
  const doVerify = async () => {
    if (!ctx.table) return;
    setBusy(true); setVerify(null);
    const r = await callRoute(ctx.base, {
      action: 'verify', verify: { catalog: ctx.catalog, schema: ctx.schema, tableName: ctx.table },
      warehouseId: ctx.warehouseId,
    });
    if (r.ok) setVerify(r as VerifyData); else setResult(r);
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Column mask (hide values from non-privileged users)</Subtitle2>
      <Caption1>
        Mirrors <code>CREATE FUNCTION</code> (a <code>CASE</code> over <code>IS_ACCOUNT_GROUP_MEMBER()</code>) +
        {' '}<code>ALTER TABLE … ALTER COLUMN … SET MASK</code>. Members of the allowed account group see the real
        value; everyone else sees the masked value.
      </Caption1>
      <TargetPickers ctx={ctx} />
      <div className={s.grid2}>
        <Field label={`Column (${columns.length} in table)`} required>
          <Dropdown placeholder={ctx.table ? 'Pick a column' : 'Pick a table first'} value={column} selectedOptions={column ? [column] : []}
            onOptionSelect={(_, d) => setColumn(d.optionValue || '')}>
            {columns.map((c) => <Option key={c.column_name} value={c.column_name} text={c.column_name}>{c.column_name} : {c.data_type}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Allowed account group (sees real value)" required hint="IS_ACCOUNT_GROUP_MEMBER('…')">
          <Input value={allowedGroup} onChange={(_, d) => setAllowedGroup(d.value)} placeholder="hr-admins" />
        </Field>
      </div>
      <div className={s.grid2}>
        <Field label="Mask value (what others see)">
          <Dropdown value={maskMode} selectedOptions={[maskMode]} onOptionSelect={(_, d) => setMaskMode((d.optionValue as any) || 'null')}>
            <Option value="null" text="NULL — redact to null (any type)">NULL — redact to null (any type)</Option>
            <Option value="literal" text="Literal — fixed string (STRING columns)">Literal — fixed string (STRING columns)</Option>
          </Dropdown>
        </Field>
        {maskMode === 'literal' && (
          <Field label="Replacement literal" required hint="STRING-typed column only">
            <Input value={maskLiteral} onChange={(_, d) => setMaskLiteral(d.value)} placeholder="***-**-****" />
          </Field>
        )}
      </div>
      <Field label="Mask UDF schema (where the function is created)" hint="Defaults to the table's schema">
        <Input value={maskSchema} onChange={(_, d) => setMaskSchema(d.value)} placeholder={ctx.schema || 'security'} />
      </Field>
      {maskMode === 'literal' && col && !isStringCol && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Literal mask needs a STRING column</MessageBarTitle>
            <code>{col.column_name}</code> is <code>{col.data_type}</code>. Use the NULL mask for non-string columns.
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={s.actions}>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={() => post(true)}>Preview SQL</Button>
        <Button icon={<Play20Regular />} appearance="primary" disabled={!ready || busy} onClick={() => post(false)}>{busy ? 'Working…' : 'Apply mask'}</Button>
        <Button appearance="subtle" disabled={!ctx.table || !column || busy} onClick={doDrop}>Clear mask</Button>
        <Button icon={<Beaker20Regular />} appearance="subtle" disabled={!ctx.table || busy} onClick={doVerify}
          title="Read information_schema to confirm the mask is bound + show the admin (unmasked) view">Verify</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
      <VerifyResult data={verify} />
    </div>
  );
}

// ------------------------------------------------------------------
// Row filter wizard
// ------------------------------------------------------------------

function RowFilterWizard({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const columns = ctx.sec?.columns || [];
  const [filterColumn, setFilterColumn] = useState('');
  const [adminGroup, setAdminGroup] = useState('');
  const [filterSchema, setFilterSchema] = useState('');
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [verify, setVerify] = useState<VerifyData | null>(null);

  const col = columns.find((c) => c.column_name === filterColumn);
  const ready = !!ctx.schema && !!ctx.table && !!filterColumn && !!adminGroup.trim();

  const params = col ? {
    catalog: ctx.catalog, schema: ctx.schema, tableName: ctx.table,
    filterColumn, filterColumnType: col.data_type,
    filterSchema: filterSchema.trim() || undefined,
    adminGroup: adminGroup.trim(),
  } : null;

  const post = async (preview: boolean) => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callRoute(ctx.base, { wizard: 'row-filter', params, preview, warehouseId: ctx.warehouseId, catalog: ctx.catalog });
    setSql(r.sql || (preview ? '' : sql));
    if (!preview || !r.ok) setResult(r);
    if (!preview && r.ok) ctx.reload();
    setBusy(false);
  };
  const doDrop = async () => {
    if (!ctx.table) return;
    setBusy(true); setResult(null);
    const r = await callRoute(ctx.base, {
      action: 'drop-filter',
      params: { catalog: ctx.catalog, schema: ctx.schema, tableName: ctx.table },
      warehouseId: ctx.warehouseId, catalog: ctx.catalog,
    });
    setSql(r.sql || sql); setResult(r); if (r.ok) ctx.reload();
    setBusy(false);
  };
  const doVerify = async () => {
    if (!ctx.table) return;
    setBusy(true); setVerify(null);
    const r = await callRoute(ctx.base, {
      action: 'verify', verify: { catalog: ctx.catalog, schema: ctx.schema, tableName: ctx.table },
      warehouseId: ctx.warehouseId,
    });
    if (r.ok) setVerify(r as VerifyData); else setResult(r);
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Row filter (hide rows from non-privileged users)</Subtitle2>
      <Caption1>
        Mirrors <code>CREATE FUNCTION</code> (<code>CURRENT_USER() = owner_col OR IS_ACCOUNT_GROUP_MEMBER()</code>) +
        {' '}<code>ALTER TABLE … SET ROW FILTER … ON (col)</code>. Each row is visible only when the chosen column
        equals the querying user's UPN, or they are in the admin group. One row filter per table.
      </Caption1>
      <TargetPickers ctx={ctx} />
      <div className={s.grid2}>
        <Field label="Filter column (compared to CURRENT_USER())" required hint="A column holding the owning principal's UPN">
          <Dropdown placeholder={ctx.table ? 'Pick a column' : 'Pick a table first'} value={filterColumn} selectedOptions={filterColumn ? [filterColumn] : []}
            onOptionSelect={(_, d) => setFilterColumn(d.optionValue || '')}>
            {columns.map((c) => <Option key={c.column_name} value={c.column_name} text={c.column_name}>{c.column_name} : {c.data_type}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Admin account group (bypasses the filter)" required hint="IS_ACCOUNT_GROUP_MEMBER('…')">
          <Input value={adminGroup} onChange={(_, d) => setAdminGroup(d.value)} placeholder="data-admins" />
        </Field>
      </div>
      <Field label="Filter UDF schema (where the function is created)" hint="Defaults to the table's schema">
        <Input value={filterSchema} onChange={(_, d) => setFilterSchema(d.value)} placeholder={ctx.schema || 'security'} />
      </Field>
      <div className={s.actions}>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={() => post(true)}>Preview SQL</Button>
        <Button icon={<Play20Regular />} appearance="primary" disabled={!ready || busy} onClick={() => post(false)}>{busy ? 'Working…' : 'Apply row filter'}</Button>
        <Button appearance="subtle" disabled={!ctx.table || busy} onClick={doDrop}>Drop row filter</Button>
        <Button icon={<Beaker20Regular />} appearance="subtle" disabled={!ctx.table || busy} onClick={doVerify}
          title="Read information_schema to confirm the filter is bound + show the admin (all-rows) view">Verify</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
      <VerifyResult data={verify} />
    </div>
  );
}

// ------------------------------------------------------------------
// ABAC policies — tag-driven row filters + column masks
// ------------------------------------------------------------------

type PolicyRow = Record<string, unknown>;

function AbacPolicyPanel({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const POL_BASE = '/api/databricks/unity-catalog/policies';

  const [securableType, setSecurableType] = useState<'CATALOG' | 'SCHEMA' | 'TABLE'>(
    ctx.table ? 'TABLE' : ctx.schema ? 'SCHEMA' : 'CATALOG',
  );
  const [effective, setEffective] = useState(true);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [cols, setCols] = useState<string[]>(['Policy Name', 'Policy Type', 'Catalog', 'Schema', 'Table', 'Comment']);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const securableName = useMemo(() => {
    if (securableType === 'CATALOG') return ctx.catalog;
    if (securableType === 'SCHEMA') return ctx.schema ? `${ctx.catalog}.${ctx.schema}` : '';
    return ctx.schema && ctx.table ? `${ctx.catalog}.${ctx.schema}.${ctx.table}` : '';
  }, [securableType, ctx.catalog, ctx.schema, ctx.table]);

  const load = useCallback(async () => {
    if (!securableName) { setPolicies([]); return; }
    setLoading(true); setErr(null); setGate(null);
    try {
      const p = new URLSearchParams({ securable_type: securableType, securable_name: securableName });
      if (effective) p.set('effective', 'true');
      if (ctx.warehouseId) p.set('warehouseId', ctx.warehouseId);
      const r = await fetch(`${POL_BASE}?${p.toString()}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setPolicies([]); }
      else if (!j.ok) { setErr(j.error || 'failed to list policies'); setPolicies([]); }
      else {
        const rows: PolicyRow[] = j.policies || [];
        setPolicies(rows);
        if (rows.length) setCols(Object.keys(rows[0]));
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [securableType, securableName, effective, ctx.warehouseId]);

  useEffect(() => { load(); }, [load]);

  // ---- create form ----
  const [name, setName] = useState('');
  const [policyType, setPolicyType] = useState<'ROW FILTER' | 'COLUMN MASK'>('ROW FILTER');
  const [fnName, setFnName] = useState('');
  const [toPrincipals, setToPrincipals] = useState('');
  const [exceptPrincipals, setExceptPrincipals] = useState('');
  const [whenKey, setWhenKey] = useState('');
  const [whenVal, setWhenVal] = useState('');
  const [matchKey, setMatchKey] = useState('');
  const [matchVal, setMatchVal] = useState('');
  const [matchAlias, setMatchAlias] = useState('');
  const [usingCols, setUsingCols] = useState('');
  const [orReplace, setOrReplace] = useState(false);
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);

  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

  const buildParams = () => {
    const matchColumns = matchKey.trim()
      ? [{ tagKey: matchKey.trim(), tagValue: matchVal.trim() || undefined, alias: matchAlias.trim() || undefined }]
      : [];
    const usingColumns = csv(usingCols).map((tok) => {
      if (/^-?\d+$/.test(tok)) return { kind: 'int', value: tok };
      if (/^'.*'$/.test(tok)) return { kind: 'string', value: tok.slice(1, -1) };
      return { kind: 'alias', value: tok };
    });
    return {
      name: name.trim(), orReplace, securableType, securableName,
      policyType, functionName: fnName.trim(),
      toPrincipals: csv(toPrincipals),
      exceptPrincipals: csv(exceptPrincipals),
      when: whenKey.trim() ? { tagKey: whenKey.trim(), tagValue: whenVal.trim() || undefined } : undefined,
      matchColumns,
      onColumnAlias: policyType === 'COLUMN MASK' ? (matchAlias.trim() || undefined) : undefined,
      usingColumns,
    };
  };

  const ready = !!securableName && !!name.trim() && !!fnName.trim() && !!toPrincipals.trim()
    && (policyType === 'ROW FILTER' || !!matchAlias.trim());

  const post = async (preview: boolean) => {
    setBusy(true); setResult(null);
    const r = await callRoute(POL_BASE, { action: 'create', preview, params: buildParams(), warehouseId: ctx.warehouseId });
    setSql(r.sql || (preview ? '' : sql));
    if (!preview || !r.ok) setResult(r);
    if (!preview && r.ok) void load();
    setBusy(false);
  };
  const doDrop = async (polName: string) => {
    if (!polName) return;
    setBusy(true); setResult(null);
    const r = await callRoute(POL_BASE, { action: 'drop', name: polName, securable_type: securableType, securable_name: securableName, warehouseId: ctx.warehouseId });
    setSql(r.sql || sql); setResult(r); if (r.ok) void load();
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>ABAC policies (tag-driven row filters + column masks)</Subtitle2>
      <Caption1>
        One policy on a catalog / schema / table applies to every descendant table whose columns
        carry the matched governed tags — the scalable, tag-driven evolution of per-table masks and
        filters. Mirrors <code>CREATE POLICY … {'{ROW FILTER | COLUMN MASK}'} … FOR TABLES MATCH
        COLUMNS has_tag_value(…)</code>.
      </Caption1>

      <div className={s.row}>
        <Field label="Scope securable">
          <Dropdown value={securableType} selectedOptions={[securableType]} onOptionSelect={(_, d) => setSecurableType((d.optionValue as any) || 'SCHEMA')}>
            <Option value="CATALOG" text="Catalog">Catalog</Option>
            <Option value="SCHEMA" text="Schema">Schema</Option>
            <Option value="TABLE" text="Table">Table</Option>
          </Dropdown>
        </Field>
        <Field label="Securable name (from tree selection)" style={{ minWidth: 280 }}>
          <Input value={securableName} readOnly placeholder="pick a catalog / schema / table" />
        </Field>
        <Button appearance={effective ? 'primary' : 'outline'} onClick={() => setEffective((v) => !v)}>
          {effective ? 'Effective (+inherited)' : 'Direct only'}
        </Button>
        <Button appearance="outline" onClick={() => load()} disabled={loading}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
      </div>

      {gate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody></MessageBar>
      )}
      {err && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not list policies</MessageBarTitle>{err}</MessageBarBody></MessageBar>
      )}
      {!securableName && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Pick a {securableType.toLowerCase()}</MessageBarTitle>
            Select a {securableType.toLowerCase()} in the left tree (and a schema / table where needed) to scope the policy.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.tableWrap}>
        <Table size="small" aria-label="ABAC policies">
          <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}<TableHeaderCell> </TableHeaderCell></TableRow></TableHeader>
          <TableBody>
            {policies.length === 0 && <TableRow><TableCell colSpan={cols.length + 1}><Caption1>No policies on this securable.</Caption1></TableCell></TableRow>}
            {policies.map((p, i) => (
              <TableRow key={i}>
                {cols.map((c) => <TableCell key={c} className={s.mono}>{String(p[c] ?? '')}</TableCell>)}
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy || !p['Policy Name']}
                    title="Drop this policy" aria-label="Drop policy" onClick={() => doDrop(String(p['Policy Name'] || ''))} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Create policy</Subtitle2>
      <div className={s.grid2}>
        <Field label="Policy name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="mask_ssn" /></Field>
        <Field label="Policy type" required>
          <Dropdown value={policyType} selectedOptions={[policyType]} onOptionSelect={(_, d) => setPolicyType((d.optionValue as any) || 'ROW FILTER')}>
            <Option value="ROW FILTER" text="Row filter">Row filter</Option>
            <Option value="COLUMN MASK" text="Column mask">Column mask</Option>
          </Dropdown>
        </Field>
      </div>
      <Field label="UDF — fully-qualified row-filter / column-mask function" required hint="e.g. main.security.redact_ssn — needs EXECUTE on the UDF">
        <Input value={fnName} onChange={(_, d) => setFnName(d.value)} placeholder="catalog.schema.function" />
      </Field>
      <div className={s.grid2}>
        <Field label="TO principals (comma-separated)" required hint="users, groups (e.g. account users) or SPs">
          <Input value={toPrincipals} onChange={(_, d) => setToPrincipals(d.value)} placeholder="us_analysts, account users" />
        </Field>
        <Field label="EXCEPT principals (optional)"><Input value={exceptPrincipals} onChange={(_, d) => setExceptPrincipals(d.value)} placeholder="admins" /></Field>
      </div>
      <div className={s.grid2}>
        <Field label="WHEN table tag key (optional)" hint="has_tag / has_tag_value — limits which tables match"><Input value={whenKey} onChange={(_, d) => setWhenKey(d.value)} placeholder="sensitivity" /></Field>
        <Field label="WHEN tag value (optional)"><Input value={whenVal} onChange={(_, d) => setWhenVal(d.value)} placeholder="high" /></Field>
      </div>
      <div className={s.grid2}>
        <Field label={`MATCH COLUMNS tag key${policyType === 'COLUMN MASK' ? '' : ' (optional)'}`} hint={policyType === 'COLUMN MASK' ? 'required — identifies columns to mask' : 'optional for row filters'}>
          <Input value={matchKey} onChange={(_, d) => setMatchKey(d.value)} placeholder="pii" />
        </Field>
        <Field label="MATCH COLUMNS tag value (optional)"><Input value={matchVal} onChange={(_, d) => setMatchVal(d.value)} placeholder="ssn" /></Field>
      </div>
      <div className={s.grid2}>
        <Field label={`Matched-column alias${policyType === 'COLUMN MASK' ? '' : ' (optional)'}`} hint="binds the matched column for ON COLUMN / USING COLUMNS">
          <Input value={matchAlias} onChange={(_, d) => setMatchAlias(d.value)} placeholder="ssn_col" />
        </Field>
        <Field label="USING COLUMNS args (comma-separated)" hint="aliases, integers, or 'strings' passed to the UDF"><Input value={usingCols} onChange={(_, d) => setUsingCols(d.value)} placeholder="ssn_col, 4" /></Field>
      </div>
      <div className={s.actions}>
        <Button appearance={orReplace ? 'primary' : 'outline'} onClick={() => setOrReplace((v) => !v)}>{orReplace ? 'CREATE OR REPLACE' : 'CREATE'}</Button>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={() => post(true)}>Preview SQL</Button>
        <Button icon={<Add20Regular />} appearance="primary" disabled={!ready || busy} onClick={() => post(false)}>{busy ? 'Working…' : 'Create policy'}</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
    </div>
  );
}

// ------------------------------------------------------------------
// Current security — live information_schema state
// ------------------------------------------------------------------

function CurrentUcSecurity({ sec }: { sec: UcState }) {
  const s = useStyles();
  return (
    <div className={s.card}>
      <Subtitle2>Column masks ({sec.columnMasks.length})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Column masks">
          <TableHeader><TableRow>
            <TableHeaderCell>Schema</TableHeaderCell><TableHeaderCell>Table</TableHeaderCell>
            <TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Mask function</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {sec.columnMasks.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No column masks in this catalog.</Caption1></TableCell></TableRow>}
            {sec.columnMasks.map((m, i) => (
              <TableRow key={i}>
                <TableCell>{String(m.schema_name)}</TableCell>
                <TableCell>{String(m.table_name)}</TableCell>
                <TableCell className={s.mono}>{String(m.column_name)}</TableCell>
                <TableCell className={s.mono}>{m.mask_schema}.{m.mask_name}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Row filters ({sec.rowFilters.length})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Row filters">
          <TableHeader><TableRow>
            <TableHeaderCell>Schema</TableHeaderCell><TableHeaderCell>Table</TableHeaderCell>
            <TableHeaderCell>Filter function</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {sec.rowFilters.length === 0 && <TableRow><TableCell colSpan={3}><Caption1>No row filters in this catalog.</Caption1></TableCell></TableRow>}
            {sec.rowFilters.map((f, i) => (
              <TableRow key={i}>
                <TableCell>{String(f.schema_name)}</TableCell>
                <TableCell>{String(f.table_name)}</TableCell>
                <TableCell className={s.mono}>{f.filter_schema}.{f.filter_name}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Body1><Caption1>All rows read live from <code>{sec.catalog}.information_schema.column_masks</code> and <code>.row_filters</code>.</Caption1></Body1>
    </div>
  );
}

export default UcSecurityPanel;
