'use client';

/**
 * CopyJobWizard — the Loom one-for-one of Microsoft Fabric's "Copy job" guided
 * wizard (ui-parity.md). Fabric's Copy job walks the author through
 * Source → Destination → Copy mode (Full / Incremental / CDC) → Update method →
 * column Mapping → Review, then materialises a copy pipeline with the
 * appropriate change-tracking backend. Loom builds the SAME guided flow with
 * typed controls (no raw JSON, loom_no_freeform_config) and emits a structured
 * `CopyJobSpec` the BFF turns into a real ADF pipeline.
 *
 * Backend (no-vaporware / no-fabric-dependency): the spec is materialised into
 * an Azure Data Factory pipeline —
 *   • Full        → a single Copy activity.
 *   • Incremental → the 4-activity Lookup→Lookup→Copy→StoredProcedure
 *                   custom-watermark pattern (MAX(<col>) high-water mark).
 *   • CDC         → native SQL Server change tracking: each run reads net
 *                   inserts/updates/deletes via cdc.fn_cdc_get_net_changes_*
 *                   between the last processed LSN and the current max LSN, then
 *                   upserts. The last LSN lives in dbo.copy_watermark.
 * Both incremental backends use the same Azure SQL control table; no Microsoft
 * Fabric capacity/workspace is required.
 *
 * Grounded in:
 *   learn.microsoft.com/fabric/data-factory/cdc-copy-job
 *   learn.microsoft.com/fabric/data-factory/cdc-copy-job-azure-sql-database
 *   learn.microsoft.com/azure/data-factory/connector-sql-server#native-change-data-capture
 *   learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-portal
 */

import { useMemo, useState, useEffect } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Textarea, Text, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Checkmark16Filled } from '@fluentui/react-icons';
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

export type CopyMode = 'Full' | 'Incremental' | 'CDC';
export type WriteMode = 'Append' | 'Overwrite' | 'Merge';

