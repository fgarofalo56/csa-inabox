'use client';

/**
 * WS-1.5 — Eval Depth panel: built-in evaluator library + one-click LLM judge
 * + OTel span waterfall + cluster analysis + continuous-eval Monitor alert.
 *
 * Complements (does not duplicate) the WS-1.4 AgentQualityPanel — this panel
 * adds the DEPTH layer:
 *   • Evaluator picker (4 typed enum evaluators — not freeform)
 *   • One-click judge: runs POST /api/foundry/agents/eval/judge → real AOAI
 *   • Span tree waterfall: GET /api/foundry/agents/spans → OTel span tree with
 *     token/latency/error rollups (from existing agent thread records)
 *   • Failure cluster analysis: client-side, grouping failing rows by theme
 *   • Eval regression alert: GET/POST/DELETE /api/admin/agent-quality/eval-alert
 *     → real Azure Monitor scheduled-query alert
 *
 * REAL backends only. Honest Fluent MessageBar gates (naming exact env var)
 * when infra is absent — full UI still renders. Fluent v9 + Loom tokens.
 * SplitPane/storageKey (G3), flexWrap+minWidth:0 on badge rows. No Fabric dependency.
 *
 * See .claude/rules/no-vaporware.md, ux-baseline.md, web3-ui.md.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Dropdown, Option, Spinner,
  Subtitle2, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, Beaker24Regular,
  CheckmarkCircle16Filled, Warning16Filled,
  DataUsage24Regular, Timeline24Regular, AlertOn24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import {
  EVALUATOR_TYPES,
  EVALUATOR_META,
  clusterFailures,
  type EvaluatorType,
  type FailingRow,
} from '@/lib/foundry/evaluator-library';
import { DEFAULT_EVAL_SCORE_THRESHOLD, EVAL_ALERT_NAME } from '@/lib/foundry/eval-alert';
import type { SpanNode, SpanTreeRollup } from '@/lib/foundry/span-tree';

// ── Wire shapes ───────────────────────────────────────────────────────────────

interface JudgeResult {
  evaluatorType: EvaluatorType;
  score: number;
  rationale: string;
  scoredAt: string;
}
interface AlertRule {
  id?: string;
  name: string;
  enabled: boolean;
  severity?: number;
  description?: string;
}
interface SpansResp {
  ok: boolean;
  root?: SpanNode;
  rollup?: SpanTreeRollup;
  error?: string;
  hint?: string;
  missing?: string;
}
interface TraceRun {
  threadId: string;
  runId?: string;
  status: string;
  model: string;
  latencyMs: number;
  createdAt: string;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  scoreTile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    transition: 'box-shadow 0.15s',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  scoreValue: { fontSize: '2rem', fontWeight: 700, lineHeight: '1' },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0, alignItems: 'center' },
  rationale: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  spanRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground3 },
  },
  spanLabel: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  spanTime: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  clusterRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  rollupTile: {
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
  textareaBase: {
    width: '100%', boxSizing: 'border-box',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit', fontSize: tokens.fontSizeBase300,
    resize: 'vertical' as const,
  },
});

// ── Score colour helpers ──────────────────────────────────────────────────────

type ScoreColor = 'success' | 'warning' | 'danger' | 'informative';

function scoreColor(score: number): ScoreColor {
  if (score === 0) return 'informative';
  if (score >= 4)  return 'success';
  if (score >= 3)  return 'warning';
  return 'danger';
}

function fmtMs(ms: number): string {
  if (ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// ── Span waterfall row ────────────────────────────────────────────────────────

function SpanRow({ span, depth }: { span: SpanNode; depth: number }) {
  const s = useStyles();
  const indent = depth * 16;
  return (
    <>
      <div className={s.spanRow} style={{ paddingLeft: `${indent + 8}px` }}>
        <Badge
          appearance="filled"
          color={span.isError ? 'danger' : span.kind === 'agent-turn' ? 'brand' : 'informative'}
          style={{ flexShrink: 0 }}
        >
          {span.kind}
        </Badge>
        <Text className={s.spanLabel} size={200}>{span.label}</Text>
        <Badge
          appearance="outline"
          color={span.status === 'completed' ? 'success' : span.isError ? 'danger' : 'informative'}
          style={{ flexShrink: 0 }}
        >
          {span.status}
        </Badge>
        {span.totalTokens != null && span.totalTokens > 0 && (
          <Caption1 className={s.spanTime}>{span.totalTokens}tok</Caption1>
        )}
        <Caption1 className={s.spanTime}>{fmtMs(span.durationMs)}</Caption1>
      </div>
      {span.children.map((child) => (
        <SpanRow key={child.id} span={child} depth={depth + 1} />
      ))}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  /** Pre-loaded agent trace runs for the span picker (from WS-1.4 rollup route). */
  recentRuns?: TraceRun[];
  /** Selected agent name (from WS-1.4 agent selector). */
  selectedAgent?: string;
}

