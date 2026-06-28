'use client';

/**
 * column-security-dialog (§2.2) — CHECKBOX-GRID column-level-security authoring
 * for ONE OneLake security role, mirroring Fabric's "Column-level security"
 * (pick the columns a role may read) with the Azure-native cls route as the
 * backend (no Fabric).
 *
 * Flow:
 *   1. Pick a table (real Delta tables of the item — schema route).
 *   2. A checkbox grid of the table's columns. The CHECKED set = allowedColumns
 *      (the columns the role may SELECT). "Select all / none" toggles the grid.
 *   3. Save POSTs { rules } to .../onelake-security/[role]/cls, which validates
 *      each list (isValidColumnList) and reconciles to the source engine
 *      (per-member column GRANT/REVOKE on Synapse, or an ADX project policy).
 *      The {@link ReconcileReceipt} is rendered honestly (applied / gated /
 *      partial + warnings, incl. the ADX table-wide / last-writer disclosure).
 *
 * The route stores ColumnLevelRule[] (one rule per table) and REPLACES the whole
 * array on POST, so this dialog manages the role's full set: existing rules list
 * with edit/delete, plus the grid for add/replace.
 *
 * Every control calls the REAL route; columns come from a REAL Delta-schema read
 * or an honest empty/gate state (no mock columns, no dead buttons).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody, DialogContent,
  DialogSurface, DialogTitle, Divider, Dropdown, Field, MessageBar, MessageBarBody,
  MessageBarTitle, Option, Spinner, Subtitle2, Text, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ColumnTripleRegular, Delete16Regular, Edit16Regular, TableRegular,
} from '@fluentui/react-icons';

import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { ReconcileReceiptBar, type ReconcileReceipt } from './reconcile-receipt-bar';

export type OneLakeSecurityItemType = 'lakehouse' | 'mirrored-database' | 'mirrored-catalog';

interface SchemaTable { schema: string; name: string; label: string; status?: string }
interface SchemaColumn { name: string; type: string }
interface ColumnLevelRule { table: string; allowedColumns: string[] }

const useStyles = makeStyles({
  surface: { maxWidth: '680px', width: '92vw' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  existing: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  ruleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  ruleMeta: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingVerticalXS, maxHeight: '280px', overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  colCell: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
});

export interface ColumnSecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  itemType: OneLakeSecurityItemType;
  /** Role name = the [role] path segment (Cosmos roleDocId is derived from it). */
  roleName: string;
}

