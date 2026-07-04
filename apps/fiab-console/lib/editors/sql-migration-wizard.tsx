'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * sql-migration-wizard.tsx — the SQL DB migration assistant surface.
 *
 * A three-step wizard that brings the SQL Server / Azure SQL → Synapse
 * Dedicated SQL pool migration flow (a DACPAC import + compatibility
 * assessment, the same job SSMA / Synapse Pathway do) into Loom, themed with
 * Fluent v9:
 *
 *   1. Upload   — drop / pick a .dacpac (the schema-only data-tier package).
 *   2. Assess   — POST /api/items/warehouse/migrate/scan parses the package and
 *                 returns a real compatibility report (object counts + findings)
 *                 plus the generated Dedicated-pool DDL.
 *   3. Import   — POST /api/items/warehouse/migrate/import executes the DDL
 *                 against the LIVE Synapse Dedicated SQL pool, with a per-object
 *                 result and an object-kind filter (schema-only first, etc.).
 *
 * Every control calls a real backend (no-vaporware.md). Azure-native default:
 * no Fabric workspace is read (no-fabric-dependency.md). Honest gates surface
 * the precise pool/env remediation when import can't run.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { shorthands,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Badge,
  Card,
  CardHeader,
  Text,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  Checkbox,
  Textarea,
  Divider,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowUpload20Regular,
  CheckmarkCircle20Filled,
  Warning20Filled,
  Info20Regular,
  DatabasePlugConnected20Regular,
  DocumentArrowDown20Regular,
} from '@fluentui/react-icons';

// ── Response shapes (mirror the BFF routes) ─────────────────────────────────

type Severity = 'error' | 'warning' | 'info';

interface CompatFinding {
  severity: Severity;
  object: string;
  rule: string;
  message: string;
  remediation?: string;
}

interface CompatReport {
  packageName?: string;
  packageVersion?: string;
  sourceCompatLevel?: number;
  counts: {
    schemas: number; tables: number; columns: number;
    views: number; procedures: number; functions: number; triggers: number;
  };
  findings: CompatFinding[];
  importable: boolean;
}

interface DdlStatement { kind: 'schema' | 'table' | 'view' | 'procedure' | 'function'; name: string; sql: string; }

interface ScanResponse {
  ok: boolean;
  error?: string;
  fileName?: string;
  report?: CompatReport;
  ddl?: { statements: DdlStatement[]; script: string };
}

