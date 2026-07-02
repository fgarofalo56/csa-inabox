'use client';

/**
 * row-security-dialog (§2.2) — GUIDED row-level-security authoring for ONE
 * OneLake security role, mirroring Fabric's "Define row rule" experience but
 * with the Azure-native rls route as the backend (no Fabric, no freeform SQL).
 *
 * Flow:
 *   1. Pick a table (real Delta tables of the item — schema route).
 *   2. Build a condition list: each row is { column ▾, operator ▾, value }, the
 *      value either a literal or the signed-in identity (USER_NAME()) via a
 *      toggle. Rows are joined by a per-row AND/OR connector.
 *   3. The conditions COMPILE client-side to a SQL WHERE predicate, shown in a
 *      READ-ONLY preview (loom-no-freeform-config — no raw SQL/JSON entry).
 *   4. Save POSTs { rules } to .../onelake-security/[role]/rls, which RE-VALIDATES
 *      every predicate (isValidRlsPredicate) and reconciles to the source engine.
 *      The {@link ReconcileReceipt} is rendered honestly (applied / gated /
 *      partial + warnings, incl. the ADX table-wide / last-writer disclosure).
 *
 * One predicate per table (the route stores RowLevelRule[] = one rule per table
 * and REPLACES the whole array on POST), so this dialog manages the role's full
 * rule set: existing rules list with edit/delete, plus the builder for add/replace.
 *
 * Every control calls the REAL route; columns come from a REAL Delta-schema read
 * or an honest empty/gate state (no mock columns, no dead buttons).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent,
  DialogSurface, DialogTitle, Divider, Dropdown, Field, Input, MessageBar, MessageBarBody,
  MessageBarTitle, Option, Spinner, Subtitle2, Switch, Text, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, Edit16Regular, FilterRegular, PersonRegular,
  TableRegular,
} from '@fluentui/react-icons';

import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { isValidRlsPredicate } from '@/lib/azure/onelake-security-rules';
import { ReconcileReceiptBar, type ReconcileReceipt } from './reconcile-receipt-bar';

export type OneLakeSecurityItemType = 'lakehouse' | 'mirrored-database' | 'mirrored-catalog';

interface SchemaTable { schema: string; name: string; label: string; status?: string }
interface SchemaColumn { name: string; type: string }
interface RowLevelRule { table: string; predicate: string }

const OPERATORS = ['=', '<>', '>', '>=', '<', '<=', 'IN', 'contains'] as const;
type Op = (typeof OPERATORS)[number];

interface Condition {
  id: string;
  connector: 'AND' | 'OR';
  column: string;
  operator: Op;
  value: string;
  /** Compare to the signed-in identity (USER_NAME()) instead of a literal. */
  useIdentity: boolean;
}

const OP_LABELS: Record<Op, string> = {
  '=': 'equals', '<>': 'not equals', '>': 'greater than', '>=': 'greater or equal',
  '<': 'less than', '<=': 'less or equal', IN: 'in list', contains: 'contains',
};

let _cid = 0;
function blankCondition(connector: 'AND' | 'OR' = 'AND'): Condition {
  return { id: `c${++_cid}`, connector, column: '', operator: '=', value: '', useIdentity: false };
}

// ── client-side predicate compilation (preview is READ-ONLY) ──────────────────

/** Single-quoted SQL string literal (doubles embedded quotes). */
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** A condition is complete enough to compile + save. */
function isComplete(c: Condition): boolean {
  return !!c.column && (c.useIdentity || c.value.trim() !== '');
}

function compileCondition(c: Condition): string {
  const col = `[${c.column}]`;
  if (c.useIdentity) {
    const op = c.operator === '<>' ? '<>' : '=';
    return `${col} ${op} USER_NAME()`;
  }
  if (c.operator === 'IN') {
    const items = c.value.split(',').map((x) => x.trim()).filter(Boolean).map(sqlStr);
    return `${col} IN (${items.join(', ')})`;
  }
  if (c.operator === 'contains') {
    return `${col} LIKE ${sqlStr(`%${c.value}%`)}`;
  }
  return `${col} ${c.operator} ${sqlStr(c.value)}`;
}

/** Compile the complete conditions to a SQL WHERE predicate (parens per row). */
function compilePredicate(conds: Condition[]): string {
  return conds
    .filter(isComplete)
    .map((c, i) => (i === 0 ? `(${compileCondition(c)})` : `${c.connector} (${compileCondition(c)})`))
    .join(' ');
}

