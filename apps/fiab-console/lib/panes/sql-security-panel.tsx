'use client';

/**
 * SqlSecurityPanel — the SQL granular-security surface (F11). One-for-one with
 * the security DDL you'd hand-write in SSMS / the Synapse + Azure SQL portal
 * query editor, but driven by guided wizards with a live preview-SQL pane.
 *
 * Four wizards, each: (1) configure with dropdowns/checkboxes populated from the
 * live sys.* catalog → (2) Preview the generated T-SQL in a read-only Monaco
 * pane → (3) Execute over TDS (Entra-token only) → (4) receipt + a Verify action
 * (EXECUTE AS the test principal) that proves the effect landed:
 *
 *   - Object GRANT          GRANT/DENY <perms> ON OBJECT::[s].[o] TO [principal]
 *   - Column GRANT          GRANT/DENY SELECT ON [s].[t](cols) TO [principal]
 *   - Row-Level Security    CREATE FUNCTION predicate + CREATE SECURITY POLICY
 *   - Dynamic Data Masking  ALTER COLUMN ADD MASKED WITH (FUNCTION='…')
 *
 * Plus a "Current security" tab listing live grants, masked columns and RLS
 * policies straight from the catalog.
 *
 * The client never sends raw SQL — only structured params; the BFF route builds
 * the SQL server-side (lib/sql/tsql-builders.ts). No mock data: every list and
 * receipt comes from a real TDS round-trip, or an honest MessageBar gate.
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
  ShieldKeyhole20Regular, Play20Regular, Eye20Regular, Beaker20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { OBJECT_PERMISSIONS, type ObjectPermission } from '@/lib/sql/tsql-builders';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalXS, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, backgroundColor: tokens.colorNeutralBackground1,
  },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM },
  permRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: '320px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

// ------------------------------------------------------------------
// Shared state shapes (mirror the route GET response)
// ------------------------------------------------------------------

interface Principal { name: string; typeDesc: string; authTypeDesc?: string }
interface ObjectRow { schema_name: string; table_name: string; object_type: string }
interface SecState {
  ok: boolean;
  backend: 'synapse-dedicated' | 'synapse-serverless' | 'azure-sql';
  serverless: boolean;
  principals: Principal[];
  tables: ObjectRow[];
  views: ObjectRow[];
  columnsByObject: Record<string, { name: string; dataType: string }[]>;
  grants: Record<string, any>[];
  maskedColumns: Record<string, any>[];
  securityPolicies: Record<string, any>[];
  warnings?: string[];
}

type WizardTab = 'object' | 'column' | 'rls' | 'ddm' | 'current';

export interface SqlSecurityPanelProps {
  itemType: string;
  itemId: string;
  /** Azure SQL family only — Synapse resolves server/db from env. */
  server?: string;
  database?: string;
}

