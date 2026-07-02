'use client';

/**
 * SqlConstraintBuilder — the inline keys & constraints **designer** for a single
 * Azure SQL / Fabric SQL database table. A Fluent v9 dialog with four tabs
 * (Primary Key · Unique · Foreign Key · Check) that mirror the SSMS "New
 * Constraint" / table-designer dialogs, with the Loom theme applied. Every tab
 * is a structured form (no raw DDL/JSON entry) except the CHECK tab's boolean
 * expression field — the one arbitrary-T-SQL surface the real SSMS/portal
 * designers also expose.
 *
 * On submit it POSTs the structured spec to `/api/sqldb/constraints`, which
 * builds the `ALTER TABLE … ADD CONSTRAINT …` from catalog-verified identifiers
 * (no client-supplied SQL for PK/UQ/FK). Azure SQL Database and Fabric SQL
 * database share the same TDS engine and enforce all four types identically;
 * there is no Microsoft Fabric workspace dependency on this path.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Input, Checkbox, Dropdown, Option, Textarea, Spinner,
  TabList, Tab, Badge, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  KeyMultiple20Regular, Link20Regular, Checkmark20Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  surface: { maxWidth: '640px', width: '640px' },
  body: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, minHeight: '320px',
  },
  form: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalS,
  },
  colList: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    maxHeight: '220px', overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXS,
  },
  colRow: {
    display: 'flex', alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalXXS,
    borderRadius: tokens.borderRadiusSmall,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  colName: { flex: 1, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase300 },
  colType: { color: tokens.colorNeutralForeground3, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  hint: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: 'Consolas, monospace' },
  dirDropdown: { minWidth: '124px' },
  actionsRow: { display: 'flex', gap: tokens.spacingHorizontalM },
  flex1: { flex: 1 },
  matchOk: { color: tokens.colorPaletteGreenForeground1 },
  matchWarn: { color: tokens.colorPaletteRedForeground1 },
});

/** Compact SQL type rendering for the column pickers (e.g. nvarchar(50)). */
function shortType(c: SqlColumnRow): string {
  const t = (c.dataType || '').toLowerCase();
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(t)) {
    const len = c.maxLength === -1 ? 'max' : (t.startsWith('n') ? c.maxLength / 2 : c.maxLength);
    return `${t}(${len})`;
  }
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
  return t;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export interface SqlColumnRow {
  columnId: number; name: string; dataType: string; maxLength: number;
  precision: number; scale: number; isNullable: boolean; isIdentity: boolean;
  isComputed: boolean; isPrimaryKey: boolean;
}
export interface SqlConstraintRow {
  constraintId: number; name: string;
  constraintType: 'PK' | 'UQ' | 'FK' | 'CK';
  isSystemNamed: boolean; isDisabled: boolean; isTrusted: boolean;
  columns: string; indexTypeDesc?: string;
  refTableId?: number; refTableName?: string; refColumns?: string;
  onDelete?: string; onUpdate?: string; checkDefinition?: string;
}
interface SqlTableLite { objectId: number; schema: string; name: string; fullName: string }

type Tab4 = 'PK' | 'UQ' | 'FK' | 'CK';
type RefAction = 'NO_ACTION' | 'CASCADE' | 'SET_NULL' | 'SET_DEFAULT';

export interface SqlConstraintBuilderProps {
  open: boolean;
  onClose: () => void;
  /** Called after a constraint is created so the parent reloads the list. */
  onCreated: () => void;
  tableObjectId: number;
  /** `[schema].[name]` (display only) and bare table name (for default names). */
  tableFullName: string;
  tableName: string;
  /** Already-loaded columns of this table. */
  columns: SqlColumnRow[];
  /** Existing constraints (client-side name-uniqueness + PK-exists hints). */
  existingConstraints: SqlConstraintRow[];
  /** Whether the table already has a clustered index (PK/UQ clustered gating). */
  hasClusteredIndex: boolean;
  /**
   * TDS backend dialect of the bound connection. `sqldb` (default) is the full
   * engine (Azure SQL Database / Fabric SQL database — all four types ENFORCED).
   * `warehouse` (Fabric Warehouse / SQL analytics endpoint) and
   * `synapse-dedicated` (Synapse dedicated SQL pool) only accept metadata-only
   * constraints: PK/UNIQUE are forced NONCLUSTERED NOT ENFORCED, CHECK is
   * unsupported, and FOREIGN KEY is unsupported on a dedicated pool.
   */
  backendKind?: 'sqldb' | 'warehouse' | 'synapse-dedicated';
  /** URL param string shared with the parent's BFF routes. */
  q: string;
}