export function EvalDepthPanel({ recentRuns = [], selectedAgent = '' }: Props) {
  const s = useStyles();

  // ── One-click judge state ─────────────────────────────────────────────────
  const [selectedEvaluator, setSelectedEvaluator] = useState<EvaluatorType>('relevance');
  const [judgeQuestion, setJudgeQuestion] = useState('');
  const [judgeAnswer, setJudgeAnswer]     = useState('');
  const [judgeContext, setJudgeContext]   = useState('');
  const [judgeToolCalls, setJudgeToolCalls] = useState('');
  const [judging, setJudging]   = useState(false);
  const [judgeResults, setJudgeResults] = useState<JudgeResult[]>([]);
  const [judgeError, setJudgeError] = useState<{ error: string; hint?: string; missing?: string } | null>(null);

  // ── Span tree state ───────────────────────────────────────────────────────
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [spansLoading, setSpansLoading]   = useState(false);
  const [spansData, setSpansData]         = useState<SpansResp | null>(null);

  // ── Alert state ───────────────────────────────────────────────────────────
  const [alertLoading, setAlertLoading]   = useState(false);
  const [alertRule, setAlertRule]         = useState<AlertRule | null | undefined>(undefined);
  const [alertError, setAlertError]       = useState<string | null>(null);
  const [alertThreshold, setAlertThreshold] = useState(DEFAULT_EVAL_SCORE_THRESHOLD);
  const [alertSaving, setAlertSaving]     = useState(false);

  // ── Cluster analysis (derived from failing judge results) ─────────────────
  const clusters = useMemo(() => {
    const failing: FailingRow[] = judgeResults
      .filter((r) => r.score > 0 && r.score < 4)
      .map((r) => ({ prompt: judgeQuestion, evaluatorType: r.evaluatorType, score: r.score, rationale: r.rationale }));
    return clusterFailures(failing);
  }, [judgeResults, judgeQuestion]);

  // ── Load alert status on mount ────────────────────────────────────────────
  useEffect(() => {
    loadAlert();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAlert = useCallback(async () => {
    setAlertLoading(true);
    setAlertError(null);
    try {
      const r = await clientFetch('/api/admin/agent-quality/eval-alert');
      const j = await r.json();
      if (j.ok) setAlertRule(j.alert);
      else setAlertError(j.hint || j.error);
    } catch {
      setAlertError('Could not reach the alert API — check console connectivity.');
    } finally {
      setAlertLoading(false);
    }
  }, []);

  // ── One-click judge ───────────────────────────────────────────────────────
  const runJudge = useCallback(async (evaluatorType: EvaluatorType) => {
    if (!judgeQuestion.trim() || !judgeAnswer.trim()) return;
    setJudging(true);
    setJudgeError(null);
    try {
      const body: Record<string, string> = { evaluatorType, question: judgeQuestion, answer: judgeAnswer };
      if (judgeContext.trim())   body.context   = judgeContext;
      if (judgeToolCalls.trim()) body.toolCalls = judgeToolCalls;
      const r = await clientFetch('/api/foundry/agents/eval/judge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        setJudgeResults((prev) => {
          const filtered = prev.filter((x) => x.evaluatorType !== evaluatorType);
          return [...filtered, { evaluatorType, score: j.score, rationale: j.rationale, scoredAt: j.scoredAt }];
        });
      } else {
        setJudgeError({ error: j.error, hint: j.hint, missing: j.missing });
      }
    } catch (e) {
      setJudgeError({ error: String(e) });
    } finally {
      setJudging(false);
    }
  }, [judgeQuestion, judgeAnswer, judgeContext, judgeToolCalls]);

  const runAllEvaluators = useCallback(async () => {
    for (const t of EVALUATOR_TYPES) {
      await runJudge(t);
    }
  }, [runJudge]);

  // ── Span tree load ────────────────────────────────────────────────────────
  const loadSpans = useCallback(async (threadId: string) => {
    if (!selectedAgent || !threadId) return;
    setSpansLoading(true);
    setSpansData(null);
    try {
      const r = await clientFetch(
        `/api/foundry/agents/spans?agent=${encodeURIComponent(selectedAgent)}&threadId=${encodeURIComponent(threadId)}`,
      );
      setSpansData(await r.json());
    } catch (e) {
      setSpansData({ ok: false, error: String(e) });
    } finally {
      setSpansLoading(false);
    }
  }, [selectedAgent]);

  useEffect(() => {
    if (selectedThreadId) loadSpans(selectedThreadId);
  }, [selectedThreadId, loadSpans]);

  // ── Alert save / disable ─────────────────────────────────────────────────
  const saveAlert = useCallback(async (enabled: boolean) => {
    setAlertSaving(true);
    try {
      const r = await clientFetch('/api/admin/agent-quality/eval-alert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scoreThreshold: alertThreshold, enabled }),
      });
      const j = await r.json();
      if (j.ok) {
        setAlertRule({ name: j.name, enabled: j.enabled });
        setAlertError(null);
      } else {
        setAlertError(j.hint || j.error);
      }
    } catch (e) {
      setAlertError(String(e));
    } finally {
      setAlertSaving(false);
    }
  }, [alertThreshold]);

  const disableAlert = useCallback(async () => {
    setAlertSaving(true);
    try {
      const r = await clientFetch('/api/admin/agent-quality/eval-alert', { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) setAlertRule({ name: j.name, enabled: false });
      else setAlertError(j.hint || j.error);
    } catch (e) {
      setAlertError(String(e));
    } finally {
      setAlertSaving(false);
    }
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL }}>

      {/* ── 1. One-click LLM judge ─────────────────────────────────────── */}
      <Section
        title="One-click evaluator judge"
        actions={
          <LearnPopover
            title="Built-in evaluator library"
            content={
              'Four typed evaluators (groundedness, relevance, tool-call-accuracy, task-adherence) ' +
              'score a data-agent output 1–5 using a real AOAI judge call — the mlflow.evaluate ' +
              'pattern on your existing Azure OpenAI deployment. Run all evaluators for a full diagnostic.'
            }
            learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/concepts/observability"
          />
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>

          {/* Evaluator picker — typed enum, not freeform */}
          <div className={s.toolbar}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Evaluator:</Caption1>
            <Dropdown
              value={EVALUATOR_META[selectedEvaluator].label}
              onOptionSelect={(_, d) => setSelectedEvaluator(d.optionValue as EvaluatorType)}
              style={{ minWidth: '200px' }}
            >
              {EVALUATOR_TYPES.map((t) => (
                <Option key={t} value={t}>{EVALUATOR_META[t].label}</Option>
              ))}
            </Dropdown>
            <Caption1 style={{ color: tokens.colorNeutralForeground3, maxWidth: '320px', minWidth: 0 }}>
              {EVALUATOR_META[selectedEvaluator].description}
            </Caption1>
          </div>

          {/* Input fields */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <div>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXXS, fontWeight: 600 }}>
                Question / prompt *
              </Caption1>
              <textarea
                value={judgeQuestion}
                onChange={(e) => setJudgeQuestion(e.target.value)}
                rows={2}
                placeholder="The data-agent question or task prompt…"
                className={s.textareaBase}
              />
            </div>
            <div>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXXS, fontWeight: 600 }}>
                Agent answer *
              </Caption1>
              <textarea
                value={judgeAnswer}
                onChange={(e) => setJudgeAnswer(e.target.value)}
                rows={4}
                placeholder="The agent's response to score…"
                className={s.textareaBase}
              />
            </div>
            {selectedEvaluator === 'groundedness' && (
              <div>
                <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXXS, fontWeight: 600 }}>
                  Context / retrieved sources (groundedness)
                </Caption1>
                <textarea
                  value={judgeContext}
                  onChange={(e) => setJudgeContext(e.target.value)}
                  rows={3}
                  placeholder="Paste the retrieved documents or context the agent had access to…"
                  className={s.textareaBase}
                />
              </div>
            )}
            {selectedEvaluator === 'tool-call-accuracy' && (
              <div>
                <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXXS, fontWeight: 600 }}>
                  Tool-call log (tool-call-accuracy)
                </Caption1>
                <textarea
                  value={judgeToolCalls}
                  onChange={(e) => setJudgeToolCalls(e.target.value)}
                  rows={3}
                  placeholder='search_data(query="revenue") → {rows: 42}…'
                  className={s.textareaBase}
                  style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}
                />
              </div>
            )}
          </div>

          {judgeError && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Judge not available</MessageBarTitle>
                {judgeError.hint || judgeError.error}
                {judgeError.missing && ` Set ${judgeError.missing} on the Console app (Admin → Runtime configuration).`}
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Action toolbar */}
          <div className={s.toolbar}>
            <Button
              appearance="primary"
              icon={judging ? <Spinner size="tiny" /> : <Beaker24Regular />}
              disabled={judging || !judgeQuestion.trim() || !judgeAnswer.trim()}
              onClick={() => runJudge(selectedEvaluator)}
            >
              Judge: {EVALUATOR_META[selectedEvaluator].label}
            </Button>
            <Tooltip content="Run all 4 evaluators sequentially against this answer" relationship="description">
              <Button
                appearance="secondary"
                disabled={judging || !judgeQuestion.trim() || !judgeAnswer.trim()}
                onClick={runAllEvaluators}
              >
                Run all evaluators
              </Button>
            </Tooltip>
            {judgeResults.length > 0 && (
              <Button
                appearance="transparent"
                icon={<ArrowClockwise16Regular />}
                onClick={() => setJudgeResults([])}
              >
                Clear scores
              </Button>
            )}
          </div>

          {/* Score results */}
          {judgeResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Subtitle2>Evaluator scores</Subtitle2>
              <TileGrid minTileWidth={200}>
                {judgeResults.map((r) => {
                  const meta = EVALUATOR_META[r.evaluatorType];
                  const color = scoreColor(r.score);
                  return (
                    <div key={r.evaluatorType} className={s.scoreTile}>
                      <div className={s.badgeRow}>
                        <Badge appearance="filled" color={color}>{meta.label}</Badge>
                      </div>
                      <Text
                        className={s.scoreValue}
                        style={{
                          color: color === 'success'  ? tokens.colorPaletteGreenForeground3
                               : color === 'warning'  ? tokens.colorPaletteYellowForeground2
                               : color === 'danger'   ? tokens.colorPaletteRedForeground3
                               : tokens.colorNeutralForeground1,
                        }}
                      >
                        {r.score > 0 ? `${r.score}/5` : '—'}
                      </Text>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        {meta.rubricSummary}
                      </Caption1>
                      {r.rationale && (
                        <Body1 className={s.rationale} style={{ marginTop: tokens.spacingVerticalXS }}>
                          {r.rationale}
                        </Body1>
                      )}
                    </div>
                  );
                })}
              </TileGrid>

              {/* Failure cluster analysis */}
              {clusters.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  <Subtitle2>
                    <DataUsage24Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                    Failure cluster analysis
                  </Subtitle2>
                  {clusters.map((c) => (
                    <div key={c.theme} className={s.clusterRow}>
                      <Badge appearance="filled" color="warning" style={{ flexShrink: 0 }}>{c.count}</Badge>
                      <Text weight="semibold" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.theme}</Text>
                      <div className={s.badgeRow} style={{ flex: '1 1 auto' }}>
                        {c.evaluatorTypes.map((t) => (
                          <Badge key={t} appearance="outline" size="small">{EVALUATOR_META[t].label}</Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* ── 2. OTel span waterfall ────────────────────────────────────────── */}
      <Section
        title="Agent turn span tree"
        actions={
          <LearnPopover
            title="OTel span waterfall"
            content={
              'Renders the full OTel-style span tree for a multi-tool agent turn: ' +
              'tool calls, message-creation, code-interpreter, and retrieval spans ' +
              'with token/latency/error rollups. Data comes from existing agent thread ' +
              'records in the loom-agent-memory Cosmos container — no new infra needed.'
            }
            learnMoreHref="https://learn.microsoft.com/azure/monitor/app/opentelemetry-overview"
          />
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
          {recentRuns.length === 0 ? (
            <EmptyState
              icon={<Timeline24Regular />}
              title="No agent traces yet"
              body={
                selectedAgent
                  ? `No trace threads found for agent "${selectedAgent}". Run an agent query from the playground to generate a thread.`
                  : 'Select an agent from the Agent Quality panel to load its trace threads here.'
              }
            />
          ) : (
            <>
              <div className={s.toolbar}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Thread:</Caption1>
                <Dropdown
                  value={selectedThreadId || 'Select a thread…'}
                  onOptionSelect={(_, d) => setSelectedThreadId(d.optionValue as string)}
                  style={{ minWidth: '300px' }}
                >
                  {recentRuns.map((run) => {
                    const optLabel = `${run.threadId.slice(0, 8)}… · ${run.model} · ${fmtMs(run.latencyMs)} · ${run.status}`;
                    return (
                      <Option key={run.threadId} value={run.threadId} text={optLabel}>
                        {optLabel}
                      </Option>
                    );
                  })}
                </Dropdown>
                {selectedThreadId && (
                  <Button
                    appearance="transparent"
                    icon={<ArrowClockwise16Regular />}
                    onClick={() => loadSpans(selectedThreadId)}
                    disabled={spansLoading}
                  >
                    Refresh
                  </Button>
                )}
              </div>

              {spansLoading && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                  <Spinner size="tiny" />
                  <Caption1>Loading span tree…</Caption1>
                </div>
              )}

              {spansData && !spansData.ok && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Span tree unavailable</MessageBarTitle>
                    {spansData.hint || spansData.error}
                    {spansData.missing && ` Set ${spansData.missing} on the Console app (Admin → Runtime configuration).`}
                  </MessageBarBody>
                </MessageBar>
              )}

              {spansData?.ok && spansData.rollup && spansData.root && (
                <SplitPane storageKey="eval-depth-spans" defaultSize="200px" direction="vertical">
                  {/* Rollup stat tiles */}
                  <div style={{ padding: tokens.spacingVerticalS }}>
                    <TileGrid minTileWidth={150}>
                      {[
                        { label: 'Total latency', value: fmtMs(spansData.rollup.totalLatencyMs) },
                        { label: 'Total tokens',  value: spansData.rollup.totalTokens > 0 ? String(spansData.rollup.totalTokens) : '—' },
                        { label: 'Spans',         value: String(spansData.rollup.spanCount) },
                        { label: 'Errors',        value: String(spansData.rollup.errorCount) },
                      ].map((t) => (
                        <div key={t.label} className={s.rollupTile}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.label}</Caption1>
                          <Text weight="semibold" size={400}>{t.value}</Text>
                        </div>
                      ))}
                    </TileGrid>
                  </div>

                  {/* Span waterfall */}
                  <div style={{
                    overflowY: 'auto',
                    padding: tokens.spacingVerticalS,
                    display: 'flex', flexDirection: 'column', gap: '2px',
                    backgroundColor: tokens.colorNeutralBackground1,
                    borderRadius: tokens.borderRadiusMedium,
                    border: `1px solid ${tokens.colorNeutralStroke2}`,
                  }}>
                    <SpanRow span={spansData.root} depth={0} />
                  </div>
                </SplitPane>
              )}

              {!selectedThreadId && (
                <EmptyState
                  icon={<Timeline24Regular />}
                  title="Select a thread"
                  body="Pick a recent agent thread from the dropdown above to render its span waterfall."
                />
              )}
            </>
          )}
        </div>
      </Section>

      {/* ── 3. Continuous-eval regression alert ──────────────────────────── */}
      <Section
        title="Continuous-eval regression alert"
        actions={
          <Button
            appearance="transparent"
            icon={alertLoading ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
            onClick={loadAlert}
            disabled={alertLoading}
          >
            Refresh
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
          <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
            A real Azure Monitor scheduled-query alert fires every 15 minutes when any agent eval
            avgScore falls below the threshold. The alert appears in Azure Monitor and can be routed
            to any action group (email, webhook, ITSM).
          </Body1>

          {alertError && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Alert not available</MessageBarTitle>
                {alertError}
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Current alert status */}
          {alertRule !== undefined && !alertError && (
            <div className={s.toolbar}>
              {alertRule === null ? (
                <Badge appearance="outline" color="informative">Not created</Badge>
              ) : alertRule.enabled ? (
                <Badge appearance="filled" color="success" icon={<CheckmarkCircle16Filled />}>Active</Badge>
              ) : (
                <Badge appearance="outline" color="warning" icon={<Warning16Filled />}>Disabled</Badge>
              )}
              <Text>
                {alertRule === null
                  ? `No "${EVAL_ALERT_NAME}" rule found — create one below.`
                  : `Rule: ${alertRule.name}`}
              </Text>
            </div>
          )}

          {/* Threshold config */}
          <div className={s.toolbar}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Score threshold (1–5):</Caption1>
            <Dropdown
              value={String(alertThreshold)}
              onOptionSelect={(_, d) => setAlertThreshold(Number(d.optionValue))}
              style={{ width: '80px' }}
            >
              {[4.5, 4.0, 3.5, 3.0].map((v) => (
                <Option key={v} value={String(v)} text={String(v)}>{String(v)}</Option>
              ))}
            </Dropdown>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Alert fires when avgScore &lt; {alertThreshold} in the past hour
            </Caption1>
          </div>

          <div className={s.toolbar}>
            <Button
              appearance="primary"
              icon={alertSaving ? <Spinner size="tiny" /> : <AlertOn24Regular />}
              disabled={alertSaving}
              onClick={() => saveAlert(true)}
            >
              {alertRule ? 'Update alert' : 'Create alert'}
            </Button>
            {alertRule?.enabled && (
              <Button appearance="secondary" disabled={alertSaving} onClick={disableAlert}>
                Disable
              </Button>
            )}
            {alertRule === null && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Requires: LOOM_SUBSCRIPTION_ID, LOOM_ALERT_RG, LOOM_LOG_ANALYTICS_RESOURCE_ID
              </Caption1>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

export default EvalDepthPanel;