export function SqlSecurityPanel({ itemType, itemId, server, database }: SqlSecurityPanelProps) {
  const s = useStyles();
  const [sec, setSec] = useState<SecState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [tab, setTab] = useState<WizardTab>('object');

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (server) p.set('server', server);
    if (database) p.set('database', database);
    const str = p.toString();
    return str ? `?${str}` : '';
  }, [server, database]);

  const base = `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/sql-security`;

  const reload = useCallback(async () => {
    setLoading(true); setLoadError(null); setGate(null);
    try {
      const r = await fetch(`${base}${qs}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setSec(null); }
      else if (!j.ok) { setLoadError(j.error || 'failed to load security state'); setSec(null); }
      else setSec(j as SecState);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base, qs]);

  useEffect(() => { reload(); }, [reload]);

  const ctx: WizardCtx = { base, qs, sec, reload };

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<ShieldKeyhole20Regular />}>SQL granular security</Badge>
        {sec && <Badge appearance="outline">{sec.backend}</Badge>}
        <Badge appearance="outline" color="success">Microsoft Entra auth only</Badge>
        <Button size="small" appearance="outline" onClick={reload} disabled={loading}>Refresh</Button>
        {loading && <Spinner size="tiny" label="Reading catalog…" labelPosition="after" />}
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
            <MessageBarTitle>Could not load security state</MessageBarTitle>
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

      {sec && sec.principals.length === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No database users found</MessageBarTitle>
            Create a contained user first, e.g.{' '}
            <code>CREATE USER [upn@contoso.com] FROM EXTERNAL PROVIDER;</code> — then refresh.
          </MessageBarBody>
        </MessageBar>
      )}

      {sec && (
        <>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as WizardTab)}>
            <Tab value="object" icon={<ShieldKeyhole20Regular />}>Object GRANT</Tab>
            <Tab value="column" icon={<ShieldKeyhole20Regular />}>Column GRANT</Tab>
            <Tab value="rls" icon={<ShieldKeyhole20Regular />}>Row-Level Security</Tab>
            <Tab value="ddm" icon={<ShieldKeyhole20Regular />}>Dynamic Data Masking</Tab>
            <Tab value="current" icon={<Eye20Regular />}>Current security</Tab>
          </TabList>

          {tab === 'object' && <ObjectGrantWizard ctx={ctx} />}
          {tab === 'column' && <ColumnGrantWizard ctx={ctx} />}
          {tab === 'rls' && <RlsWizard ctx={ctx} />}
          {tab === 'ddm' && <DdmWizard ctx={ctx} />}
          {tab === 'current' && <CurrentSecurity sec={sec} />}
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
  qs: string;
  sec: SecState | null;
  reload: () => Promise<void>;
}

interface ExecResult { ok: boolean; sql?: string; recordsAffected?: number; executionMs?: number; error?: string; messages?: string[] }

/** Build the combined table+view object list for the pickers. */
function useObjects(sec: SecState | null, includeViews = true): { key: string; schema: string; name: string; kind: string }[] {
  return useMemo(() => {
    if (!sec) return [];
    const rows = [
      ...sec.tables.map((t) => ({ schema: t.schema_name, name: t.table_name, kind: 'table' })),
      ...(includeViews ? sec.views.map((v) => ({ schema: v.schema_name, name: v.table_name, kind: 'view' })) : []),
    ];
    return rows.map((r) => ({ key: `${r.schema}.${r.name}`, ...r }));
  }, [sec, includeViews]);
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
        {result.messages?.length ? ` · ${result.messages.join(' ')}` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}

/** Render a verify result (rows the test principal can see). */
function VerifyResult({ data }: { data: { columns: string[]; rows: unknown[][] } | null }) {
  const s = useStyles();
  if (!data) return null;
  return (
    <div className={s.tableWrap}>
      <Table size="small" aria-label="Verification result (as test principal)">
        <TableHeader><TableRow>{data.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {data.rows.length === 0 && <TableRow><TableCell colSpan={Math.max(1, data.columns.length)}><Caption1>0 rows visible to this principal.</Caption1></TableCell></TableRow>}
          {data.rows.map((row, i) => (
            <TableRow key={i}>{data.columns.map((_, j) => <TableCell key={j} className={s.mono}>{String(row[j] ?? '∅')}</TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

async function callWizard(base: string, qs: string, payload: any): Promise<ExecResult> {
  const r = await fetch(`${base}${qs}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

// ------------------------------------------------------------------
// Wizard 1 — Object GRANT
// ------------------------------------------------------------------

function ObjectGrantWizard({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const objects = useObjects(ctx.sec);
  const [objKey, setObjKey] = useState('');
  const [principal, setPrincipal] = useState('');
  const [perms, setPerms] = useState<ObjectPermission[]>(['SELECT']);
  const [action, setAction] = useState<'GRANT' | 'DENY'>('GRANT');
  const [withGrant, setWithGrant] = useState(false);
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);

  const obj = objects.find((o) => o.key === objKey);
  const params = obj ? { schema: obj.schema, objectName: obj.name, permissions: perms, principal, withGrantOption: withGrant, action } : null;
  const ready = !!obj && !!principal && perms.length > 0;

  const togglePerm = (p: ObjectPermission, on: boolean) =>
    setPerms((cur) => (on ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)));

  const doPreview = async () => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'object-grant', params, preview: true });
    setSql(r.sql || ''); if (!r.ok) setResult(r);
    setBusy(false);
  };
  const doExecute = async () => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'object-grant', params });
    setSql(r.sql || sql); setResult(r); if (r.ok) ctx.reload();
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Grant or deny object-level permissions</Subtitle2>
      <Caption1>Mirrors <code>GRANT … ON OBJECT:: … TO …</code>. Targets the table/view you pick; the grantee can then query the object.</Caption1>
      <div className={s.grid2}>
        <Field label="Object (table or view)" required>
          <Dropdown placeholder="Pick an object" value={objKey} selectedOptions={objKey ? [objKey] : []}
            onOptionSelect={(_, d) => setObjKey(d.optionValue || '')}>
            {objects.map((o) => <Option key={o.key} value={o.key} text={`${o.key} (${o.kind})`}>{o.key} ({o.kind})</Option>)}
          </Dropdown>
        </Field>
        <Field label="Principal (database user / role)" required>
          <Dropdown placeholder="Pick a principal" value={principal} selectedOptions={principal ? [principal] : []}
            onOptionSelect={(_, d) => setPrincipal(d.optionValue || '')}>
            {(ctx.sec?.principals || []).map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name} · {p.typeDesc}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label="Permissions" required>
        <div className={s.permRow}>
          {OBJECT_PERMISSIONS.map((p) => (
            <Checkbox key={p} label={p} checked={perms.includes(p)} onChange={(_, d) => togglePerm(p, !!d.checked)} />
          ))}
        </div>
      </Field>
      <div className={s.permRow}>
        <Field label="Action">
          <Dropdown value={action} selectedOptions={[action]} onOptionSelect={(_, d) => setAction((d.optionValue as any) || 'GRANT')}>
            <Option value="GRANT">GRANT</Option>
            <Option value="DENY">DENY</Option>
          </Dropdown>
        </Field>
        {action === 'GRANT' && <Checkbox label="WITH GRANT OPTION" checked={withGrant} onChange={(_, d) => setWithGrant(!!d.checked)} />}
      </div>
      <div className={s.actions}>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={doPreview}>Preview SQL</Button>
        <Button icon={<Play20Regular />} appearance="primary" disabled={!ready || busy} onClick={doExecute}>{busy ? 'Working…' : 'Execute'}</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
    </div>
  );
}

