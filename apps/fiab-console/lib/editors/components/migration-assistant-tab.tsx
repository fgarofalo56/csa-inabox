'use client';

/**
 * MigrationAssistantTab — SQL DB migration assistant for the Warehouse editor.
 *
 * Azure-native equivalent of Fabric's "Migration Assistant for Fabric Data
 * Warehouse" (Build 2026 #22). A three-step wizard:
 *
 *   1. Upload      — pick a .dacpac (data-tier application) extracted from the
 *                    source SQL Server / Azure SQL DB.
 *   2. Assess      — POST action=scan → the BFF parses the model in-process and
 *                    runs the dedicated-SQL-pool compatibility scan, returning a
 *                    graded findings list + the generated, dedicated-pool-safe
 *                    DDL preview. Read-only.
 *   3. Import      — choose distribution/index, then POST action=deploy → the
 *                    BFF executes the DDL on the LIVE Synapse Dedicated SQL pool
 *                    over TDS and returns per-object results.
 *
 * No Fabric / Power BI dependency — works with LOOM_DEFAULT_FABRIC_WORKSPACE
 * unset. Every control hits the real /api/items/warehouse/[id]/migrate route.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dropdown,
  Option,
  Switch,
  Spinner,
  Text,
  Title3,
  Body1,
  Caption1,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowUpload20Regular,
  CheckmarkCircle20Filled,
  Warning20Filled,
  ErrorCircle20Filled,
  Info20Regular,
  DatabaseArrowUp20Regular,
  Copy20Regular,
  CheckmarkCircle20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1000px' },
  steps: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  step: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'background-color, border-color, color', transitionDuration: tokens.durationNormal,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  stepActive: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  stepDone: {
    ...shorthands.borderColor(tokens.colorPaletteGreenBorder1),
    color: tokens.colorNeutralForeground1,
  },
  stepConnector: {
    flexGrow: 1, minWidth: '12px', maxWidth: '48px', height: '2px',
    backgroundColor: tokens.colorNeutralStroke2, borderRadius: tokens.borderRadiusSmall,
    transitionProperty: 'background-color', transitionDuration: tokens.durationNormal,
  },
  stepConnectorDone: { backgroundColor: tokens.colorPaletteGreenBorder1 },
  card: { padding: tokens.spacingVerticalL },
  dropZone: {
    ...shorthands.border('2px', 'dashed', tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalXXL, textAlign: 'center', cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    transitionProperty: 'border-color, background-color', transitionDuration: tokens.durationNormal,
    ':hover': { ...shorthands.borderColor(tokens.colorNeutralStroke1Hover), backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': {
      outlineWidth: '2px', outlineStyle: 'solid', outlineColor: tokens.colorBrandStroke1, outlineOffset: '2px',
    },
  },
  dropZoneActive: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorBrandBackground2 },
  dropIcon: { color: tokens.colorBrandForeground1, fontSize: '32px' },
  counts: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  controls: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '180px' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  previewHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalXS,
  },
  pre: {
    backgroundColor: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium, fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', maxHeight: '320px', overflow: 'auto',
    margin: 0, ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  cleanState: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorPaletteGreenBorder1),
  },
  hidden: { display: 'none' },
});

type Severity = 'block' | 'warn' | 'info';
interface Finding { severity: Severity; rule: string; object: string; message: string; remediation: string; autoFixed: boolean; }
interface CompatReport { findings: Finding[]; blockers: number; warnings: number; infos: number; deployable: boolean; }
interface ScanResp {
  ok: boolean; error?: string; notConfigured?: boolean;
  fileName?: string;
  metadata?: { name?: string; version?: string; description?: string };
  counts?: Record<string, number>;
  objectCount?: number; columnCount?: number;
  report?: CompatReport;
  preview?: { statementCount: number; script: string; skipped: string[] };
}
interface DeployResp {
  ok: boolean; error?: string; state?: string;
  deploy?: { executed: number; failed: number; results: { object: string; type: string; ok: boolean; error?: string }[] };
  skipped?: string[];
  pool?: string;
}
interface PoolState { ok: boolean; pool?: string | null; state?: string; sku?: string | null; online?: boolean; }

const PRETTY_TYPE: Record<string, string> = {
  SqlTable: 'Tables', SqlView: 'Views', SqlProcedure: 'Procedures',
  SqlScalarFunction: 'Scalar functions', SqlInlineTableValuedFunction: 'Inline TVFs',
  SqlMultiStatementTableValuedFunction: 'Multi-statement TVFs',
  SqlForeignKeyConstraint: 'Foreign keys', SqlPrimaryKeyConstraint: 'Primary keys',
  SqlCheckConstraint: 'Check constraints', SqlIndex: 'Indexes', SqlSchema: 'Schemas',
};

function sevIcon(s: Severity) {
  if (s === 'block') return <ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
  if (s === 'warn') return <Warning20Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <Info20Regular style={{ color: tokens.colorNeutralForeground3 }} />;
}

export function MigrationAssistantTab({ id }: { id: string }) {
  const s = useStyles();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [scan, setScan] = useState<ScanResp | null>(null);
  const [scanning, setScanning] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deploy, setDeploy] = useState<DeployResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [copied, setCopied] = useState(false);

  const [distribution, setDistribution] = useState<'ROUND_ROBIN' | 'HASH' | 'REPLICATE'>('ROUND_ROBIN');
  const [index, setIndex] = useState<'CLUSTERED COLUMNSTORE INDEX' | 'HEAP'>('CLUSTERED COLUMNSTORE INDEX');
  const [ifNotExists, setIfNotExists] = useState(true);

  const base = `/api/items/warehouse/${encodeURIComponent(id)}/migrate`;

  useEffect(() => {
    let live = true;
    fetch(base).then((r) => r.json()).then((j: PoolState) => { if (live) setPool(j); }).catch(() => {});
    return () => { live = false; };
  }, [base]);

  const pickFile = useCallback((f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setScan(null);
    setDeploy(null);
    setError(null);
  }, []);

  const runScan = useCallback(async () => {
    if (!file) return;
    setScanning(true); setError(null); setDeploy(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('action', 'scan');
      const r = await fetch(base, { method: 'POST', body: fd });
      const j: ScanResp = await r.json();
      if (!j.ok) { setError(j.error || 'Scan failed.'); setScan(j); }
      else setScan(j);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setScanning(false);
    }
  }, [base, file]);

  const runDeploy = useCallback(async () => {
    if (!file) return;
    setDeploying(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('action', 'deploy');
      fd.append('distribution', distribution);
      fd.append('index', index);
      fd.append('ifNotExists', String(ifNotExists));
      const r = await fetch(base, { method: 'POST', body: fd });
      const j: DeployResp = await r.json();
      setDeploy(j);
      if (!j.ok && j.error) setError(j.error);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setDeploying(false);
    }
  }, [base, file, distribution, index, ifNotExists]);

  const copyDdl = useCallback(() => {
    const script = scan?.preview?.script;
    if (!script) return;
    void navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, [scan?.preview?.script]);

  const report = scan?.ok ? scan.report : undefined;
  const step = deploy ? 4 : report ? 3 : file ? 2 : 1;

  return (
    <div className={s.root}>
      <div>
        <Title3>SQL DB migration assistant</Title3>
        <Body1 block>
          Import a SQL Server / Azure SQL Database schema (.dacpac) into this warehouse&apos;s
          Synapse Dedicated SQL pool, with an automatic dedicated-pool compatibility assessment.
        </Body1>
      </div>

      <div className={s.steps} role="list" aria-label="Migration steps">
        <div role="listitem" aria-current={step === 1 ? 'step' : undefined} className={`${s.step} ${step >= 1 ? s.stepActive : ''} ${step > 1 ? s.stepDone : ''}`}>
          {step > 1 ? <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : <Text>1</Text>}
          <Text>Upload .dacpac</Text>
        </div>
        <div className={`${s.stepConnector} ${step > 1 ? s.stepConnectorDone : ''}`} aria-hidden />
        <div role="listitem" aria-current={step === 2 ? 'step' : undefined} className={`${s.step} ${step >= 2 ? s.stepActive : ''} ${step > 2 ? s.stepDone : ''}`}>
          {step > 2 ? <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : <Text>2</Text>}
          <Text>Assess compatibility</Text>
        </div>
        <div className={`${s.stepConnector} ${step > 2 ? s.stepConnectorDone : ''}`} aria-hidden />
        <div role="listitem" aria-current={step >= 3 ? 'step' : undefined} className={`${s.step} ${step >= 3 ? s.stepActive : ''} ${step > 3 ? s.stepDone : ''}`}>
          {step > 3 ? <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : <Text>3</Text>}
          <Text>Import to pool</Text>
        </div>
      </div>

      {/* Target pool badge / honest gate */}
      {pool && (
        pool.pool ? (
          <div className={s.counts}>
            <Badge appearance="outline" icon={<DatabaseArrowUp20Regular />}>{pool.pool}</Badge>
            <Badge appearance="filled" color={pool.online ? 'success' : 'warning'}>{pool.state}</Badge>
            {pool.sku && <Badge appearance="outline">{pool.sku}</Badge>}
          </div>
        ) : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>No Dedicated SQL pool bound</MessageBarTitle>
              Set <code>LOOM_SYNAPSE_WORKSPACE</code> and <code>LOOM_SYNAPSE_DEDICATED_POOL</code>{' '}
              (provisioned by <code>platform/fiab/bicep/modules/analytics/synapse.bicep</code>) to enable schema import.
              You can still upload and assess a .dacpac without a pool bound.
            </MessageBarBody>
          </MessageBar>
        )
      )}

      {/* Step 1 — upload */}
      <Card className={s.card}>
        <CardHeader header={<Text weight="semibold">1. Upload data-tier application (.dacpac)</Text>} />
        <div
          className={`${s.dropZone} ${dragOver ? s.dropZoneActive : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
        >
          <ArrowUpload20Regular className={s.dropIcon} />
          <Text weight="semibold">{file ? file.name : 'Drop a .dacpac here, or click to browse'}</Text>
          <Caption1>
            {file
              ? `${(file.size / 1024).toFixed(0)} KiB — extract one with SqlPackage /Action:Extract or SSDT`
              : 'A DACPAC is a schema model (tables, views, procedures). Max 50 MiB.'}
          </Caption1>
          <input
            ref={fileRef}
            className={s.hidden}
            type="file"
            accept=".dacpac,application/octet-stream"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </div>
        <div className={s.actions} style={{ marginTop: tokens.spacingVerticalM }}>
          <Button appearance="primary" disabled={!file || scanning} onClick={runScan} icon={scanning ? <Spinner size="tiny" /> : undefined}>
            {scanning ? 'Assessing…' : 'Assess compatibility'}
          </Button>
          {file && <Button appearance="subtle" onClick={() => pickFile(null as any)} disabled={scanning}>Clear</Button>}
        </div>
      </Card>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Migration assistant</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Step 2 — assessment results */}
      {scan?.ok && report && (
        <Card className={s.card}>
          <CardHeader
            header={<Text weight="semibold">2. Compatibility assessment</Text>}
            description={
              <Caption1>
                {scan.metadata?.name ? `Source: ${scan.metadata.name}` : ''}{scan.metadata?.version ? ` v${scan.metadata.version}` : ''}
              </Caption1>
            }
          />
          <div className={s.counts} style={{ marginBottom: tokens.spacingVerticalM }}>
            {Object.entries(scan.counts || {})
              .filter(([t]) => PRETTY_TYPE[t])
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => (
                <Badge key={t} appearance="outline">{PRETTY_TYPE[t]}: {n}</Badge>
              ))}
          </div>
          <div className={s.counts} style={{ marginBottom: tokens.spacingVerticalM }}>
            <Badge appearance="filled" color={report.blockers ? 'danger' : 'success'}>{report.blockers} blocker(s)</Badge>
            <Badge appearance="filled" color={report.warnings ? 'warning' : 'success'}>{report.warnings} change(s) on import</Badge>
            <Badge appearance="outline">{report.infos} note(s)</Badge>
            <Badge appearance="filled" color={report.deployable ? 'success' : 'danger'}>
              {report.deployable ? 'Ready to import' : 'Not deployable'}
            </Badge>
          </div>

          {report.findings.length === 0 && (
            <div className={s.cleanState}>
              <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />
              <Text weight="semibold">No compatibility issues found — every object maps cleanly to the dedicated SQL pool.</Text>
            </div>
          )}

          {report.findings.length > 0 && (
            <Table size="small" aria-label="Compatibility findings">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell style={{ width: 36 }}> </TableHeaderCell>
                  <TableHeaderCell>Object</TableHeaderCell>
                  <TableHeaderCell>Finding</TableHeaderCell>
                  <TableHeaderCell>Remediation</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.findings.map((f, i) => (
                  <TableRow key={`${f.rule}-${i}`}>
                    <TableCell>{sevIcon(f.severity)}</TableCell>
                    <TableCell><Caption1>{f.object || '—'}</Caption1></TableCell>
                    <TableCell><Caption1>{f.message}</Caption1></TableCell>
                    <TableCell><Caption1>{f.remediation}{f.autoFixed ? ' (auto)' : ''}</Caption1></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {scan.preview && (
            <div style={{ marginTop: tokens.spacingVerticalL }}>
              <div className={s.previewHead}>
                <Text weight="semibold">Generated DDL preview ({scan.preview.statementCount} statement(s))</Text>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={copied ? <CheckmarkCircle20Regular /> : <Copy20Regular />}
                  onClick={copyDdl}
                  disabled={!scan.preview.script}
                >
                  {copied ? 'Copied' : 'Copy DDL'}
                </Button>
              </div>
              <pre className={s.pre}>{scan.preview.script || '-- nothing to deploy'}</pre>
              {scan.preview.skipped.length > 0 && (
                <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>{scan.preview.skipped.length} object(s) skipped</MessageBarTitle>
                    {scan.preview.skipped.join('; ')}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Step 3 — import */}
      {scan?.ok && report && (
        <Card className={s.card}>
          <CardHeader header={<Text weight="semibold">3. Import to Synapse Dedicated SQL pool</Text>} />
          <div className={s.controls} style={{ marginBottom: tokens.spacingVerticalM }}>
            <div className={s.field}>
              <Caption1>Default distribution</Caption1>
              <Dropdown
                value={distribution}
                selectedOptions={[distribution]}
                onOptionSelect={(_, d) => setDistribution((d.optionValue as any) || 'ROUND_ROBIN')}
              >
                <Option value="ROUND_ROBIN" text="ROUND_ROBIN">ROUND_ROBIN (default)</Option>
                <Option value="HASH" text="HASH">HASH</Option>
                <Option value="REPLICATE" text="REPLICATE">REPLICATE (small dims)</Option>
              </Dropdown>
            </div>
            <div className={s.field}>
              <Caption1>Default index</Caption1>
              <Dropdown
                value={index === 'HEAP' ? 'HEAP' : 'CLUSTERED COLUMNSTORE INDEX'}
                selectedOptions={[index]}
                onOptionSelect={(_, d) => setIndex((d.optionValue as any) || 'CLUSTERED COLUMNSTORE INDEX')}
              >
                <Option value="CLUSTERED COLUMNSTORE INDEX" text="CLUSTERED COLUMNSTORE INDEX">Clustered columnstore (default)</Option>
                <Option value="HEAP" text="HEAP">Heap</Option>
              </Dropdown>
            </div>
            <div className={s.field}>
              <Caption1>Idempotent</Caption1>
              <Switch checked={ifNotExists} onChange={(_, d) => setIfNotExists(d.checked)} label="Skip objects that already exist" />
            </div>
          </div>
          <div className={s.actions}>
            <Button
              appearance="primary"
              icon={deploying ? <Spinner size="tiny" /> : <DatabaseArrowUp20Regular />}
              disabled={deploying || !report.deployable || pool?.online === false || !pool?.pool}
              onClick={runDeploy}
            >
              {deploying ? 'Importing…' : 'Import schema'}
            </Button>
            {!pool?.pool && <Caption1>Bind a Dedicated SQL pool to enable import.</Caption1>}
            {pool?.pool && pool?.online === false && <Caption1>Resume the Dedicated SQL pool to enable import.</Caption1>}
          </div>
        </Card>
      )}

      {/* Step 4 — results */}
      {deploy && (
        <Card className={s.card}>
          <CardHeader header={<Text weight="semibold">4. Import results</Text>} />
          {deploy.deploy ? (
            <>
              <div className={s.counts} style={{ marginBottom: tokens.spacingVerticalM }}>
                <Badge appearance="filled" color="success">{deploy.deploy.executed} executed</Badge>
                <Badge appearance="filled" color={deploy.deploy.failed ? 'danger' : 'success'}>{deploy.deploy.failed} failed</Badge>
                {deploy.pool && <Badge appearance="outline">{deploy.pool}</Badge>}
              </div>
              <Table size="small" aria-label="Import results">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell style={{ width: 36 }}> </TableHeaderCell>
                    <TableHeaderCell>Object</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Result</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deploy.deploy.results.map((r, i) => (
                    <TableRow key={`${r.object}-${i}`}>
                      <TableCell>{r.ok ? <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : <ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />}</TableCell>
                      <TableCell><Caption1>{r.object}</Caption1></TableCell>
                      <TableCell><Caption1>{r.type}</Caption1></TableCell>
                      <TableCell><Caption1>{r.ok ? 'Created' : (r.error || 'Failed')}</Caption1></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <MessageBar intent="error"><MessageBarBody>{deploy.error || 'Import failed.'}</MessageBarBody></MessageBar>
          )}
        </Card>
      )}
    </div>
  );
}
