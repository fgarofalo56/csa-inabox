'use client';

/**
 * IngestionMappingWizardDialog — the ADX / Fabric Eventhouse "Create ingestion
 * mapping" wizard with sample-file auto-detect.
 *
 * Fabric / ADX parity: the Real-Time Intelligence "Get data" flow and the ADX
 * web UI both let you author a named ingestion mapping by picking a source
 * format, uploading a sample file to auto-derive the schema, and editing the
 * source→column→datatype grid before saving. This component is the Loom-themed
 * one-for-one of that flow.
 *
 * Two steps:
 *   1. Identity   — mapping name, target table (dropdown of the DB's tables),
 *                   format (CSV/TSV/PSV/JSON/Parquet/Avro/ORC), optional sample
 *                   file. Uploading a CSV/TSV/PSV/JSON file auto-detects the
 *                   column grid client-side (no server round-trip).
 *   2. Column map — an editable grid: source (Ordinal for tabular formats /
 *                   JSONPath for JSON-ish / field name for Avro), target column,
 *                   and KQL datatype. Add / remove rows.
 *
 * Submit POSTs `{ name, kind, table, mapping }` to
 * `/api/adx/ingestion-mappings?id=<item>` which issues the real
 * `.create-or-alter table T ingestion <kind> mapping "NAME" '<json>'` control
 * command (no mocks; honest 503 infra-gate surfaced as a MessageBar). On
 * success the parent gets a ready-to-run KQL snippet that verifies the mapping
 * (`.show table T ingestion mappings`) and test-ingests a sample row with
 * `ingestionMappingReference`.
 *
 * Mapping wire format grounded in Microsoft Learn (kusto/management/mappings):
 *   - tabular (csv/tsv/psv)  → Properties: { Ordinal: <int> }, kind = csv
 *   - json / orc / parquet   → Properties: { Path: "$.field" }
 *   - avro                   → Properties: { Field: "fieldName" }
 * Each element: { Column, datatype?, Properties }.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Select, Caption1, Body1Strong, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, ArrowImport20Regular, ArrowUpload20Regular,
} from '@fluentui/react-icons';
import {
  type MappingFormat, type MappingRow, FORMAT_TO_KIND, BINARY, TABULAR,
  detectSchema, serializeMapping, buildSnippet,
} from './ingestion-mapping-format';

export type { MappingFormat, MappingRow } from './ingestion-mapping-format';
export { detectSchema, serializeMapping } from './ingestion-mapping-format';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 560 },
  row: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 180 },
  fileRow: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: 8, border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: 6,
  },
  gridCellInput: { minWidth: 120 },
  select: { minWidth: 110 },
  steps: { display: 'flex', gap: 6, alignItems: 'center' },
});

/** Display formats with friendly labels for the format selector. */
const FORMATS: Array<{ value: MappingFormat; label: string }> = [
  { value: 'csv', label: 'CSV (comma-separated)' },
  { value: 'tsv', label: 'TSV (tab-separated)' },
  { value: 'psv', label: 'PSV (pipe-separated)' },
  { value: 'json', label: 'JSON' },
  { value: 'parquet', label: 'Parquet' },
  { value: 'avro', label: 'Avro' },
  { value: 'orc', label: 'ORC' },
];

const DATATYPES = ['', 'string', 'long', 'int', 'real', 'decimal', 'datetime', 'timespan', 'bool', 'dynamic', 'guid'];