// ------------------------------------------------------------------
// Wizard 2 — Column GRANT
// ------------------------------------------------------------------

function ColumnGrantWizard({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const serverless = !!ctx.sec?.serverless;
  // Serverless column-level security applies to views, not external tables.
  const objects = useObjects(ctx.sec);
  const [objKey, setObjKey] = useState('');
  const [principal, setPrincipal] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [action, setAction] = useState<'GRANT' | 'DENY'>('GRANT');
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [verify, setVerify] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);

  const obj = objects.find((o) => o.key === objKey);
  const objCols = (obj && ctx.sec?.columnsByObject[obj.key]) || [];
  const params = obj ? { schema: obj.schema, tableName: obj.name, columns: cols, principal, action } : null;
  const ready = !!obj && !!principal && cols.length > 0;
  const toggleCol = (c: string, on: boolean) => setCols((cur) => (on ? [...new Set([...cur, c])] : cur.filter((x) => x !== c)));

  const post = async (preview: boolean) => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'column-grant', params, preview });
    setSql(r.sql || (preview ? '' : sql)); if (!preview || !r.ok) setResult(r); if (!preview && r.ok) ctx.reload();
    setBusy(false);
  };
  const doVerify = async () => {
    if (!obj || !principal) return;
    setBusy(true); setVerify(null);
    const r: any = await callWizard(ctx.base, ctx.qs, { action: 'verify', verify: { principal, schema: obj.schema, table: obj.name } });
    if (r.ok) setVerify({ columns: r.columns, rows: r.rows }); else setResult(r);
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Column-level security (restrict visible columns)</Subtitle2>
      <Caption1>Mirrors <code>GRANT SELECT ON [s].[t](cols) TO …</code>. The principal sees only the granted columns.</Caption1>
      {serverless && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Serverless: views only</MessageBarTitle>
            Column-level security on Synapse Serverless SQL pools applies to <strong>views</strong>, not external tables. Pick a view target.
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={s.grid2}>
        <Field label="Object" required>
          <Dropdown placeholder="Pick a table/view" value={objKey} selectedOptions={objKey ? [objKey] : []}
            onOptionSelect={(_, d) => { setObjKey(d.optionValue || ''); setCols([]); }}>
            {objects.map((o) => <Option key={o.key} value={o.key} text={`${o.key} (${o.kind})`}>{o.key} ({o.kind})</Option>)}
          </Dropdown>
        </Field>
        <Field label="Principal" required>
          <Dropdown placeholder="Pick a principal" value={principal} selectedOptions={principal ? [principal] : []}
            onOptionSelect={(_, d) => setPrincipal(d.optionValue || '')}>
            {(ctx.sec?.principals || []).map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name} · {p.typeDesc}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label={`Columns (${objCols.length} available)`} required>
        <div className={s.permRow}>
          {objCols.length === 0 && <Caption1>Pick an object to list its columns.</Caption1>}
          {objCols.map((c) => <Checkbox key={c.name} label={`${c.name} : ${c.dataType}`} checked={cols.includes(c.name)} onChange={(_, d) => toggleCol(c.name, !!d.checked)} />)}
        </div>
      </Field>
      <Field label="Action">
        <Dropdown value={action} selectedOptions={[action]} onOptionSelect={(_, d) => setAction((d.optionValue as any) || 'GRANT')}>
          <Option value="GRANT">GRANT</Option>
          <Option value="DENY">DENY</Option>
        </Dropdown>
      </Field>
      <div className={s.actions}>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={() => post(true)}>Preview SQL</Button>
        <Button icon={<Play20Regular />} appearance="primary" disabled={!ready || busy} onClick={() => post(false)}>{busy ? 'Working…' : 'Execute'}</Button>
        <Button icon={<Beaker20Regular />} appearance="subtle" disabled={!obj || !principal || busy} onClick={doVerify}
          title="Run SELECT as the principal to confirm only granted columns are visible">Verify as principal</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
      <VerifyResult data={verify} />
    </div>
  );
}