/** Best-effort decompile of THIS builder's own output back to conditions (for
 *  Edit). Returns null when the predicate wasn't authored here (e.g. the F8
 *  free-form editor) so the caller falls back to a fresh row + a reference note. */
function decompilePredicate(pred: string): Condition[] | null {
  try {
    const re = /(AND|OR)?\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
    const out: Condition[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(pred)) !== null) {
      const connector = (m[1] || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
      const frag = parseFragment(m[2].trim());
      if (!frag) return null;
      out.push({ id: `c${++_cid}`, connector: out.length === 0 ? 'AND' : connector, ...frag });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function parseFragment(inner: string): Omit<Condition, 'id' | 'connector'> | null {
  const colM = inner.match(/^\[([^\]]+)\]|^([A-Za-z_][A-Za-z0-9_ ]*)/);
  if (!colM) return null;
  const column = (colM[1] ?? colM[2] ?? '').trim();
  const rest = inner.slice(colM[0].length).trim();
  const idM = rest.match(/^(=|<>)\s*USER_NAME\(\)$/i);
  if (idM) return { column, operator: idM[1] as Op, value: '', useIdentity: true };
  const likeM = rest.match(/^LIKE\s+'%(.*)%'$/i);
  if (likeM) return { column, operator: 'contains', value: likeM[1].replace(/''/g, "'"), useIdentity: false };
  const inM = rest.match(/^IN\s*\((.*)\)$/i);
  if (inM) {
    const vals = inM[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '').replace(/''/g, "'")).filter(Boolean);
    return { column, operator: 'IN', value: vals.join(', '), useIdentity: false };
  }
  const opM = rest.match(/^(=|<>|>=|<=|>|<)\s*'(.*)'$/);
  if (opM) return { column, operator: opM[1] as Op, value: opM[2].replace(/''/g, "'"), useIdentity: false };
  return null;
}

// ── styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  surface: { maxWidth: '760px', width: '92vw' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  existing: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  ruleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  ruleMeta: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  builder: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  condGrid: {
    display: 'grid',
    gridTemplateColumns: '64px minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) auto',
    gap: tokens.spacingHorizontalS, alignItems: 'end',
  },
  connector: { display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: tokens.spacingVerticalS },
  preview: {
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground3,
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export interface RowSecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  itemType: OneLakeSecurityItemType;
  /** Role name = the [role] path segment (Cosmos roleDocId is derived from it). */
  roleName: string;
}

