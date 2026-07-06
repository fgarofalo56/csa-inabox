'use client';

/**
 * WarehouseTimeTravelTab — Fabric-Warehouse data-recovery parity surface for the
 * Warehouse editor (rel-T82). Five real, Azure-native capabilities, each wired
 * to a live backend (no mocks, no Fabric dependency):
 *
 *   Clone          → CTAS-as-clone on the Synapse Dedicated SQL pool (default)
 *                    or a zero-copy Delta SHALLOW CLONE on Databricks.
 *   Time travel    → VERSION AS OF / TIMESTAMP AS OF read over Delta (Databricks).
 *   Restore points → DISCRETE/CONTINUOUS restore points via the Synapse ARM API.
 *   COPY INTO      → visual wizard building a real COPY INTO on the pool.
 *   Snapshots      → Delta version/checkpoint listing + zero-copy snapshot.
 *
 * Fluent v9 + Loom tokens; honest infra-gate MessageBars name the exact env var
 * / role when a backend is not configured, and the full surface still renders.
 */

import { useCallback, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Card, Caption1, Subtitle2, Body1, Badge, Button, Input, Field, Spinner,
  Tab, TabList, Dropdown, Option, Radio, RadioGroup,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Copy20Regular, History20Regular, ArrowClockwise20Regular,
  CloudArrowUp20Regular, Camera20Regular, Play16Regular, Add16Regular, Delete16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

const CONTAINERS = ['bronze', 'silver', 'gold', 'landing', 'csv-imports'] as const;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge,
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  field: { minWidth: '180px', flex: '1 1 180px' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: {
    overflow: 'auto', maxHeight: '340px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
  },
  code: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0,
    padding: tokens.spacingHorizontalM, backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, maxHeight: '160px', overflowY: 'auto',
  },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
});