// ------------------------------------------------------------------
// Wizard 3 — Row-Level Security
// ------------------------------------------------------------------

function RlsWizard({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const serverless = !!ctx.sec?.serverless;
  const objects = useObjects(ctx.sec, false); // tables only
  const [objKey, setObjKey] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [predicateSchema, setPredicateSchema] = useState('Security');
  const [filterColumn, setFilterColumn] = useState('');
  const [allowAdmin, setAllowAdmin] = useState(true);
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [verify, setVerify] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [verifyPrincipal, setVerifyPrincipal] = useState('');

  const obj = objects.find((o) => o.key === objKey);
  const objCols = (obj && ctx.sec?.columnsByObject[obj.key]) || [];
  const params = obj ? { policyName, targetSchema: obj.schema, targetTable: obj.name, filterColumn, predicateSchema, allowAdmin } : null;
  const ready = !!obj && !!policyName && !!filterColumn && !!predicateSchema && !serverless;

  const post = async (preview: boolean) => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'rls', params, preview });
    if (r.ok && (r as any).gated === undefined) setSql(r.sql || (preview ? '' : sql));
    if (!preview || !r.ok) setResult(r); if (!preview && r.ok) ctx.reload();
    setBusy(false);
  };
  const doVerify = async () => {
    if (!obj || !verifyPrincipal) return;
    setBusy(true); setVerify(null);
    const r: any = await callWizard(ctx.base, ctx.qs, { action: 'verify', verify: { principal: verifyPrincipal, schema: obj.schema, table: obj.name } });
    if (r.ok) setVerify({ columns: r.columns, rows: r.rows }); else setResult(r);
    setBusy(false);
  };

  if (serverless) {
    return (
      <div className={s.card}>
        <Subtitle2>Row-Level Security</Subtitle2>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Not supported on Synapse Serverless</MessageBarTitle>
            Row-level security is not available on Serverless SQL pools. Apply RLS on a Dedicated SQL pool / Azure SQL database, or use a view-based workaround over the serverless dataset.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.card}>
      <Subtitle2>Row-Level Security policy</Subtitle2>
      <Caption1>Creates an inline table-valued predicate function and a <code>SECURITY POLICY</code> filtering rows where the chosen column equals <code>USER_NAME()</code>.</Caption1>
      <div className={s.grid2}>
        <Field label="Target table" required>
          <Dropdown placeholder="Pick a table" value={objKey} selectedOptions={objKey ? [objKey] : []}
            onOptionSelect={(_, d) => { setObjKey(d.optionValue || ''); setFilterColumn(''); }}>
            {objects.map((o) => <Option key={o.key} value={o.key} text={o.key}>{o.key}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Filter column (compared to USER_NAME())" required>
          <Dropdown placeholder="Pick a column" value={filterColumn} selectedOptions={filterColumn ? [filterColumn] : []}
            onOptionSelect={(_, d) => setFilterColumn(d.optionValue || '')}>
            {objCols.map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name} : {c.dataType}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Policy name" required hint="Letters, digits, underscore">
          <Input value={policyName} onChange={(_, d) => setPolicyName(d.value)} placeholder="SalesRepFilter" />
        </Field>
        <Field label="Predicate schema" required>
          <Input value={predicateSchema} onChange={(_, d) => setPredicateSchema(d.value)} placeholder="Security" />
        </Field>
      </div>
      <Checkbox label="Allow dbo / admin to see all rows (OR USER_NAME() = 'dbo')" checked={allowAdmin} onChange={(_, d) => setAllowAdmin(!!d.checked)} />
      <div className={s.actions}>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={() => post(true)}>Preview SQL</Button>
        <Button icon={<Play20Regular />} appearance="primary" disabled={!ready || busy} onClick={() => post(false)}>{busy ? 'Working…' : 'Execute'}</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
      <div className={s.grid2}>
        <Field label="Verify as principal (row-count seen)">
          <Dropdown placeholder="Pick a principal" value={verifyPrincipal} selectedOptions={verifyPrincipal ? [verifyPrincipal] : []}
            onOptionSelect={(_, d) => setVerifyPrincipal(d.optionValue || '')}>
            {(ctx.sec?.principals || []).map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name}</Option>)}
          </Dropdown>
        </Field>
        <div className={s.actions} style={{ alignItems: 'flex-end' }}>
          <Button icon={<Beaker20Regular />} appearance="subtle" disabled={!obj || !verifyPrincipal || busy} onClick={doVerify}>Verify rows visible</Button>
        </div>
      </div>
      <VerifyResult data={verify} />
    </div>
  );
}

