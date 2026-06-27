'use client';

/**
 * DeployToPipelineDialog — REPORT-BUILDER PARITY · WAVE 9
 *
 * The Loom one-for-one for Power BI / Fabric "Deployment pipelines", scoped to a
 * single report. It lets the author add THIS report to a Loom-native deployment
 * pipeline and promote it from one stage to the next (Development → Test →
 * Production) — the Azure-native default for Fabric Deployment pipelines
 * (no-fabric-dependency.md). Nothing here touches a Fabric capacity or a Power BI
 * workspace: the pipeline, its stages, the content-level compare, the deploy
 * (which re-runs the SAME real provisioner the install path uses), and the
 * history all live in Cosmos + the Azure-native provisioner backends.
 *
 * ── What it does (parity with the Power BI deployment-pipeline pane) ──────────
 *   1. Pick a pipeline           → GET  /api/deployment-pipelines/loom
 *   2. Pick source + target stage (from the pipeline's ordered stages)
 *   3. Compare                   → GET  …/loom/[id]/compare?source=&target=
 *        renders the real content-level diff (Same / Different / OnlyInSource /
 *        NotInSource) for the two stages, highlighting this report's row.
 *   4. Deploy                    → POST …/loom/[id]/deploy
 *        body { sourceStageId, targetStageId, items:[{sourceItemId:reportId,
 *        itemType:'report'}], note? } — promotes + re-provisions ONLY this report
 *        into the target stage's workspace. The receipt (operationId, status,
 *        deployedItemIds, steps) is rendered verbatim.
 *   5. History                   → GET  …/loom/[id]/history
 *        the deploy receipts for the selected pipeline (most recent first),
 *        refreshed after every deploy.
 *
 * ── Backend per control (no-vaporware.md) ────────────────────────────────────
 * Every button hits a real route. There is NO new route here — this file is a
 * pure client of the EXISTING /api/deployment-pipelines/loom/* surface. When a
 * tenant has no pipelines yet, an honest EmptyState links to the pipeline admin
 * page (`/deployment-pipelines`) instead of a dead control. When the report is
 * not present in the chosen source stage's workspace, the deploy route returns a
 * precise error ("none of the chosen items exist in the source stage") which is
 * surfaced verbatim in a Fluent MessageBar.
 *
 * ── Rules compliance ─────────────────────────────────────────────────────────
 *   no-fabric-dependency: Cosmos + Azure-native provisioners only; no Fabric /
 *     Power BI host on any path.
 *   no-vaporware: real list / compare / deploy / history calls; honest
 *     EmptyState + error MessageBars; no stubbed data.
 *   no-freeform-config: pipeline + stage selection are Dropdowns; the only text
 *     input is the optional deploy note (a benign promotion comment, like a
 *     commit message — not configuration).
 *   web3-ui: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex in
 *     chrome); cards with elevation, status badges, designed empty/loading
 *     states — consistent with the sibling Sensitivity / Export-data dialogs.
 *
 * Mounting: report-designer.tsx mounts this from the Home ribbon's Lifecycle
 * group (`<DeployToPipelineDialog … />`); the designer edit is mount-only and all
 * logic lives here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Spinner, Caption1, Subtitle1, Subtitle2, Text, Field, Divider,
  Dropdown, Option, Textarea, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  Branch20Regular, Dismiss24Regular, ArrowRight16Regular, ArrowSync20Regular,
  Rocket20Regular, History20Regular, Open16Regular,
  CheckmarkCircle16Filled, ErrorCircle16Filled, Warning16Filled, Info16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
// Type-only imports — fully erased at compile, so these (the loom-pipeline module
// also exports runtime helpers; pipeline-compare pulls in server-only buildTmsl)
// are NEVER bundled into the client.
import type { LoomPipeline, LoomPipelineStage, LoomPipelineHistoryRecord } from '@/lib/types/loom-pipeline';
import type { PipelineDiffPair } from '@/lib/install/pipeline-compare';

// ── wire shapes (LOCAL mirror of the route JSON contracts) ───────────────────────
interface DiffSummary { same: number; different: number; onlyInSource: number; notInSource: number }
interface PipelinesResp { ok?: boolean; data?: { pipelines?: LoomPipeline[] }; error?: string }
interface CompareResp {
  ok?: boolean;
  data?: { sourceStageId: string; targetStageId: string; pairs?: PipelineDiffPair[]; summary?: DiffSummary };
  error?: string;
}
interface DeployResp {
  ok?: boolean;
  data?: {
    operationId: string;
    status: LoomPipelineHistoryRecord['status'];
    diff?: PipelineDiffPair[];
    summary?: DiffSummary;
    deployedItemIds?: string[];
    steps?: string[];
  };
  error?: string;
}
interface HistoryResp { ok?: boolean; data?: { records?: LoomPipelineHistoryRecord[] }; error?: string }

const DEPLOY_TIMEOUT_MS = 180_000; // deploy re-provisions — bound it well above the 6s default.

// ── styles (Fluent v9 + Loom tokens only) ────────────────────────────────────────
const useStyles = makeStyles({
  surface: { maxWidth: '760px', width: '94vw' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  fieldLabel: { color: tokens.colorNeutralForeground2 },
  muted: { color: tokens.colorNeutralForeground3 },

  stageRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  stageField: { flex: 1, minWidth: '180px' },
  arrow: { display: 'flex', alignItems: 'center', height: '32px', color: tokens.colorNeutralForeground3 },
  dropdown: { width: '100%', minWidth: 0 },

  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalM,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },

  diffList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    maxHeight: '220px', overflowY: 'auto', minWidth: 0,
  },
  diffRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingInline: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium, minWidth: 0,
  },
  diffRowHi: { backgroundColor: tokens.colorBrandBackground2, outline: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}` },
  diffName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 },
  diffMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },

  steps: {
    margin: 0, paddingInlineStart: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    maxHeight: '180px', overflowY: 'auto',
  },
  stepText: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },

  histList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, maxHeight: '200px', overflowY: 'auto', minWidth: 0 },
  histRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingInline: tokens.spacingHorizontalS, minWidth: 0,
  },
  histText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  histWhen: { color: tokens.colorNeutralForeground3 },

  loadPad: { padding: tokens.spacingVerticalL, display: 'flex', justifyContent: 'center' },
  footer: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, width: '100%' },
  grow: { flex: 1, minWidth: 0 },
  noteBox: { width: '100%' },
});

export interface DeployToPipelineDialogProps {
  open: boolean;
  onClose: () => void;
  /** The report item id — promoted as `items:[{ sourceItemId, itemType:'report' }]`. */
  reportId: string;
}

