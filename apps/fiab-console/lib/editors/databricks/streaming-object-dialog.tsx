'use client';

/**
 * StreamingObjectDialog + RefreshScheduleDialog — the typed builders for
 * Databricks streaming tables + materialized views in the SQL Warehouse editor
 * (Wave 10, DBX-7).
 *
 * `StreamingObjectDialog` authors a `CREATE OR REFRESH STREAMING TABLE` /
 * `CREATE OR REPLACE MATERIALIZED VIEW` from typed inputs (target picker, source
 * picker or query, inline expectations, refresh schedule) — NO freeform JSON
 * (loom_no_freeform_config); the only free-text is the SQL query / expectation
 * condition, which are allowed query/expression surfaces. It shows the compiled
 * DDL read-only, then EXECUTES it over the real Statement Execution API (the
 * editor's existing `/query` route) and surfaces the receipt.
 *
 * `RefreshScheduleDialog` runs a manual `REFRESH …` or an `ALTER … ADD/DROP
 * SCHEDULE …` against an existing streaming table / materialized view — the
 * refresh-scheduling control the PRP calls for (setting a schedule auto-creates
 * a backing Databricks job; streaming tables / MVs are DLT-backed).
 *
 * Backend: the bound Databricks SQL warehouse via the Statement Execution API.
 * No new BFF route (reuses `/query`), no bicep, no Microsoft Fabric.
 */

import { useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Textarea, Field, Dropdown, Option, Badge, Spinner, Caption1, Body1,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { safeModelJson } from '../model-fetch';
import {
  buildCreateStreamingTable, buildCreateMaterializedView,
  buildRefreshStatement, buildAlterSchedule, validateStreamingObject, validateSchedule,
  EVERY_UNITS,
  type StreamingObjectKind, type StreamingExpectation, type RefreshSchedule,
  type RefreshScheduleKind, type EveryUnit,
  type CreateStreamingTableSpec, type CreateMaterializedViewSpec,
} from './streaming-sql';
import { DLT_FILE_FORMATS, DLT_EXPECTATION_ACTIONS, type DltFileFormat, type DltExpectationAction } from './dlt-spec';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: '520px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  expRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end', flexWrap: 'wrap' },
  code: {
    fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '220px', overflow: 'auto',
  },
  problems: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

// ---------------------------------------------------------------------------
// Schedule sub-form (shared by create + refresh dialogs)
// ---------------------------------------------------------------------------

