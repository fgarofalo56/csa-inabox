'use client';

/**
 * Index-my-estate wizard (AIF-3) — one-click "Add search index" from a lakehouse
 * / warehouse / ADX item, or from the AI Search editor over the whole estate.
 *
 * Parity with the Azure portal "Import and vectorize data" wizard, applied to
 * Loom's own estate. Five typed, default-ON-skippable steps:
 *   1. Source & connection  — auto-derived from the item's real ADLS Gen2 root
 *      (honest-gates warehouse / ADX with the exact reason + recommended path).
 *   2. Content & schema     — Documents vs Structured preset + the real source
 *      column → index field mapping table (confirm).
 *   3. Vectorization        — chunk size / overlap + the embedding deployment the
 *      skillset + query-time vectorizer use (reuses AIF-2 builders).
 *   4. Schedule & create    — optional recurrence, then orchestrate (POST /run).
 *   5. Finish               — created artifacts + a live test-query pane.
 *
 * Every step is a typed picker; the primary path is real REST end-to-end.
 * Honest gates render a Fluent MessageBar naming the exact env var / role.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Field, Input, Dropdown, Option, RadioGroup, Radio, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, Body1Strong, Caption1, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, Database20Regular, BrainCircuit20Regular,
  DocumentBulletList20Regular, Play16Regular, Warning20Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { SCHEDULE_PRESETS } from '@/lib/azure/search-field-shapes';
import type { IndexableSourceType, ContentPreset } from '@/lib/azure/index-my-data';

const useStyles = makeStyles({
  surface: { maxWidth: '860px', width: '90vw' },
  body: { display: 'flex', gap: tokens.spacingHorizontalL, minHeight: '420px' },
  rail: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    minWidth: '190px', borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalM,
  },
  railItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  railActive: { background: tokens.colorNeutralBackground1Selected },
  railNum: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
    background: tokens.colorNeutralBackground4, color: tokens.colorNeutralForeground2,
  },
  railNumActive: { background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  railNumDone: { background: tokens.colorPaletteGreenBackground3, color: tokens.colorNeutralForegroundOnBrand },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, overflowY: 'auto', maxHeight: '60vh' },
  kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`, alignItems: 'center' },
  code: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
  presetRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  hits: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  hitCard: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalM, background: tokens.colorNeutralBackground2 },
});

const STEP_LABELS = ['Source', 'Content & schema', 'Vectorization', 'Schedule & create', 'Finish'];

export interface WizardSourceRef {
  sourceType: IndexableSourceType;
  itemId: string;
  itemName?: string;
}

interface PlanColumn { name: string; type: string }
interface FieldMappingRow { source: string; sourceType: string; target: string; edmType: string }
interface Plan {
  ok: boolean;
  sourceType: IndexableSourceType;
  itemId: string;
  itemName: string;
  support: { supported: boolean; datasourceType?: string; reason?: string; recommended?: string };
  names: { dataSourceName: string; indexName: string; skillsetName: string; indexerName: string };
  embedding: { resourceUri: string; deploymentId: string; modelName: string; dimensions: number } | null;
  embeddingGate: string | null;
  searchConfigured: boolean;
  connection: { container: string; account: string; root: string; abfss: string; storageResourceId: string } | null;
  connectionGate: string | null;
  tableChoices: string[];
  columns: PlanColumn[];
  fieldMapping: FieldMappingRow[];
}

interface EstateSource { id: string; sourceType: IndexableSourceType; displayName: string; workspaceId: string; supported: boolean }

export function IndexMyDataWizard({
  open, onOpenChange, initialSource,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-bound source (launched from a source editor). Omit for estate-pick mode. */
  initialSource?: WizardSourceRef;
}) {
  const s = useStyles();

  const [step, setStep] = useState(0);
  // Estate-pick mode (AI Search entry point) — choose a source item first.
  const [estate, setEstate] = useState<EstateSource[] | null>(null);
  const [picked, setPicked] = useState<WizardSourceRef | null>(initialSource ?? null);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Options.
  const [preset, setPreset] = useState<ContentPreset>('documents');
  const [subPath, setSubPath] = useState('');
  const [chunkSize, setChunkSize] = useState(2000);
  const [chunkOverlap, setChunkOverlap] = useState(500);
  const [scheduleInterval, setScheduleInterval] = useState(''); // '' = run once

  // Run + finish.
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  // Test query.
  const [testQuery, setTestQuery] = useState('*');
  const [testing, setTesting] = useState(false);
  const [testHits, setTestHits] = useState<any>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const isEstateMode = !initialSource;

  // Reset when (re)opened.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setPicked(initialSource ?? null);
    setPlan(null); setPlanError(null);
    setPreset('documents'); setSubPath(''); setChunkSize(2000); setChunkOverlap(500); setScheduleInterval('');
    setRunning(false); setRunError(null); setResult(null);
    setTestQuery('*'); setTestHits(null); setTestError(null);
  }, [open, initialSource]);

  // Estate list (only in estate mode).
  useEffect(() => {
    if (!open || !isEstateMode || estate) return;
    let cancelled = false;
    clientFetch('/api/ai-search/index-my-data/sources')
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.ok) setEstate(j.sources || []); })
      .catch(() => { if (!cancelled) setEstate([]); });
    return () => { cancelled = true; };
  }, [open, isEstateMode, estate]);

  // Load the plan whenever a source is picked/bound.
  const loadPlan = useCallback(async (src: WizardSourceRef) => {
    setLoadingPlan(true); setPlanError(null); setPlan(null);
    try {
      const r = await clientFetch(`/api/ai-search/index-my-data/prepare?sourceType=${encodeURIComponent(src.sourceType)}&itemId=${encodeURIComponent(src.itemId)}`);
      const j = await r.json();
      if (!j?.ok) { setPlanError(j?.error || 'Failed to prepare the wizard.'); return; }
      setPlan(j as Plan);
    } catch (e: any) {
      setPlanError(e?.message || String(e));
    } finally {
      setLoadingPlan(false);
    }
  }, []);

  useEffect(() => {
    if (open && picked) loadPlan(picked);
  }, [open, picked, loadPlan]);

  const supported = !!plan?.support?.supported;
  const canCreate = !!plan && supported && plan.searchConfigured && !!plan.embedding && !!plan.connection;

  const runOrchestration = useCallback(async () => {
    if (!plan || !picked) return;
    setRunning(true); setRunError(null); setResult(null);
    try {
      const r = await clientFetch('/api/ai-search/index-my-data/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceType: picked.sourceType,
          itemId: picked.itemId,
          preset,
          chunkSize,
          chunkOverlap,
          subPath: subPath.trim() || undefined,
          scheduleInterval: scheduleInterval || undefined,
        }),
      }, 60000);
      const j = await r.json();
      if (!j?.ok) { setRunError(j?.error || 'Pipeline creation failed.'); return; }
      setResult(j);
      setStep(4);
    } catch (e: any) {
      setRunError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [plan, picked, preset, chunkSize, chunkOverlap, subPath, scheduleInterval]);

  const runTestQuery = useCallback(async () => {
    if (!result?.indexName) return;
    setTesting(true); setTestError(null); setTestHits(null);
    try {
      const r = await clientFetch(`/api/ai-search/indexes/${encodeURIComponent(result.indexName)}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ search: testQuery || '*', top: 5, count: true }),
      }, 30000);
      const j = await r.json();
      if (!j?.ok) { setTestError(j?.error || 'Query failed.'); return; }
      setTestHits(j.result);
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally {
      setTesting(false);
    }
  }, [result, testQuery]);

  // ---- Rendering ----
  const railItem = (idx: number, label: string) => {
    const active = step === idx;
    const done = step > idx || (idx === 4 && !!result);
    return (
      <div key={idx} className={`${s.railItem} ${active ? s.railActive : ''}`}>
        <span className={`${s.railNum} ${active ? s.railNumActive : ''} ${done && !active ? s.railNumDone : ''}`}>{idx + 1}</span>
        <Caption1 style={{ fontWeight: active ? tokens.fontWeightSemibold : tokens.fontWeightRegular }}>{label}</Caption1>
      </div>
    );
  };

  const gates = plan && (
    <>
      {!supported && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{plan.sourceType} can’t be indexed directly</MessageBarTitle>
            {plan.support.reason}
            {plan.support.recommended && <><br /><strong>Recommended:</strong> {plan.support.recommended}</>}
          </MessageBarBody>
        </MessageBar>
      )}
      {supported && !plan.searchConfigured && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Search not configured</MessageBarTitle>
            Set <code className={s.code}>LOOM_AI_SEARCH_SERVICE</code> on the Console Container App to a deployed
            search service. The UAMI needs <strong>Search Service Contributor</strong> + <strong>Search Index Data Contributor</strong>.
          </MessageBarBody>
        </MessageBar>
      )}
      {supported && plan.embeddingGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Embeddings not configured</MessageBarTitle>
            {plan.embeddingGate}
          </MessageBarBody>
        </MessageBar>
      )}
      {supported && !plan.connectionGate && plan.embedding && (
        <MessageBar intent="info">
          <MessageBarBody>
            The search service’s managed identity must hold <strong>Storage Blob Data Reader</strong> on
            <code className={s.code}> {plan.connection?.account}</code> and <strong>Cognitive Services OpenAI User</strong> on the
            Foundry AOAI account. Missing roles surface as a real indexer error on the Finish step.
          </MessageBarBody>
        </MessageBar>
      )}
      {supported && plan.connectionGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Source path not resolved</MessageBarTitle>
            {plan.connectionGate}
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );

  const stepBody = () => {
    if (loadingPlan) return <Spinner label="Resolving the source from your estate…" />;
    if (planError) return <MessageBar intent="error"><MessageBarBody>{planError}</MessageBarBody></MessageBar>;

    // Estate-pick (step 0 in estate mode, before a plan exists).
    if (isEstateMode && !picked) {
      return (
        <>
          <Body1Strong>Choose a source to index</Body1Strong>
          <Caption1>Lakehouses index directly; warehouses and ADX databases show the recommended Azure-native path.</Caption1>
          {estate === null ? <Spinner label="Loading your estate…" /> : (
            <Field label="Source item">
              <Dropdown
                placeholder={estate.length ? 'Select a lakehouse / warehouse / ADX item' : 'No indexable items found'}
                onOptionSelect={(_, d) => {
                  const found = estate.find((x) => x.id === d.optionValue);
                  if (found) setPicked({ sourceType: found.sourceType, itemId: found.id, itemName: found.displayName });
                }}
              >
                {estate.map((x) => (
                  <Option key={x.id} value={x.id} text={`${x.displayName} (${x.sourceType})`}>
                    {x.displayName} — {x.sourceType}{!x.supported ? ' (needs export)' : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          )}
        </>
      );
    }

    if (!plan) return <Spinner label="Preparing…" />;

    switch (step) {
      case 0:
        return (
          <>
            {gates}
            <Body1Strong>Source connection</Body1Strong>
            <div className={s.kv}>
              <Caption1>Item</Caption1><span>{plan.itemName} <Badge appearance="tint" size="small">{plan.sourceType}</Badge></span>
              {plan.connection && <><Caption1>Container</Caption1><span className={s.code}>{plan.connection.container}</span></>}
              {plan.connection && <><Caption1>Root path</Caption1><span className={s.code}>{plan.connection.root || '(container root)'}</span></>}
              {plan.connection && <><Caption1>ADLS Gen2</Caption1><span className={s.code}>{plan.connection.abfss}</span></>}
            </div>
            {supported && plan.connection && (
              <>
                <Field label="Content type">
                  <RadioGroup value={preset} onChange={(_, d) => setPreset(d.value as ContentPreset)} layout="horizontal">
                    <Radio value="documents" label="Documents (PDF / Office / images — OCR + chunk + embed)" />
                    <Radio value="structured" label="Structured (JSON lines — chunk + embed)" />
                  </RadioGroup>
                </Field>
                <Field label="Subfolder (optional)" hint="Restrict indexing to a path under the lakehouse root. Leave blank to index the whole root.">
                  <Input value={subPath} onChange={(_, d) => setSubPath(d.value)} placeholder="e.g. docs/handbooks" />
                </Field>
              </>
            )}
          </>
        );
      case 1:
        return (
          <>
            <Body1Strong>Index schema</Body1Strong>
            <Caption1>
              The pipeline projects one search document per chunk into these fields (portal Import-and-vectorize parity):
              <code className={s.code}> chunk_id</code> (key), <code className={s.code}>parent_id</code>,
              <code className={s.code}> title</code>, <code className={s.code}>chunk</code>,
              <code className={s.code}> text_vector</code> ({plan.embedding?.dimensions ?? 3072}-dim).
            </Caption1>
            {plan.columns.length > 0 ? (
              <>
                <Body1Strong>Source schema → Edm type</Body1Strong>
                <Caption1>Detected from the live source. Confirm the type mapping.</Caption1>
                <Table size="small" aria-label="Field type mapping">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Source column</TableHeaderCell>
                      <TableHeaderCell>Source type</TableHeaderCell>
                      <TableHeaderCell>Suggested field</TableHeaderCell>
                      <TableHeaderCell>Edm type</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.fieldMapping.map((m) => (
                      <TableRow key={m.source}>
                        <TableCell>{m.source}</TableCell>
                        <TableCell>{m.sourceType}</TableCell>
                        <TableCell className={s.code}>{m.target}</TableCell>
                        <TableCell className={s.code}>{m.edmType}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <MessageBar intent="info"><MessageBarBody>No columnar schema detected — the document pipeline extracts and chunks file content directly.</MessageBarBody></MessageBar>
            )}
          </>
        );
      case 2:
        return (
          <>
            <Body1Strong>Vectorization</Body1Strong>
            {plan.embedding ? (
              <div className={s.kv}>
                <Caption1>Embedding endpoint</Caption1><span className={s.code}>{plan.embedding.resourceUri}</span>
                <Caption1>Deployment</Caption1><span className={s.code}>{plan.embedding.deploymentId}</span>
                <Caption1>Dimensions</Caption1><span>{plan.embedding.dimensions}</span>
                <Caption1>Vector profile</Caption1><span>HNSW (cosine) + azureOpenAI vectorizer (query-time)</span>
              </div>
            ) : <MessageBar intent="warning"><MessageBarBody>{plan.embeddingGate}</MessageBarBody></MessageBar>}
            <Field label="Chunk size (characters)" hint="SplitSkill maximumPageLength. Default 2000.">
              <Input type="number" value={String(chunkSize)} onChange={(_, d) => setChunkSize(parseInt(d.value) || 2000)} />
            </Field>
            <Field label="Chunk overlap (characters)" hint="Overlap between consecutive chunks. Default 500.">
              <Input type="number" value={String(chunkOverlap)} onChange={(_, d) => setChunkOverlap(parseInt(d.value) || 0)} />
            </Field>
          </>
        );
      case 3:
        return (
          <>
            <Body1Strong>Schedule & create</Body1Strong>
            <Field label="Indexer schedule" hint="Run once now, or set a recurrence. You can change it later on the indexer.">
              <Dropdown
                value={scheduleInterval ? (SCHEDULE_PRESETS.find((p) => p.interval === scheduleInterval)?.label || scheduleInterval) : 'Run once (no schedule)'}
                selectedOptions={[scheduleInterval]}
                onOptionSelect={(_, d) => setScheduleInterval(d.optionValue || '')}
              >
                <Option value="" text="Run once (no schedule)">Run once (no schedule)</Option>
                {SCHEDULE_PRESETS.filter((p) => p.interval).map((p) => (
                  <Option key={p.interval} value={p.interval} text={p.label}>{p.label}</Option>
                ))}
              </Dropdown>
            </Field>
            <Divider />
            <Body1Strong>Artifacts to create</Body1Strong>
            <div className={s.kv}>
              <Caption1>Data source</Caption1><span className={s.code}>{plan.names.dataSourceName}</span>
              <Caption1>Index</Caption1><span className={s.code}>{plan.names.indexName}</span>
              <Caption1>Skillset</Caption1><span className={s.code}>{plan.names.skillsetName}</span>
              <Caption1>Indexer</Caption1><span className={s.code}>{plan.names.indexerName}</span>
            </div>
            {runError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Creation failed (rolled back)</MessageBarTitle>{runError}</MessageBarBody></MessageBar>}
            {!canCreate && gates}
          </>
        );
      case 4:
        return (
          <>
            {result ? (
              <>
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Pipeline created</MessageBarTitle>
                    Index <strong>{result.indexName}</strong> and its data source, skillset, and indexer are live. The indexer
                    is running — vectors appear as documents finish processing.
                  </MessageBarBody>
                </MessageBar>
                <div className={s.kv}>
                  <Caption1>Index</Caption1><span className={s.code}>{result.created?.indexName || result.indexName}</span>
                  <Caption1>Indexer</Caption1><span className={s.code}>{result.created?.indexerName}</span>
                  <Caption1>Skillset</Caption1><span className={s.code}>{result.created?.skillsetName}</span>
                  <Caption1>Data source</Caption1><span className={s.code}>{result.created?.dataSourceName}</span>
                  {result.status?.lastResult?.status && (<><Caption1>Indexer status</Caption1><span><Badge appearance="tint" color={result.status.lastResult.status === 'success' ? 'success' : 'warning'}>{result.status.lastResult.status}</Badge></span></>)}
                </div>
                <Divider />
                <Body1Strong>Test query</Body1Strong>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' }}>
                  <Field label="Search text" style={{ flex: 1 }}>
                    <Input value={testQuery} onChange={(_, d) => setTestQuery(d.value)} placeholder="Search the new index…" />
                  </Field>
                  <Button appearance="primary" icon={testing ? <Spinner size="tiny" /> : <Play16Regular />} disabled={testing} onClick={runTestQuery}>Run</Button>
                </div>
                {testError && <MessageBar intent="error"><MessageBarBody>{testError}</MessageBarBody></MessageBar>}
                {testHits && (
                  <div className={s.hits}>
                    <Caption1>{typeof testHits['@odata.count'] === 'number' ? `${testHits['@odata.count']} matching documents` : `${(testHits.value || []).length} results`}</Caption1>
                    {(testHits.value || []).slice(0, 5).map((h: any, i: number) => (
                      <div key={i} className={s.hitCard}>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>score {typeof h['@search.score'] === 'number' ? h['@search.score'].toFixed(3) : '—'} · {h.title || h.parent_id || h.chunk_id || ''}</Caption1>
                        <div style={{ marginTop: tokens.spacingVerticalXXS }}>{String(h.chunk || h.content || '').slice(0, 240)}</div>
                      </div>
                    ))}
                    {(testHits.value || []).length === 0 && <Caption1>No documents yet — the indexer may still be running. Re-run in a moment.</Caption1>}
                  </div>
                )}
              </>
            ) : <Spinner label="Creating…" />}
          </>
        );
      default:
        return null;
    }
  };

  const atFinish = step === 4;
  const showBack = !atFinish && step > 0 && !(isEstateMode && !picked);
  const showNext = !atFinish && step < 3 && (!isEstateMode || !!picked) && !!plan && (step > 0 || supported && !!plan.connection);
  const showCreate = step === 3 && !atFinish;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Search20Regular /> Index my data — {plan?.itemName || initialSource?.itemName || 'select a source'}
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.rail}>{STEP_LABELS.map((l, i) => railItem(i, l))}</div>
              <div className={s.main}>{stepBody()}</div>
            </div>
          </DialogContent>
          <DialogActions>
            {showBack && <Button appearance="secondary" onClick={() => setStep((x) => Math.max(0, x - 1))}>Back</Button>}
            {isEstateMode && picked && step === 0 && (
              <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => { setPicked(null); setPlan(null); }}>Change source</Button>
            )}
            <div style={{ flex: 1 }} />
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>{atFinish ? 'Close' : 'Cancel'}</Button>
            {showNext && <Button appearance="primary" onClick={() => setStep((x) => Math.min(3, x + 1))} disabled={step === 0 && !canCreate}>Next</Button>}
            {showCreate && (
              <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <BrainCircuit20Regular />} disabled={!canCreate || running} onClick={runOrchestration}>
                {running ? 'Creating…' : 'Create & run'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Launcher button + wizard, for a source editor toolbar (pre-bound source) or the
 * AI Search editor (estate mode when `source` is omitted).
 */
export function IndexMyDataButton({
  source, appearance = 'subtle', label = 'Index my data',
}: {
  source?: WizardSourceRef;
  appearance?: 'primary' | 'secondary' | 'subtle' | 'outline' | 'transparent';
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button appearance={appearance} size="small" icon={<DocumentBulletList20Regular />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <IndexMyDataWizard open={open} onOpenChange={setOpen} initialSource={source} />
    </>
  );
}