// ── small helpers ────────────────────────────────────────────────────────────────

/** Map a deploy status to a Fluent Badge color + icon. */
function statusBadge(status: LoomPipelineHistoryRecord['status']): { color: 'success' | 'warning' | 'danger' | 'informative'; icon: ReactElement; label: string } {
  switch (status) {
    case 'succeeded': return { color: 'success', icon: <CheckmarkCircle16Filled />, label: 'Succeeded' };
    case 'partial': return { color: 'warning', icon: <Warning16Filled />, label: 'Partial' };
    case 'failed': return { color: 'danger', icon: <ErrorCircle16Filled />, label: 'Failed' };
    default: return { color: 'informative', icon: <Info16Regular />, label: 'Running' };
  }
}

/** Map a content-diff status to a Fluent Badge color + label. */
function diffBadge(status: PipelineDiffPair['status']): { color: 'brand' | 'success' | 'informative' | 'subtle'; label: string } {
  switch (status) {
    case 'Different': return { color: 'brand', label: 'Different' };
    case 'OnlyInSource': return { color: 'success', label: 'New in source' };
    case 'NotInSource': return { color: 'informative', label: 'Only in target' };
    default: return { color: 'subtle', label: 'Same' };
  }
}

function fmtWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ── component ────────────────────────────────────────────────────────────────────

