'use client';

/**
 * SQL DB migration assistant — Azure-native answer to Fabric's Migration
 * Assistant (Build 2026 #22). Three-step wizard:
 *   1. Upload a .dacpac (SQL Server / Azure SQL data-tier package).
 *   2. Review the compatibility assessment against the Synapse Dedicated SQL
 *      pool (blockers / warnings, grouped object inventory).
 *   3. Import the supported schema into the env-bound dedicated pool and read
 *      the per-object receipt.
 *
 * Every control hits a real BFF route (/api/sqldb/migration/assess|import).
 * No mocks — the assessment is real DACPAC parsing, the import is real TDS DDL.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Subtitle2,
  Body1,
  Caption1,
  Badge,
  Button,
  Card,
  CardHeader,
  Spinner,
  Divider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Link,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowUpload24Regular,
  CheckmarkCircle24Filled,
  Warning24Filled,
  DismissCircle24Filled,
  Database24Regular,
  DocumentTable24Regular,
  PlayCircle24Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  steps: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  stepPill: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '4px 12px', borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
  },
  stepActive: {
    borderColor: tokens.colorBrandStroke1,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  uploadZone: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
    padding: '40px', borderRadius: tokens.borderRadiusLarge,
    border: `2px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    textAlign: 'center',
  },
  summaryGrid: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  summaryCard: {
    minWidth: '120px', padding: '12px 16px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  summaryNum: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: '1' },
  summaryLabel: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  hidden: { display: 'none' },
});

type Severity = 'blocker' | 'warning' | 'info';
interface CompatFinding { rule: string; severity: Severity; object: string; message: string; doc?: string }
interface PlanStatement { kind: string; object: string; sql: string; skipped?: boolean; reason?: string }
interface TableRow { schema: string; name: string; columnCount: number }
interface AssessResponse {
  ok: boolean;
  error?: string;
  fileName?: string;
  databaseName?: string;
  summary?: { tables: number; views: number; procedures: number; functions: number; indexes: number; blockers: number; warnings: number };
  findings?: CompatFinding[];
  schemas?: string[];
  tables?: TableRow[];
  plan?: { statements: PlanStatement[] };
}
interface ImportResult { kind: string; object: string; status: 'ok' | 'error'; error?: string; recordsAffected?: number }
interface ImportResponse {
  ok: boolean; error?: string; code?: string; missing?: string[]; hint?: any;
  target?: { server: string; database: string };
  executed?: number; succeeded?: number; failed?: number; skipped?: number;
  results?: ImportResult[];
}

const SEV_META: Record<Severity, { intent: 'error' | 'warning' | 'info'; label: string }> = {
  blocker: { intent: 'error', label: 'Blocker' },
  warning: { intent: 'warning', label: 'Warning' },
  info: { intent: 'info', label: 'Info' },
};

function SummaryCard({ num, label, accent }: { num: number; label: string; accent?: string }) {
  const s = useStyles();
  return (
    <div className={s.summaryCard}>
      <div className={s.summaryNum} style={accent ? { color: accent } : undefined}>{num}</div>
      <Caption1 className={s.summaryLabel}>{label}</Caption1>
    </div>
  );
}

export function SqlMigrationPane() {
  const s = useStyles();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [assessing, setAssessing] = useState(false);
  const [assessment, setAssessment] = useState<AssessResponse | null>(null);
  const [assessError, setAssessError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);

  const step = importResult ? 3 : assessment ? 2 : 1;

  const onFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setAssessError(null);
    setAssessment(null);
    setImportResult(null);
    setAssessing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/sqldb/migration/assess', { method: 'POST', body: fd });
      const data: AssessResponse = await res.json();
      if (!res.ok || !data.ok) {
        setAssessError(data.error || `Assessment failed (HTTP ${res.status})`);
      } else {
        setAssessment(data);
      }
    } catch (e: any) {
      setAssessError(e?.message || String(e));
    } finally {
      setAssessing(false);
    }
  }, []);

  const runImport = useCallback(async () => {
    if (!assessment?.plan?.statements?.length) return;
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch('/api/sqldb/migration/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statements: assessment.plan.statements }),
      });
      const data: ImportResponse = await res.json();
      setImportResult(data);
    } catch (e: any) {
      setImportResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setImporting(false);
    }
  }, [assessment]);

  const reset = useCallback(() => {
    setFileName(''); setAssessment(null); setAssessError(null); setImportResult(null);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const findingCols: LoomColumn<CompatFinding>[] = useMemo(() => [
    {
      key: 'severity', label: 'Severity', width: 110, filterType: 'select',
      render: (r) => <Badge appearance="tint" color={r.severity === 'blocker' ? 'danger' : r.severity === 'warning' ? 'warning' : 'informative'}>{SEV_META[r.severity].label}</Badge>,
      getValue: (r) => r.severity,
    },
    { key: 'object', label: 'Object', width: 240 },
    {
      key: 'message', label: 'Finding', width: 420,
      render: (r) => (
        <span>
          {r.message}{' '}
          {r.doc && <Link href={r.doc} target="_blank" rel="noreferrer">Learn more</Link>}
        </span>
      ),
    },
  ], []);

  const tableCols: LoomColumn<TableRow>[] = useMemo(() => [
    { key: 'schema', label: 'Schema', width: 140, filterType: 'select' },
    { key: 'name', label: 'Table', width: 280 },
    { key: 'columnCount', label: 'Columns', width: 100, getValue: (r) => r.columnCount },
  ], []);

  const resultCols: LoomColumn<ImportResult>[] = useMemo(() => [
    { key: 'kind', label: 'Type', width: 120, filterType: 'select' },
    { key: 'object', label: 'Object', width: 280 },
    {
      key: 'status', label: 'Status', width: 120, filterType: 'select',
      render: (r) => r.status === 'ok'
        ? <Badge appearance="tint" color="success" icon={<CheckmarkCircle24Filled />}>Created</Badge>
        : <Badge appearance="tint" color="danger" icon={<DismissCircle24Filled />}>Failed</Badge>,
      getValue: (r) => r.status,
    },
    { key: 'error', label: 'Detail', width: 420, render: (r) => r.error || (r.recordsAffected != null ? `${r.recordsAffected} rows` : '—') },
  ], []);

  const sum = assessment?.summary;
  const importGated = importResult && !importResult.ok && importResult.code === 'not-configured';

  return (
    <div className={s.root}>
      <div className={s.steps}>
        {[
          { n: 1, label: 'Upload .dacpac' },
          { n: 2, label: 'Assess compatibility' },
          { n: 3, label: 'Import to Synapse' },
        ].map((st) => (
          <div key={st.n} className={`${s.stepPill} ${step >= st.n ? s.stepActive : ''}`}>
            <Badge appearance={step >= st.n ? 'filled' : 'outline'} color={step >= st.n ? 'brand' : 'subtle'} size="small">{st.n}</Badge>
            {st.label}
          </div>
        ))}
      </div>

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Azure-native migration</MessageBarTitle>
          Upload a SQL Server / Azure SQL <code>.dacpac</code>. The assistant parses its schema, flags features
          unsupported by the Synapse <strong>Dedicated SQL pool</strong>, and imports the compatible schema over the
          live TDS connection. No Microsoft Fabric capacity required.
        </MessageBarBody>
      </MessageBar>

      {/* Step 1 — upload */}
      <Card>
        <CardHeader
          image={<ArrowUpload24Regular />}
          header={<Subtitle2>1. Upload data-tier package</Subtitle2>}
          description={<Caption1>A .dacpac is the schema package produced by SqlPackage / SSDT / SSMS &quot;Extract Data-tier Application&quot;.</Caption1>}
        />
        <div className={s.uploadZone}>
          <Database24Regular style={{ fontSize: 36, color: tokens.colorBrandForeground1 }} />
          <Body1>{fileName ? <strong>{fileName}</strong> : 'Choose a .dacpac file to assess'}</Body1>
          <input
            ref={fileRef}
            type="file"
            accept=".dacpac,application/octet-stream"
            aria-label="DACPAC file to migrate"
            className={s.hidden}
            onChange={(e) => onFile(e.target.files?.[0] || null)}
          />
          <div className={s.actions}>
            <Button appearance="primary" icon={<ArrowUpload24Regular />} disabled={assessing} onClick={() => fileRef.current?.click()}>
              {fileName ? 'Choose a different file' : 'Choose .dacpac'}
            </Button>
            {(assessment || fileName) && <Button appearance="subtle" onClick={reset}>Reset</Button>}
          </div>
          {assessing && <Spinner size="small" label="Parsing and assessing schema…" />}
        </div>
      </Card>

      {assessError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not assess this file</MessageBarTitle>
            {assessError}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Step 2 — assessment */}
      {assessment && sum && (
        <Card>
          <CardHeader
            image={<DocumentTable24Regular />}
            header={<Subtitle2>2. Compatibility assessment — {assessment.databaseName}</Subtitle2>}
            description={<Caption1>Assessed against Azure Synapse Dedicated SQL pool feature support.</Caption1>}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 16px 16px' }}>
            <div className={s.summaryGrid}>
              <SummaryCard num={sum.tables} label="Tables" />
              <SummaryCard num={sum.views} label="Views" />
              <SummaryCard num={sum.procedures} label="Procedures" />
              <SummaryCard num={sum.functions} label="Functions" />
              <SummaryCard num={sum.indexes} label="Indexes" />
              <SummaryCard num={sum.blockers} label="Blockers" accent={sum.blockers ? tokens.colorPaletteRedForeground1 : undefined} />
              <SummaryCard num={sum.warnings} label="Warnings" accent={sum.warnings ? tokens.colorPaletteDarkOrangeForeground1 : undefined} />
            </div>

            {sum.blockers === 0 && sum.warnings === 0 ? (
              <MessageBar intent="success">
                <MessageBarBody>
                  <MessageBarTitle>Fully compatible</MessageBarTitle>
                  <CheckmarkCircle24Filled style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  Every object in this package imports into the dedicated SQL pool as-is.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <MessageBar intent={sum.blockers ? 'warning' : 'info'}>
                <MessageBarBody>
                  <MessageBarTitle>{sum.blockers} blocker(s), {sum.warnings} warning(s)</MessageBarTitle>
                  Blockers are skipped during import; warnings import with a documented behavior change. Review below.
                </MessageBarBody>
              </MessageBar>
            )}

            {assessment.findings && assessment.findings.length > 0 && (
              <div>
                <Caption1 style={{ marginBottom: 4, display: 'block' }}>Findings</Caption1>
                <LoomDataTable<CompatFinding>
                  columns={findingCols}
                  rows={assessment.findings}
                  getRowId={(r) => `${r.rule}:${r.object}`}
                />
              </div>
            )}

            <Divider />
            <div>
              <Caption1 style={{ marginBottom: 4, display: 'block' }}>Table inventory</Caption1>
              <LoomDataTable<TableRow>
                columns={tableCols}
                rows={assessment.tables || []}
                getRowId={(r) => `${r.schema}.${r.name}`}
              />
            </div>

            <Divider />
            <div className={s.actions}>
              <Button
                appearance="primary"
                icon={<PlayCircle24Regular />}
                disabled={importing || !assessment.plan?.statements?.length}
                onClick={runImport}
              >
                Import compatible schema to Synapse
              </Button>
              {importing && <Spinner size="small" label="Executing DDL on the dedicated pool…" />}
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                {assessment.plan?.statements.filter((x) => !x.skipped && !/^\s*--/.test(x.sql)).length || 0} statement(s) will run.
              </Caption1>
            </div>
          </div>
        </Card>
      )}

      {/* Step 3 — import receipt */}
      {importResult && (
        <Card>
          <CardHeader
            image={importResult.ok ? <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : <Warning24Filled style={{ color: tokens.colorPaletteDarkOrangeForeground1 }} />}
            header={<Subtitle2>3. Import receipt</Subtitle2>}
            description={importResult.target && <Caption1>{importResult.target.server} / {importResult.target.database}</Caption1>}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 16px 16px' }}>
            {importGated ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Synapse Dedicated SQL pool not configured</MessageBarTitle>
                  {importResult.error}{' '}
                  {importResult.missing && <>Set: <code>{importResult.missing.join(', ')}</code>.</>}
                  {importResult.hint?.bicepModule && <> Deploy via <code>{importResult.hint.bicepModule}</code>.</>}
                </MessageBarBody>
              </MessageBar>
            ) : importResult.error && !importResult.results ? (
              <MessageBar intent="error"><MessageBarBody>{importResult.error}</MessageBarBody></MessageBar>
            ) : (
              <>
                <div className={s.summaryGrid}>
                  <SummaryCard num={importResult.succeeded || 0} label="Created" accent={tokens.colorPaletteGreenForeground1} />
                  <SummaryCard num={importResult.failed || 0} label="Failed" accent={(importResult.failed || 0) ? tokens.colorPaletteRedForeground1 : undefined} />
                  <SummaryCard num={importResult.skipped || 0} label="Skipped (incompatible)" />
                </div>
                {importResult.results && importResult.results.length > 0 && (
                  <LoomDataTable<ImportResult>
                    columns={resultCols}
                    rows={importResult.results}
                    getRowId={(r) => `${r.kind}:${r.object}`}
                  />
                )}
                <div className={s.actions}>
                  <Button appearance="subtle" onClick={reset}>Migrate another package</Button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