export interface CopyJobSpec {
  source: { linkedService: string; type: string; sourceTable?: string; query?: string };
  sink: { linkedService: string; type: string; table?: string };
  mode: CopyMode;
  writeMode: WriteMode;
  /** Incremental only — the monotonically-increasing watermark column. */
  watermarkCol?: string;
  /** Incremental + CDC — logical source name; PK in dbo.copy_watermark. */
  sourceName?: string;
  /**
   * CDC only — the SQL Server capture instance to read net changes from
   * (cdc.fn_cdc_get_net_changes_<captureInstance>). Defaults to the default
   * capture instance name `<schema>_<table>` (per `sys.sp_cdc_enable_table`)
   * when blank.
   */
  cdcCaptureInstance?: string;
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

const MODES: { kind: CopyMode; title: string; desc: string }[] = [
  { kind: 'Full', title: 'Full copy', desc: 'Copy the entire source every run. Simplest — no watermark.' },
  { kind: 'Incremental', title: 'Incremental copy', desc: 'Copy only rows changed since the last run, tracked by a watermark column in a control table.' },
  { kind: 'CDC', title: 'Change data capture (CDC)', desc: 'Read native SQL change tracking (inserts, updates, deletes) since the last run — no watermark column needed. SQL-family sources only.' },
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
  cardLocked: { opacity: 0.5, cursor: 'not-allowed' },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'space-between' },
  cardTitle: { fontWeight: 600, fontSize: '13px' },
  cardDesc: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
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
  const [cdcCaptureInstance, setCdcCaptureInstance] = useState('');
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
    setCdcCaptureInstance(s.cdcCaptureInstance || '');
    setMergeKeys(s.mergeKeys || '');
    setMappingsText(JSON.stringify(s.mappings || [], null, 2));
  }, [open, initialSpec]);

  const isSqlSource = SQL_SOURCE_TYPES.has(srcType);

  // CDC applies net changes (inserts/updates/deletes) into the destination —
  // that is an upsert keyed by the table's PK, so CDC pins the write method to
  // Merge (matching Fabric's CDC SCD-Type-1 default).
  useEffect(() => {
    if (mode === 'CDC' && writeMode !== 'Merge') setWriteMode('Merge');
  }, [mode, writeMode]);

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
      ...(mode === 'CDC' ? { sourceName: (sourceName || srcTable) || undefined, cdcCaptureInstance: cdcCaptureInstance || undefined } : {}),
      ...(writeMode === 'Merge' ? { mergeKeys: mergeKeys || undefined } : {}),
      mappings,
    };
  }, [srcLs, srcType, srcTable, srcQuery, snkLs, snkType, snkTable, mode, writeMode, watermarkCol, sourceName, cdcCaptureInstance, mergeKeys, mappingsText]);

  const stepValid = useMemo(() => {
    switch (step) {
      case 0: return !!srcLs && !!srcType && (!isSqlSource || !!srcTable);
      case 1: return !!snkLs && !!snkType && !!snkTable;
      case 2:
        if (mode === 'Full') return true;
        if (mode === 'CDC') return isSqlSource && !!srcTable;
        return !!watermarkCol && (!!sourceName || !!srcTable);
      // CDC applies net inserts/updates/deletes by key — Merge is required and merge keys are mandatory.
      case 3: return (writeMode !== 'Merge' && mode !== 'CDC') || !!mergeKeys.trim();
      default: return true;
    }
  }, [step, srcLs, srcType, srcTable, isSqlSource, snkLs, snkType, snkTable, mode, watermarkCol, sourceName, writeMode, mergeKeys]);

  const canSave = !busy && !!srcLs && !!snkLs && !!snkTable
    && (mode === 'Full' || isSqlSource)
    && (mode !== 'Incremental' || !!watermarkCol)
    && (mode !== 'CDC' || (!!srcTable && writeMode === 'Merge' && !!mergeKeys.trim()))
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
                    {MODES.map((m) => (
                      <div key={m.kind} role="button" tabIndex={0} aria-pressed={mode === m.kind}
                        className={`${styles.card} ${mode === m.kind ? styles.cardActive : ''}`}
                        onClick={() => setMode(m.kind)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode(m.kind); } }}>
                        <span className={styles.cardTitle}>{m.title}</span>
                        <span className={styles.cardDesc}>{m.desc}</span>
                      </div>
                    ))}
                  </div>
                  {mode === 'Incremental' && (
                    <>
                      {!isSqlSource && (
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>SQL-family source required</MessageBarTitle>
                            Incremental copy reads the watermark with MAX(&lt;column&gt;) against the source
                            table, so it needs a SQL source. Pick a SQL source type on the Source step.
                          </MessageBarBody>
                        </MessageBar>
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
                  {mode === 'CDC' && (
                    <>
                      {!isSqlSource && (
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>SQL-family source required</MessageBarTitle>
                            CDC mode reads native SQL Server change tracking and is only supported for Azure SQL,
                            SQL Server, and SQL Managed Instance sources. Pick a SQL source type on the Source step.
                          </MessageBarBody>
                        </MessageBar>
                      )}
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        Each run reads net inserts, updates, and deletes from the source between the last processed
                        log-sequence number (LSN) and the current one, then upserts them into the destination. The source
                        database and table must have CDC enabled (sys.sp_cdc_enable_db / sys.sp_cdc_enable_table with
                        supports_net_changes=1).
                      </Text>
                      <div className={styles.grid2}>
                        <Field label="Capture instance (optional)"
                          hint="The CDC capture instance to read. Leave blank to use the default instance name (<schema>_<table>).">
                          <Input value={cdcCaptureInstance} onChange={(_, d) => setCdcCaptureInstance(d.value)}
                            placeholder={srcTable ? srcTable.replace('.', '_') : 'dbo_orders'} />
                        </Field>
                        <Field label="Source name (control-table key)"
                          hint="Identifies this job's LSN checkpoint row in dbo.copy_watermark. Defaults to the source table.">
                          <Input value={sourceName} onChange={(_, d) => setSourceName(d.value)} placeholder={srcTable || 'orders-feed'} />
                        </Field>
                      </div>
                    </>
                  )}
                </>
              )}

              {step === 3 && (
                <>
                  {mode === 'CDC' && (
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                      CDC applies the source's net inserts, updates, and deletes by key, so the update method is
                      fixed to <strong>Merge (upsert)</strong>. Provide the key column(s) used to match rows.
                    </Text>
                  )}
                  <div className={styles.cardRow}>
                    {WRITE_MODES.map((w) => {
                      const locked = mode === 'CDC' && w.kind !== 'Merge';
                      const pinned = mode === 'CDC' && w.kind === 'Merge';
                      return (
                        <div key={w.kind} role="button" tabIndex={locked ? -1 : 0}
                          aria-disabled={locked || undefined}
                          aria-pressed={writeMode === w.kind}
                          className={`${styles.card} ${writeMode === w.kind ? styles.cardActive : ''} ${locked ? styles.cardLocked : ''}`}
                          onClick={() => { if (!locked) setWriteMode(w.kind); }}
                          onKeyDown={(e) => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setWriteMode(w.kind); } }}>
                          <span className={styles.cardTitleRow}>
                            <span className={styles.cardTitle}>{w.title}</span>
                            {pinned && <Badge appearance="tint" color="success" size="small">Required for CDC</Badge>}
                          </span>
                          <span className={styles.cardDesc}>{w.desc}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
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
                    <SummaryRow k="Copy mode" v={mode === 'CDC' ? 'Change data capture (CDC)' : mode} />
                    {mode === 'Incremental' && <SummaryRow k="Watermark column" v={watermarkCol || '—'} />}
                    {mode === 'Incremental' && <SummaryRow k="Control-table key" v={sourceName || srcTable || '—'} />}
                    {mode === 'CDC' && <SummaryRow k="Capture instance" v={cdcCaptureInstance || `${(srcTable || '').replace('.', '_') || 'default'} (default)`} />}
                    {mode === 'CDC' && <SummaryRow k="LSN checkpoint key" v={sourceName || srcTable || '—'} />}
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
                    : mode === 'CDC'
                      ? 'CDC mode generates Lookup(last LSN) → Lookup(max LSN) → Copy(net changes via cdc.fn_cdc_get_net_changes_*) → StoredProcedure activities and persists the last processed LSN in dbo.copy_watermark.'
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