function ScheduleFields({ schedule, onChange }: { schedule: RefreshSchedule; onChange: (s: RefreshSchedule) => void }) {
  const s = useStyles();
  return (
    <>
      <Field label="Refresh schedule">
        <Dropdown
          selectedOptions={[schedule.kind]}
          value={schedule.kind === 'manual' ? 'Manual (on demand)' : schedule.kind === 'every' ? 'Every interval' : 'CRON'}
          onOptionSelect={(_, d) => onChange({ ...schedule, kind: (d.optionValue as RefreshScheduleKind) })}
        >
          <Option value="manual" text="Manual (on demand)">Manual (on demand)</Option>
          <Option value="every" text="Every interval">Every interval</Option>
          <Option value="cron" text="CRON">CRON (quartz)</Option>
        </Dropdown>
      </Field>
      {schedule.kind === 'every' && (
        <div className={s.row}>
          <Field label="Every">
            <Input type="number" value={String(schedule.everyNumber ?? 1)}
              onChange={(_, d) => onChange({ ...schedule, everyNumber: Math.max(1, Number(d.value) || 1) })} style={{ width: 90 }} />
          </Field>
          <Field label="Unit">
            <Dropdown selectedOptions={[schedule.everyUnit ?? 'HOUR']} value={schedule.everyUnit ?? 'HOUR'}
              onOptionSelect={(_, d) => onChange({ ...schedule, everyUnit: (d.optionValue as EveryUnit) })}>
              {EVERY_UNITS.map((u) => <Option key={u} value={u}>{u}</Option>)}
            </Dropdown>
          </Field>
        </div>
      )}
      {schedule.kind === 'cron' && (
        <div className={s.row}>
          <Field label="Quartz CRON (6 fields: sec min hour dom month dow)">
            <Input value={schedule.cron ?? ''} onChange={(_, d) => onChange({ ...schedule, cron: d.value })}
              placeholder="0 0 * * * ?" style={{ minWidth: 220 }} />
          </Field>
          <Field label="Timezone">
            <Input value={schedule.timezone ?? 'UTC'} onChange={(_, d) => onChange({ ...schedule, timezone: d.value })} style={{ width: 120 }} />
          </Field>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Expectations sub-form
// ---------------------------------------------------------------------------

function ExpectationsFields({ expectations, onChange }: {
  expectations: StreamingExpectation[];
  onChange: (x: StreamingExpectation[]) => void;
}) {
  const s = useStyles();
  return (
    <Field label="Expectations (data-quality constraints)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
        {expectations.map((x, i) => (
          <div key={i} className={s.expRow}>
            <Input placeholder="name" value={x.name} aria-label={`Expectation ${i + 1} name`}
              onChange={(_, d) => onChange(expectations.map((e, j) => j === i ? { ...e, name: d.value } : e))} style={{ width: 130 }} />
            <Input placeholder="condition (e.g. id IS NOT NULL)" value={x.condition} aria-label={`Expectation ${i + 1} condition`}
              onChange={(_, d) => onChange(expectations.map((e, j) => j === i ? { ...e, condition: d.value } : e))} style={{ minWidth: 200 }} />
            <Dropdown selectedOptions={[x.action]} value={x.action} aria-label={`Expectation ${i + 1} action`}
              onOptionSelect={(_, d) => onChange(expectations.map((e, j) => j === i ? { ...e, action: (d.optionValue as DltExpectationAction) } : e))}
              style={{ minWidth: 90 }}>
              {DLT_EXPECTATION_ACTIONS.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Dropdown>
            <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove expectation ${i + 1}`}
              onClick={() => onChange(expectations.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div>
          <Button size="small" icon={<Add20Regular />}
            onClick={() => onChange([...expectations, { name: '', condition: '', action: 'warn' }])}>
            Add expectation
          </Button>
        </div>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

async function runStatement(itemId: string, warehouseId: string, sql: string, catalog?: string, schema?: string) {
  const r = await clientFetch(`/api/items/databricks-sql-warehouse/${itemId}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, warehouseId, catalog, schema }),
  });
  return safeModelJson(r);
}

export function StreamingObjectDialog({
  open, onOpenChange, kind, itemId, warehouseId, defaultCatalog, defaultSchema, onCreated, onInsertSql,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: StreamingObjectKind;
  itemId: string;
  warehouseId: string;
  defaultCatalog?: string;
  defaultSchema?: string;
  onCreated?: () => void;
  /** Optional: drop the generated DDL into the editor instead of only executing. */
  onInsertSql?: (sql: string) => void;
}) {
  const s = useStyles();
  const isST = kind === 'streaming_table';
  const [catalog, setCatalog] = useState(defaultCatalog ?? '');
  const [schema, setSchema] = useState(defaultSchema ?? '');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [sourceKind, setSourceKind] = useState<'files' | 'table'>('files');
  const [path, setPath] = useState('');
  const [fileFormat, setFileFormat] = useState<DltFileFormat>('json');
  const [tableName, setTableName] = useState('');
  const [query, setQuery] = useState('');
  const [expectations, setExpectations] = useState<StreamingExpectation[]>([]);
  const [schedule, setSchedule] = useState<RefreshSchedule>({ kind: 'manual' });
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | null>(null);

  const spec: CreateStreamingTableSpec | CreateMaterializedViewSpec = useMemo(() => {
    const target = { catalog: catalog || undefined, schema: schema || undefined, name };
    if (isST) {
      return {
        target,
        source: { kind: sourceKind, path, fileFormat, tableName },
        query: query || undefined,
        comment: comment || undefined,
        expectations,
        schedule,
      } as CreateStreamingTableSpec;
    }
    return {
      target,
      query,
      comment: comment || undefined,
      expectations,
      schedule,
    } as CreateMaterializedViewSpec;
  }, [isST, catalog, schema, name, sourceKind, path, fileFormat, tableName, query, comment, expectations, schedule]);

  const ddl = useMemo(() => {
    try {
      return isST
        ? buildCreateStreamingTable(spec as CreateStreamingTableSpec)
        : buildCreateMaterializedView(spec as CreateMaterializedViewSpec);
    } catch {
      return '-- fix the fields to compile';
    }
  }, [isST, spec]);

  const problems = useMemo(() => validateStreamingObject(kind, spec), [kind, spec]);

  const create = async () => {
    if (problems.length) return;
    setBusy(true);
    setReceipt(null);
    try {
      const j = await runStatement(itemId, warehouseId, ddl, catalog || undefined, schema || undefined);
      if (j.ok) {
        const rc = (j.data as any)?.rowCount ?? 0;
        const ms = (j.data as any)?.executionMs ?? 0;
        setReceipt({ ok: true, text: `Created. Statement succeeded in ${ms} ms (${rc} rows). A serverless Lakeflow pipeline now backs this object.` });
        onCreated?.();
      } else {
        setReceipt({ ok: false, text: j.error || 'Statement failed.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New {isST ? 'streaming table' : 'materialized view'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <div className={s.row}>
                <Field label="Catalog"><Input value={catalog} onChange={(_, d) => setCatalog(d.value)} placeholder="main" style={{ width: 140 }} /></Field>
                <Field label="Schema"><Input value={schema} onChange={(_, d) => setSchema(d.value)} placeholder="bronze" style={{ width: 140 }} /></Field>
                <Field label="Name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder={isST ? 'events_raw' : 'daily_metrics'} style={{ width: 180 }} /></Field>
              </div>

              {isST && (
                <>
                  <Field label="Source">
                    <Dropdown selectedOptions={[sourceKind]} value={sourceKind === 'files' ? 'Auto Loader files' : 'Table stream'}
                      onOptionSelect={(_, d) => setSourceKind(d.optionValue as 'files' | 'table')}>
                      <Option value="files" text="Auto Loader files">Auto Loader files (read_files)</Option>
                      <Option value="table" text="Table stream">Unity Catalog table stream</Option>
                    </Dropdown>
                  </Field>
                  {sourceKind === 'files' ? (
                    <div className={s.row}>
                      <Field label="Path"><Input value={path} onChange={(_, d) => setPath(d.value)} placeholder="abfss://raw@acct.dfs.core.windows.net/events/" style={{ minWidth: 320 }} /></Field>
                      <Field label="Format">
                        <Dropdown selectedOptions={[fileFormat]} value={fileFormat} onOptionSelect={(_, d) => setFileFormat(d.optionValue as DltFileFormat)}>
                          {DLT_FILE_FORMATS.map((f) => <Option key={f} value={f}>{f}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                  ) : (
                    <Field label="Source table (catalog.schema.table)"><Input value={tableName} onChange={(_, d) => setTableName(d.value)} placeholder="main.raw.events" /></Field>
                  )}
                </>
              )}

              <Field label={isST ? 'Query (optional — leave blank to SELECT * from the source)' : 'Query (required)'} required={!isST}>
                <Textarea value={query} onChange={(_, d) => setQuery(d.value)} resize="vertical" rows={isST ? 2 : 4}
                  aria-label={`${isST ? 'streaming table' : 'materialized view'} SELECT query`}
                  placeholder={isST ? 'SELECT * FROM STREAM read_files(...)' : 'SELECT date, count(*) AS n FROM main.bronze.events GROUP BY date'} />
              </Field>

              <Field label="Comment (optional)"><Input value={comment} onChange={(_, d) => setComment(d.value)} /></Field>

              <ExpectationsFields expectations={expectations} onChange={setExpectations} />
              <ScheduleFields schedule={schedule} onChange={setSchedule} />

              <Caption1>Generated SQL (executed over the Statement Execution API):</Caption1>
              <pre className={s.code} aria-label="Generated DDL definition">{ddl}</pre>

              {problems.length > 0 && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <div className={s.problems}>{problems.map((p, i) => <Caption1 key={i}>• {p}</Caption1>)}</div>
                  </MessageBarBody>
                </MessageBar>
              )}
              {receipt && (
                <MessageBar intent={receipt.ok ? 'success' : 'error'}>
                  <MessageBarBody>{receipt.text}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {onInsertSql && (
              <Button appearance="secondary" onClick={() => { onInsertSql(ddl); onOpenChange(false); }} disabled={problems.length > 0}>
                Insert into editor
              </Button>
            )}
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button appearance="primary" onClick={create} disabled={busy || problems.length > 0} icon={busy ? <Spinner size="tiny" /> : undefined}>
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Refresh / schedule dialog for an existing object
// ---------------------------------------------------------------------------

export function RefreshScheduleDialog({
  open, onOpenChange, kind, fullName, itemId, warehouseId, onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: StreamingObjectKind;
  fullName: string;  // catalog.schema.name
  itemId: string;
  warehouseId: string;
  onDone?: () => void;
}) {
  const s = useStyles();
  const [schedule, setSchedule] = useState<RefreshSchedule>({ kind: 'manual' });
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'schedule' | null>(null);
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | null>(null);

  const refreshSql = useMemo(() => buildRefreshStatement(kind, fullName, full), [kind, fullName, full]);
  const scheduleSql = useMemo(() => buildAlterSchedule(kind, fullName, schedule), [kind, fullName, schedule]);
  const scheduleProblems = useMemo(() => validateSchedule(schedule), [schedule]);

  const run = async (which: 'refresh' | 'schedule') => {
    setBusy(which);
    setReceipt(null);
    try {
      const sql = which === 'refresh' ? refreshSql : scheduleSql;
      const j = await runStatement(itemId, warehouseId, sql);
      if (j.ok) {
        const ms = (j.data as any)?.executionMs ?? 0;
        setReceipt({
          ok: true,
          text: which === 'refresh'
            ? `Refresh triggered (${ms} ms) — the backing Lakeflow pipeline update is running.`
            : `Schedule ${schedule.kind === 'manual' ? 'removed' : 'set'} (${ms} ms). A backing Databricks job now drives refreshes.`,
        });
        onDone?.();
      } else {
        setReceipt({ ok: false, text: j.error || 'Statement failed.' });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Refresh / schedule</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Body1><Badge appearance="tint" color="brand">{kind === 'streaming_table' ? 'Streaming table' : 'Materialized view'}</Badge> {fullName}</Body1>

              <Field label="Manual refresh">
                <Dropdown selectedOptions={[full ? 'full' : 'incremental']} value={full ? 'Full refresh' : 'Incremental'}
                  onOptionSelect={(_, d) => setFull(d.optionValue === 'full')}>
                  <Option value="incremental" text="Incremental">Incremental</Option>
                  <Option value="full" text="Full refresh">Full refresh (recompute)</Option>
                </Dropdown>
              </Field>
              <pre className={s.code} aria-label="Refresh statement">{refreshSql}</pre>

              <ScheduleFields schedule={schedule} onChange={setSchedule} />
              <Caption1>Schedule statement:</Caption1>
              <pre className={s.code} aria-label="Schedule statement">{scheduleSql}</pre>
              {scheduleProblems.length > 0 && (
                <MessageBar intent="warning"><MessageBarBody>{scheduleProblems.join(' ')}</MessageBarBody></MessageBar>
              )}
              {receipt && (
                <MessageBar intent={receipt.ok ? 'success' : 'error'}><MessageBarBody>{receipt.text}</MessageBarBody></MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button appearance="secondary" onClick={() => run('schedule')} disabled={busy !== null || scheduleProblems.length > 0}
              icon={busy === 'schedule' ? <Spinner size="tiny" /> : undefined}>
              Apply schedule
            </Button>
            <Button appearance="primary" onClick={() => run('refresh')} disabled={busy !== null}
              icon={busy === 'refresh' ? <Spinner size="tiny" /> : undefined}>
              Refresh now
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
