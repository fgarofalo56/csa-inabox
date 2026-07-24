'use client';

/**
 * /admin/migrate — the inbound-migration ON-RAMP. Two tabs:
 *
 *   • Assess (M1) — point Loom at a Snowflake / Databricks Unity Catalog /
 *     Microsoft Fabric / Power BI estate, enumerate it, and render a
 *     MIGRATION-READINESS REPORT (per-object → Loom item type + effort). Real
 *     data via the audited BFF (/api/migrate/assess).
 *   • Copy in (M2) — build a copy plan from that report and land each assessed
 *     table into ADLS Bronze via a REAL Azure Data Factory Copy pipeline (the
 *     mirror substrate IN REVERSE), then materialize managed Delta in the target
 *     Loom lakehouse. Real data + a live progress monitor via /api/migrate/copy.
 *
 * A Fabric / Power BI estate is only ever a migration SOURCE — Loom itself has
 * no Fabric dependency; the default path reaches no Fabric host. Every
 * non-functional state is an HONEST gate (no fabricated counts) per no-vaporware.
 *
 * UX baseline: guided empty states (no red on first open), Fluent v9 + Loom
 * tokens only, TileGrid / EmptyState primitives, flexWrap badge rows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { clientFetch } from '@/lib/client-fetch';
import { AdminShell } from '@/lib/components/admin-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { TranslatePanel } from './translate-panel';
import {
  makeStyles, tokens, Subtitle2, Caption1, Body1, Badge, Spinner, Dropdown, Option,
  Button, Input, Field, MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  TabList, Tab,
} from '@fluentui/react-components';
import {
  ArrowSwap24Regular, DatabaseArrowRight20Regular, Search20Regular, CheckmarkCircle20Regular,
  Warning20Regular, ArrowSync20Regular, TableSimple20Regular,
} from '@fluentui/react-icons';
import {
  MIGRATION_SOURCE_LABELS, effortBadgeColor,
  type MigrationSourceType, type ReadinessReport, type AssessedObject,
} from '@/lib/migrate/assessment';
import { buildCopyInPlan, type CopyInPlan } from '@/lib/migrate/copy-plan';
import type { CopyJobDoc, CopyObjectResult, CopyObjectStatus, CopyJobStatus } from '@/lib/migrate/copy-job-model';

const SOURCE_TYPES: MigrationSourceType[] = ['snowflake', 'databricks-uc', 'fabric', 'powerbi'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  toolbar: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM, flex: 1, minWidth: 0 },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  tileValue: { fontSize: '28px', fontWeight: 700, lineHeight: 1.1, overflowWrap: 'anywhere' },
  tileLabel: { color: tokens.colorNeutralForeground2 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  scroll: { overflowX: 'auto', minWidth: 0 },
  reason: { color: tokens.colorNeutralForeground3, fontSize: '12px', maxWidth: '420px', overflowWrap: 'anywhere' },
  mono: { fontFamily: tokens.fontFamilyMonospace, overflowWrap: 'anywhere' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
});

// ── shared source-connection form (reused by the Assess tab) ────────────────

interface AssessState {
  loading: boolean;
  report?: ReadinessReport;
  infraGate?: { title: string; remediation: string; fixItHref: string };
  connectorGate?: { message: string; prerequisite: string[] };
  error?: string;
}

async function assess(sourceType: MigrationSourceType, connection: Record<string, string>) {
  const res = await clientFetch('/api/migrate/assess', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceType, connection }),
  }, 90_000);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export default function MigratePage() {
  const styles = useStyles();
  const [tab, setTab] = useState<'assess' | 'copy' | 'translate'>('assess');

  // Assess state
  const [sourceType, setSourceType] = useState<MigrationSourceType>('snowflake');
  const [host, setHost] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [catalog, setCatalog] = useState('');
  const [token, setToken] = useState('');
  const [state, setState] = useState<AssessState>({ loading: false });

  async function runAssess() {
    setState({ loading: true });
    try {
      const connection: Record<string, string> = {};
      if (host.trim()) connection.host = host.trim();
      if (workspaceId.trim()) connection.workspaceId = workspaceId.trim();
      if (catalog.trim()) connection.catalog = catalog.trim();
      if (token.trim()) connection.token = token.trim();
      const { status, json } = await assess(sourceType, connection);
      if (status === 503 && json?.gate) {
        setState({ loading: false, infraGate: { title: json.gate.title, remediation: json.gate.remediation, fixItHref: json.gate.fixItHref } });
        return;
      }
      if (json?.ok === false && json?.gated && json?.gate) {
        setState({ loading: false, connectorGate: { message: json.gate.remediation || json.gate.message, prerequisite: json.gate.missing || json.gate.prerequisite || [] } });
        return;
      }
      if (json?.report) { setState({ loading: false, report: json.report as ReadinessReport }); return; }
      setState({ loading: false, error: json?.error || `Assessment failed (${status}).` });
    } catch (e) {
      setState({ loading: false, error: (e as Error)?.message || 'Assessment failed.' });
    }
  }

  const showHost = sourceType === 'snowflake' || sourceType === 'databricks-uc';
  const showWorkspace = sourceType === 'fabric' || sourceType === 'powerbi';
  const showCatalog = sourceType === 'databricks-uc' || sourceType === 'snowflake';

  return (
    <AdminShell
      sectionTitle="Migrate"
      learn={{
        title: 'Estate migration on-ramp',
        content:
          'Point Loom at a Snowflake, Databricks Unity Catalog, Microsoft Fabric, or Power BI estate. Assess produces a migration-readiness report (every object mapped to a Loom item type). Copy in lands the assessed tables into your lake via a real Azure Data Factory Copy pipeline and materializes managed Delta — no Microsoft Fabric required. A Fabric or Power BI estate is only ever a migration SOURCE.',
      }}
    >
      <div className={styles.root}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'assess' | 'copy' | 'translate')}>
          <Tab value="assess" icon={<ArrowSwap24Regular />}>Assess</Tab>
          <Tab value="copy" icon={<DatabaseArrowRight20Regular />}>Copy in</Tab>
          <Tab value="translate">Translate</Tab>
        </TabList>

        {tab === 'assess' && (
          <>
            {/* Source connection picker */}
            <div className={styles.section}>
              <div className={styles.badgeRow}>
                <ArrowSwap24Regular />
                <Subtitle2>Connect a source estate</Subtitle2>
              </div>
              <div className={styles.toolbar}>
                <Field label="Source type" style={{ minWidth: '220px' }}>
                  <Dropdown
                    value={MIGRATION_SOURCE_LABELS[sourceType]}
                    selectedOptions={[sourceType]}
                    aria-label="Source type"
                    onOptionSelect={(_, d) => setSourceType((d.optionValue as MigrationSourceType) || 'snowflake')}
                  >
                    {SOURCE_TYPES.map((s) => <Option key={s} value={s}>{MIGRATION_SOURCE_LABELS[s]}</Option>)}
                  </Dropdown>
                </Field>
                <div className={styles.formGrid}>
                  {showHost && (
                    <Field label={sourceType === 'snowflake' ? 'Account URL' : 'Workspace URL'}>
                      <Input value={host} onChange={(_, d) => setHost(d.value)}
                        placeholder={sourceType === 'snowflake' ? 'https://<account>.snowflakecomputing.com' : 'https://adb-<id>.azuredatabricks.net'} />
                    </Field>
                  )}
                  {showWorkspace && (
                    <Field label="Workspace / group id">
                      <Input value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                    </Field>
                  )}
                  {showCatalog && (
                    <Field label={sourceType === 'snowflake' ? 'Database' : 'Catalog'}>
                      <Input value={catalog} onChange={(_, d) => setCatalog(d.value)} placeholder={sourceType === 'snowflake' ? 'ANALYTICS_DB' : 'main'} />
                    </Field>
                  )}
                  <Field label="Access token / PAT (Key Vault ref)" hint="Stored + resolved server-side; never rendered back.">
                    <Input type="password" value={token} onChange={(_, d) => setToken(d.value)} placeholder="@Microsoft.KeyVault(SecretUri=…) or a PAT" />
                  </Field>
                </div>
                <Button appearance="primary" icon={<Search20Regular />} onClick={runAssess} disabled={state.loading}>
                  {state.loading ? <Spinner size="tiny" /> : 'Assess'}
                </Button>
              </div>
              <Caption1 className={styles.tileLabel}>
                The reader runs in-boundary. A source whose connection isn&apos;t provided yet is honestly gated — you&apos;ll see exactly what to supply, never a fabricated count.
              </Caption1>
            </div>

            {state.infraGate && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Estate reader not configured</MessageBarTitle>
                  {state.infraGate.remediation}{' '}
                  <Link href={state.infraGate.fixItHref}>Fix it in the gate registry →</Link>
                </MessageBarBody>
              </MessageBar>
            )}
            {state.connectorGate && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Source connection required</MessageBarTitle>
                  {state.connectorGate.message}
                  {state.connectorGate.prerequisite.length > 0 && (
                    <> Provide: <span className={styles.mono}>{state.connectorGate.prerequisite.join(', ')}</span>.</>
                  )}
                </MessageBarBody>
              </MessageBar>
            )}
            {state.error && (
              <MessageBar intent="error" layout="multiline">
                <MessageBarBody><MessageBarTitle>Assessment failed</MessageBarTitle>{state.error}</MessageBarBody>
              </MessageBar>
            )}

            {state.loading && <Spinner label="Enumerating the source estate…" />}
            {state.report && <ReportView report={state.report} onCopyIn={() => setTab('copy')} />}

            {!state.loading && !state.report && !state.infraGate && !state.connectorGate && !state.error && (
              <EmptyState
                icon={<DatabaseArrowRight20Regular />}
                title="Assess a source estate to begin"
                body="Pick a source type above, provide its connection, and select Assess. Loom enumerates the estate and produces a migration-readiness report — every object mapped to a Loom item type with a 1:1 / needs-review effort flag."
              />
            )}
          </>
        )}

        {tab === 'copy' && <CopyInTab report={state.report} onGoAssess={() => setTab('assess')} />}
        {tab === 'translate' && <TranslatePanel />}
      </div>
    </AdminShell>
  );
}

