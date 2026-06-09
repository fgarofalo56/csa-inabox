'use client';

/**
 * SemanticModelHierarchyEditor — the Loom-native parity of the Power BI / Fabric
 * Model-view "Create hierarchy" experience. Build named drill hierarchies per
 * table by stacking table columns into ordered levels (Year → Quarter → Month).
 *
 * Per .claude/rules/loom-no-freeform-config.md authoring is entirely through
 * Fluent controls (table dropdown, column list, Up/Down level ordering) — no
 * raw JSON. The parent owns persistence; this component only collects the
 * hierarchy and calls back. NO Power BI / Fabric dependency — hierarchies are
 * persisted Azure-native (Cosmos) and reflected in the TMSL preview.
 */

import { useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Input, Dropdown, Option, Spinner, Subtitle2, Text, Tooltip,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete16Regular, ArrowUp16Regular, ArrowDown16Regular,
  DocumentTable16Regular, Organization20Regular,
} from '@fluentui/react-icons';
import type { ModelTable } from './model-view-canvas';

export interface ModelHierarchyLevel { ordinal: number; name: string; column: string }
export interface ModelHierarchy {
  id: string;
  name: string;
  table: string;
  levels: ModelHierarchyLevel[];
}

export interface SemanticModelHierarchyEditorProps {
  tables: ModelTable[];
  hierarchies: ModelHierarchy[];
  onCreateHierarchy: (h: Omit<ModelHierarchy, 'id'>) => Promise<void>;
  onDeleteHierarchy: (id: string) => Promise<void>;
  readOnly?: boolean;
}

interface DraftLevel { name: string; column: string }

