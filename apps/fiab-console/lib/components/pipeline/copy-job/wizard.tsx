'use client';

/**
 * CopyJobWizard — the Loom one-for-one of Microsoft Fabric's "Copy job" guided
 * wizard (ui-parity.md). Fabric's Copy job walks the author through
 * Source → Destination → Copy mode (Full / Incremental) → Update method →
 * column Mapping → Review, then materialises an incremental-copy pipeline with
 * a control-table watermark. Loom builds the SAME guided flow with typed
 * controls (no raw JSON, loom_no_freeform_config) and emits a structured
 * `CopyJobSpec` the BFF turns into a real ADF pipeline.
 *
 * Backend (no-vaporware / no-fabric-dependency): the spec is materialised into
 * an Azure Data Factory pipeline — a single Copy activity for Full mode, or the
 * canonical 4-activity Lookup→Lookup→Copy→StoredProcedure incremental pattern
 * for Incremental mode. The watermark lives in dbo.copy_watermark in Azure SQL.
 * No Microsoft Fabric capacity/workspace is required.
 *
 * Grounded in:
 *   learn.microsoft.com/fabric/data-factory/what-is-copy-job
 *   learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-portal
 */

import { useMemo, useState, useEffect } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Textarea, Text, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Checkmark16Filled, Info16Regular } from '@fluentui/react-icons';
import { KeyValueGrid } from '@/lib/components/ui/key-value-grid';

// SQL-family sources/sinks the wizard supports. Incremental mode requires a
// queryable SQL source (the watermark lookup runs MAX(<col>) against it).
export const COPY_SOURCE_TYPES = [
  'AzureSqlSource', 'SqlServerSource', 'SqlMISource', 'AzureSqlDWSource',
  'AzureBlobSource', 'DelimitedTextSource', 'ParquetSource', 'JsonSource', 'AzureTableSource',
];
export const COPY_SINK_TYPES = [
  'AzureSqlSink', 'SqlServerSink', 'SqlMISink', 'AzureSqlDWSink',
  'AzureBlobSink', 'DelimitedTextSink', 'ParquetSink', 'JsonSink', 'AzureTableSink',
];
const SQL_SOURCE_TYPES = new Set(['AzureSqlSource', 'SqlServerSource', 'SqlMISource', 'AzureSqlDWSource']);

export type CopyMode = 'Full' | 'Incremental' | 'ChangeTracking';
export type WriteMode = 'Append' | 'Overwrite' | 'Merge';

export interface CopyJobSpec {
  source: { linkedService: string; type: string; sourceTable?: string; query?: string };
  sink: { linkedService: string; type: string; table?: string };
  mode: CopyMode;
  writeMode: WriteMode;
  /** Incremental only — the monotonically-increasing watermark column. */
  watermarkCol?: string;
  /** Incremental / ChangeTracking — logical source name; PK in dbo.copy_watermark. */
  sourceName?: string;
  /**
   * ChangeTracking (native CDC) only — comma-separated primary-key column(s)
   * the CHANGETABLE(CHANGES …) join uses to resolve changed rows back to the
   * source table. Required because native change tracking returns only PKs.
   */
  keyColumns?: string;
  /** Merge only — comma-separated key columns for upsert. */
  mergeKeys?: string;
  mappings: Array<{ source: string; sink: string }>;
}

export interface LinkedServiceLite {
  name: string;
  properties?: { type?: string; description?: string };
}