function ReportView({ report, onCopyIn }: { report: ReadinessReport; onCopyIn: () => void }) {
  const styles = useStyles();
  const itemTypeEntries = Object.entries(report.byLoomItemType).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <TileGrid minTileWidth={220}>
        <div className={styles.tile}>
          <Caption1 className={styles.tileLabel}>Objects enumerated</Caption1>
          <div className={styles.tileValue}>{report.totals.objects.toLocaleString()}</div>
          <Caption1 className={styles.tileLabel}>{report.sourceLabel || MIGRATION_SOURCE_LABELS[report.sourceType]}</Caption1>
        </div>
        <div className={styles.tile}>
          <Caption1 className={styles.tileLabel}>1:1 mappings</Caption1>
          <div className={styles.tileValue}>{report.totals.oneToOne.toLocaleString()}</div>
          <div className={styles.badgeRow}>
            <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Regular />}>direct Loom item</Badge>
          </div>
        </div>
        <div className={styles.tile}>
          <Caption1 className={styles.tileLabel}>Needs review</Caption1>
          <div className={styles.tileValue}>{report.totals.needsReview.toLocaleString()}</div>
          <div className={styles.badgeRow}>
            <Badge appearance="tint" color="warning" icon={<Warning20Regular />}>manual step</Badge>
          </div>
        </div>
      </TileGrid>

      <div className={styles.section}>
        <div className={styles.badgeRow}>
          <Subtitle2>Loom item types</Subtitle2>
          <Button appearance="primary" size="small" icon={<DatabaseArrowRight20Regular />} onClick={onCopyIn}
            style={{ marginInlineStart: 'auto' }}>Copy the data in →</Button>
        </div>
        {itemTypeEntries.length ? (
          <div className={styles.badgeRow}>
            {itemTypeEntries.map(([k, n]) => (
              <Badge key={k} appearance="tint" color={k === 'needs-review' ? 'warning' : 'brand'}>{k}: {n}</Badge>
            ))}
          </div>
        ) : <Body1>No objects were enumerated.</Body1>}
      </div>

      <div className={styles.section}>
        <div className={styles.badgeRow}><Subtitle2>Per-object mapping</Subtitle2></div>
        <div className={styles.scroll}>
          <Table aria-label="Per-object migration mapping" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Source object</TableHeaderCell>
                <TableHeaderCell>Source kind</TableHeaderCell>
                <TableHeaderCell>Loom item type</TableHeaderCell>
                <TableHeaderCell>Effort</TableHeaderCell>
                <TableHeaderCell>Notes</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.objects.map((o: AssessedObject, i: number) => (
                <TableRow key={`${o.name}-${i}`}>
                  <TableCell><span className={styles.mono}>{[o.database, o.schema, o.name].filter(Boolean).join('.')}</span></TableCell>
                  <TableCell>{o.rawType || o.sourceKind}</TableCell>
                  <TableCell>
                    {o.loomItemType === 'needs-review'
                      ? <Badge appearance="tint" color="warning">needs-review</Badge>
                      : <Badge appearance="tint" color="brand">{o.loomItemType}</Badge>}
                  </TableCell>
                  <TableCell><Badge appearance="tint" color={effortBadgeColor(o.effort)}>{o.effort}</Badge></TableCell>
                  <TableCell><Tooltip content={o.reason} relationship="description"><span className={styles.reason}>{o.reason}</span></Tooltip></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}

// ── Copy-in tab: plan preview → start → live monitor ────────────────────────

const COPY_STATUS_COLOR: Record<CopyObjectStatus, 'success' | 'warning' | 'danger' | 'informative' | 'subtle'> = {
  succeeded: 'success', running: 'informative', pending: 'subtle', failed: 'danger', skipped: 'warning',
};
const JOB_STATUS_COLOR: Record<CopyJobStatus, 'success' | 'warning' | 'danger' | 'informative'> = {
  succeeded: 'success', partial: 'warning', running: 'informative', failed: 'danger', gated: 'warning',
};

async function postCopy(bodyObj: Record<string, unknown>) {
  const res = await clientFetch('/api/migrate/copy', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj),
  }, 90_000);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function CopyInTab({ report, onGoAssess }: { report?: ReadinessReport; onGoAssess: () => void }) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ remediation: string; missing: string[]; fixItHref: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CopyJobDoc | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const plan: CopyInPlan | null = report ? buildCopyInPlan(report) : null;

  const poll = useCallback(async (migrationId: string) => {
    try {
      const res = await clientFetch(`/api/migrate/copy?migrationId=${encodeURIComponent(migrationId)}`, { method: 'GET' }, 90_000);
      const json = await res.json().catch(() => ({}));
      if (json?.job) setJob(json.job as CopyJobDoc);
    } catch { /* transient — keep last known state */ }
  }, []);

  // Poll while the job is still running; stop when it settles.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (job && job.status === 'running' && job.migrationId) {
      pollRef.current = setInterval(() => poll(job.migrationId), 5000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [job, poll]);

  async function start() {
    if (!report) return;
    setBusy(true); setError(null); setGate(null);
    try {
      const { status, json } = await postCopy({ action: 'start', report });
      if (status === 503) { setError(json?.error || 'Copy-in is turned off.'); return; }
      if (json?.ok === false && json?.gated && json?.gate) {
        setGate({ remediation: json.gate.remediation, missing: json.gate.missing || [], fixItHref: json.gate.fixItHref || '/admin/gates?gate=svc-loom-migrate' });
        return;
      }
      if (json?.job) { setJob(json.job as CopyJobDoc); return; }
      setError(json?.error || `Copy-in failed to start (${status}).`);
    } catch (e) { setError((e as Error)?.message || 'Copy-in failed to start.'); }
    finally { setBusy(false); }
  }

  async function materialize(source: string) {
    if (!job) return;
    setBusy(true); setError(null);
    try {
      const { json } = await postCopy({ action: 'materialize', migrationId: job.migrationId, source });
      if (json?.job) setJob(json.job as CopyJobDoc);
      else setError(json?.error || 'Materialize failed.');
    } catch (e) { setError((e as Error)?.message || 'Materialize failed.'); }
    finally { setBusy(false); }
  }

  if (!report) {
    return (
      <EmptyState
        icon={<DatabaseArrowRight20Regular />}
        title="Assess a source estate first"
        body="Copy-in works from a migration-readiness report. Run an assessment on the Assess tab, then return here to land its tables into your lake."
        primaryAction={{ label: 'Go to Assess', onClick: onGoAssess }}
      />
    );
  }

  return (
    <>
      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Copy-in prerequisite required</MessageBarTitle>
            {gate.remediation}
            {gate.missing.length > 0 && <> Provide: <span className={styles.mono}>{gate.missing.join(', ')}</span>.</>}{' '}
            <Link href={gate.fixItHref}>Fix it in the gate registry →</Link>
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody><MessageBarTitle>Copy-in error</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Plan KPIs */}
      {plan && (
        <TileGrid minTileWidth={220}>
          <div className={styles.tile}>
            <Caption1 className={styles.tileLabel}>Tables to copy</Caption1>
            <div className={styles.tileValue}>{plan.totals.copyable.toLocaleString()}</div>
            <div className={styles.badgeRow}>
              <Badge appearance="tint" color="brand">lakehouse: {plan.totals.byTargetKind.lakehouse}</Badge>
              <Badge appearance="tint" color="brand">warehouse: {plan.totals.byTargetKind.warehouse}</Badge>
            </div>
          </div>
          <div className={styles.tile}>
            <Caption1 className={styles.tileLabel}>Handled elsewhere</Caption1>
            <div className={styles.tileValue}>{plan.totals.skipped.toLocaleString()}</div>
            <Caption1 className={styles.tileLabel}>views / models / notebooks → M3 &amp; item migrators</Caption1>
          </div>
          <div className={styles.tile}>
            <Caption1 className={styles.tileLabel}>Source</Caption1>
            <Subtitle2>{plan.sourceLabel || MIGRATION_SOURCE_LABELS[plan.sourceType]}</Subtitle2>
            <Caption1 className={styles.tileLabel}>Lands as managed Delta in ADLS Bronze (no Fabric)</Caption1>
          </div>
        </TileGrid>
      )}

      {/* Either the plan preview (pre-start) or the live monitor (post-start). */}
      {!job && plan && (
        <div className={styles.section}>
          <div className={styles.badgeRow}>
            <TableSimple20Regular />
            <Subtitle2>Copy plan</Subtitle2>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <DatabaseArrowRight20Regular />}
              onClick={start} disabled={busy || plan.totals.copyable === 0} style={{ marginInlineStart: 'auto' }}>
              {busy ? 'Starting…' : 'Start copy-in'}
            </Button>
          </div>
          {plan.totals.copyable === 0
            ? <Body1>No copyable tables in this assessment — every object is handled by M3 (code translation) or an item migrator.</Body1>
            : (
              <div className={styles.scroll}>
                <Table aria-label="Copy-in plan" size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Source table</TableHeaderCell>
                      <TableHeaderCell>Target table</TableHeaderCell>
                      <TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell>Column mapping</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.objects.map((o) => (
                      <TableRow key={o.landingSegment}>
                        <TableCell><span className={styles.mono}>{o.landingSegment}</span></TableCell>
                        <TableCell><span className={styles.mono}>{o.targetTable}</span></TableCell>
                        <TableCell><Badge appearance="tint" color="brand">{o.targetKind}</Badge></TableCell>
                        <TableCell><Badge appearance="outline">{o.columnMapping}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          <Caption1 className={styles.tileLabel}>
            Start authors a real Azure Data Factory Copy pipeline (delete-then-copy per table) that lands each table as Parquet in ADLS Bronze, then you can materialize managed Delta into the target Loom lakehouse. Views, stored procedures, semantic models, and reports are migrated by M3 / their own item migrators — not this data copy.
          </Caption1>
        </div>
      )}

      {job && <MonitorView job={job} busy={busy} onMaterialize={materialize} onRefresh={() => poll(job.migrationId)} />}
    </>
  );
}

function MonitorView({ job, busy, onMaterialize, onRefresh }: {
  job: CopyJobDoc; busy: boolean; onMaterialize: (source: string) => void; onRefresh: () => void;
}) {
  const styles = useStyles();
  return (
    <div className={styles.section}>
      <div className={styles.badgeRow}>
        <TableSimple20Regular />
        <Subtitle2>Copy progress</Subtitle2>
        <Badge appearance="tint" color={JOB_STATUS_COLOR[job.status]}>{job.status}</Badge>
        <Badge appearance="outline">{job.totals.rows.toLocaleString()} rows</Badge>
        <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={onRefresh} disabled={busy}
          style={{ marginInlineStart: 'auto' }}>Refresh</Button>
      </div>
      <Caption1 className={styles.tileLabel}>
        Migration <span className={styles.mono}>{job.migrationId}</span>
        {job.pipelineName && <> · ADF pipeline <span className={styles.mono}>{job.pipelineName}</span></>}
        {job.adfRunId && <> · run <span className={styles.mono}>{job.adfRunId}</span></>}
      </Caption1>
      {job.error && <MessageBar intent="error"><MessageBarBody>{job.error}</MessageBarBody></MessageBar>}
      <div className={styles.scroll}>
        <Table aria-label="Copy progress" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Source table</TableHeaderCell>
              <TableHeaderCell>Target table</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Rows</TableHeaderCell>
              <TableHeaderCell>Notes / actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {job.objects.map((o: CopyObjectResult) => (
              <TableRow key={o.source}>
                <TableCell><span className={styles.mono}>{o.source}</span></TableCell>
                <TableCell><span className={styles.mono}>{o.targetTable}</span> <Badge appearance="tint" color="brand">{o.targetKind}</Badge></TableCell>
                <TableCell><Badge appearance="tint" color={COPY_STATUS_COLOR[o.status]}>{o.status}</Badge></TableCell>
                <TableCell>{typeof o.rows === 'number' ? o.rows.toLocaleString() : '—'}</TableCell>
                <TableCell>
                  <div className={styles.rowActions}>
                    {o.status === 'succeeded' && (
                      <Button appearance="secondary" size="small" icon={<TableSimple20Regular />} disabled={busy}
                        onClick={() => onMaterialize(o.source)}>Materialize Delta</Button>
                    )}
                    {o.note && <Tooltip content={o.note} relationship="description"><span className={styles.reason}>{o.note}</span></Tooltip>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Caption1 className={styles.tileLabel}>
        Rows are landed in ADLS Bronze by the ADF Copy pipeline (real row counts from the Copy activity). &quot;Materialize Delta&quot; runs a Synapse Spark job that writes a managed Delta table into the target Loom lakehouse so it opens in the lakehouse editor with a real count.
      </Caption1>
    </div>
  );
}