export function ColumnSecurityDialog({ open, onOpenChange, itemId, itemType, roleName }: ColumnSecurityDialogProps) {
  const s = useStyles();
  const apiBase = `/api/items/${itemType}/${encodeURIComponent(itemId)}/onelake-security`;
  const roleBase = `${apiBase}/${encodeURIComponent(roleName)}/cls`;

  const [rules, setRules] = useState<ColumnLevelRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReconcileReceipt | null>(null);
  const [saving, setSaving] = useState(false);

  const [tables, setTables] = useState<SchemaTable[] | null>(null);
  const [tablesGate, setTablesGate] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState('');
  const [columns, setColumns] = useState<SchemaColumn[] | null>(null);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [editingTable, setEditingTable] = useState<string | null>(null);

  const resetGrid = useCallback(() => { setAllowed(new Set()); setEditingTable(null); }, []);

  const loadRules = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(roleBase);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRules(Array.isArray(j.cls) ? j.cls : []);
      if (j.lastReceipt) setReceipt(j.lastReceipt as ReconcileReceipt);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [roleBase]);

  const loadTables = useCallback(async () => {
    setTablesGate(null);
    try {
      const r = await clientFetch(`${apiBase}/schema`);
      const j = await r.json();
      if (j.gate) { setTablesGate(j.gate); setTables([]); return; }
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setTables(Array.isArray(j.tables) ? j.tables : []);
    } catch (e: any) {
      setError(e?.message || String(e));
      setTables([]);
    }
  }, [apiBase]);

  useEffect(() => {
    if (!open) return;
    setReceipt(null); resetGrid(); setSelectedTable(''); setColumns(null);
    loadRules();
    loadTables();
  }, [open, loadRules, loadTables, resetGrid]);

  const loadColumns = useCallback(async (tableKey: string, preselect?: string[]) => {
    if (!tableKey) { setColumns(null); return; }
    setColumnsLoading(true);
    try {
      const r = await clientFetch(`${apiBase}/schema?table=${encodeURIComponent(tableKey)}`);
      const j = await r.json();
      const cols: SchemaColumn[] = j.ok && Array.isArray(j.columns) ? j.columns : [];
      setColumns(cols);
      // default: a NEW rule allows ALL columns (deny none); an edit restores the
      // persisted allow-list intersected with the live schema.
      if (preselect) setAllowed(new Set(preselect.filter((c) => cols.some((x) => x.name === c))));
      else setAllowed(new Set(cols.map((c) => c.name)));
    } catch {
      setColumns([]);
    } finally {
      setColumnsLoading(false);
    }
  }, [apiBase]);

  const onPickTable = useCallback((tableKey: string) => {
    setSelectedTable(tableKey);
    setEditingTable(null);
    loadColumns(tableKey);
  }, [loadColumns]);

  const toggleColumn = (name: string, checked: boolean) =>
    setAllowed((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name); else next.delete(name);
      return next;
    });

  const allChecked = !!columns && columns.length > 0 && columns.every((c) => allowed.has(c.name));
  const setAll = (on: boolean) =>
    setAllowed(on && columns ? new Set(columns.map((c) => c.name)) : new Set());

  const hiddenColumns = useMemo(
    () => (columns || []).filter((c) => !allowed.has(c.name)).map((c) => c.name),
    [columns, allowed],
  );

  const postRules = useCallback(async (next: ColumnLevelRule[]) => {
    setSaving(true); setError(null); setReceipt(null);
    try {
      const r = await clientFetch(roleBase, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: next }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRules(Array.isArray(j.cls) ? j.cls : next);
      if (j.receipt) setReceipt(j.receipt as ReconcileReceipt);
      return true;
    } catch (e: any) {
      setError(e?.message || String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [roleBase]);

  const saveRule = useCallback(async () => {
    if (!selectedTable || allowed.size === 0) return;
    const next = rules.filter((r) => r.table.toLowerCase() !== selectedTable.toLowerCase());
    next.push({ table: selectedTable, allowedColumns: Array.from(allowed) });
    const ok = await postRules(next);
    if (ok) { setSelectedTable(''); setColumns(null); resetGrid(); }
  }, [selectedTable, allowed, rules, postRules, resetGrid]);

  const editRule = useCallback((rule: ColumnLevelRule) => {
    setSelectedTable(rule.table);
    setEditingTable(rule.table);
    loadColumns(rule.table, rule.allowedColumns);
  }, [loadColumns]);

  const deleteRule = useCallback(async (table: string) => {
    const next = rules.filter((r) => r.table.toLowerCase() !== table.toLowerCase());
    await postRules(next);
    if (editingTable && editingTable.toLowerCase() === table.toLowerCase()) {
      setSelectedTable(''); setColumns(null); resetGrid();
    }
  }, [rules, postRules, editingTable, resetGrid]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => onOpenChange(d.open)} modalType="modal">
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span className={s.sectionHead}><ColumnTripleRegular /> Column security · role “{roleName}”</span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Caption1>
                Members of <strong>{roleName}</strong> may read only the <strong>checked</strong> columns of a table.
                Unchecked columns are denied (SELECT on them fails). Each table carries one allow-list.
              </Caption1>

              {error && (
                <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
              )}
              <ReconcileReceiptBar receipt={receipt} />

              {/* ── existing rules ── */}
              <div className={s.existing}>
                <Subtitle2>Column rules ({rules.length})</Subtitle2>
                {loading && <Spinner size="tiny" label="Loading rules…" />}
                {!loading && rules.length === 0 && (
                  <EmptyState
                    icon={<ColumnTripleRegular />}
                    title="No column rules yet"
                    body="Pick a table below and choose which columns this role may read."
                  />
                )}
                {rules.map((r) => (
                  <div key={r.table} className={s.ruleRow}>
                    <div className={s.ruleMeta}>
                      <Text weight="semibold"><TableRegular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />{r.table}</Text>
                      <div className={s.chips}>
                        {r.allowedColumns.map((c) => (
                          <Badge key={c} appearance="tint" color="brand" size="small">{c}</Badge>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexShrink: 0 }}>
                      <Button size="small" appearance="subtle" icon={<Edit16Regular />} disabled={saving} onClick={() => editRule(r)}>Edit</Button>
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={saving} onClick={() => deleteRule(r.table)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>

              <Divider />

              {/* ── grid ── */}
              <div className={s.existing}>
                <Subtitle2>{editingTable ? `Edit rule · ${editingTable}` : 'Add a column rule'}</Subtitle2>

                {tablesGate ? (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Lakehouse storage not configured</MessageBarTitle>
                      {tablesGate}
                    </MessageBarBody>
                  </MessageBar>
                ) : tables === null ? (
                  <Spinner size="tiny" label="Loading tables…" />
                ) : tables.length === 0 ? (
                  <EmptyState icon={<TableRegular />} title="No tables found" body="This item has no Delta tables under its containers yet. Create a table, then define a column rule." />
                ) : (
                  <>
                    <Field label="Table" required>
                      <Dropdown
                        placeholder="Select a table…"
                        disabled={!!editingTable}
                        selectedOptions={selectedTable ? [selectedTable] : []}
                        value={selectedTable}
                        onOptionSelect={(_e, d) => onPickTable(d.optionValue || '')}
                      >
                        {tables.map((t) => (
                          <Option key={t.label} value={t.label} text={t.label}>{t.label}</Option>
                        ))}
                      </Dropdown>
                    </Field>

                    {selectedTable && (
                      columnsLoading ? (
                        <Spinner size="tiny" label="Reading table columns…" />
                      ) : columns && columns.length === 0 ? (
                        <EmptyState
                          icon={<TableRegular />}
                          title="Columns unavailable"
                          body="This table's Delta schema couldn't be read (no _delta_log, or the Console identity lacks Storage Blob Data Reader). Grant Reader and reopen to choose columns."
                        />
                      ) : columns ? (
                        <>
                          <div className={s.toolbar}>
                            <Checkbox
                              checked={allChecked ? true : allowed.size === 0 ? false : 'mixed'}
                              label={`Allow all (${allowed.size}/${columns.length} selected)`}
                              onChange={(_e, d) => setAll(!!d.checked)}
                            />
                            {hiddenColumns.length > 0 && (
                              <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>
                                Denied: {hiddenColumns.join(', ')}
                              </Caption1>
                            )}
                          </div>
                          <div className={s.grid}>
                            {columns.map((col) => (
                              <div key={col.name} className={s.colCell}>
                                <Checkbox
                                  checked={allowed.has(col.name)}
                                  label={col.name}
                                  onChange={(_e, d) => toggleColumn(col.name, !!d.checked)}
                                />
                                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{col.type}</Caption1>
                              </div>
                            ))}
                          </div>
                          {allowed.size === 0 && (
                            <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>
                              Select at least one column — an empty allow-list isn&apos;t a valid CLS rule.
                            </Caption1>
                          )}
                        </>
                      ) : null
                    )}
                  </>
                )}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              appearance="primary"
              disabled={saving || !selectedTable || allowed.size === 0}
              icon={saving ? <Spinner size="extra-tiny" /> : undefined}
              onClick={saveRule}
            >
              {saving ? 'Saving…' : editingTable ? 'Save rule' : 'Add rule'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default ColumnSecurityDialog;