export function SemanticModelHierarchyEditor({
  tables, hierarchies, onCreateHierarchy, onDeleteHierarchy, readOnly,
}: SemanticModelHierarchyEditorProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [table, setTable] = useState('');
  const [levels, setLevels] = useState<DraftLevel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const tableCols = useMemo(
    () => tables.find((t) => t.id === table || t.name === table)?.columns || [],
    [tables, table],
  );

  const reset = () => { setName(''); setTable(tables[0]?.name || ''); setLevels([]); setErr(null); };

  const openDialog = () => { reset(); setOpen(true); };

  const addLevel = (column: string) => {
    if (levels.some((l) => l.column === column)) return;
    setLevels((p) => [...p, { name: column, column }]);
  };
  const removeLevel = (i: number) => setLevels((p) => p.filter((_, j) => j !== i));
  const moveLevel = (i: number, dir: -1 | 1) => {
    setLevels((p) => {
      const j = i + dir;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const renameLevel = (i: number, value: string) =>
    setLevels((p) => p.map((l, j) => (j === i ? { ...l, name: value } : l)));

  const save = async () => {
    if (!name.trim()) { setErr('Hierarchy name is required.'); return; }
    if (!table) { setErr('Pick a table.'); return; }
    if (levels.length === 0) { setErr('Add at least one column as a drill level.'); return; }
    setBusy(true); setErr(null);
    try {
      await onCreateHierarchy({
        name: name.trim(),
        table,
        levels: levels.map((l, i) => ({ ordinal: i, name: l.name.trim() || l.column, column: l.column })),
      });
      setOpen(false);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeHierarchy = async (id: string) => {
    setDeletingId(id);
    try { await onDeleteHierarchy(id); } finally { setDeletingId(null); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="hierarchy-editor">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Organization20Regular />
        <Subtitle2>Hierarchies ({hierarchies.length})</Subtitle2>
        <Button
          size="small" appearance="primary" icon={<Add20Regular />}
          onClick={openDialog} disabled={readOnly || tables.length === 0}
          title={tables.length === 0 ? 'Load tables to build a hierarchy' : 'Build a drill hierarchy (e.g. Year → Quarter → Month)'}
        >
          New hierarchy
        </Button>
      </div>

      <div style={{ overflow: 'auto', maxHeight: 220, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
        <Table aria-label="Hierarchies" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Table</TableHeaderCell>
              <TableHeaderCell>Drill levels</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hierarchies.length === 0 && (
              <TableRow><TableCell colSpan={4}><Caption1>No hierarchies yet. Click “New hierarchy” to build a drill path.</Caption1></TableCell></TableRow>
            )}
            {hierarchies.map((h) => (
              <TableRow key={h.id}>
                <TableCell>{h.name}</TableCell>
                <TableCell>{h.table}</TableCell>
                <TableCell>
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {[...h.levels].sort((a, b) => a.ordinal - b.ordinal).map((l, i, arr) => (
                      <span key={l.ordinal} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Badge size="small" appearance="tint" color="brand">{l.name}</Badge>
                        {i < arr.length - 1 && <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>›</Text>}
                      </span>
                    ))}
                  </span>
                </TableCell>
                <TableCell>
                  <Button
                    size="small" appearance="subtle" icon={<Delete16Regular />}
                    disabled={readOnly || deletingId === h.id}
                    onClick={() => removeHierarchy(h.id)}
                    aria-label={`Delete hierarchy ${h.name}`}
                  >
                    {deletingId === h.id ? 'Deleting…' : 'Delete'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>New hierarchy</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {err && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not save</MessageBarTitle>{err}</MessageBarBody></MessageBar>
                )}
                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="Table" style={{ flex: 1 }}>
                    <Dropdown
                      value={table}
                      selectedOptions={table ? [table] : []}
                      onOptionSelect={(_, d) => { if (d.optionValue) { setTable(d.optionValue); setLevels([]); } }}
                      placeholder="Select a table"
                    >
                      {tables.map((t) => <Option key={t.id} value={t.name} text={t.name}>{t.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Hierarchy name" required style={{ flex: 1 }}>
                    <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Date Drill" />
                  </Field>
                </div>

                <div style={{ display: 'flex', gap: 16 }}>
                  {/* Available columns */}
                  <div style={{ flex: 1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8, minHeight: 180 }}>
                    <Caption1 style={{ fontWeight: 600 }}>Columns in {table || '—'}</Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
                      {tableCols.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Pick a table to list its columns.</Caption1>}
                      {tableCols.map((c) => {
                        const used = levels.some((l) => l.column === c.name);
                        return (
                          <Tooltip key={c.name} content={used ? 'Already a level' : 'Add as drill level'} relationship="label">
                            <Button
                              size="small" appearance="subtle" disabled={used}
                              icon={<DocumentTable16Regular />} style={{ justifyContent: 'flex-start' }}
                              onClick={() => addLevel(c.name)}
                            >
                              {c.name}{c.type ? ` · ${c.type}` : ''}
                            </Button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>

                  {/* Drill levels (ordered top = highest grain) */}
                  <div style={{ flex: 1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8, minHeight: 180 }}>
                    <Caption1 style={{ fontWeight: 600 }}>Drill levels (top → bottom)</Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {levels.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click columns on the left to add levels.</Caption1>}
                      {levels.map((l, i) => (
                        <div key={l.column} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Badge size="small" appearance="filled" color="brand">{i + 1}</Badge>
                          <Input
                            size="small" value={l.name} aria-label={`Level ${i + 1} display name`}
                            onChange={(_, d) => renameLevel(i, d.value)} style={{ flex: 1 }}
                          />
                          <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 60 }}>{l.column}</Caption1>
                          <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label={`Move ${l.column} up`} disabled={i === 0} onClick={() => moveLevel(i, -1)} />
                          <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label={`Move ${l.column} down`} disabled={i === levels.length - 1} onClick={() => moveLevel(i, 1)} />
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Remove ${l.column}`} onClick={() => removeLevel(i)} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={save} disabled={busy || !name.trim() || !table || levels.length === 0}>
                {busy ? <Spinner size="tiny" /> : 'Save hierarchy'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