interface ImportResult { kind: string; name: string; status: 'applied' | 'failed'; recordsAffected?: number; error?: string; }
interface ImportResponse {
  ok: boolean;
  error?: string;
  gate?: { reason: string; remediation: string };
  state?: string;
  summary?: { total: number; applied: number; failed: number };
  results?: ImportResult[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingVerticalL, maxWidth: '1100px' },
  steps: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  step: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  stepDot: {
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  stepDotActive: { backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  stepDotDone: { backgroundColor: tokens.colorPaletteGreenBackground3, color: tokens.colorNeutralForegroundOnBrand },
  stepLabelActive: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  stepLabelIdle: { color: tokens.colorNeutralForeground3 },
  stepConnector: { width: '28px', height: '2px', backgroundColor: tokens.colorNeutralStroke2, margin: `0 ${tokens.spacingHorizontalXS}` },
  stepConnectorDone: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  dropZone: {
    border: `2px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalXXXL,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground2,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  dropActive: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorBrandBackground2 },
  countGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: tokens.spacingVerticalS },
  countCard: { padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  countValue: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1, lineHeight: '1.1' },
  countLabel: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  scriptArea: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, width: '100%' },
  findingsToolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  sevChip: { cursor: 'pointer', userSelect: 'none' },
  emptyFindings: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalXXL, marginTop: tokens.spacingVerticalS,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
  },
  monoCode: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  // Long object names / messages / errors must wrap inside table cells, never
  // push the table (and the whole surface) into horizontal overflow.
  wrapCell: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableScroll: { width: '100%', overflowX: 'auto' },
});

function severityBadge(sev: Severity) {
  if (sev === 'error') return <Badge color="danger" appearance="tint" icon={<Warning20Filled />}>Error</Badge>;
  if (sev === 'warning') return <Badge color="warning" appearance="tint" icon={<Warning20Filled />}>Warning</Badge>;
  return <Badge color="informative" appearance="tint" icon={<Info20Regular />}>Info</Badge>;
}

const KIND_ORDER: DdlStatement['kind'][] = ['schema', 'table', 'view', 'procedure', 'function'];

export function SqlMigrationWizard() {
  const s = useStyles();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [selectedKinds, setSelectedKinds] = useState<Set<DdlStatement['kind']>>(new Set(KIND_ORDER));
  const [sevFilter, setSevFilter] = useState<Set<Severity>>(new Set(['error', 'warning', 'info']));
  const [importing, setImporting] = useState(false);
  const [importResp, setImportResp] = useState<ImportResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setScan(null); setScanError(null); setImportResp(null); setImportError(null);
    setSelectedKinds(new Set(KIND_ORDER));
    setSevFilter(new Set<Severity>(['error', 'warning', 'info']));
  }, []);

  const toggleSev = useCallback((sev: Severity) => {
    setSevFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      // never allow an empty filter — re-enable all when the last is removed
      return next.size === 0 ? new Set<Severity>(['error', 'warning', 'info']) : next;
    });
  }, []);

  const pickFile = useCallback((f: File | null) => {
    if (!f) return;
    setFile(f);
    reset();
  }, [reset]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  }, [pickFile]);

  const runScan = useCallback(async () => {
    if (!file) return;
    setScanning(true);
    setScanError(null);
    setScan(null);
    setImportResp(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await clientFetch('/api/items/warehouse/migrate/scan', { method: 'POST', body: fd });
      const j = (await r.json()) as ScanResponse;
      if (!j.ok) { setScanError(j.error || 'Compatibility scan failed.'); return; }
      setScan(j);
    } catch (e: any) {
      setScanError(e?.message || String(e));
    } finally {
      setScanning(false);
    }
  }, [file]);

  const availableKinds = useMemo(() => {
    const present = new Set<DdlStatement['kind']>();
    for (const st of scan?.ddl?.statements ?? []) present.add(st.kind);
    return KIND_ORDER.filter((k) => present.has(k));
  }, [scan]);

  const kindCount = useCallback(
    (k: DdlStatement['kind']) => (scan?.ddl?.statements ?? []).filter((st) => st.kind === k).length,
    [scan],
  );

  const toggleKind = useCallback((k: DdlStatement['kind'], on: boolean) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(k); else next.delete(k);
      return next;
    });
  }, []);

  const runImport = useCallback(async () => {
    if (!file || !scan) return;
    setImporting(true);
    setImportError(null);
    setImportResp(null);
    try {
      const kinds = availableKinds.filter((k) => selectedKinds.has(k));
      const fd = new FormData();
      fd.append('file', file);
      const r = await clientFetch(
        `/api/items/warehouse/migrate/import?kinds=${encodeURIComponent(kinds.join(','))}`,
        { method: 'POST', body: fd },
      );
      const j = (await r.json()) as ImportResponse;
      setImportResp(j);
      if (!j.ok && !j.summary && !j.gate) {
        setImportError(j.error || `Import failed${j.state ? ` (compute is ${j.state})` : ''}.`);
      }
    } catch (e: any) {
      setImportError(e?.message || String(e));
    } finally {
      setImporting(false);
    }
  }, [file, scan, availableKinds, selectedKinds]);

  const downloadScript = useCallback(() => {
    const script = scan?.ddl?.script;
    if (!script) return;
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(scan?.fileName || 'migration').replace(/\.dacpac$/i, '')}-synapse.sql`;
    a.click();
    URL.revokeObjectURL(url);
  }, [scan]);

  const report = scan?.report;
  const errorFindings = report?.findings.filter((f) => f.severity === 'error') ?? [];
  const warnFindings = report?.findings.filter((f) => f.severity === 'warning') ?? [];
  const infoFindings = report?.findings.filter((f) => f.severity === 'info') ?? [];
  const orderedFindings = [...errorFindings, ...warnFindings, ...infoFindings];
  const visibleFindings = orderedFindings.filter((f) => sevFilter.has(f.severity));

  // Step state drives the progress rail: 1 upload → 2 assess → 3 import.
  const importDone = !!importResp?.summary;
  const assessDone = !!report;
  const currentStep = importDone ? 3 : assessDone ? 3 : file ? 2 : 1;

  return (
    <div className={s.root}>
      <div>
        <Text size={500} weight="semibold">Migration assistant</Text>
        <br />
        <Text size={200}>
          Import a SQL Server / Azure SQL data-tier application (.dacpac), assess
          its compatibility with the Synapse Dedicated SQL pool, and import the
          schema. No Microsoft Fabric required — the warehouse is backed by Azure
          Synapse.
        </Text>
      </div>

      {/* Progress rail */}
      <div className={s.steps} role="list" aria-label="Migration steps">
        {([
          [1, 'Upload', !!file],
          [2, 'Assess', assessDone],
          [3, 'Import', importDone],
        ] as const).map(([n, label, done], idx) => {
          const active = currentStep === n && !done;
          const prevDone = ([!!file, assessDone] as const)[idx - 1];
          return (
            <span key={n} className={s.step} role="listitem" aria-current={active ? 'step' : undefined}>
              {idx > 0 && <span className={`${s.stepConnector} ${prevDone ? s.stepConnectorDone : ''}`} aria-hidden />}
              <span className={s.step}>
                <span className={`${s.stepDot} ${done ? s.stepDotDone : active ? s.stepDotActive : ''}`}>
                  {done ? <CheckmarkCircle20Filled style={{ fontSize: tokens.fontSizeBase400 }} /> : n}
                </span>
                <Text size={300} className={active || done ? s.stepLabelActive : s.stepLabelIdle}>{label}</Text>
              </span>
            </span>
          );
        })}
      </div>

      {/* Step 1 — Upload */}
      <Card>
        <CardHeader header={<Text weight="semibold">1 · Upload .dacpac</Text>} />
        <div
          className={`${s.dropZone} ${dragOver ? s.dropActive : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
          aria-label="Upload a .dacpac file"
        >
          <ArrowUpload20Regular />
          <Text weight="semibold">{file ? file.name : 'Drop a .dacpac here or click to browse'}</Text>
          {file && <Text size={200}>{(file.size / 1024).toFixed(1)} KiB</Text>}
          <input
            ref={fileInputRef}
            type="file"
            accept=".dacpac,application/octet-stream,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className={s.actions} style={{ marginTop: tokens.spacingVerticalM }}>
          <Button
            appearance="primary"
            icon={scanning ? <Spinner size="tiny" /> : <Info20Regular />}
            disabled={!file || scanning}
            onClick={runScan}
          >
            {scanning ? 'Assessing…' : 'Assess compatibility'}
          </Button>
          {file && <Button appearance="subtle" disabled={scanning} onClick={() => { setFile(null); reset(); }}>Clear</Button>}
        </div>
        {scanError && (
          <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
            <MessageBarBody><MessageBarTitle>Scan failed</MessageBarTitle>{scanError}</MessageBarBody>
          </MessageBar>
        )}
      </Card>

      {/* Step 2 — Compatibility report */}
      {report && (
        <Card>
          <CardHeader
            header={<Text weight="semibold">2 · Compatibility report</Text>}
            description={
              <Text size={200}>
                {report.packageName ? `${report.packageName} ` : ''}
                {report.packageVersion ? `v${report.packageVersion} ` : ''}
                {report.sourceCompatLevel ? `· source compat ${report.sourceCompatLevel} ` : ''}
              </Text>
            }
          />
          <MessageBar intent={report.importable ? 'success' : 'warning'} style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>
              <MessageBarTitle>
                {report.importable ? 'Ready to import' : 'Importable with auto-remediation'}
              </MessageBarTitle>
              {report.importable
                ? 'No blocking issues. The generated DDL targets the Dedicated SQL pool.'
                : 'Some constructs are auto-remediated (unsupported types mapped, memory-optimized/temporal dropped). Review the findings, then import.'}
            </MessageBarBody>
          </MessageBar>

          <div className={s.countGrid}>
            {([
              ['Schemas', report.counts.schemas],
              ['Tables', report.counts.tables],
              ['Columns', report.counts.columns],
              ['Views', report.counts.views],
              ['Procedures', report.counts.procedures],
              ['Functions', report.counts.functions],
              ['Triggers', report.counts.triggers],
            ] as const).map(([label, val]) => (
              <Card key={label} className={s.countCard} appearance="subtle">
                <Text className={s.countValue}>{val}</Text>
                <Text size={200} className={s.countLabel}>{label}</Text>
              </Card>
            ))}
          </div>

          <Divider style={{ margin: `${tokens.spacingVerticalL} 0` }} />

          <Text weight="semibold">Findings</Text>
          {report.findings.length === 0 ? (
            <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalS }}>
              <MessageBarBody>
                <MessageBarTitle>No compatibility issues found</MessageBarTitle>
                Every object in the package maps cleanly to the Dedicated SQL pool.
              </MessageBarBody>
            </MessageBar>
          ) : (
            <>
              {/* Severity filter chips — click to show / hide a severity. */}
              <div className={s.findingsToolbar} role="group" aria-label="Filter findings by severity">
                {([
                  ['error', 'danger', errorFindings.length, 'Errors'],
                  ['warning', 'warning', warnFindings.length, 'Warnings'],
                  ['info', 'informative', infoFindings.length, 'Info'],
                ] as const).map(([sev, color, count, label]) => {
                  const on = sevFilter.has(sev);
                  return (
                    <Badge
                      key={sev}
                      className={s.sevChip}
                      color={color}
                      appearance={on ? 'filled' : 'outline'}
                      role="checkbox"
                      aria-checked={on}
                      tabIndex={0}
                      onClick={() => toggleSev(sev)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSev(sev); } }}
                    >
                      {count} {label}
                    </Badge>
                  );
                })}
              </div>
              {visibleFindings.length === 0 ? (
                <div className={s.emptyFindings}>
                  <Info20Regular />
                  <Text size={200}>No findings match the selected severities.</Text>
                </div>
              ) : (
                <div className={s.tableScroll} style={{ marginTop: tokens.spacingVerticalS }}>
                  <Table size="small" aria-label="Compatibility findings">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell style={{ width: 110 }}>Severity</TableHeaderCell>
                        <TableHeaderCell style={{ width: 220 }}>Object</TableHeaderCell>
                        <TableHeaderCell>Issue</TableHeaderCell>
                        <TableHeaderCell>Handling</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleFindings.map((f, i) => (
                        <TableRow key={`${f.object}-${f.rule}-${i}`}>
                          <TableCell>{severityBadge(f.severity)}</TableCell>
                          <TableCell className={s.wrapCell}><span className={s.monoCode}>{f.object}</span></TableCell>
                          <TableCell className={s.wrapCell}>{f.message}</TableCell>
                          <TableCell className={s.wrapCell}>{f.remediation || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {scan?.ddl?.script && (
            <>
              <Divider style={{ margin: `${tokens.spacingVerticalL} 0` }} />
              <div className={s.actions}>
                <Text weight="semibold">Generated migration script ({scan.ddl.statements.length} statements)</Text>
                <Button size="small" appearance="subtle" icon={<DocumentArrowDown20Regular />} onClick={downloadScript}>
                  Download .sql
                </Button>
              </div>
              <Textarea
                className={s.scriptArea}
                value={scan.ddl.script}
                readOnly
                resize="vertical"
                rows={12}
                style={{ marginTop: tokens.spacingVerticalS }}
                aria-label="Generated migration T-SQL script"
              />
            </>
          )}
        </Card>
      )}

      {/* Step 3 — Import */}
      {scan?.ddl?.statements?.length ? (
        <Card>
          <CardHeader header={<Text weight="semibold">3 · Import schema into the warehouse</Text>} />
          <Text size={200}>
            Choose which object kinds to import, then run the DDL against the live
            Synapse Dedicated SQL pool. Compute must be Online.
          </Text>
          <div className={s.actions} style={{ marginTop: tokens.spacingVerticalM }}>
            {availableKinds.map((k) => (
              <Checkbox
                key={k}
                label={`${k[0].toUpperCase()}${k.slice(1)}s (${kindCount(k)})`}
                checked={selectedKinds.has(k)}
                onChange={(_, d) => toggleKind(k, !!d.checked)}
              />
            ))}
          </div>
          <div className={s.actions} style={{ marginTop: tokens.spacingVerticalM }}>
            <Button
              appearance="primary"
              icon={importing ? <Spinner size="tiny" /> : <DatabasePlugConnected20Regular />}
              disabled={importing || availableKinds.every((k) => !selectedKinds.has(k))}
              onClick={runImport}
            >
              {importing ? 'Importing…' : 'Import to warehouse'}
            </Button>
          </div>

          {importError && (
            <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
              <MessageBarBody><MessageBarTitle>Import failed</MessageBarTitle>{importError}</MessageBarBody>
            </MessageBar>
          )}

          {importResp?.gate && (
            <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}>
              <MessageBarBody>
                <MessageBarTitle>Warehouse not configured</MessageBarTitle>
                {importResp.gate.reason}
                <br />
                <Text size={200}>{importResp.gate.remediation}</Text>
              </MessageBarBody>
            </MessageBar>
          )}

          {importResp?.summary && (
            <>
              <MessageBar intent={importResp.ok ? 'success' : 'warning'} style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>
                    {importResp.ok ? 'Import complete' : 'Import completed with errors'}
                  </MessageBarTitle>
                  {importResp.summary.applied} applied · {importResp.summary.failed} failed · {importResp.summary.total} total
                </MessageBarBody>
              </MessageBar>
              <div className={s.tableScroll} style={{ marginTop: tokens.spacingVerticalS }}>
                <Table size="small" aria-label="Import results">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Kind</TableHeaderCell>
                      <TableHeaderCell>Object</TableHeaderCell>
                      <TableHeaderCell>Detail</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importResp.results?.map((r, i) => (
                      <TableRow key={`${r.name}-${i}`}>
                        <TableCell>
                          {r.status === 'applied'
                            ? <Badge color="success" appearance="tint" icon={<CheckmarkCircle20Filled />}>Applied</Badge>
                            : <Badge color="danger" appearance="tint" icon={<Warning20Filled />}>Failed</Badge>}
                        </TableCell>
                        <TableCell>{r.kind}</TableCell>
                        <TableCell className={s.wrapCell}><span className={s.monoCode}>{r.name}</span></TableCell>
                        <TableCell className={s.wrapCell}>{r.error || (r.status === 'applied' ? 'OK' : '—')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