type SubTab = 'clone' | 'time-travel' | 'restore' | 'copy-into' | 'snapshots';

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Shared ContainerPicker + tablePath inputs used by the Delta-backed sub-tabs. */
function DeltaSource({
  s, container, setContainer, tablePath, setTablePath,
}: {
  s: ReturnType<typeof useStyles>; container: string; setContainer: (v: string) => void;
  tablePath: string; setTablePath: (v: string) => void;
}) {
  return (
    <div className={s.row}>
      <Field label="Storage container" className={s.field}>
        <Dropdown
          value={container}
          selectedOptions={[container]}
          onOptionSelect={(_, d) => setContainer(d.optionValue || 'gold')}
        >
          {CONTAINERS.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
        </Dropdown>
      </Field>
      <Field label="Delta table path" hint="Folder containing _delta_log (e.g. Tables/orders)" className={s.field}>
        <Input value={tablePath} onChange={(_, d) => setTablePath(d.value)} placeholder="Tables/orders" />
      </Field>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Clone
// ─────────────────────────────────────────────────────────────────────────────
function ClonePanel({ id, s }: { id: string; s: ReturnType<typeof useStyles> }) {
  const [mode, setMode] = useState<'ctas' | 'delta-shallow'>('ctas');
  const [sourceSchema, setSourceSchema] = useState('dbo');
  const [sourceTable, setSourceTable] = useState('');
  const [targetSchema, setTargetSchema] = useState('dbo');
  const [targetTable, setTargetTable] = useState('');
  const [container, setContainer] = useState('gold');
  const [sourceTablePath, setSourceTablePath] = useState('');
  const [targetTablePath, setTargetTablePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const payload = mode === 'ctas'
        ? { mode, sourceSchema, sourceTable, targetSchema, targetTable }
        : { mode, container, sourceTablePath, targetTablePath };
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/clone`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setResult(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, mode, sourceSchema, sourceTable, targetSchema, targetTable, container, sourceTablePath, targetTablePath]);

  const canSubmit = mode === 'ctas'
    ? !!sourceTable.trim() && !!targetTable.trim()
    : !!sourceTablePath.trim() && !!targetTablePath.trim();

  return (
    <Card className={s.card}>
      <div className={s.header}><Copy20Regular /><Subtitle2>Clone table</Subtitle2></div>
      <Caption1>
        Create an independent copy of a table. <b>CTAS</b> clones a Synapse Dedicated SQL
        pool table (an independent copy — the Azure-native equivalent of Fabric&apos;s clone).
        <b> Delta SHALLOW CLONE</b> makes a zero-copy metadata clone of a lakehouse Delta table on Databricks.
      </Caption1>
      <RadioGroup layout="horizontal" value={mode} onChange={(_, d) => setMode(d.value as any)}>
        <Radio value="ctas" label="Warehouse table (CTAS)" />
        <Radio value="delta-shallow" label="Delta lakehouse table (SHALLOW CLONE)" />
      </RadioGroup>
      {mode === 'ctas' ? (
        <>
          <div className={s.row}>
            <Field label="Source schema" className={s.field}><Input value={sourceSchema} onChange={(_, d) => setSourceSchema(d.value)} /></Field>
            <Field label="Source table" required className={s.field}><Input value={sourceTable} onChange={(_, d) => setSourceTable(d.value)} placeholder="orders" /></Field>
          </div>
          <div className={s.row}>
            <Field label="Target schema" className={s.field}><Input value={targetSchema} onChange={(_, d) => setTargetSchema(d.value)} /></Field>
            <Field label="Target table" required className={s.field}><Input value={targetTable} onChange={(_, d) => setTargetTable(d.value)} placeholder="orders_clone" /></Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Storage container" className={s.field}>
            <Dropdown value={container} selectedOptions={[container]} onOptionSelect={(_, d) => setContainer(d.optionValue || 'gold')}>
              {CONTAINERS.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <div className={s.row}>
            <Field label="Source Delta path" required className={s.field}><Input value={sourceTablePath} onChange={(_, d) => setSourceTablePath(d.value)} placeholder="Tables/orders" /></Field>
            <Field label="Target Delta path" required className={s.field}><Input value={targetTablePath} onChange={(_, d) => setTargetTablePath(d.value)} placeholder="Tables/orders_clone" /></Field>
          </div>
        </>
      )}
      <div className={s.actions}>
        <Button appearance="primary" icon={<Copy20Regular />} disabled={busy || !canSubmit} onClick={submit}>
          {busy ? 'Cloning…' : 'Create clone'}
        </Button>
        {busy && <Spinner size="tiny" />}
      </div>
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Clone failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {result && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Clone created ({result.engine})</MessageBarTitle>
            <pre className={s.code}>{result.sql}</pre>
          </MessageBarBody>
        </MessageBar>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Time travel
// ─────────────────────────────────────────────────────────────────────────────
function TimeTravelPanel({ id, s }: { id: string; s: ReturnType<typeof useStyles> }) {
  const [container, setContainer] = useState('gold');
  const [tablePath, setTablePath] = useState('');
  const [versions, setVersions] = useState<any[] | null>(null);
  const [mode, setMode] = useState<'version' | 'timestamp'>('version');
  const [version, setVersion] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    if (!tablePath.trim()) return;
    setLoadingList(true); setError(null); setVersions(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/time-travel?container=${encodeURIComponent(container)}&tablePath=${encodeURIComponent(tablePath)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setVersions(j.versions || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoadingList(false); }
  }, [id, container, tablePath]);

  const runPreview = useCallback(async () => {
    setBusy(true); setError(null); setPreview(null);
    try {
      const payload: any = { container, tablePath, mode };
      if (mode === 'version') payload.version = Number(version);
      else payload.timestamp = timestamp;
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/time-travel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setPreview(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, container, tablePath, mode, version, timestamp]);

  const canRun = mode === 'version' ? version.trim() !== '' : timestamp.trim() !== '';

  return (
    <Card className={s.card}>
      <div className={s.header}><History20Regular /><Subtitle2>Time travel</Subtitle2></div>
      <Caption1>
        Query a Delta table as it existed at a past version or point in time
        (<code>VERSION AS OF</code> / <code>TIMESTAMP AS OF</code>) — the Azure-native equivalent of the
        Fabric Warehouse <code>OPTION (FOR TIMESTAMP AS OF …)</code>.
      </Caption1>
      <DeltaSource s={s} container={container} setContainer={setContainer} tablePath={tablePath} setTablePath={setTablePath} />
      <div className={s.actions}>
        <Button icon={<History20Regular />} disabled={loadingList || !tablePath.trim()} onClick={loadVersions}>
          {loadingList ? 'Loading history…' : 'Load version history'}
        </Button>
        {loadingList && <Spinner size="tiny" />}
      </div>
      {versions && versions.length === 0 && (
        <EmptyState icon={<History20Regular />} title="No committed versions" body="This Delta table has no version history yet, or the path is not a Delta table." />
      )}
      {versions && versions.length > 0 && (
        <div className={s.grid}>
          <Table aria-label="Delta versions" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Timestamp (UTC)</TableHeaderCell>
              <TableHeaderCell>Operation</TableHeaderCell><TableHeaderCell>Rows</TableHeaderCell><TableHeaderCell></TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.version}>
                  <TableCell className={s.cell}><Badge appearance="outline">{v.version}</Badge></TableCell>
                  <TableCell className={s.cell}>{v.timestamp || '—'}</TableCell>
                  <TableCell className={s.cell}>{v.operation}</TableCell>
                  <TableCell className={s.cell}>{v.metrics?.numOutputRows ?? '—'}</TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" onClick={() => { setMode('version'); setVersion(String(v.version)); }}>Use</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <RadioGroup layout="horizontal" value={mode} onChange={(_, d) => setMode(d.value as any)}>
        <Radio value="version" label="By version" />
        <Radio value="timestamp" label="By timestamp" />
      </RadioGroup>
      <div className={s.row}>
        {mode === 'version' ? (
          <Field label="Version" className={s.field}><Input type="number" value={version} onChange={(_, d) => setVersion(d.value)} placeholder="0" /></Field>
        ) : (
          <Field label="Timestamp (UTC, ISO8601)" className={s.field}><Input value={timestamp} onChange={(_, d) => setTimestamp(d.value)} placeholder="2026-03-13T19:39:35" /></Field>
        )}
        <Button appearance="primary" icon={<Play16Regular />} disabled={busy || !tablePath.trim() || !canRun} onClick={runPreview}>
          {busy ? 'Running…' : 'Preview as-of'}
        </Button>
      </div>
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Time travel</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {preview && (
        <>
          <div className={s.actions}>
            <Badge appearance="filled" color="success">{preview.rowCount ?? preview.rows?.length ?? 0} rows</Badge>
            <Caption1>· {preview.executionMs} ms</Caption1>
          </div>
          <pre className={s.code}>{preview.sql}</pre>
          {(preview.rows?.length ?? 0) > 0 && (
            <div className={s.grid}>
              <Table aria-label="Time-travel results" size="small">
                <TableHeader><TableRow>{(preview.columns || []).map((c: string) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                <TableBody>
                  {(preview.rows || []).map((row: unknown[], i: number) => (
                    <TableRow key={i}>{(preview.columns || []).map((_: string, j: number) => <TableCell key={j} className={s.cell}>{fmtCell(row[j])}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore points
// ─────────────────────────────────────────────────────────────────────────────
function RestorePointsPanel({ id, s }: { id: string; s: ReturnType<typeof useStyles> }) {
  const [points, setPoints] = useState<any[] | null>(null);
  const [poolState, setPoolState] = useState<string>('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/restore-points`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setPoints([]); return; }
      setPoints(j.restorePoints || []); setPoolState(j.poolState || '');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);

  const act = useCallback(async (payload: any, successNote: string) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/restore-points`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNote(j.note || successNote); setLabel('');
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, load]);

  return (
    <Card className={s.card}>
      <div className={s.header}><ArrowClockwise20Regular /><Subtitle2>Restore points</Subtitle2></div>
      <Caption1>
        User-defined (DISCRETE) and automatic (CONTINUOUS, ~8h) restore points for the backing Synapse
        Dedicated SQL pool. Restoring provisions a <b>new</b> pool from the chosen point in time — dedicated
        pools do not restore in-place.
      </Caption1>
      <div className={s.actions}>
        <Button icon={<ArrowClockwise20Regular />} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Load restore points'}</Button>
        {poolState && <Badge appearance="filled" color={poolState === 'Online' ? 'success' : 'warning'}>{poolState}</Badge>}
      </div>
      <div className={s.row}>
        <Field label="New restore point label" className={s.field}><Input value={label} onChange={(_, d) => setLabel(d.value)} placeholder="before-load" /></Field>
        <Button appearance="primary" icon={<Add16Regular />} disabled={busy || !label.trim()} onClick={() => act({ action: 'create', label }, 'Restore point created.')}>
          {busy ? 'Working…' : 'Create restore point'}
        </Button>
      </div>
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Restore points</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
      {points && points.length === 0 && !error && (
        <EmptyState icon={<ArrowClockwise20Regular />} title="No restore points" body="Create a user-defined restore point above, or wait for the automatic 8-hour snapshot." />
      )}
      {points && points.length > 0 && (
        <div className={s.grid}>
          <Table aria-label="Restore points" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Label</TableHeaderCell>
              <TableHeaderCell>Created (UTC)</TableHeaderCell><TableHeaderCell></TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {points.map((p, i) => (
                <TableRow key={p.name || i}>
                  <TableCell className={s.cell}><Badge appearance="outline" color={p.type === 'CONTINUOUS' ? 'informative' : 'brand'}>{p.type}</Badge></TableCell>
                  <TableCell className={s.cell}>{p.label || '—'}</TableCell>
                  <TableCell className={s.cell}>{p.creationDate || '—'}</TableCell>
                  <TableCell>
                    <div className={s.actions}>
                      {p.creationDate && (
                        <Button size="small" appearance="subtle" icon={<ArrowClockwise20Regular />}
                          disabled={busy}
                          onClick={() => {
                            const targetPool = `restore_${Date.now().toString(36)}`;
                            act({ action: 'restore', targetPool, restorePointInTime: p.creationDate }, 'Restore started.');
                          }}>Restore to new pool</Button>
                      )}
                      {p.type !== 'CONTINUOUS' && p.name && (
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy}
                          onClick={() => act({ action: 'delete', name: p.name }, 'Restore point deleted.')}>Delete</Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COPY INTO wizard
// ─────────────────────────────────────────────────────────────────────────────
function CopyIntoPanel({ id, s }: { id: string; s: ReturnType<typeof useStyles> }) {
  const [targetSchema, setTargetSchema] = useState('dbo');
  const [targetTable, setTargetTable] = useState('');
  const [container, setContainer] = useState('landing');
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState<any[] | null>(null);
  const [fileType, setFileType] = useState('CSV');
  const [firstRow, setFirstRow] = useState('2');
  const [fieldTerminator, setFieldTerminator] = useState(',');
  const [rowTerminator, setRowTerminator] = useState('0x0A');
  const [encoding, setEncoding] = useState('UTF8');
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (nextPrefix: string) => {
    setBrowsing(true); setError(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/copy-into?container=${encodeURIComponent(container)}&prefix=${encodeURIComponent(nextPrefix)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setEntries(j.entries || []); setPrefix(nextPrefix);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBrowsing(false); }
  }, [id, container]);

  const submit = useCallback(async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/copy-into`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetSchema, targetTable, container, sourcePath: prefix, fileType, firstRow: Number(firstRow), fieldTerminator, rowTerminator, encoding }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setResult(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, targetSchema, targetTable, container, prefix, fileType, firstRow, fieldTerminator, rowTerminator, encoding]);

  return (
    <Card className={s.card}>
      <div className={s.header}><CloudArrowUp20Regular /><Subtitle2>COPY INTO</Subtitle2></div>
      <Caption1>
        Bulk-load files from ADLS Gen2 into a warehouse table. Pick a source folder, target table, and file
        format — Loom builds and runs a real <code>COPY INTO</code> using the pool&apos;s managed identity.
      </Caption1>
      <div className={s.row}>
        <Field label="Storage container" className={s.field}>
          <Dropdown value={container} selectedOptions={[container]} onOptionSelect={(_, d) => { setContainer(d.optionValue || 'landing'); setEntries(null); setPrefix(''); }}>
            {CONTAINERS.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Source folder / path" hint="Loaded into the table (folder = all files under it)" className={s.field}>
          <Input value={prefix} onChange={(_, d) => setPrefix(d.value)} placeholder="orders/2026/" />
        </Field>
        <Button icon={<CloudArrowUp20Regular />} disabled={browsing} onClick={() => browse(prefix)}>{browsing ? 'Listing…' : 'Browse'}</Button>
      </div>
      {entries && (
        <div className={s.grid}>
          <Table aria-label="Storage entries" size="small">
            <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Size</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {entries.length === 0 && <TableRow><TableCell className={s.cell}>Empty</TableCell></TableRow>}
              {entries.map((e) => (
                <TableRow key={e.name}>
                  <TableCell className={s.cell}>
                    {e.isDirectory
                      ? <Button size="small" appearance="transparent" onClick={() => browse(e.name)}>{e.name}/</Button>
                      : e.name}
                  </TableCell>
                  <TableCell className={s.cell}>{e.isDirectory ? 'folder' : 'file'}</TableCell>
                  <TableCell className={s.cell}>{e.isDirectory ? '—' : e.size}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className={s.row}>
        <Field label="Target schema" className={s.field}><Input value={targetSchema} onChange={(_, d) => setTargetSchema(d.value)} /></Field>
        <Field label="Target table" required className={s.field}><Input value={targetTable} onChange={(_, d) => setTargetTable(d.value)} placeholder="orders" /></Field>
        <Field label="File type" className={s.field}>
          <Dropdown value={fileType} selectedOptions={[fileType]} onOptionSelect={(_, d) => setFileType(d.optionValue || 'CSV')}>
            {['CSV', 'PARQUET', 'ORC'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
          </Dropdown>
        </Field>
      </div>
      {fileType === 'CSV' && (
        <div className={s.row}>
          <Field label="First row" className={s.field}><Input type="number" value={firstRow} onChange={(_, d) => setFirstRow(d.value)} /></Field>
          <Field label="Field terminator" className={s.field}><Input value={fieldTerminator} onChange={(_, d) => setFieldTerminator(d.value)} /></Field>
          <Field label="Row terminator" className={s.field}><Input value={rowTerminator} onChange={(_, d) => setRowTerminator(d.value)} /></Field>
          <Field label="Encoding" className={s.field}>
            <Dropdown value={encoding} selectedOptions={[encoding]} onOptionSelect={(_, d) => setEncoding(d.optionValue || 'UTF8')}>
              {['UTF8', 'UTF16'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
            </Dropdown>
          </Field>
        </div>
      )}
      <div className={s.actions}>
        <Button appearance="primary" icon={<Play16Regular />} disabled={busy || !targetTable.trim()} onClick={submit}>{busy ? 'Loading…' : 'Run COPY INTO'}</Button>
        {busy && <Spinner size="tiny" />}
      </div>
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>COPY INTO failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {result && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Loaded {result.rowsLoaded ?? 0} rows into {result.target}</MessageBarTitle>
            <pre className={s.code}>{result.sql}</pre>
          </MessageBarBody>
        </MessageBar>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshots
// ─────────────────────────────────────────────────────────────────────────────
function SnapshotsPanel({ id, s }: { id: string; s: ReturnType<typeof useStyles> }) {
  const [container, setContainer] = useState('gold');
  const [tablePath, setTablePath] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tablePath.trim()) return;
    setLoading(true); setError(null); setData(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/snapshots?container=${encodeURIComponent(container)}&tablePath=${encodeURIComponent(tablePath)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id, container, tablePath]);

  const createSnapshot = useCallback(async (version?: number) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/snapshots`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container, tablePath, ...(version !== undefined ? { version } : {}) }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNote(`Snapshot created: ${j.snapshot}`);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, container, tablePath]);

  const checkpoints: any[] = data?.checkpoints || [];
  const versions: any[] = data?.versions || [];

  return (
    <Card className={s.card}>
      <div className={s.header}><Camera20Regular /><Subtitle2>Snapshots</Subtitle2></div>
      <Caption1>
        A Delta table&apos;s recoverable snapshots — its committed versions and checkpoint consistency points.
        Create a read-only point-in-time snapshot as a zero-copy Delta clone (Fabric warehouse-snapshot semantics).
      </Caption1>
      <DeltaSource s={s} container={container} setContainer={setContainer} tablePath={tablePath} setTablePath={setTablePath} />
      <div className={s.actions}>
        <Button icon={<Camera20Regular />} disabled={loading || !tablePath.trim()} onClick={load}>{loading ? 'Loading…' : 'Load snapshots'}</Button>
        <Button appearance="primary" icon={<Add16Regular />} disabled={busy || !tablePath.trim()} onClick={() => createSnapshot()}>{busy ? 'Working…' : 'Create snapshot (current)'}</Button>
      </div>
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Snapshots</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
      {data && (
        <>
          <Body1><b>Checkpoints</b> ({checkpoints.length})</Body1>
          {checkpoints.length === 0 ? (
            <Caption1>No checkpoints yet (Delta writes one every ~10 commits).</Caption1>
          ) : (
            <div className={s.grid}>
              <Table aria-label="Checkpoints" size="small">
                <TableHeader><TableRow><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Latest</TableHeaderCell><TableHeaderCell>Parts</TableHeaderCell><TableHeaderCell>Size (bytes)</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {checkpoints.map((c) => (
                    <TableRow key={c.version}>
                      <TableCell className={s.cell}><Badge appearance="outline">{c.version}</Badge></TableCell>
                      <TableCell className={s.cell}>{c.isLatest ? <Badge appearance="filled" color="success">latest</Badge> : '—'}</TableCell>
                      <TableCell className={s.cell}>{c.parts}</TableCell>
                      <TableCell className={s.cell}>{c.sizeBytes}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Body1><b>Versions</b> ({versions.length})</Body1>
          {versions.length > 0 && (
            <div className={s.grid}>
              <Table aria-label="Snapshot versions" size="small">
                <TableHeader><TableRow><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Timestamp (UTC)</TableHeaderCell><TableHeaderCell>Operation</TableHeaderCell><TableHeaderCell></TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell className={s.cell}>{v.version}</TableCell>
                      <TableCell className={s.cell}>{v.timestamp || '—'}</TableCell>
                      <TableCell className={s.cell}>{v.operation}</TableCell>
                      <TableCell><Button size="small" appearance="subtle" icon={<Camera20Regular />} disabled={busy} onClick={() => createSnapshot(v.version)}>Snapshot this</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function WarehouseTimeTravelTab({ id }: { id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<SubTab>('clone');
  return (
    <div className={s.root}>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as SubTab)}>
        <Tab value="clone" icon={<Copy20Regular />}>Clone</Tab>
        <Tab value="time-travel" icon={<History20Regular />}>Time travel</Tab>
        <Tab value="restore" icon={<ArrowClockwise20Regular />}>Restore points</Tab>
        <Tab value="copy-into" icon={<CloudArrowUp20Regular />}>COPY INTO</Tab>
        <Tab value="snapshots" icon={<Camera20Regular />}>Snapshots</Tab>
      </TabList>
      {tab === 'clone' && <ClonePanel id={id} s={s} />}
      {tab === 'time-travel' && <TimeTravelPanel id={id} s={s} />}
      {tab === 'restore' && <RestorePointsPanel id={id} s={s} />}
      {tab === 'copy-into' && <CopyIntoPanel id={id} s={s} />}
      {tab === 'snapshots' && <SnapshotsPanel id={id} s={s} />}
    </div>
  );
}
