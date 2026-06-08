'use client';

/**
 * OneLakeSecurityTab — the "Security" sub-surface of the OneLake catalog item
 * details pane, one-for-one with Microsoft Fabric's OneLake **column-level
 * security (CLS)** editor (the "hide columns from a role" experience).
 *
 * Azure-native, NO Fabric dependency (no-fabric-dependency.md): hiding a column
 * issues a real **column-scope DENY SELECT** (plus a table-level GRANT so the
 * principal can still query the table) on the Synapse **Dedicated SQL pool**
 * via /api/lakehouse/permissions?tab=cls. No Fabric / Power BI REST is touched.
 *
 *   GRANT SELECT ON [s].[t] TO [role];
 *   DENY  SELECT ON [s].[t]([SSN],[Phone]) TO [role];
 *
 * DENY semantics surfaced in the UI:
 *   • column-level DENY takes precedence over column-level GRANT;
 *   • a table-level DENY does NOT override a column-level GRANT (T-SQL
 *     backward-compat), so the correct hide-columns model is table GRANT +
 *     column DENY.
 *
 * Conflict detection: a column that carries BOTH a GRANT and a DENY for the
 * same principal is dead weight (DENY wins) — the editor warns on the overlap.
 *
 * Honest infra-gate: when the Dedicated pool isn't wired the BFF returns
 * { gate:true, missing, hint } and we render <NotConfiguredBar> (no silent
 * no-op, no mock data) — the full surface still renders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
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
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { EyeOff20Regular, ShieldKeyhole20Regular } from '@fluentui/react-icons';

import { NotConfiguredBar } from '@/lib/components/admin-security/not-configured-bar';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

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

export default OneLakeSecurityTab;
