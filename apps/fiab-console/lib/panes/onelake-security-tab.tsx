'use client';

/**
 * onelake-security-tab — two OneLake security authoring surfaces that share this
 * file:
 *
 *   1. OneLakeSecurityTab — Fabric OneLake **column-level security (CLS)** editor
 *      (the "hide columns from a role" experience). Azure-native, NO Fabric
 *      dependency: hiding a column issues a real column-scope DENY SELECT (plus a
 *      table-level GRANT so the principal can still query the table) on the
 *      Synapse Dedicated SQL pool via /api/lakehouse/permissions?tab=cls.
 *
 *   2. OnelakeRlsPredicateEditor (F8) — custom row-level-security (RLS)
 *      WHERE-predicate authoring surface rendered inside the Lakehouse →
 *      Permissions → Row tab, beneath the fixed-subject quick form. Azure-native,
 *      NO Fabric dependency — every action runs real T-SQL against the Synapse
 *      Dedicated SQL pool via /api/lakehouse/permissions (save) and
 *      /api/lakehouse/permissions/rls-test (preview).
 *
 * Both surfaces are Azure-native (no-fabric-dependency.md) — no Fabric / Power BI
 * REST is touched — and use an honest infra-gate (NotConfiguredBar / MessageBar)
 * when the Dedicated pool isn't wired (no silent no-op, no mock data).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Checkbox,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  EyeOff20Regular,
  Info16Regular,
  Play16Regular,
  ShieldCheckmark20Regular,
  ShieldKeyhole20Regular,
} from '@fluentui/react-icons';

import { NotConfiguredBar } from '@/lib/components/admin-security/not-configured-bar';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { validateWhereClause, RLS_WHERE_MAX } from '@/lib/azure/rls-predicate';

// ───────────────────────────────────────────────────────────────────────────
// OneLakeSecurityTab — column-level security (CLS)
// ───────────────────────────────────────────────────────────────────────────

interface SqlTable { objectId: number; schema: string; name: string; type: string }
interface SqlColumn { columnId: number; name: string; dataType: string }
interface DenyRow { principal: string; schema: string; table: string; column: string | null }
interface GrantRow { principal: string; schema: string; table: string; column: string | null }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground1 },
  note: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  colPicker: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    maxHeight: '220px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  colRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  hiddenSummary: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  sectionLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: '11px',
  },
});

export function OneLakeSecurityTab({ lakehouseId }: { lakehouseId: string }) {
  const styles = useStyles();

  const [gate, setGate] = useState<{ missing?: string; hint?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [tables, setTables] = useState<SqlTable[]>([]);
  const [denyRows, setDenyRows] = useState<DenyRow[]>([]);
  const [columnGrants, setColumnGrants] = useState<GrantRow[]>([]);

  const [selObjectId, setSelObjectId] = useState<number | null>(null);
  const [columns, setColumns] = useState<SqlColumn[]>([]);
  const [selColIds, setSelColIds] = useState<number[]>([]);
  const [upn, setUpn] = useState('');
  const [maskView, setMaskView] = useState(false);

  const selTable = useMemo(() => tables.find((t) => t.objectId === selObjectId) || null, [tables, selObjectId]);

  // ── load deny grants + column grants (for conflict detection) ──
  const loadState = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/lakehouse/permissions?tab=cls');
      const j = await r.json();
      if (j.gate) { setGate({ missing: j.missing, hint: j.hint }); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setGate(null);
      setDenyRows(Array.isArray(j.denyGrants) ? j.denyGrants : []);
      setColumnGrants(Array.isArray(j.grants) ? j.grants : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  const loadTables = useCallback(async () => {
    try {
      const r = await fetch('/api/lakehouse/permissions?tab=cls&list=tables');
      const j = await r.json();
      if (j.gate) { setGate({ missing: j.missing, hint: j.hint }); return; }
      if (j.ok) setTables(Array.isArray(j.tables) ? j.tables : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([loadState(), loadTables()]).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadState, loadTables]);

  const onPickTable = useCallback(async (objectId: number | null) => {
    setSelObjectId(objectId);
    setSelColIds([]);
    setColumns([]);
    setNotice(null);
    if (objectId == null) return;
    try {
      const r = await fetch(`/api/lakehouse/permissions?tab=cls&list=columns&objectId=${objectId}`);
      const j = await r.json();
      if (j.ok) setColumns(Array.isArray(j.columns) ? j.columns : []);
      else if (j.error) setError(j.error);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  // ── conflict detection: a selected column that already has a column-level
  //    GRANT for this principal+table is dead weight (DENY wins). ──
  const conflictColumns = useMemo(() => {
    const name = upn.trim().toLowerCase();
    if (!name || !selTable) return [] as string[];
    const grantedCols = new Set(
      columnGrants
        .filter(
          (g) =>
            g.principal.toLowerCase() === name &&
            g.schema === selTable.schema &&
            g.table === selTable.name &&
            g.column != null,
        )
        .map((g) => g.column as string),
    );
    return columns.filter((c) => selColIds.includes(c.columnId) && grantedCols.has(c.name)).map((c) => c.name);
  }, [upn, selTable, columnGrants, columns, selColIds]);

  const selectedColumnNames = useMemo(
    () => columns.filter((c) => selColIds.includes(c.columnId)).map((c) => c.name),
    [columns, selColIds],
  );

  const toggleCol = (columnId: number, checked: boolean) => {
    setSelColIds((prev) => (checked ? [...new Set([...prev, columnId])] : prev.filter((n) => n !== columnId)));
  };

  const applyDeny = useCallback(async () => {
    if (!selObjectId || !upn.trim() || selColIds.length === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await fetch('/api/lakehouse/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'cls', upn: upn.trim(), objectId: selObjectId, columnIds: selColIds, maskView }),
      });
      const j = await r.json();
      if (j.gate) { setGate({ missing: j.missing, hint: j.hint }); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNotice(
        `Hidden ${j.hiddenColumns?.join(', ') ?? ''} from ${upn.trim()}` +
          (j.maskedView ? ` · masked view ${j.maskedView.viewFqn}` : ''),
      );
      setSelColIds([]);
      await loadState();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [selObjectId, upn, selColIds, maskView, loadState]);

  const revokeDeny = useCallback(async (row: DenyRow) => {
    const tbl = tables.find((t) => t.schema === row.schema && t.name === row.table);
    if (!tbl || !row.column) { setError(`Could not resolve object_id for ${row.schema}.${row.table}`); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      // resolve the column_id of the denied column on that table
      const cr = await fetch(`/api/lakehouse/permissions?tab=cls&list=columns&objectId=${tbl.objectId}`);
      const cj = await cr.json();
      const hit = (cj.columns || []).find((c: SqlColumn) => c.name === row.column);
      if (!hit) throw new Error(`Column ${row.column} no longer exists on ${row.schema}.${row.table}`);
      const r = await fetch('/api/lakehouse/permissions?tab=cls', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upn: row.principal, objectId: tbl.objectId, columnIds: [hit.columnId] }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNotice(`Un-hid ${row.column} for ${row.principal}`);
      await loadState();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [tables, loadState]);

  // existing deny rows that ALSO have a matching column-level grant (conflict).
  const denyConflictKeys = useMemo(() => {
    const grantSet = new Set(
      columnGrants
        .filter((g) => g.column != null)
        .map((g) => `${g.principal.toLowerCase()}|${g.schema}|${g.table}|${g.column}`),
    );
    return new Set(
      denyRows
        .filter((d) => d.column != null && grantSet.has(`${d.principal.toLowerCase()}|${d.schema}|${d.table}|${d.column}`))
        .map((d) => `${d.principal}|${d.schema}|${d.table}|${d.column}`),
    );
  }, [denyRows, columnGrants]);

  const denyColumns: LoomColumn<DenyRow>[] = useMemo(
    () => [
      { key: 'principal', label: 'Principal', width: 240, render: (r) => r.principal },
      { key: 'object', label: 'Table', width: 220, getValue: (r) => `${r.schema}.${r.table}`, render: (r) => `${r.schema}.${r.table}` },
      {
        key: 'column',
        label: 'Hidden column',
        width: 200,
        getValue: (r) => r.column ?? '',
        render: (r) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <EyeOff20Regular style={{ width: 16, height: 16, color: tokens.colorPaletteRedForeground1 }} />
            <span>{r.column}</span>
            {denyConflictKeys.has(`${r.principal}|${r.schema}|${r.table}|${r.column}`) && (
              <Badge appearance="tint" color="warning" size="small">GRANT conflict</Badge>
            )}
          </span>
        ),
      },
      {
        key: 'actions',
        label: 'Actions',
        width: 120,
        sortable: false,
        filterable: false,
        render: (r) => (
          <Button size="small" appearance="subtle" disabled={busy} onClick={() => revokeDeny(r)}>
            Un-hide
          </Button>
        ),
      },
    ],
    [busy, revokeDeny, denyConflictKeys],
  );

  if (loading) return <Spinner size="tiny" label="Loading column security…" />;

  if (gate) {
    return (
      <div className={styles.root}>
        <NotConfiguredBar
          surface="Column-level security (Synapse Dedicated SQL pool)"
          rawError={gate.hint}
          hint={{
            missingEnvVar: gate.missing,
            bicepModule: 'platform/fiab/bicep/modules/landing-zone/synapse.bicep',
            bicepStatus: 'deploys the Dedicated SQL pool; set LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL on loom-console',
            followUp: 'Grant the Console UAMI db_owner on the pool database so it can issue GRANT/DENY DDL.',
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <ShieldKeyhole20Regular />
        <Text weight="semibold">Column-level security (CLS)</Text>
      </div>

      <div className={styles.note}>
        <Caption1>
          Hiding a column issues a <strong>column-scope DENY SELECT</strong> to the principal (plus a table-level GRANT so it can
          still query the table). Column-level DENY takes precedence over column-level GRANT; a table-level DENY does
          <em> not </em> override a column-level GRANT (T-SQL backward-compat), so hide-columns = table GRANT + column DENY.
          Querying a hidden column then fails with Msg 230.
        </Caption1>
        <span className={styles.code}>GRANT SELECT ON [schema].[table] TO [principal];{'\n'}DENY  SELECT ON [schema].[table]([column]) TO [principal];</span>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {notice && (
        <MessageBar intent="success" politeness="polite">
          <MessageBarBody>{notice}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.form}>
        <Field label="Table or view">
          <Dropdown
            placeholder="Select a table or view…"
            value={selTable ? `${selTable.schema}.${selTable.name}` : ''}
            selectedOptions={selObjectId != null ? [String(selObjectId)] : []}
            onOptionSelect={(_e, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
          >
            {tables.map((t) => (
              <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>
                {t.schema}.{t.name} {t.type === 'V' ? '(view)' : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Principal (role / user UPN)">
          <Input
            placeholder="analyst@contoso.com"
            value={upn}
            onChange={(_e, d) => setUpn(d.value)}
          />
        </Field>

        <Field label="Hidden columns (multi-select)" hint={selectedColumnNames.length ? undefined : 'Select one or more columns to hide.'}>
          {selObjectId == null ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Pick a table to list its columns.</Caption1>
          ) : columns.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No columns found on this object.</Caption1>
          ) : (
            <div className={styles.colPicker}>
              {columns.map((c) => (
                <div key={c.columnId} className={styles.colRow}>
                  <Checkbox
                    checked={selColIds.includes(c.columnId)}
                    onChange={(_e, d) => toggleCol(c.columnId, Boolean(d.checked))}
                    label={c.name}
                  />
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.dataType}</Caption1>
                </div>
              ))}
            </div>
          )}
        </Field>

        {selectedColumnNames.length > 0 && (
          <div className={styles.hiddenSummary}>
            <span className={styles.sectionLabel}>Will hide:</span>
            {selectedColumnNames.map((n) => (
              <Badge key={n} appearance="tint" color="danger" size="small" icon={<EyeOff20Regular />}>{n}</Badge>
            ))}
          </div>
        )}

        {conflictColumns.length > 0 && (
          <MessageBar intent="warning" politeness="polite">
            <MessageBarBody>
              <MessageBarTitle>Role conflict on {conflictColumns.length} column{conflictColumns.length > 1 ? 's' : ''}</MessageBarTitle>
              {conflictColumns.join(', ')} already {conflictColumns.length > 1 ? 'have' : 'has'} a column-level GRANT for{' '}
              <strong>{upn.trim()}</strong>. DENY wins at column scope, so the GRANT becomes dead weight — consider revoking the
              column-level GRANT (Lakehouse → Permissions → Column) first to keep intent clear.
            </MessageBarBody>
          </MessageBar>
        )}

        <Checkbox
          checked={maskView}
          onChange={(_e, d) => setMaskView(Boolean(d.checked))}
          label="Also generate a Serverless masked view (NULL-projects hidden columns; CLS DENY is Dedicated-only, so a view is the Serverless parity path)"
        />

        <div className={styles.actions}>
          <Button
            appearance="primary"
            icon={<EyeOff20Regular />}
            disabled={busy || selObjectId == null || !upn.trim() || selColIds.length === 0}
            onClick={applyDeny}
          >
            {busy ? 'Applying…' : 'Hide columns (apply DENY)'}
          </Button>
          {busy && <Spinner size="tiny" />}
        </div>
      </div>

      <div>
        <div className={styles.sectionLabel} style={{ marginBottom: tokens.spacingVerticalS }}>
          Existing hidden columns (column-level DENY)
        </div>
        <LoomDataTable
          columns={denyColumns}
          rows={denyRows}
          getRowId={(r) => `${r.principal}|${r.schema}|${r.table}|${r.column}`}
          ariaLabel="Hidden columns (column-level DENY entries)"
          empty="No columns are hidden yet. Select a table, a principal, and one or more columns above."
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// OnelakeRlsPredicateEditor (F8) — custom row-level-security WHERE predicate
// ───────────────────────────────────────────────────────────────────────────

// Max predicate length — re-exported from the shared sanitizer.
const MAX_CHARS = RLS_WHERE_MAX;

/** Client-side wrapper over the shared validator — returns an error string or null. */
export function validateRlsPredicate(s: string): string | null {
  const v = validateWhereClause(s);
  return v.ok ? null : v.error || 'Invalid predicate.';
}

const useRlsStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px' },
  pickers: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' },
  counter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  note: {
    display: 'flex',
    gap: '6px',
    alignItems: 'flex-start',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    padding: '8px 10px',
  },
  resultBox: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    maxHeight: '260px',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: {
    textAlign: 'left',
    padding: '5px 8px',
    position: 'sticky',
    top: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  td: { padding: '5px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, whiteSpace: 'nowrap' },
});

export interface OnelakeRlsTable {
  objectId: number;
  schema: string;
  name: string;
  type: string;
}

export interface OnelakeRlsPredicateEditorProps {
  /** Tables/views from the parent's catalog list (Synapse Dedicated SQL pool). */
  tables: OnelakeRlsTable[];
  /** Signed-in admin's UPN — seeds the "Test as identity" field. */
  defaultIdentity?: string;
  /** Called after a policy is successfully created so the parent can refresh. */
  onSaved?: () => void;
}

interface SqlColRef {
  columnId: number;
  name: string;
  dataType: string;
}

interface TestResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  testIdentity: string;
}

// Register the @cmp-aware completion provider once per page (Monaco providers
// are global; a module flag avoids duplicate suggestions across remounts).
let completionRegistered = false;
function registerRlsCompletions(monaco: any) {
  if (completionRegistered) return;
  completionRegistered = true;
  const items = [
    { label: '@cmp', insertText: '@cmp', detail: "The filter column's value for the current row" },
    { label: 'USER_NAME()', insertText: 'USER_NAME()', detail: 'Database user name of the caller (UPN)' },
    { label: 'SUSER_SNAME()', insertText: 'SUSER_SNAME()', detail: 'Login name of the caller' },
    { label: "IS_MEMBER('db_owner')", insertText: "IS_MEMBER('db_owner') = 1", detail: 'True when the caller is a db_owner' },
    { label: 'SESSION_CONTEXT', insertText: "SESSION_CONTEXT(N'key')", detail: 'Session context value (set per connection)' },
  ];
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems(model: any, position: any) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: items.map((it) => ({
          label: it.label,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: it.insertText,
          detail: it.detail,
          range,
        })),
      };
    },
  });
}