const REF_ACTIONS: Array<{ key: RefAction; label: string }> = [
  { key: 'NO_ACTION', label: 'No action' },
  { key: 'CASCADE', label: 'Cascade' },
  { key: 'SET_NULL', label: 'Set null' },
  { key: 'SET_DEFAULT', label: 'Set default' },
];

export function SqlConstraintBuilder(props: SqlConstraintBuilderProps) {
  const {
    open, onClose, onCreated, tableObjectId, tableFullName, tableName,
    columns, existingConstraints, hasClusteredIndex, backendKind = 'sqldb', q,
  } = props;
  const s = useStyles();

  // Fabric Warehouse / Synapse dedicated pool only accept metadata-only
  // constraints (NONCLUSTERED NOT ENFORCED), no CHECK, no WITH (NO)CHECK; a
  // dedicated pool additionally rejects FOREIGN KEY entirely.
  const metadataOnly = backendKind === 'warehouse' || backendKind === 'synapse-dedicated';
  const fkUnsupported = backendKind === 'synapse-dedicated';
  const backendLabel = backendKind === 'warehouse'
    ? 'Fabric Warehouse / SQL analytics endpoint'
    : backendKind === 'synapse-dedicated' ? 'Synapse dedicated SQL pool' : '';

  const [tab, setTab] = useState<Tab4>('PK');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PK / UQ shared column-selection state (columnId → descending flag, ordered).
  const [keyCols, setKeyCols] = useState<Array<{ columnId: number; descending: boolean }>>([]);
  const [clustered, setClustered] = useState(false);
  const [pkName, setPkName] = useState('');
  const [uqName, setUqName] = useState('');

  // FK state
  const [fkCols, setFkCols] = useState<number[]>([]);
  const [refTableId, setRefTableId] = useState<number | null>(null);
  const [refCols, setRefCols] = useState<number[]>([]);
  const [onDelete, setOnDelete] = useState<RefAction>('NO_ACTION');
  const [onUpdate, setOnUpdate] = useState<RefAction>('NO_ACTION');
  const [fkNoCheck, setFkNoCheck] = useState(false);
  const [fkName, setFkName] = useState('');
  const [tables, setTables] = useState<SqlTableLite[] | 'loading' | null>(null);
  const [refColumns, setRefColumns] = useState<SqlColumnRow[] | 'loading' | null>(null);

  // CK state
  const [ckName, setCkName] = useState('');
  const [ckExpr, setCkExpr] = useState('');
  const [ckNoCheck, setCkNoCheck] = useState(false);

  const pkExists = existingConstraints.some((c) => c.constraintType === 'PK');
  const existingNames = useMemo(
    () => new Set(existingConstraints.map((c) => c.name.toLowerCase())),
    [existingConstraints],
  );

  // Reset on (re)open; default names follow SSMS conventions.
  useEffect(() => {
    if (!open) return;
    setTab(pkExists ? 'UQ' : 'PK');
    setError(null); setBusy(false);
    // On a metadata-only backend a clustered PK/UQ is impossible — keep it off.
    setKeyCols([]); setClustered(!metadataOnly && !hasClusteredIndex);
    setPkName(`PK_${tableName}`);
    setUqName(`UQ_${tableName}`);
    setFkCols([]); setRefTableId(null); setRefCols([]);
    setOnDelete('NO_ACTION'); setOnUpdate('NO_ACTION'); setFkNoCheck(false);
    setFkName(`FK_${tableName}`);
    setTables(null); setRefColumns(null);
    setCkName(`CK_${tableName}`); setCkExpr(''); setCkNoCheck(false);
  }, [open, tableName, hasClusteredIndex, pkExists, metadataOnly]);

  // Lazy-load the table list once the FK tab is shown.
  useEffect(() => {
    if (!open || tab !== 'FK' || tables !== null) return;
    setTables('loading');
    fetch(`/api/sqldb/tables?${q}`).then(readJson).then((b) => {
      if (b.ok) setTables((b.tables || []).map((t: any) => ({ objectId: t.objectId, schema: t.schema, name: t.name, fullName: t.fullName })));
      else { setTables([]); setError(b.error || 'failed to load tables'); }
    }).catch((e) => { setTables([]); setError(e?.message || String(e)); });
  }, [open, tab, tables, q]);

  // Load referenced columns when the referenced table changes.
  useEffect(() => {
    if (refTableId == null) { setRefColumns(null); return; }
    setRefColumns('loading'); setRefCols([]);
    fetch(`/api/sqldb/columns?${q}&objectId=${refTableId}`).then(readJson).then((b) => {
      if (b.ok) setRefColumns(b.columns || []);
      else { setRefColumns([]); setError(b.error || 'failed to load referenced columns'); }
    }).catch((e) => { setRefColumns([]); setError(e?.message || String(e)); });
  }, [refTableId, q]);

  const toggleKeyCol = useCallback((columnId: number, on: boolean) => {
    setKeyCols((prev) => on
      ? (prev.some((k) => k.columnId === columnId) ? prev : [...prev, { columnId, descending: false }])
      : prev.filter((k) => k.columnId !== columnId));
  }, []);

  const setKeyColDir = useCallback((columnId: number, descending: boolean) => {
    setKeyCols((prev) => prev.map((k) => (k.columnId === columnId ? { ...k, descending } : k)));
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    let spec: any;
    if (tab === 'PK' || tab === 'UQ') {
      const name = (tab === 'PK' ? pkName : uqName).trim();
      if (!name) { setError('A constraint name is required.'); return; }
      if (existingNames.has(name.toLowerCase())) { setError(`A constraint named "${name}" already exists.`); return; }
      if (keyCols.length === 0) { setError('Select at least one key column.'); return; }
      spec = { type: tab, name, columns: keyCols, clustered };
    } else if (tab === 'FK') {
      const name = fkName.trim();
      if (!name) { setError('A constraint name is required.'); return; }
      if (existingNames.has(name.toLowerCase())) { setError(`A constraint named "${name}" already exists.`); return; }
      if (fkCols.length === 0) { setError('Select at least one column in this table.'); return; }
      if (refTableId == null) { setError('Select a referenced table.'); return; }
      if (refCols.length !== fkCols.length) { setError('Select the same number of referenced columns as foreign-key columns.'); return; }
      spec = { type: 'FK', name, columns: fkCols, refTableObjectId: refTableId, refColumns: refCols, onDelete, onUpdate, noCheck: fkNoCheck };
    } else {
      const name = ckName.trim();
      if (!name) { setError('A constraint name is required.'); return; }
      if (existingNames.has(name.toLowerCase())) { setError(`A constraint named "${name}" already exists.`); return; }
      if (!ckExpr.trim()) { setError('Enter a CHECK expression.'); return; }
      spec = { type: 'CK', name, expression: ckExpr.trim(), noCheck: ckNoCheck };
    }
    setBusy(true);
    try {
      const body = await fetch(`/api/sqldb/constraints?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableObjectId, spec }),
      }).then(readJson);
      if (!body.ok) { setError(body.error || 'failed to create constraint'); setBusy(false); return; }
      onCreated();
      onClose();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [tab, pkName, uqName, fkName, ckName, keyCols, clustered, fkCols, refTableId, refCols, onDelete, onUpdate, fkNoCheck, ckExpr, ckNoCheck, existingNames, q, tableObjectId, onCreated, onClose]);

  const tableOpts = Array.isArray(tables) ? tables : [];
  const refColOpts = Array.isArray(refColumns) ? refColumns : [];

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Add constraint · <code className={s.mono}>{tableFullName}</code></DialogTitle>
          <DialogContent className={s.body}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => { setError(null); setTab(d.value as Tab4); }} size="small">
              <Tab value="PK" icon={<KeyMultiple20Regular />} disabled={pkExists}>Primary key</Tab>
              <Tab value="UQ">Unique</Tab>
              <Tab value="FK" icon={<Link20Regular />} disabled={fkUnsupported}>Foreign key</Tab>
              <Tab value="CK" icon={<Checkmark20Regular />} disabled={metadataOnly}>Check</Tab>
            </TabList>

            {metadataOnly && (
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>{backendLabel}</MessageBarTitle>
                  Keys are created as <strong>NONCLUSTERED&nbsp;NOT&nbsp;ENFORCED</strong> metadata constraints — the engine
                  uses them for query optimization but does not enforce uniqueness or referential integrity.
                  {fkUnsupported
                    ? ' CHECK and FOREIGN KEY constraints are not supported here.'
                    : ' CHECK constraints are not supported here.'}
                </MessageBarBody>
              </MessageBar>
            )}

            {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not add constraint</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

            {/* ---- PRIMARY KEY / UNIQUE ---- */}
            {(tab === 'PK' || tab === 'UQ') && (
              <div className={s.form}>
                {tab === 'PK' && pkExists && (
                  <MessageBar intent="warning"><MessageBarBody>This table already has a primary key. Drop it first to define a new one.</MessageBarBody></MessageBar>
                )}
                <Field label="Constraint name">
                  <Input value={tab === 'PK' ? pkName : uqName} onChange={(_, d) => (tab === 'PK' ? setPkName(d.value) : setUqName(d.value))} />
                </Field>
                <Field label="Key columns (in order)" hint="Select the columns and their sort direction. Order matters for composite keys.">
                  <div className={s.colList}>
                    {columns.length === 0 && <Caption1 className={s.hint}>No columns on this table.</Caption1>}
                    {columns.map((c) => {
                      const selIdx = keyCols.findIndex((k) => k.columnId === c.columnId);
                      const sel = selIdx >= 0 ? keyCols[selIdx] : undefined;
                      // A PK column must be NOT NULL; nullable columns are unselectable on the PK tab.
                      const pkBlocked = tab === 'PK' && c.isNullable;
                      return (
                        <div key={c.columnId} className={s.colRow}>
                          <Checkbox
                            checked={!!sel}
                            disabled={pkBlocked}
                            onChange={(_, d) => toggleKeyCol(c.columnId, !!d.checked)}
                            label={undefined}
                            aria-label={`Include ${c.name} in key`}
                          />
                          <span className={s.colName}>{c.name}</span>
                          <span className={s.colType}>{shortType(c)}</span>
                          {pkBlocked && <Badge size="small" appearance="outline" color="warning">nullable</Badge>}
                          {sel && <Badge size="small" appearance="tint" color="brand">{selIdx + 1}</Badge>}
                          {sel && (
                            <Dropdown
                              size="small"
                              value={sel.descending ? 'Descending' : 'Ascending'}
                              selectedOptions={[sel.descending ? 'DESC' : 'ASC']}
                              onOptionSelect={(_, d) => setKeyColDir(c.columnId, d.optionValue === 'DESC')}
                              className={s.dirDropdown}
                              aria-label={`Sort direction for ${c.name}`}
                            >
                              <Option value="ASC">Ascending</Option>
                              <Option value="DESC">Descending</Option>
                            </Dropdown>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Field>
                {metadataOnly ? (
                  <Caption1 className={s.hint}>
                    NONCLUSTERED NOT ENFORCED (required on {backendLabel}).
                  </Caption1>
                ) : (
                  <Checkbox
                    checked={clustered}
                    disabled={hasClusteredIndex}
                    onChange={(_, d) => setClustered(!!d.checked)}
                    label={hasClusteredIndex ? 'Clustered (a clustered index already exists — this will be NONCLUSTERED)' : 'Clustered index'}
                  />
                )}
              </div>
            )}

            {/* ---- FOREIGN KEY ---- */}
            {tab === 'FK' && (
              <div className={s.form}>
                <Field label="Constraint name">
                  <Input value={fkName} onChange={(_, d) => setFkName(d.value)} />
                </Field>
                <Field label="Columns in this table (in order)" hint="Selection order defines the foreign-key column order; match it below.">
                  <div className={s.colList}>
                    {columns.length === 0 && <Caption1 className={s.hint}>No columns on this table.</Caption1>}
                    {columns.map((c) => {
                      const ord = fkCols.indexOf(c.columnId);
                      return (
                        <div key={c.columnId} className={s.colRow}>
                          <Checkbox
                            checked={ord >= 0}
                            onChange={(_, d) => setFkCols((prev) => d.checked ? [...prev, c.columnId] : prev.filter((x) => x !== c.columnId))}
                            aria-label={`Include ${c.name} in foreign key`}
                          />
                          <span className={s.colName}>{c.name}</span>
                          <span className={s.colType}>{shortType(c)}</span>
                          {ord >= 0 && <Badge size="small" appearance="tint" color="brand">{ord + 1}</Badge>}
                        </div>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Referenced table">
                  {tables === 'loading'
                    ? <Spinner size="tiny" label="Loading tables…" />
                    : (
                      <Dropdown
                        placeholder="Select a table"
                        value={refTableId != null ? (tableOpts.find((t) => t.objectId === refTableId)?.fullName ?? '') : ''}
                        selectedOptions={refTableId != null ? [String(refTableId)] : []}
                        onOptionSelect={(_, d) => setRefTableId(d.optionValue ? Number(d.optionValue) : null)}
                      >
                        {tableOpts.map((t) => <Option key={t.objectId} value={String(t.objectId)}>{t.fullName}</Option>)}
                      </Dropdown>
                    )}
                </Field>
                {refTableId != null && (
                  <Field label="Referenced columns (match the order above)">
                    {refColumns === 'loading'
                      ? <Spinner size="tiny" label="Loading columns…" />
                      : (
                        <div className={s.colList}>
                          {refColOpts.length === 0 && <Caption1 className={s.hint}>No columns on the referenced table.</Caption1>}
                          {refColOpts.map((c) => {
                            const ord = refCols.indexOf(c.columnId);
                            return (
                              <div key={c.columnId} className={s.colRow}>
                                <Checkbox
                                  checked={ord >= 0}
                                  onChange={(_, d) => setRefCols((prev) => d.checked ? [...prev, c.columnId] : prev.filter((x) => x !== c.columnId))}
                                  aria-label={`Reference ${c.name}`}
                                />
                                <span className={s.colName}>{c.name}</span>
                                <span className={s.colType}>{shortType(c)}</span>
                                {ord >= 0 && <Badge size="small" appearance="tint" color="brand">{ord + 1}</Badge>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    {refColumns !== 'loading' && fkCols.length > 0 && (
                      <Caption1 className={refCols.length === fkCols.length ? s.matchOk : s.matchWarn}>
                        {refCols.length === fkCols.length
                          ? `Matched ${refCols.length} column${refCols.length === 1 ? '' : 's'}.`
                          : `Select ${fkCols.length} referenced column${fkCols.length === 1 ? '' : 's'} to match (${refCols.length} of ${fkCols.length} selected).`}
                      </Caption1>
                    )}
                  </Field>
                )}
                {metadataOnly ? (
                  <Caption1 className={s.hint}>
                    NOT ENFORCED (required on {backendLabel}); ON DELETE/UPDATE actions do not apply.
                  </Caption1>
                ) : (
                  <>
                    <div className={s.actionsRow}>
                      <Field label="On delete" className={s.flex1}>
                        <Dropdown value={REF_ACTIONS.find((a) => a.key === onDelete)?.label} selectedOptions={[onDelete]} onOptionSelect={(_, d) => setOnDelete(d.optionValue as RefAction)}>
                          {REF_ACTIONS.map((a) => <Option key={a.key} value={a.key}>{a.label}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="On update" className={s.flex1}>
                        <Dropdown value={REF_ACTIONS.find((a) => a.key === onUpdate)?.label} selectedOptions={[onUpdate]} onOptionSelect={(_, d) => setOnUpdate(d.optionValue as RefAction)}>
                          {REF_ACTIONS.map((a) => <Option key={a.key} value={a.key}>{a.label}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <Checkbox checked={fkNoCheck} onChange={(_, d) => setFkNoCheck(!!d.checked)} label="Skip validation of existing data (WITH NOCHECK)" />
                    {fkNoCheck && <MessageBar intent="warning"><MessageBarBody>Existing rows will not be validated; the constraint is created as <strong>not trusted</strong> (the optimizer ignores it until you re-validate).</MessageBarBody></MessageBar>}
                  </>
                )}
              </div>
            )}

            {/* ---- CHECK ---- */}
            {tab === 'CK' && (
              <div className={s.form}>
                <Field label="Constraint name">
                  <Input value={ckName} onChange={(_, d) => setCkName(d.value)} />
                </Field>
                <Field label="Check expression" hint="A T-SQL boolean expression, e.g. [Age] > 0 AND [Age] < 150">
                  <Textarea value={ckExpr} onChange={(_, d) => setCkExpr(d.value)} rows={4} resize="vertical" placeholder="[Column] > 0" />
                </Field>
                <Checkbox checked={ckNoCheck} onChange={(_, d) => setCkNoCheck(!!d.checked)} label="Skip validation of existing data (WITH NOCHECK)" />
                {ckNoCheck && <MessageBar intent="warning"><MessageBarBody>Existing rows will not be validated; the constraint is created as <strong>not trusted</strong>.</MessageBarBody></MessageBar>}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <ArrowSync16Regular />} onClick={submit} disabled={busy}>
              {busy ? 'Creating…' : 'Create constraint'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