export interface IngestionMappingWizardProps {
  /** The bound kql-database item id → `?id=` so the route resolves the DB. */
  itemId: string;
  /** Tables in the database, used to populate the target-table dropdown. */
  tables: Array<{ name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after the mapping is created. `kqlSnippet` verifies the mapping and
   * test-ingests a sample row; callers typically inject it into the editor and
   * refresh the object navigator.
   */
  onCreated: (name: string, kind: string, table: string, kqlSnippet: string) => void;
}

// ---------------------------------------------------------------------------

export function IngestionMappingWizardDialog({
  itemId, tables, open, onOpenChange, onCreated,
}: IngestionMappingWizardProps) {
  const s = useStyles();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [table, setTable] = useState('');
  const [format, setFormat] = useState<MappingFormat>('csv');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setStep(1); setName(''); setTable(tables[0]?.name || ''); setFormat('csv');
    setFileName(''); setRows([]); setDetecting(false); setDetectMsg(null);
    setError(null); setGate(null); setSubmitting(false);
  }, [tables]);

  // Seed the target-table default when the dialog opens with a table list.
  useEffect(() => {
    if (open) setTable((t) => t || tables[0]?.name || '');
  }, [open, tables]);

  const close = useCallback((o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  }, [onOpenChange, reset]);

  const sourceLabel = TABULAR.includes(format)
    ? 'Ordinal'
    : format === 'avro' ? 'Field' : 'Path';
  const sourcePlaceholder = TABULAR.includes(format)
    ? '0'
    : format === 'avro' ? 'fieldName' : '$.field';

  const onFile = useCallback(async (file: File | null) => {
    setError(null); setDetectMsg(null);
    if (!file) { setFileName(''); return; }
    setFileName(file.name);
    if (BINARY.includes(format)) {
      setDetectMsg(`Auto-detect reads text formats (CSV/TSV/PSV/JSON). ${format.toUpperCase()} is binary — add the column map manually on the next step.`);
      return;
    }
    setDetecting(true);
    try {
      const detected = await detectSchema(file, format);
      if (detected.length === 0) {
        setDetectMsg('Could not detect any columns from the sample. Add rows manually on the next step.');
      } else {
        setRows(detected);
        setDetectMsg(`Detected ${detected.length} column${detected.length === 1 ? '' : 's'} from ${file.name}.`);
      }
    } catch (e: any) {
      setDetectMsg(`Auto-detect failed: ${e?.message || String(e)}. Add rows manually.`);
    } finally {
      setDetecting(false);
    }
  }, [format]);

  const next = useCallback(() => {
    setError(null);
    if (!name.trim()) { setError('Mapping name is required.'); return; }
    if (!/^[A-Za-z_]/.test(name.trim())) { setError('Mapping name must start with a letter or underscore.'); return; }
    if (!table) { setError('Pick a target table.'); return; }
    if (rows.length === 0) {
      setRows([{ source: TABULAR.includes(format) ? '0' : sourcePlaceholder, column: '', datatype: '' }]);
    }
    setStep(2);
  }, [name, table, rows.length, format, sourcePlaceholder]);

  const addRow = useCallback(() => {
    setRows((rs) => [
      ...rs,
      { source: TABULAR.includes(format) ? String(rs.length) : '', column: '', datatype: '' },
    ]);
  }, [format]);

  const updateRow = useCallback((i: number, patch: Partial<MappingRow>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = useCallback((i: number) => {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }, []);

  const submit = useCallback(async () => {
    setError(null); setGate(null);
    const valid = rows.filter((r) => r.column.trim());
    if (valid.length === 0) { setError('Add at least one column with a target column name.'); return; }
    const kind = FORMAT_TO_KIND[format];
    const mapping = serializeMapping(rows, format);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/adx/ingestion-mappings?id=${encodeURIComponent(itemId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), kind, table, mapping }),
      });
      const text = await res.text();
      let body: any = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: text }; }
      if (body?.code === 'not_configured' && body?.missing) { setGate(body.missing); setSubmitting(false); return; }
      if (!res.ok || !body.ok) { setError(body.error || `Create failed (HTTP ${res.status}).`); setSubmitting(false); return; }
      const snippet = buildSnippet(name.trim(), format, table, valid);
      onCreated(name.trim(), kind, table, snippet);
      reset();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }, [rows, format, itemId, name, table, onCreated, reset]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => close(d.open)}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <ArrowImport20Regular />
              New ingestion mapping
              <Badge size="small" appearance="tint" color="brand">Step {step} of 2</Badge>
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>ADX cluster not configured</MessageBarTitle>
                    Set <code>{gate}</code> so the Loom console can reach a real Azure Data Explorer /
                    Fabric Eventhouse cluster. The mapping is created with a real Kusto control command
                    once the cluster is reachable.
                  </MessageBarBody>
                </MessageBar>
              )}

              {step === 1 && (
                <>
                  <div className={s.row}>
                    <Field label="Mapping name" required className={s.field}>
                      <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="EventMapping" />
                    </Field>
                    <Field label="Target table" required className={s.field}>
                      <Dropdown
                        placeholder={tables.length ? 'Select a table' : 'No tables — create one first'}
                        value={table}
                        selectedOptions={table ? [table] : []}
                        onOptionSelect={(_, d) => setTable(d.optionValue || '')}
                        disabled={!tables.length}
                      >
                        {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>

                  <Field label="Source format">
                    <Select
                      className={s.select}
                      value={format}
                      onChange={(_, d) => { setFormat(d.value as MappingFormat); setRows([]); setFileName(''); setDetectMsg(null); }}
                    >
                      {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </Select>
                  </Field>

                  <div className={s.fileRow}>
                    <Caption1>
                      <ArrowUpload20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                      Auto-detect schema from a sample file (optional)
                    </Caption1>
                    <input
                      type="file"
                      accept=".csv,.tsv,.psv,.json,.jsonl,.txt,text/csv,application/json"
                      aria-label="Sample file for ingestion mapping auto-detect"
                      onChange={(e) => onFile(e.target.files?.[0] || null)}
                    />
                    {fileName && <Caption1>{fileName}</Caption1>}
                    {detecting && <Spinner size="tiny" label="Detecting schema…" />}
                    {detectMsg && (
                      <MessageBar intent={rows.length ? 'success' : 'info'}>
                        <MessageBarBody>{detectMsg}</MessageBarBody>
                      </MessageBar>
                    )}
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      For Parquet/Avro/ORC (binary) the schema can&apos;t be read in the browser — add the
                      column map manually on the next step.
                    </Caption1>
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <Body1Strong>
                    Column map — {format.toUpperCase()} → <code>{table}</code>
                  </Body1Strong>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {TABULAR.includes(format)
                      ? 'Source is the zero-based column Ordinal in the file; rows map in file order.'
                      : format === 'avro'
                        ? 'Source is the Avro field name.'
                        : 'Source is a JSONPath ($.field) into each record.'}
                  </Caption1>
                  <Table size="small" aria-label="Ingestion column map">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>{sourceLabel}</TableHeaderCell>
                        <TableHeaderCell>Target column</TableHeaderCell>
                        <TableHeaderCell>Datatype</TableHeaderCell>
                        <TableHeaderCell aria-label="Remove" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            <Input
                              className={s.gridCellInput}
                              size="small"
                              value={r.source}
                              placeholder={sourcePlaceholder}
                              aria-label={`Source for row ${i + 1}`}
                              onChange={(_, d) => updateRow(i, { source: d.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              className={s.gridCellInput}
                              size="small"
                              value={r.column}
                              placeholder="columnName"
                              aria-label={`Target column for row ${i + 1}`}
                              onChange={(_, d) => updateRow(i, { column: d.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              className={s.select}
                              value={r.datatype}
                              aria-label={`Datatype for row ${i + 1}`}
                              onChange={(_, d) => updateRow(i, { datatype: d.value })}
                            >
                              {DATATYPES.map((dt) => <option key={dt || 'auto'} value={dt}>{dt || '(auto)'}</option>)}
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Delete16Regular />}
                              aria-label={`Remove row ${i + 1}`}
                              onClick={() => removeRow(i)}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div>
                    <Button size="small" appearance="secondary" icon={<Add16Regular />} onClick={addRow}>
                      Add column
                    </Button>
                  </div>
                </>
              )}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Mapping error</MessageBarTitle>{error}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => close(false)} disabled={submitting}>Cancel</Button>
            {step === 2 && (
              <Button appearance="secondary" onClick={() => setStep(1)} disabled={submitting}>Back</Button>
            )}
            {step === 1 && (
              <Button appearance="primary" onClick={next} disabled={!tables.length}>Next</Button>
            )}
            {step === 2 && (
              <Button appearance="primary" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create mapping'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