export interface CopyJobWizardProps {
  open: boolean;
  onClose: () => void;
  linkedServices: LinkedServiceLite[];
  initialSpec?: Partial<CopyJobSpec>;
  onSave: (spec: CopyJobSpec) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

const STEPS = ['Source', 'Destination', 'Mode', 'Update', 'Mapping', 'Review'] as const;

const MODES: { kind: CopyMode; title: string; desc: string; sqlOnly?: boolean }[] = [
  { kind: 'Full', title: 'Full copy', desc: 'Copy the entire source every run. Simplest — no watermark.' },
  { kind: 'Incremental', title: 'Incremental copy', desc: 'Copy only rows changed since the last run, tracked by a watermark column in a control table.' },
  { kind: 'ChangeTracking', title: 'Native CDC (change tracking)', desc: 'Copy inserts/updates/deletes using SQL Server / Azure SQL native change tracking — no watermark column needed; the database tracks the delta.', sqlOnly: true },
];

const WRITE_MODES: { kind: WriteMode; title: string; desc: string }[] = [
  { kind: 'Append', title: 'Append', desc: 'Insert source rows into the destination. Existing rows are kept.' },
  { kind: 'Overwrite', title: 'Overwrite', desc: 'Truncate the destination table first, then copy. Replaces all rows.' },
  { kind: 'Merge', title: 'Merge (upsert)', desc: 'Update matching rows by key column(s); insert the rest.' },
];

const useStyles = makeStyles({
  stepper: { display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' },
  step: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '14px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, fontSize: '12px',
    color: tokens.colorNeutralForeground3, backgroundColor: tokens.colorNeutralBackground1,
  },
  stepActive: {
    border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1, fontWeight: 600,
  },
  stepDone: { color: tokens.colorNeutralForeground2, borderColor: tokens.colorBrandStroke2 },
  stepIndex: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '18px', height: '18px', borderRadius: '50%', fontSize: '11px',
    backgroundColor: tokens.colorNeutralBackground4, color: tokens.colorNeutralForeground2,
  },
  cardRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' },
  card: {
    flex: '1 1 200px', minWidth: '190px', padding: '12px', borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: '4px',
  },
  cardActive: { border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  cardDisabled: { opacity: 0.6, cursor: 'not-allowed', backgroundColor: tokens.colorNeutralBackgroundDisabled },
  cardTitle: { fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' },
  cardDesc: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  cardHint: {
    fontSize: '11px', marginTop: '2px', display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorPaletteDarkOrangeForeground1,
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  body: { display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '54vh', overflowY: 'auto', paddingRight: '4px' },
  summaryLabel: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
});

export function CopyJobWizard({
  open, onClose, linkedServices, initialSpec, onSave, busy, error,
}: CopyJobWizardProps) {
  const styles = useStyles();
  const [step, setStep] = useState(0);

  const [srcLs, setSrcLs] = useState('');
  const [srcType, setSrcType] = useState('AzureSqlSource');
  const [srcTable, setSrcTable] = useState('');
  const [srcQuery, setSrcQuery] = useState('');
  const [snkLs, setSnkLs] = useState('');
  const [snkType, setSnkType] = useState('AzureSqlSink');
  const [snkTable, setSnkTable] = useState('');
  const [mode, setMode] = useState<CopyMode>('Full');
  const [writeMode, setWriteMode] = useState<WriteMode>('Append');
  const [watermarkCol, setWatermarkCol] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [keyColumns, setKeyColumns] = useState('');
  const [mergeKeys, setMergeKeys] = useState('');
  const [mappingsText, setMappingsText] = useState('[]');

  // Seed from the persisted spec whenever the wizard opens.
  useEffect(() => {
    if (!open) return;
    const s = initialSpec || {};
    setStep(0);
    setSrcLs(s.source?.linkedService || '');
    setSrcType(s.source?.type || 'AzureSqlSource');
    setSrcTable(s.source?.sourceTable || '');
    setSrcQuery(s.source?.query || '');
    setSnkLs(s.sink?.linkedService || '');
    setSnkType(s.sink?.type || 'AzureSqlSink');
    setSnkTable(s.sink?.table || '');
    setMode(s.mode || 'Full');
    setWriteMode(s.writeMode || 'Append');
    setWatermarkCol(s.watermarkCol || '');
    setSourceName(s.sourceName || '');
    setKeyColumns(s.keyColumns || '');
    setMergeKeys(s.mergeKeys || '');
    setMappingsText(JSON.stringify(s.mappings || [], null, 2));
  }, [open, initialSpec]);

  const isSqlSource = SQL_SOURCE_TYPES.has(srcType);

  const spec = useMemo<CopyJobSpec>(() => {
    let mappings: Array<{ source: string; sink: string }> = [];
    try {
      const parsed = JSON.parse(mappingsText || '[]');
      if (Array.isArray(parsed)) mappings = parsed;
    } catch { /* keep empty */ }
    return {
      source: { linkedService: srcLs, type: srcType, sourceTable: srcTable || undefined, query: srcQuery || undefined },
      sink: { linkedService: snkLs, type: snkType, table: snkTable || undefined },
      mode,
      writeMode,
      ...(mode === 'Incremental' ? { watermarkCol: watermarkCol || undefined, sourceName: (sourceName || srcTable) || undefined } : {}),
      ...(mode === 'ChangeTracking' ? { keyColumns: keyColumns || undefined, sourceName: (sourceName || srcTable) || undefined } : {}),
      ...(writeMode === 'Merge' ? { mergeKeys: mergeKeys || undefined } : {}),
      mappings,
    };
  }, [srcLs, srcType, srcTable, srcQuery, snkLs, snkType, snkTable, mode, writeMode, watermarkCol, sourceName, keyColumns, mergeKeys, mappingsText]);

  const stepValid = useMemo(() => {
    switch (step) {
      case 0: return !!srcLs && !!srcType && (!isSqlSource || !!srcTable);
      case 1: return !!snkLs && !!snkType && !!snkTable;
      case 2:
        if (mode === 'Full') return true;
        if (mode === 'ChangeTracking') return isSqlSource && !!srcTable && !!keyColumns.trim();
        return !!watermarkCol && (!!sourceName || !!srcTable);
      case 3: return writeMode !== 'Merge' || !!mergeKeys.trim();
      default: return true;
    }
  }, [step, srcLs, srcType, srcTable, isSqlSource, snkLs, snkType, snkTable, mode, watermarkCol, sourceName, keyColumns, writeMode, mergeKeys]);

  const canSave = !busy && !!srcLs && !!snkLs && !!snkTable
    && (mode === 'Full'
      || (mode === 'Incremental' && !!watermarkCol && isSqlSource)
      || (mode === 'ChangeTracking' && isSqlSource && !!srcTable && !!keyColumns.trim()))
    && (writeMode !== 'Merge' || !!mergeKeys.trim());

  const lsOptions = (l: LinkedServiceLite) => (l.properties?.type ? `${l.name} (${l.properties.type})` : l.name);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 680 }}>
        <DialogBody>
          <DialogTitle>Copy job</DialogTitle>
          <DialogContent>
            <div className={styles.stepper}>
              {STEPS.map((label, i) => (
                <span key={label}
                  className={`${styles.step} ${i === step ? styles.stepActive : ''} ${i < step ? styles.stepDone : ''}`}>
                  <span className={styles.stepIndex}>
                    {i < step ? <Checkmark16Filled /> : i + 1}
                  </span>
                  {label}
                </span>
              ))}
            </div>

            <div className={styles.body}>
              {step === 0 && (
                <>
                  <Field label="Source linked service" required
                    hint="An ADF Linked Service the factory can read from. Create one in the Data Factory portal (Manage → Linked services).">
                    <Dropdown value={srcLs} selectedOptions={srcLs ? [srcLs] : []}
                      placeholder={linkedServices.length ? 'Select a Linked Service' : 'No Linked Services available'}
                      disabled={linkedServices.length === 0}
                      onOptionSelect={(_, d) => setSrcLs(d.optionValue || '')}>
                      {linkedServices.map((l) => <Option key={l.name} value={l.name}>{lsOptions(l)}</Option>)}
                    </Dropdown>
                  </Field>
                  <div className={styles.grid2}>
                    <Field label="Source type">
                      <Dropdown value={srcType} selectedOptions={[srcType]}
                        onOptionSelect={(_, d) => d.optionValue && setSrcType(d.optionValue)}>
                        {COPY_SOURCE_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Source table" required={isSqlSource}
                      hint={isSqlSource ? 'Schema-qualified, e.g. dbo.orders' : 'Optional for file sources'}>
                      <Input value={srcTable} onChange={(_, d) => setSrcTable(d.value)} placeholder="dbo.orders" />
                    </Field>
                  </div>
                  <Field label="Source query (optional override)"
                    hint="Leave blank to copy the whole table. Ignored in Incremental mode (a watermark-bounded query is generated).">
                    <Textarea value={srcQuery} onChange={(_, d) => setSrcQuery(d.value)} rows={2}
                      placeholder="SELECT id, name, amount FROM dbo.orders" />
                  </Field>
                </>
              )}

              {step === 1 && (
                <>
                  <Field label="Destination linked service" required>
                    <Dropdown value={snkLs} selectedOptions={snkLs ? [snkLs] : []}
                      placeholder={linkedServices.length ? 'Select a Linked Service' : 'No Linked Services available'}
                      disabled={linkedServices.length === 0}
                      onOptionSelect={(_, d) => setSnkLs(d.optionValue || '')}>
                      {linkedServices.map((l) => <Option key={l.name} value={l.name}>{lsOptions(l)}</Option>)}
                    </Dropdown>
                  </Field>
                  <div className={styles.grid2}>
                    <Field label="Destination type">
                      <Dropdown value={snkType} selectedOptions={[snkType]}
                        onOptionSelect={(_, d) => d.optionValue && setSnkType(d.optionValue)}>
                        {COPY_SINK_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Destination table / path" required
                      hint="Schema-qualified table (SQL sinks) or folder path (file sinks).">
                      <Input value={snkTable} onChange={(_, d) => setSnkTable(d.value)} placeholder="bronze.orders" />
                    </Field>
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <div className={styles.cardRow}>
                    {MODES.map((m) => {
                      const disabled = !!m.sqlOnly && !isSqlSource;
                      const selected = mode === m.kind;
                      return (
                        <div key={m.kind} role="button" tabIndex={disabled ? -1 : 0}
                          aria-disabled={disabled} aria-pressed={selected}
                          title={disabled ? 'Requires a SQL-family source — pick one on the Source step.' : undefined}
                          className={`${styles.card} ${selected ? styles.cardActive : ''} ${disabled ? styles.cardDisabled : ''}`}
                          onClick={() => { if (!disabled) setMode(m.kind); }}
                          onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode(m.kind); } }}>
                          <span className={styles.cardTitle}>
                            {m.title}
                            {m.sqlOnly && <Badge appearance="outline" size="small" color="informative">SQL</Badge>}
                          </span>
                          <span className={styles.cardDesc}>{m.desc}</span>
                          {disabled && (
                            <span className={styles.cardHint}>
                              <Info16Regular />
                              Requires a SQL-family source — pick one on the Source step.
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {mode === 'Incremental' && (
                    <>
                      {!isSqlSource && (
                        <Text size={200} style={{ color: tokens.colorPaletteDarkOrangeForeground1 }}>
                          Incremental copy requires a SQL-family source (the watermark is read with
                          MAX(&lt;column&gt;) against the source table). Pick a SQL source type on the Source step.
                        </Text>
                      )}
                      <div className={styles.grid2}>
                        <Field label="Watermark column" required
                          hint="A monotonically-increasing column (datetime or identity) tracked across runs.">
                          <Input value={watermarkCol} onChange={(_, d) => setWatermarkCol(d.value)} placeholder="updated_at" />
                        </Field>
                        <Field label="Source name (control-table key)"
                          hint="Identifies this job's watermark row in dbo.copy_watermark. Defaults to the source table.">
                          <Input value={sourceName} onChange={(_, d) => setSourceName(d.value)} placeholder={srcTable || 'orders-feed'} />
                        </Field>
                      </div>
                    </>
                  )}
                  {mode === 'ChangeTracking' && (
                    <>
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        Native change tracking must be enabled on the source database and table
                        (<code>ALTER DATABASE … SET CHANGE_TRACKING = ON</code> and{' '}
                        <code>ALTER TABLE {srcTable || '<table>'} ENABLE CHANGE_TRACKING</code>). The job
                        stores the last <code>SYS_CHANGE_VERSION</code> in <code>dbo.copy_watermark</code> and
                        each run reads only rows changed since, via <code>CHANGETABLE(CHANGES …)</code>.
                      </Text>
                      <div className={styles.grid2}>
                        <Field label="Primary key column(s)" required
                          hint="Comma-separated PK column(s) used to join CHANGETABLE(CHANGES …) back to the source table (e.g. id or org_id,sku).">
                          <Input value={keyColumns} onChange={(_, d) => setKeyColumns(d.value)} placeholder="id" />
                        </Field>
                        <Field label="Source name (control-table key)"
                          hint="Identifies this job's change-version row in dbo.copy_watermark. Defaults to the source table.">
                          <Input value={sourceName} onChange={(_, d) => setSourceName(d.value)} placeholder={srcTable || 'orders-feed'} />
                        </Field>
                      </div>
                    </>
                  )}
                </>
              )}

              {step === 3 && (
                <div className={styles.cardRow}>
                  {WRITE_MODES.map((w) => (
                    <div key={w.kind} role="button" tabIndex={0}
                      className={`${styles.card} ${writeMode === w.kind ? styles.cardActive : ''}`}
                      onClick={() => setWriteMode(w.kind)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setWriteMode(w.kind); }}>
                      <span className={styles.cardTitle}>{w.title}</span>
                      <span className={styles.cardDesc}>{w.desc}</span>
                    </div>
                  ))}
                </div>
              )}
              {step === 3 && writeMode === 'Merge' && (
                <Field label="Merge key column(s)" required
                  hint="Comma-separated key column(s) used to match rows for upsert (e.g. id or org_id,sku).">
                  <Input value={mergeKeys} onChange={(_, d) => setMergeKeys(d.value)} placeholder="id" />
                </Field>
              )}

              {step === 4 && (
                <>
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                    Map each source column to its destination column. Leave empty to copy all columns by name.
                  </Text>
                  <KeyValueGrid value={mappingsText} onChange={setMappingsText}
                    keyLabel="Source column" valueLabel="Destination column"
                    keyPlaceholder="OrderId" valuePlaceholder="order_id" addLabel="Add mapping"
                    arrayMode={{ keyField: 'source', valueField: 'sink' }} />
                </>
              )}

              {step === 5 && (
                <Table size="small" aria-label="Copy job summary">
                  <TableHeader>
                    <TableRow><TableHeaderCell>Setting</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow>
                  </TableHeader>
                  <TableBody>
                    <SummaryRow k="Source" v={`${srcLs || '—'} · ${srcType}${srcTable ? ` · ${srcTable}` : ''}`} />
                    <SummaryRow k="Destination" v={`${snkLs || '—'} · ${snkType} · ${snkTable || '—'}`} />
                    <SummaryRow k="Copy mode" v={mode === 'ChangeTracking' ? 'Native CDC (change tracking)' : mode} />
                    {mode === 'Incremental' && <SummaryRow k="Watermark column" v={watermarkCol || '—'} />}
                    {mode === 'ChangeTracking' && <SummaryRow k="Primary key column(s)" v={keyColumns || '—'} />}
                    {(mode === 'Incremental' || mode === 'ChangeTracking') && <SummaryRow k="Control-table key" v={sourceName || srcTable || '—'} />}
                    <SummaryRow k="Update method" v={writeMode} />
                    {writeMode === 'Merge' && <SummaryRow k="Merge keys" v={mergeKeys || '—'} />}
                    <SummaryRow k="Column mappings" v={`${spec.mappings.length} mapped${spec.mappings.length === 0 ? ' (all by name)' : ''}`} />
                  </TableBody>
                </Table>
              )}

              {error && <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
              {step === 5 && (
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                  <Badge appearance="tint" color="informative">ADF pipeline</Badge>{' '}
                  Saving materialises an Azure Data Factory pipeline. {mode === 'Incremental'
                    ? 'Incremental mode generates Lookup → Lookup → Copy → StoredProcedure activities and persists the watermark in dbo.copy_watermark.'
                    : mode === 'ChangeTracking'
                      ? 'Native CDC mode generates Lookup → Lookup → Copy (CHANGETABLE join) → StoredProcedure activities and persists the SYS_CHANGE_VERSION in dbo.copy_watermark.'
                      : 'Full mode generates a single Copy activity.'}
                </Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            {step > 0 && <Button appearance="secondary" onClick={() => setStep((s) => s - 1)} disabled={busy}>Back</Button>}
            {step < STEPS.length - 1
              ? <Button appearance="primary" disabled={!stepValid} onClick={() => setStep((s) => s + 1)}>Next</Button>
              : <Button appearance="primary" disabled={!canSave} onClick={() => onSave(spec)}>{busy ? 'Saving…' : 'Save & apply'}</Button>}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  const styles = useStyles();
  return (
    <TableRow>
      <TableCell className={styles.summaryLabel}>{k}</TableCell>
      <TableCell>{v}</TableCell>
    </TableRow>
  );
}