// ------------------------------------------------------------------
// Wizard 4 — Dynamic Data Masking
// ------------------------------------------------------------------

type MaskKind = 'default' | 'email' | 'partial' | 'random' | 'datetime';

function DdmWizard({ ctx }: { ctx: WizardCtx }) {
  const s = useStyles();
  const objects = useObjects(ctx.sec, false); // mask base-table columns
  const [objKey, setObjKey] = useState('');
  const [column, setColumn] = useState('');
  const [kind, setKind] = useState<MaskKind>('partial');
  const [prefix, setPrefix] = useState('0');
  const [suffix, setSuffix] = useState('4');
  const [padding, setPadding] = useState('XXX-XX-');
  const [rndStart, setRndStart] = useState('1');
  const [rndEnd, setRndEnd] = useState('100');
  const [dtPart, setDtPart] = useState<'Y' | 'M' | 'D' | 'h' | 'm' | 's'>('Y');
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [verify, setVerify] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [verifyPrincipal, setVerifyPrincipal] = useState('');

  const obj = objects.find((o) => o.key === objKey);
  const objCols = (obj && ctx.sec?.columnsByObject[obj.key]) || [];

  const maskFn = useMemo(() => {
    switch (kind) {
      case 'partial': return { type: 'partial', prefix: Number(prefix), suffix: Number(suffix), padding };
      case 'random': return { type: 'random', start: Number(rndStart), end: Number(rndEnd) };
      case 'datetime': return { type: 'datetime', part: dtPart };
      default: return { type: kind };
    }
  }, [kind, prefix, suffix, padding, rndStart, rndEnd, dtPart]);

  const params = obj && column ? { schema: obj.schema, tableName: obj.name, column, maskFn } : null;
  const ready = !!params;

  const post = async (preview: boolean) => {
    if (!params) return;
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'ddm', params, preview });
    setSql(r.sql || (preview ? '' : sql)); if (!preview || !r.ok) setResult(r); if (!preview && r.ok) ctx.reload();
    setBusy(false);
  };
  const doDrop = async () => {
    if (!obj || !column) return;
    setBusy(true); setResult(null);
    const r = await callWizard(ctx.base, ctx.qs, { wizard: 'ddm-drop', params: { schema: obj.schema, tableName: obj.name, column } });
    setSql(r.sql || sql); setResult(r); if (r.ok) ctx.reload();
    setBusy(false);
  };
  const doVerify = async () => {
    if (!obj || !column || !verifyPrincipal) return;
    setBusy(true); setVerify(null);
    const r: any = await callWizard(ctx.base, ctx.qs, { action: 'verify', verify: { principal: verifyPrincipal, schema: obj.schema, table: obj.name, column } });
    if (r.ok) setVerify({ columns: r.columns, rows: r.rows }); else setResult(r);
    setBusy(false);
  };

  return (
    <div className={s.card}>
      <Subtitle2>Dynamic Data Masking</Subtitle2>
      <Caption1>Mirrors <code>ALTER COLUMN … ADD MASKED WITH (FUNCTION='…')</code>. Non-privileged users see the masked value; grant <code>UNMASK</code> to reveal. Requires <code>ALTER ANY MASK</code> (the console identity is db_owner by default).</Caption1>
      <div className={s.grid2}>
        <Field label="Table" required>
          <Dropdown placeholder="Pick a table" value={objKey} selectedOptions={objKey ? [objKey] : []}
            onOptionSelect={(_, d) => { setObjKey(d.optionValue || ''); setColumn(''); }}>
            {objects.map((o) => <Option key={o.key} value={o.key} text={o.key}>{o.key}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Column" required>
          <Dropdown placeholder="Pick a column" value={column} selectedOptions={column ? [column] : []}
            onOptionSelect={(_, d) => setColumn(d.optionValue || '')}>
            {objCols.map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name} : {c.dataType}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label="Mask function" required>
        <Dropdown value={kind} selectedOptions={[kind]} onOptionSelect={(_, d) => setKind((d.optionValue as MaskKind) || 'default')}>
          <Option value="default" text="default()">default() — full mask by type</Option>
          <Option value="email" text="email()">email() — aXXX@XXXX.com</Option>
          <Option value="partial" text="partial()">partial(prefix,&quot;pad&quot;,suffix)</Option>
          <Option value="random" text="random()">random(start,end) — numeric</Option>
          <Option value="datetime" text="datetime()">datetime(&quot;part&quot;)</Option>
        </Dropdown>
      </Field>
      {kind === 'partial' && (
        <div className={s.grid2}>
          <Field label="Prefix (chars shown at start)"><Input type="number" value={prefix} onChange={(_, d) => setPrefix(d.value)} /></Field>
          <Field label="Suffix (chars shown at end)"><Input type="number" value={suffix} onChange={(_, d) => setSuffix(d.value)} /></Field>
          <Field label="Padding (replaces the middle)"><Input value={padding} onChange={(_, d) => setPadding(d.value)} placeholder="XXX-XX-" /></Field>
        </div>
      )}
      {kind === 'random' && (
        <div className={s.grid2}>
          <Field label="Start"><Input type="number" value={rndStart} onChange={(_, d) => setRndStart(d.value)} /></Field>
          <Field label="End"><Input type="number" value={rndEnd} onChange={(_, d) => setRndEnd(d.value)} /></Field>
        </div>
      )}
      {kind === 'datetime' && (
        <Field label="Datetime part to keep">
          <Dropdown value={dtPart} selectedOptions={[dtPart]} onOptionSelect={(_, d) => setDtPart((d.optionValue as any) || 'Y')}>
            {(['Y', 'M', 'D', 'h', 'm', 's'] as const).map((p) => <Option key={p} value={p} text={p}>{p}</Option>)}
          </Dropdown>
        </Field>
      )}
      <div className={s.actions}>
        <Button icon={<Eye20Regular />} appearance="outline" disabled={!ready || busy} onClick={() => post(true)}>Preview SQL</Button>
        <Button icon={<Play20Regular />} appearance="primary" disabled={!ready || busy} onClick={() => post(false)}>{busy ? 'Working…' : 'Apply mask'}</Button>
        <Button appearance="subtle" disabled={!obj || !column || busy} onClick={doDrop}>Drop mask</Button>
      </div>
      <PreviewPane sql={sql} />
      <ResultBar result={result} />
      <div className={s.grid2}>
        <Field label="Verify as principal (masked value seen)">
          <Dropdown placeholder="Pick a principal" value={verifyPrincipal} selectedOptions={verifyPrincipal ? [verifyPrincipal] : []}
            onOptionSelect={(_, d) => setVerifyPrincipal(d.optionValue || '')}>
            {(ctx.sec?.principals || []).map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name}</Option>)}
          </Dropdown>
        </Field>
        <div className={s.actions} style={{ alignItems: 'flex-end' }}>
          <Button icon={<Beaker20Regular />} appearance="subtle" disabled={!obj || !column || !verifyPrincipal || busy} onClick={doVerify}>Verify masked value</Button>
        </div>
      </div>
      <VerifyResult data={verify} />
    </div>
  );
}