export function DeployToPipelineDialog({ open, onClose, reportId }: DeployToPipelineDialogProps): ReactElement {
  const s = useStyles();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<LoomPipeline[]>([]);

  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [sourceStageId, setSourceStageId] = useState<string>('');
  const [targetStageId, setTargetStageId] = useState<string>('');
  const [note, setNote] = useState<string>('');

  const [comparing, setComparing] = useState(false);
  const [compareErr, setCompareErr] = useState<string | null>(null);
  const [pairs, setPairs] = useState<PipelineDiffPair[] | null>(null);
  const [summary, setSummary] = useState<DiffSummary | null>(null);

  const [deploying, setDeploying] = useState(false);
  const [deployErr, setDeployErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DeployResp['data'] | null>(null);

  const [history, setHistory] = useState<LoomPipelineHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const selectedPipeline = useMemo(
    () => pipelines.find((p) => p.id === selectedPipelineId) || null,
    [pipelines, selectedPipelineId],
  );
  const stages = useMemo<LoomPipelineStage[]>(
    () => (selectedPipeline ? [...selectedPipeline.stages].sort((a, b) => a.order - b.order) : []),
    [selectedPipeline],
  );

  const stageName = useCallback(
    (id: string) => stages.find((st) => st.id === id)?.displayName || '',
    [stages],
  );

  // ── load the tenant's pipelines on open ────────────────────────────────────────
  const loadPipelines = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await clientFetch('/api/deployment-pipelines/loom', { cache: 'no-store' });
      const j = (await r.json()) as PipelinesResp;
      if (r.ok && j?.ok) {
        const list = Array.isArray(j.data?.pipelines) ? j.data!.pipelines! : [];
        setPipelines(list);
      } else {
        setErr(j?.error || `Failed to load pipelines (HTTP ${r.status}).`);
        setPipelines([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPipelines([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── load history for the selected pipeline ──────────────────────────────────────
  const loadHistory = useCallback(async (pipelineId: string) => {
    if (!pipelineId) { setHistory([]); return; }
    setHistoryLoading(true);
    try {
      const r = await clientFetch(`/api/deployment-pipelines/loom/${encodeURIComponent(pipelineId)}/history`, { cache: 'no-store' });
      const j = (await r.json()) as HistoryResp;
      setHistory(r.ok && j?.ok && Array.isArray(j.data?.records) ? j.data!.records! : []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // (Re)load on open; reset transient compare/deploy state on close.
  useEffect(() => {
    if (open) {
      void loadPipelines();
    } else {
      setErr(null);
      setComparing(false);
      setDeploying(false);
      setCompareErr(null);
      setDeployErr(null);
      setPairs(null);
      setSummary(null);
      setReceipt(null);
    }
  }, [open, loadPipelines]);

  // Default the selection to the first pipeline once loaded.
  useEffect(() => {
    if (open && !selectedPipelineId && pipelines.length > 0) {
      setSelectedPipelineId(pipelines[0].id);
    }
  }, [open, pipelines, selectedPipelineId]);

  // When the pipeline changes, default source = first stage, target = next stage,
  // clear any prior compare/receipt, and load that pipeline's history.
  useEffect(() => {
    if (!selectedPipeline) { setSourceStageId(''); setTargetStageId(''); setHistory([]); return; }
    const ordered = [...selectedPipeline.stages].sort((a, b) => a.order - b.order);
    setSourceStageId(ordered[0]?.id || '');
    setTargetStageId(ordered[1]?.id || ordered[0]?.id || '');
    setPairs(null);
    setSummary(null);
    setReceipt(null);
    setCompareErr(null);
    setDeployErr(null);
    void loadHistory(selectedPipeline.id);
  }, [selectedPipeline, loadHistory]);

  const stagesDistinct = !!sourceStageId && !!targetStageId && sourceStageId !== targetStageId;
  const ready = !!selectedPipeline && stagesDistinct;

  // ── compare the two stages (real content diff) ──────────────────────────────────
  const runCompare = useCallback(async () => {
    if (!selectedPipeline || !stagesDistinct) return;
    setComparing(true);
    setCompareErr(null);
    setPairs(null);
    setSummary(null);
    try {
      const url = `/api/deployment-pipelines/loom/${encodeURIComponent(selectedPipeline.id)}/compare`
        + `?source=${encodeURIComponent(sourceStageId)}&target=${encodeURIComponent(targetStageId)}`;
      const r = await clientFetch(url, { cache: 'no-store' });
      const j = (await r.json()) as CompareResp;
      if (r.ok && j?.ok) {
        setPairs(Array.isArray(j.data?.pairs) ? j.data!.pairs! : []);
        setSummary(j.data?.summary || null);
      } else {
        setCompareErr(j?.error || `Compare failed (HTTP ${r.status}).`);
      }
    } catch (e) {
      setCompareErr(e instanceof Error ? e.message : String(e));
    } finally {
      setComparing(false);
    }
  }, [selectedPipeline, stagesDistinct, sourceStageId, targetStageId]);

  // ── deploy THIS report to the target stage (real provisioner re-run) ────────────
  const runDeploy = useCallback(async () => {
    if (!selectedPipeline || !stagesDistinct) return;
    setDeploying(true);
    setDeployErr(null);
    setReceipt(null);
    try {
      const r = await clientFetch(
        `/api/deployment-pipelines/loom/${encodeURIComponent(selectedPipeline.id)}/deploy`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceStageId,
            targetStageId,
            items: [{ sourceItemId: reportId, itemType: 'report' }],
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        },
        DEPLOY_TIMEOUT_MS,
      );
      const j = (await r.json()) as DeployResp;
      if (r.ok && j?.ok && j.data) {
        setReceipt(j.data);
        // Refresh history so the new receipt shows; keep the dialog open so the
        // author can read the result (and optionally promote to the next stage).
        void loadHistory(selectedPipeline.id);
      } else {
        setDeployErr(j?.error || `Deploy failed (HTTP ${r.status}).`);
      }
    } catch (e) {
      setDeployErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  }, [selectedPipeline, stagesDistinct, sourceStageId, targetStageId, reportId, note, loadHistory]);

  const busy = comparing || deploying;

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={(
              <Button
                appearance="subtle" icon={<Dismiss24Regular />}
                aria-label="Close deployment pipeline" disabled={busy} onClick={onClose}
              />
            )}
          >
            <span className={s.titleRow}>
              <Branch20Regular />
              <Subtitle1>Deployment pipeline</Subtitle1>
              <Badge appearance="tint" color="brand" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={s.body}>
              {err && (
                <MessageBar intent="error">
                  <MessageBarBody>{err}</MessageBarBody>
                </MessageBar>
              )}

              {loading && (
                <div className={s.loadPad}>
                  <Spinner size="tiny" label="Loading deployment pipelines…" />
                </div>
              )}

              {/* EMPTY STATE — no pipelines yet (honest CTA to the pipeline admin) */}
              {!loading && !err && pipelines.length === 0 && (
                <EmptyState
                  icon={<Branch20Regular />}
                  title="No deployment pipelines yet"
                  body="A Loom-native deployment pipeline promotes content through Development → Test → Production stages — the Azure-native default for Fabric deployment pipelines, with no Fabric capacity required. Create one, bind each stage to a workspace, then return here to deploy this report."
                  primaryAction={{ label: 'Create a pipeline', href: '/deployment-pipelines' }}
                  secondaryAction={{ label: 'Refresh', onClick: () => void loadPipelines() }}
                />
              )}

              {/* MAIN — pipeline + stage selection */}
              {!loading && pipelines.length > 0 && (
                <>
                  <div className={s.section}>
                    <Caption1 className={s.fieldLabel}>Pipeline</Caption1>
                    <Dropdown
                      className={s.dropdown}
                      aria-label="Deployment pipeline"
                      value={selectedPipeline?.displayName || ''}
                      selectedOptions={selectedPipelineId ? [selectedPipelineId] : []}
                      disabled={busy}
                      onOptionSelect={(_e, d) => setSelectedPipelineId(d.optionValue || '')}
                    >
                      {pipelines.map((p) => (
                        <Option key={p.id} value={p.id} text={p.displayName}>
                          {p.displayName} · {p.stages.length} stage{p.stages.length === 1 ? '' : 's'}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>

                  {/* SOURCE → TARGET stage pickers */}
                  <div className={s.stageRow}>
                    <Field className={s.stageField} label="From (source stage)">
                      <Dropdown
                        className={s.dropdown}
                        aria-label="Source stage"
                        value={stageName(sourceStageId)}
                        selectedOptions={sourceStageId ? [sourceStageId] : []}
                        disabled={busy}
                        onOptionSelect={(_e, d) => { setSourceStageId(d.optionValue || ''); setPairs(null); setSummary(null); setReceipt(null); }}
                      >
                        {stages.map((st) => (
                          <Option key={st.id} value={st.id} text={st.displayName}>
                            {st.displayName}{st.workspaceName ? ` · ${st.workspaceName}` : ''}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <div className={s.arrow} aria-hidden><ArrowRight16Regular /></div>
                    <Field className={s.stageField} label="To (target stage)">
                      <Dropdown
                        className={s.dropdown}
                        aria-label="Target stage"
                        value={stageName(targetStageId)}
                        selectedOptions={targetStageId ? [targetStageId] : []}
                        disabled={busy}
                        onOptionSelect={(_e, d) => { setTargetStageId(d.optionValue || ''); setPairs(null); setSummary(null); setReceipt(null); }}
                      >
                        {stages.map((st) => (
                          <Option key={st.id} value={st.id} text={st.displayName}>
                            {st.displayName}{st.workspaceName ? ` · ${st.workspaceName}` : ''}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  </div>

                  {!stagesDistinct && !!sourceStageId && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        Pick two different stages — content is promoted from the source stage into a distinct target stage.
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  <Caption1 className={s.muted}>
                    Only this report is promoted. Deploy re-runs the real Azure-native provisioner against the
                    target stage&rsquo;s workspace, applying that stage&rsquo;s deployment rules first.
                  </Caption1>

                  {/* COMPARE RESULT */}
                  {compareErr && (
                    <MessageBar intent="error"><MessageBarBody>{compareErr}</MessageBarBody></MessageBar>
                  )}
                  {pairs && (
                    <div className={s.card}>
                      <div className={s.cardHead}>
                        <ArrowSync20Regular />
                        <Subtitle2>Stage comparison</Subtitle2>
                        {summary && (
                          <span className={s.diffMeta}>
                            <Badge appearance="tint" color="brand" size="small">{summary.different} different</Badge>
                            <Badge appearance="tint" color="success" size="small">{summary.onlyInSource} new</Badge>
                            <Badge appearance="tint" color="subtle" size="small">{summary.same} same</Badge>
                          </span>
                        )}
                      </div>
                      {pairs.length === 0 ? (
                        <Caption1 className={s.muted}>Both stages are empty — nothing to compare.</Caption1>
                      ) : (
                        <div className={s.diffList}>
                          {pairs.map((p, i) => {
                            const isThis = p.sourceItemId === reportId || p.targetItemId === reportId;
                            const db = diffBadge(p.status);
                            const name = p.sourceItemDisplayName || p.targetItemDisplayName || '(unnamed)';
                            return (
                              <div key={`${p.itemType}:${name}:${i}`} className={`${s.diffRow} ${isThis ? s.diffRowHi : ''}`}>
                                <Text className={s.diffName} weight={isThis ? 'semibold' : 'regular'}>
                                  {name}
                                </Text>
                                <span className={s.diffMeta}>
                                  <Badge appearance="outline" color="subtle" size="small">{p.itemType}</Badge>
                                  <Badge appearance="tint" color={db.color} size="small">{db.label}</Badge>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* DEPLOY RECEIPT */}
                  {deployErr && (
                    <MessageBar intent="error"><MessageBarBody>{deployErr}</MessageBarBody></MessageBar>
                  )}
                  {receipt && (
                    <div className={s.card}>
                      <div className={s.cardHead}>
                        {statusBadge(receipt.status).icon}
                        <Subtitle2>Deploy receipt</Subtitle2>
                        <Badge appearance="tint" color={statusBadge(receipt.status).color} size="small">
                          {statusBadge(receipt.status).label}
                        </Badge>
                        <Badge appearance="outline" color="subtle" size="small">
                          {(receipt.deployedItemIds?.length ?? 0)} item{(receipt.deployedItemIds?.length ?? 0) === 1 ? '' : 's'}
                        </Badge>
                      </div>
                      <Caption1 className={s.muted}>Operation {receipt.operationId}</Caption1>
                      {Array.isArray(receipt.steps) && receipt.steps.length > 0 && (
                        <ul className={s.steps}>
                          {receipt.steps.map((st, i) => (
                            <li key={i}><span className={s.stepText}>{st}</span></li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* OPTIONAL DEPLOY NOTE */}
                  <Field label="Deploy note (optional)">
                    <Textarea
                      className={s.noteBox}
                      value={note}
                      disabled={busy}
                      resize="vertical"
                      placeholder="Why this promotion? (recorded on the deploy receipt)"
                      onChange={(_e, d) => setNote(d.value.slice(0, 1024))}
                    />
                  </Field>

                  <Divider />

                  {/* HISTORY */}
                  <div className={s.section}>
                    <span className={s.cardHead}>
                      <History20Regular />
                      <Subtitle2>Deploy history</Subtitle2>
                      {historyLoading && <Spinner size="tiny" />}
                    </span>
                    {!historyLoading && history.length === 0 && (
                      <span className={s.titleRow}>
                        <Info16Regular className={s.muted} />
                        <Caption1 className={s.muted}>No deploys recorded for this pipeline yet.</Caption1>
                      </span>
                    )}
                    {history.length > 0 && (
                      <div className={s.histList}>
                        {history.map((h) => {
                          const sb = statusBadge(h.status);
                          return (
                            <div key={h.id} className={s.histRow}>
                              {sb.icon}
                              <div className={s.histText}>
                                <Text size={200}>
                                  {stageName(h.sourceStageId) || h.sourceStageId}
                                  {' → '}
                                  {stageName(h.targetStageId) || h.targetStageId}
                                  {h.note ? ` — ${h.note}` : ''}
                                </Text>
                                <Caption1 className={s.histWhen}>
                                  {fmtWhen(h.completedAt || h.startedAt)} · {h.deployedItemIds.length} item{h.deployedItemIds.length === 1 ? '' : 's'}
                                </Caption1>
                              </div>
                              <Badge appearance="tint" color={sb.color} size="small">{sb.label}</Badge>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </DialogContent>

          <DialogActions>
            <div className={s.footer}>
              {deploying && <Spinner size="tiny" label="Deploying — re-provisioning in the target workspace…" />}
              {!deploying && comparing && <Spinner size="tiny" label="Comparing stages…" />}
              <span className={s.grow} />
              <Button
                as="a" appearance="subtle" icon={<Open16Regular />}
                href="/deployment-pipelines" target="_blank" rel="noreferrer"
              >
                Manage pipelines
              </Button>
              <Button appearance="secondary" onClick={onClose} disabled={busy}>Close</Button>
              <Button
                appearance="secondary"
                icon={<ArrowSync20Regular />}
                onClick={() => void runCompare()}
                disabled={!ready || busy}
              >
                Compare
              </Button>
              <Tooltip
                content="Promote this report from the source stage to the target stage"
                relationship="label"
              >
                <Button
                  appearance="primary"
                  icon={deploying ? <Spinner size="tiny" /> : <Rocket20Regular />}
                  onClick={() => void runDeploy()}
                  disabled={!ready || busy}
                >
                  Deploy
                </Button>
              </Tooltip>
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default DeployToPipelineDialog;