export function RowSecurityDialog({ open, onOpenChange, itemId, itemType, roleName }: RowSecurityDialogProps) {
  const s = useStyles();
  const apiBase = `/api/items/${itemType}/${encodeURIComponent(itemId)}/onelake-security`;
  const roleBase = `${apiBase}/${encodeURIComponent(roleName)}/rls`;

  const [rules, setRules] = useState<RowLevelRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReconcileReceipt | null>(null);
  const [saving, setSaving] = useState(false);

  // schema introspection
  const [tables, setTables] = useState<SchemaTable[] | null>(null);
  const [tablesGate, setTablesGate] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState('');
  const [columns, setColumns] = useState<SchemaColumn[] | null>(null);
  const [columnsLoading, setColumnsLoading] = useState(false);

  // builder
  const [conditions, setConditions] = useState<Condition[]>([blankCondition()]);
  const [editingTable, setEditingTable] = useState<string | null>(null);
  const [decompileNote, setDecompileNote] = useState<string | null>(null);

  const resetBuilder = useCallback(() => {
    setConditions([blankCondition()]);
    setEditingTable(null);
    setDecompileNote(null);
  }, []);

  // ── load existing rules + tables on open ──
  const loadRules = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(roleBase);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRules(Array.isArray(j.rls) ? j.rls : []);
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
    setReceipt(null); resetBuilder(); setSelectedTable(''); setColumns(null);
    loadRules();
    loadTables();
  }, [open, loadRules, loadTables, resetBuilder]);

  // ── load columns when a table is picked ──
  const loadColumns = useCallback(async (tableKey: string) => {
    if (!tableKey) { setColumns(null); return; }
    setColumnsLoading(true);
    try {
      const r = await clientFetch(`${apiBase}/schema?table=${encodeURIComponent(tableKey)}`);
      const j = await r.json();
      setColumns(j.ok && Array.isArray(j.columns) ? j.columns : []);
    } catch {
      setColumns([]);
    } finally {
      setColumnsLoading(false);
    }
  }, [apiBase]);

  const onPickTable = useCallback((tableKey: string) => {
    setSelectedTable(tableKey);
    resetBuilder();
    loadColumns(tableKey);
  }, [loadColumns, resetBuilder]);

  const compiled = useMemo(() => compilePredicate(conditions), [conditions]);
  const completeCount = useMemo(() => conditions.filter(isComplete).length, [conditions]);
  const previewValidation = useMemo(
    () => (compiled ? isValidRlsPredicate(compiled) : { ok: false, error: 'Add at least one complete condition.' }),
    [compiled],
  );

  const updateCondition = (id: string, patch: Partial<Condition>) =>
    setConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addCondition = () => setConditions((prev) => [...prev, blankCondition('AND')]);
  const removeCondition = (id: string) =>
    setConditions((prev) => (prev.length === 1 ? prev : prev.filter((c) => c.id !== id)));

  // ── persist (replace the role's whole RowLevelRule[] array) ──
  const postRules = useCallback(async (next: RowLevelRule[]) => {
    setSaving(true); setError(null); setReceipt(null);
    try {
      const r = await clientFetch(roleBase, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: next }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRules(Array.isArray(j.rls) ? j.rls : next);
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
    if (!selectedTable || !previewValidation.ok) return;
    const next = rules.filter((r) => r.table.toLowerCase() !== selectedTable.toLowerCase());
    next.push({ table: selectedTable, predicate: compiled });
    const ok = await postRules(next);
    if (ok) { setSelectedTable(''); setColumns(null); resetBuilder(); }
  }, [selectedTable, previewValidation.ok, rules, compiled, postRules, resetBuilder]);

  const editRule = useCallback((rule: RowLevelRule) => {
    setSelectedTable(rule.table);
    setEditingTable(rule.table);
    loadColumns(rule.table);
    const decoded = decompilePredicate(rule.predicate);
    if (decoded) { setConditions(decoded); setDecompileNote(null); }
    else {
      setConditions([blankCondition()]);
      setDecompileNote(`This predicate wasn't built here: ${rule.predicate}. Rebuild the conditions below — saving replaces the rule for this table.`);
    }
  }, [loadColumns]);

  const deleteRule = useCallback(async (table: string) => {
    const next = rules.filter((r) => r.table.toLowerCase() !== table.toLowerCase());
    await postRules(next);
    if (editingTable && editingTable.toLowerCase() === table.toLowerCase()) {
      setSelectedTable(''); setColumns(null); resetBuilder();
    }
  }, [rules, postRules, editingTable, resetBuilder]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => onOpenChange(d.open)} modalType="modal">
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span className={s.sectionHead}><FilterRegular /> Row security · role “{roleName}”</span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Caption1>
                Rows are visible to members of <strong>{roleName}</strong> only when the compiled predicate is true.
                Database owners always see every row. Each table carries one predicate.
              </Caption1>

              {error && (
                <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
              )}
              <ReconcileReceiptBar receipt={receipt} />

              {/* ── existing rules ── */}
              <div className={s.existing}>
                <Subtitle2>Row rules ({rules.length})</Subtitle2>
                {loading && <Spinner size="tiny" label="Loading rules…" />}
                {!loading && rules.length === 0 && (
                  <EmptyState
                    icon={<FilterRegular />}
                    title="No row rules yet"
                    body="Pick a table below and build a condition to filter the rows this role can see."
                  />
                )}
                {rules.map((r) => (
                  <div key={r.table} className={s.ruleRow}>
                    <div className={s.ruleMeta}>
                      <Text weight="semibold"><TableRegular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />{r.table}</Text>
                      <span className={s.code}>WHERE {r.predicate}</span>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexShrink: 0 }}>
                      <Button size="small" appearance="subtle" icon={<Edit16Regular />} disabled={saving} onClick={() => editRule(r)}>Edit</Button>
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={saving} onClick={() => deleteRule(r.table)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>

              <Divider />

              {/* ── builder ── */}
              <div className={s.builder}>
                <Subtitle2>{editingTable ? `Edit rule · ${editingTable}` : 'Add a row rule'}</Subtitle2>

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
                  <EmptyState icon={<TableRegular />} title="No tables found" body="This item has no Delta tables under its containers yet. Create a table, then define a row rule." />
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

                    {decompileNote && (
                      <MessageBar intent="info"><MessageBarBody>{decompileNote}</MessageBarBody></MessageBar>
                    )}

                    {selectedTable && (
                      columnsLoading ? (
                        <Spinner size="tiny" label="Reading table columns…" />
                      ) : columns && columns.length === 0 ? (
                        <EmptyState
                          icon={<TableRegular />}
                          title="Columns unavailable"
                          body="This table's Delta schema couldn't be read (no _delta_log, or the Console identity lacks Storage Blob Data Reader). Grant Reader and reopen to build a condition."
                        />
                      ) : columns ? (
                        <>
                          {conditions.map((c, idx) => (
                            <div key={c.id}>
                              {idx > 0 && (
                                <div className={s.connector}>
                                  <Switch
                                    checked={c.connector === 'OR'}
                                    label={c.connector === 'OR' ? 'OR' : 'AND'}
                                    onChange={(_e, d) => updateCondition(c.id, { connector: d.checked ? 'OR' : 'AND' })}
                                  />
                                </div>
                              )}
                              <div className={s.condGrid}>
                                <Caption1 style={{ paddingBottom: tokens.spacingVerticalS }}>{idx === 0 ? 'WHERE' : ''}</Caption1>
                                <Field label={idx === 0 ? 'Column' : undefined}>
                                  <Dropdown
                                    placeholder="Column"
                                    selectedOptions={c.column ? [c.column] : []}
                                    value={c.column}
                                    onOptionSelect={(_e, d) => updateCondition(c.id, { column: d.optionValue || '' })}
                                  >
                                    {columns.map((col) => (
                                      <Option key={col.name} value={col.name} text={col.name}>{col.name} ({col.type})</Option>
                                    ))}
                                  </Dropdown>
                                </Field>
                                <Field label={idx === 0 ? 'Operator' : undefined}>
                                  <Dropdown
                                    selectedOptions={[c.operator]}
                                    value={OP_LABELS[c.operator]}
                                    onOptionSelect={(_e, d) => updateCondition(c.id, { operator: (d.optionValue as Op) || '=' })}
                                  >
                                    {OPERATORS.map((op) => (
                                      <Option key={op} value={op} text={OP_LABELS[op]}>{OP_LABELS[op]} ({op})</Option>
                                    ))}
                                  </Dropdown>
                                </Field>
                                <Field label={idx === 0 ? 'Value' : undefined}>
                                  <Input
                                    placeholder={c.useIdentity ? 'USER_NAME()' : c.operator === 'IN' ? 'a, b, c' : 'value'}
                                    disabled={c.useIdentity}
                                    value={c.useIdentity ? 'USER_NAME()' : c.value}
                                    contentBefore={c.useIdentity ? <PersonRegular /> : undefined}
                                    onChange={(_e, d) => updateCondition(c.id, { value: d.value })}
                                  />
                                </Field>
                                <Button
                                  size="small" appearance="subtle" icon={<Delete16Regular />}
                                  disabled={conditions.length === 1} aria-label="Remove condition"
                                  onClick={() => removeCondition(c.id)}
                                />
                              </div>
                              <Switch
                                checked={c.useIdentity}
                                label="Match current user (USERPRINCIPALNAME)"
                                onChange={(_e, d) => updateCondition(c.id, { useIdentity: d.checked })}
                              />
                            </div>
                          ))}

                          <div>
                            <Button size="small" appearance="secondary" icon={<Add16Regular />} onClick={addCondition}>Add condition</Button>
                          </div>

                          <Field label="Compiled predicate (read-only)" validationState={completeCount > 0 && !previewValidation.ok ? 'error' : 'none'} validationMessage={completeCount > 0 && !previewValidation.ok ? previewValidation.error : undefined}>
                            <div className={s.preview}>
                              <span className={s.code}>{compiled ? `WHERE ${compiled}` : '— add a complete condition —'}</span>
                            </div>
                          </Field>
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
              disabled={saving || !selectedTable || completeCount === 0 || !previewValidation.ok}
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

export default RowSecurityDialog;