// ------------------------------------------------------------------
// Current security — live catalog state
// ------------------------------------------------------------------

function CurrentSecurity({ sec }: { sec: SecState }) {
  const s = useStyles();
  return (
    <div className={s.card}>
      <Subtitle2>Object &amp; column grants ({sec.grants.length})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Grants">
          <TableHeader><TableRow>
            <TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Permission</TableHeaderCell>
            <TableHeaderCell>Object</TableHeaderCell><TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Principal</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {sec.grants.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No object/column grants.</Caption1></TableCell></TableRow>}
            {sec.grants.map((g, i) => (
              <TableRow key={i}>
                <TableCell>{String(g.state_desc)}</TableCell>
                <TableCell>{String(g.permission_name)}</TableCell>
                <TableCell className={s.mono}>{g.schema_name}.{g.object_name}</TableCell>
                <TableCell className={s.mono}>{g.column_name || '—'}</TableCell>
                <TableCell>{String(g.principal_name)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Masked columns ({sec.maskedColumns.length})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Masked columns">
          <TableHeader><TableRow>
            <TableHeaderCell>Schema</TableHeaderCell><TableHeaderCell>Table</TableHeaderCell>
            <TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Mask function</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {sec.maskedColumns.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No masked columns.</Caption1></TableCell></TableRow>}
            {sec.maskedColumns.map((m, i) => (
              <TableRow key={i}>
                <TableCell>{String(m.schema_name)}</TableCell><TableCell>{String(m.table_name)}</TableCell>
                <TableCell className={s.mono}>{String(m.column_name)}</TableCell>
                <TableCell className={s.mono}>{String(m.masking_function)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Subtitle2>Security policies / RLS ({sec.securityPolicies.length})</Subtitle2>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Security policies">
          <TableHeader><TableRow>
            <TableHeaderCell>Policy</TableHeaderCell><TableHeaderCell>Enabled</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Target</TableHeaderCell><TableHeaderCell>Predicate</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {sec.securityPolicies.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No security policies.</Caption1></TableCell></TableRow>}
            {sec.securityPolicies.map((p, i) => (
              <TableRow key={i}>
                <TableCell>{String(p.policy_name)}</TableCell>
                <TableCell><Badge appearance="outline" color={p.is_enabled ? 'success' : 'subtle'}>{p.is_enabled ? 'ON' : 'OFF'}</Badge></TableCell>
                <TableCell>{String(p.predicate_type)}</TableCell>
                <TableCell className={s.mono}>{p.target_schema}.{p.target_table}</TableCell>
                <TableCell className={s.mono}>{String(p.predicate_definition)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Body1><Caption1>All rows read live from <code>sys.database_permissions</code>, <code>sys.masked_columns</code> and <code>sys.security_policies</code>.</Caption1></Body1>
    </div>
  );
}

export default SqlSecurityPanel;