export function OnelakeRlsPredicateEditor({ tables, defaultIdentity, onSaved }: OnelakeRlsPredicateEditorProps) {
  const styles = useRlsStyles();
  // Only base tables (type 'U') can carry an RLS policy — match the fixed form.
  const rlsTables = useMemo(() => tables.filter((t) => t.type === 'U'), [tables]);

  const [objectId, setObjectId] = useState<number | null>(null);
  const [cols, setCols] = useState<SqlColRef[]>([]);
  const [colsLoading, setColsLoading] = useState(false);
  const [filterColumnId, setFilterColumnId] = useState<number | null>(null);
  const [whereClause, setWhereClause] = useState('@cmp = USER_NAME()');
  const [testIdentity, setTestIdentity] = useState(defaultIdentity || '');

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveReceipt, setSaveReceipt] = useState<{ policyName: string; functionName: string } | null>(null);

  useEffect(() => {
    setTestIdentity((cur) => cur || defaultIdentity || '');
  }, [defaultIdentity]);

  const validationError = validateRlsPredicate(whereClause);
  const charCount = whereClause.length;
  const overLimit = charCount > MAX_CHARS;

  const loadColumns = useCallback(async (oid: number) => {
    setColsLoading(true);
    try {
      const r = await fetch(`/api/lakehouse/permissions?tab=column&list=columns&objectId=${oid}`);
      const j = await r.json();
      setCols(j.ok ? j.columns || [] : []);
    } catch {
      setCols([]);
    } finally {
      setColsLoading(false);
    }
  }, []);

  const onPickTable = useCallback(
    (oid: number | null) => {
      setObjectId(oid);
      setFilterColumnId(null);
      setCols([]);
      setTestResult(null);
      setTestError(null);
      setSaveReceipt(null);
      setSaveError(null);
      if (oid != null) loadColumns(oid);
    },
    [loadColumns],
  );

  const monacoReady = useRef(false);
  const onMonacoReady = useCallback((_editor: any, monaco: any) => {
    if (monacoReady.current) return;
    monacoReady.current = true;
    registerRlsCompletions(monaco);
  }, []);

  const canRun = objectId != null && filterColumnId != null && !validationError;

  const runTest = useCallback(async () => {
    if (!canRun) return;
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const r = await fetch('/api/lakehouse/permissions/rls-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectId, filterColumnId, whereClause, testIdentity: testIdentity.trim() }),
      });
      const j = await r.json();
      if (!j.ok) {
        setTestError(j.gate ? `Synapse Dedicated SQL pool not configured (${j.missing}).` : j.error || `HTTP ${r.status}`);
        return;
      }
      setTestResult({
        columns: j.columns || [],
        rows: j.rows || [],
        rowCount: j.rowCount || 0,
        executionMs: j.executionMs || 0,
        truncated: !!j.truncated,
        testIdentity: j.testIdentity || testIdentity.trim(),
      });
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally {
      setTestLoading(false);
    }
  }, [canRun, objectId, filterColumnId, whereClause, testIdentity]);

  const savePolicy = useCallback(async () => {
    if (!canRun) return;
    setSaveLoading(true);
    setSaveError(null);
    setSaveReceipt(null);
    try {
      const r = await fetch('/api/lakehouse/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'row', objectId, filterColumnId, whereClause }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveError(j.gate ? `Synapse Dedicated SQL pool not configured (${j.missing}).` : j.error || `HTTP ${r.status}`);
        return;
      }
      setSaveReceipt({ policyName: j.policyName, functionName: j.functionName });
      onSaved?.();
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaveLoading(false);
    }
  }, [canRun, objectId, filterColumnId, whereClause, onSaved]);

  const selectedTableLabel =
    objectId != null && rlsTables.find((t) => t.objectId === objectId)
      ? `${rlsTables.find((t) => t.objectId === objectId)!.schema}.${rlsTables.find((t) => t.objectId === objectId)!.name}`
      : '';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <ShieldCheckmark20Regular />
        <Subtitle2>Custom WHERE predicate</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
      </div>
      <Caption1>
        Author a free-form filter predicate. <code>@cmp</code> is the chosen filter column&apos;s value for each row; a
        row is visible when the predicate is true. The policy is a real inline table-valued function +{' '}
        <code>SECURITY POLICY</code> on the Synapse Dedicated SQL pool.
      </Caption1>

      <div className={styles.pickers}>
        <Field label="Table" required>
          <Dropdown
            placeholder="Select a table"
            selectedOptions={objectId != null ? [String(objectId)] : []}
            value={selectedTableLabel}
            onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
          >
            {rlsTables.map((t) => (
              <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>
                {t.schema}.{t.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Filter column" required hint={colsLoading ? 'Loading…' : undefined}>
          <Dropdown
            placeholder="Select a column"
            disabled={objectId == null || colsLoading}
            selectedOptions={filterColumnId != null ? [String(filterColumnId)] : []}
            value={filterColumnId != null && cols.find((c) => c.columnId === filterColumnId) ? cols.find((c) => c.columnId === filterColumnId)!.name : ''}
            onOptionSelect={(_, d) => setFilterColumnId(d.optionValue ? Number(d.optionValue) : null)}
          >
            {cols.map((c) => (
              <Option key={c.columnId} value={String(c.columnId)} text={c.name}>
                {c.name} ({c.dataType})
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Test as identity" hint="Substitutes USER_NAME()/SUSER_SNAME() in the preview">
          <Input
            value={testIdentity}
            onChange={(_, d) => setTestIdentity(d.value)}
            placeholder="user@contoso.com"
          />
        </Field>
      </div>

      <Field
        label="WHERE predicate"
        required
        validationState={validationError ? 'error' : 'none'}
        validationMessage={validationError || undefined}
      >
        <MonacoTextarea
          value={whereClause}
          onChange={setWhereClause}
          language="tsql"
          height={84}
          lineNumbers={false}
          minimap={false}
          ariaLabel="Row-level security WHERE predicate"
          onReady={onMonacoReady}
        />
      </Field>
      <div className={styles.counter}>
        <Caption1 style={{ color: overLimit ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
          {charCount} / {MAX_CHARS} characters
        </Caption1>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Compare <code>@cmp</code> to <code>USER_NAME()</code>, <code>SUSER_SNAME()</code>, or another column.
        </Caption1>
      </div>

      <div className={styles.note}>
        <Info16Regular style={{ marginTop: 2, flexShrink: 0 }} />
        <Caption1>
          The saved policy applies as <code>(your predicate) OR IS_MEMBER(&apos;db_owner&apos;) = 1</code>, so database
          owners always see every row. When multiple security policies target the same table their predicates are{' '}
          <strong>AND-combined</strong> at row evaluation; to OR several conditions, combine them with <code>OR</code>{' '}
          inside this one predicate.
        </Caption1>
      </div>

      <div className={styles.actions}>
        <Button appearance="secondary" icon={<Play16Regular />} onClick={runTest} disabled={!canRun || testLoading}>
          {testLoading ? 'Testing…' : 'Test predicate'}
        </Button>
        <Button appearance="primary" onClick={savePolicy} disabled={!canRun || saveLoading}>
          {saveLoading ? 'Saving…' : 'Save policy'}
        </Button>
      </div>

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not save policy</MessageBarTitle>
            {saveError}
          </MessageBarBody>
        </MessageBar>
      )}
      {saveReceipt && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Security policy created</MessageBarTitle>
            <code>{saveReceipt.policyName}</code> over <code>{saveReceipt.functionName}</code> is enabled on{' '}
            <code>{selectedTableLabel}</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {testError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Test failed</MessageBarTitle>
            {testError}
          </MessageBarBody>
        </MessageBar>
      )}
      {testLoading && <Spinner size="tiny" label="Running preview against live rows…" labelPosition="after" />}
      {testResult && (
        <div>
          <Body1 block style={{ marginBottom: 4 }}>
            {testResult.rowCount.toLocaleString()} row{testResult.rowCount === 1 ? '' : 's'} visible to{' '}
            <code>{testResult.testIdentity || '(connection identity)'}</code> · {testResult.executionMs} ms
            {testResult.truncated ? ' · truncated' : ''}
          </Body1>
          <div className={styles.resultBox}>
            {testResult.columns.length === 0 ? (
              <Caption1 style={{ display: 'block', padding: 8 }}>No rows match this predicate for that identity.</Caption1>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    {testResult.columns.map((c) => (
                      <th key={c} className={styles.th}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {testResult.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className={styles.td}>{v == null ? 'NULL' : String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default OneLakeSecurityTab;
