'use client';

/**
 * WS-1.4 — Unified Agent Quality panel (Admin → Agent Quality).
 *
 * ONE surface consolidating the four EXISTING, real agent-quality backends that
 * used to be scattered across routes:
 *   • Evaluations  — GET/POST /api/foundry/agents/eval   (LLM-judge scored runs
 *                    + regression-vs-baseline, computed by lib/admin/agent-quality)
 *   • Red-team     — /api/admin/agent-quality (list) + /api/items/ai-red-team/[id]
 *                    (drill) — real refusal-classified adversarial scans
 *   • Traces       — GET /api/foundry/agents/rollup + /threads (AgentOps: real
 *                    token/cost/latency per run + per-run step timeline; the
 *                    tier-router's model tier surfaced on each trace)
 *   • Latency SLO  — the shared CopilotSloCard over /api/admin/performance/copilot-slo
 *
 * Every tile/score/trace reads REAL data; a source with no data yet renders an
 * honest EmptyState / gate, never a fabricated number (no-vaporware.md). Fluent
 * v9 + Loom tokens, AdminShell siblings' look, SplitPane for the trace timeline
 * (web3-ui.md / ux-baseline G3).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Dropdown, Option, Spinner, Subtitle2, Text,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, Beaker24Regular, ShieldError24Regular,
  Timeline24Regular, BranchCompare20Regular, CheckmarkCircle16Filled,
  ErrorCircle16Filled, Warning16Filled, Bot24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { CopilotSloCard } from '@/lib/components/admin/copilot-slo-card';
import {
  buildScorecard, latestRegression, failingEvalRows,
  type EvalRunLike, type EvalRegression, type ScorecardTile, type RollupLike, type RedTeamLike,
} from '@/lib/admin/agent-quality';

// ── Wire shapes ──────────────────────────────────────────────────────────────

interface AgentInfo { name: string; description?: string }
interface Gate { code: string; error: string; hint?: string; missing?: string }
interface RedTeamRunSummary {
  id: string; startedAt?: string; finishedAt?: string; deployment?: string;
  categories?: string[]; refusalRate: number; attackSuccessRate: number;
  total: number; unsafe: number; partial: number;
}
interface RedTeamItem {
  id: string; displayName: string; workspaceId: string; runCount: number;
  latestRun: RedTeamRunSummary | null;
}
interface SloEval { id: string; met: boolean; sampled: number }
interface Snapshot {
  agents: { configured: boolean; list: AgentInfo[]; gate?: Gate };
  redTeam: { items: RedTeamItem[]; error?: string };
  slo: { evaluations: SloEval[] };
}

interface RollupResp {
  ok: boolean; error?: string; code?: string; hint?: string;
  rollup?: RollupLike & { avgCostUsd: number; totalTokens: number; byModel: any[] };
  runs?: TraceRun[];
}
interface TraceRun {
  threadId: string; runId?: string; status: string; model: string;
  costUsd: number; latencyMs: number; totalTokens: number; createdAt: string;
}
interface ThreadStep { id: string; type: string; status: string; durationMs?: number }
interface ThreadDetail {
  threadId: string; status: string; tier?: string; model?: string;
  question: string; answer: string; costUsd?: number; latencyMs?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  steps?: Array<{ id?: string; type?: string; status?: string; createdAt?: number; completedAt?: number }>;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: '1 1 auto' },
  scoreGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  tileLabel: {
    fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  tileValue: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  tileRow: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  sub: { color: tokens.colorNeutralForeground3 },
  runList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  runItem: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer', textAlign: 'left', minWidth: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  runItemActive: {
    borderColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  rowTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left', fontSize: tokens.fontSizeBase100, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontWeight: tokens.fontWeightSemibold,
  },
  td: {
    padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    verticalAlign: 'top', fontSize: tokens.fontSizeBase200,
  },
  rowFail: { backgroundColor: tokens.colorStatusDangerBackground1 },
  rowWarn: { backgroundColor: tokens.colorStatusWarningBackground1 },
  splitWrap: { height: '460px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden' },
  pane: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 },
  paneScroll: { overflowY: 'auto', padding: tokens.spacingVerticalM, minWidth: 0, flex: '1 1 auto' },
  paneHead: {
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200,
  },
  timeline: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  step: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS, paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke3}`, minWidth: 0,
  },
  bar: { height: '6px', borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorBrandBackground },
  barTrack: { flex: '1 1 auto', height: '6px', borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground3, minWidth: '40px', overflow: 'hidden' },
  gradePill: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: '22px', height: '22px', paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusCircular, fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  answer: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: tokens.colorNeutralForeground2 },
  catBars: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  catRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  catLabel: { width: '150px', minWidth: '150px', fontSize: tokens.fontSizeBase200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

// ── Small helpers ────────────────────────────────────────────────────────────

const toneColor: Record<string, string> = {
  good: tokens.colorPaletteGreenForeground1,
  warn: tokens.colorPaletteYellowForeground2,
  bad: tokens.colorPaletteRedForeground1,
  neutral: tokens.colorNeutralForeground2,
};
const gradeColor: Record<string, string> = {
  A: tokens.colorPaletteGreenBackground3,
  B: tokens.colorPaletteGreenBackground3,
  C: tokens.colorPaletteYellowBackground3,
  D: tokens.colorPaletteDarkOrangeBackground3,
  F: tokens.colorPaletteRedBackground3,
};

function GradePill({ grade }: { grade?: string }) {
  const s = useStyles();
  if (!grade) return null;
  return <span className={s.gradePill} style={{ backgroundColor: gradeColor[grade] ?? tokens.colorNeutralBackground5 }}>{grade}</span>;
}

function fmtMs(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
function fmtTime(iso?: string): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function scoreBadgeColor(score: number, threshold: number): 'success' | 'warning' | 'danger' | 'subtle' {
  if (score === 0) return 'subtle';
  if (score >= threshold) return 'success';
  if (score >= threshold - 1) return 'warning';
  return 'danger';
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function AgentQualityPanel() {
  const s = useStyles();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Selection state.
  const [agent, setAgent] = useState<string | null>(null);
  const [evalRuns, setEvalRuns] = useState<EvalRunLike[] | null>(null);
  const [evalGate, setEvalGate] = useState<string | null>(null);
  const [selectedEvalId, setSelectedEvalId] = useState<string | null>(null);
  const [rollup, setRollup] = useState<RollupResp['rollup'] | null>(null);
  const [traceRuns, setTraceRuns] = useState<TraceRun[] | null>(null);
  const [traceGate, setTraceGate] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  // Red-team drill.
  const [rtItemId, setRtItemId] = useState<string | null>(null);
  const [rtRows, setRtRows] = useState<any[] | null>(null);
  const [rtLoading, setRtLoading] = useState(false);

  const loadSnapshot = useCallback(() => {
    setLoading(true); setErr(null);
    clientFetch('/api/admin/agent-quality', { cache: 'no-store' }, 25_000)
      .then((r) => (r.status === 401 || r.status === 403 ? null : r.json()))
      .then((j: any) => {
        if (!j) { setErr('Sign in as a tenant admin to view agent-quality telemetry.'); return; }
        if (j.ok) {
          setSnap(j as Snapshot);
          if (!agent && j.agents?.list?.length) setAgent(j.agents.list[0].name);
        } else setErr(j.error || 'Failed to load agent-quality snapshot');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [agent]);

  useEffect(() => { loadSnapshot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load per-agent evals + rollup/traces when the selected agent changes.
  useEffect(() => {
    if (!agent) { setEvalRuns(null); setRollup(null); setTraceRuns(null); return; }
    const a = encodeURIComponent(agent);
    setEvalRuns(null); setEvalGate(null); setSelectedEvalId(null);
    setRollup(null); setTraceRuns(null); setTraceGate(null); setSelectedThread(null); setThreadDetail(null);

    clientFetch(`/api/foundry/agents/eval?agent=${a}`, { cache: 'no-store' }, 20_000)
      .then((r) => r.json())
      .then((j: any) => {
        if (j.ok) { setEvalRuns(j.runs || []); setSelectedEvalId((j.runs || [])[0]?.id ?? null); }
        else setEvalGate(j.hint || j.error || 'Evaluations unavailable.');
      })
      .catch((e) => setEvalGate(String(e)));

    clientFetch(`/api/foundry/agents/rollup?agent=${a}`, { cache: 'no-store' }, 20_000)
      .then((r) => r.json())
      .then((j: RollupResp) => {
        if (j.ok) { setRollup(j.rollup ?? null); setTraceRuns(j.runs ?? []); }
        else setTraceGate(j.hint || j.error || 'AgentOps traces unavailable.');
      })
      .catch((e) => setTraceGate(String(e)));
  }, [agent]);

  // Load a full thread transcript when a trace is selected.
  useEffect(() => {
    if (!agent || !selectedThread) { setThreadDetail(null); return; }
    setThreadLoading(true);
    clientFetch(`/api/foundry/agents/threads?agent=${encodeURIComponent(agent)}&threadId=${encodeURIComponent(selectedThread)}`, { cache: 'no-store' }, 20_000)
      .then((r) => r.json())
      .then((j: any) => setThreadDetail(j.ok ? j.thread : null))
      .catch(() => setThreadDetail(null))
      .finally(() => setThreadLoading(false));
  }, [agent, selectedThread]);

  // Load red-team probe rows when a scan item is selected.
  useEffect(() => {
    if (!rtItemId) { setRtRows(null); return; }
    setRtLoading(true);
    clientFetch(`/api/items/ai-red-team/${encodeURIComponent(rtItemId)}`, { cache: 'no-store' }, 20_000)
      .then((r) => r.json())
      .then((j: any) => {
        const runs = Array.isArray(j?.state?.runs) ? j.state.runs : [];
        setRtRows(Array.isArray(runs[0]?.results) ? runs[0].results : []);
      })
      .catch(() => setRtRows([]))
      .finally(() => setRtLoading(false));
  }, [rtItemId]);

  // ── Derived: selected eval run + regression + scorecard ──
  const selectedEval = useMemo(
    () => (evalRuns || []).find((r) => r.id === selectedEvalId) ?? (evalRuns || [])[0] ?? null,
    [evalRuns, selectedEvalId],
  );
  const regression: EvalRegression | null = useMemo(() => {
    if (!evalRuns || !selectedEval) return null;
    const idx = evalRuns.findIndex((r) => r.id === selectedEval.id);
    return idx >= 0 ? latestRegression(evalRuns.slice(idx)) : null;
  }, [evalRuns, selectedEval]);

  const latestRedTeam: RedTeamLike | null = useMemo(() => {
    const items = snap?.redTeam.items || [];
    const withRun = items.filter((i) => i.latestRun);
    if (!withRun.length) return null;
    // Freshest scan across all items.
    const newest = withRun.sort((a, b) => (b.latestRun!.finishedAt || '').localeCompare(a.latestRun!.finishedAt || ''))[0];
    const r = newest.latestRun!;
    return { total: r.total, refusalRate: r.refusalRate, attackSuccessRate: r.attackSuccessRate };
  }, [snap]);

  const tiles: ScorecardTile[] = useMemo(() => buildScorecard({
    latestEval: selectedEval,
    evalRegression: regression,
    redTeam: latestRedTeam,
    slo: snap ? { evaluations: snap.slo.evaluations } : null,
    rollup: rollup ? { runs: rollup.runs, successRate: rollup.successRate, totalCostUsd: rollup.totalCostUsd, avgLatencyMs: rollup.avgLatencyMs, p95LatencyMs: rollup.p95LatencyMs } : null,
  }), [selectedEval, regression, latestRedTeam, snap, rollup]);

  if (loading && !snap) {
    return <Spinner size="large" label="Loading agent quality…" labelPosition="below" style={{ marginTop: tokens.spacingVerticalXXXL }} />;
  }
  if (err && !snap) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody><MessageBarTitle>Sign-in required</MessageBarTitle> {err}</MessageBarBody>
      </MessageBar>
    );
  }

  const agents = snap?.agents.list ?? [];

  return (
    <div>
      {/* Toolbar: agent picker + refresh */}
      <div className={s.toolbar} style={{ marginBottom: tokens.spacingVerticalL }}>
        <Bot24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Text weight="semibold">Agent</Text>
        <Dropdown
          aria-label="Select agent"
          placeholder={snap?.agents.configured ? 'Select an agent' : 'No agents configured'}
          value={agent ?? ''}
          selectedOptions={agent ? [agent] : []}
          disabled={!agents.length}
          onOptionSelect={(_e, d) => d.optionValue && setAgent(d.optionValue)}
          style={{ minWidth: '220px' }}
        >
          {agents.map((a) => <Option key={a.name} value={a.name} text={a.name}>{a.name}</Option>)}
        </Dropdown>
        <div className={s.spacer} />
        <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={loadSnapshot} disabled={loading}>Refresh</Button>
      </div>

      {/* ── Overview scorecard ── */}
      <Section
        title="Quality scorecard"
        actions={<LearnPopover
          title="Agent Quality scorecard"
          content="One roll-up of eval quality (LLM-judge mean + regression vs the prior run), red-team refusal rate (defensive adversarial scan), Copilot turn-latency SLO attainment, and AgentOps cost/latency for the selected agent. Every tile reads a real backend; an em-dash means that source has no data yet."
          learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai"
        />}
      >
        <div className={s.scoreGrid}>
          {tiles.map((t) => (
            <div key={t.id} className={s.tile}>
              <span className={s.tileLabel}>{t.label}</span>
              <div className={s.tileRow}>
                <span className={s.tileValue} style={{ color: toneColor[t.tone] }}>{t.value}</span>
                <GradePill grade={t.grade} />
              </div>
              <Caption1 className={mergeClasses(s.sub, s.ellipsis)}>{t.caption}</Caption1>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Evaluations ── */}
      <Section
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}><Beaker24Regular style={{ color: tokens.colorBrandForeground1 }} /> Evaluation sets &amp; LLM-judge scores</span>}
        actions={<LearnPopover
          title="Agent evaluations"
          content="Each run replays a prompt-set through the agent (a real Agent Service call) and an Azure OpenAI judge scores every answer 1–5 against your criteria. Pick a run to see per-turn scores and drill into a failing turn; the banner compares it to the prior run (regression-vs-baseline)."
          learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk"
        />}
      >
        {renderEvaluations()}
      </Section>

      {/* ── Red-team ── */}
      <Section
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}><ShieldError24Regular style={{ color: tokens.colorBrandForeground1 }} /> Red-team results</span>}
        actions={<LearnPopover
          title="AI red-teaming"
          content="Defensive safety scans: curated adversarial probes are sent to a model deployment and each response is classified refused / partial / unsafe by an AOAI judge (Azure-native analog of the Microsoft AI Red Teaming Agent). Higher refusal rate is better. Drill into a scan to see which probe slipped through."
          learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/how-to/develop/run-scans-ai-red-teaming-agent"
        />}
      >
        {renderRedTeam()}
      </Section>

      {/* ── Traces ── */}
      <Section
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}><Timeline24Regular style={{ color: tokens.colorBrandForeground1 }} /> Per-agent trace timeline</span>}
        actions={<LearnPopover
          title="AgentOps traces"
          content="Every persisted run for the selected agent with its real token usage, estimated cost, wall-clock latency, runtime tier and model. Select a run to see its transcript and per-step timeline; a non-completed run is your failing-turn drill-down."
          learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/how-to/develop/trace-agents-sdk"
        />}
      >
        {renderTraces()}
      </Section>

      {/* ── Latency SLO (shared card) ── */}
      <CopilotSloCard />
    </div>
  );

  // ── Sub-renderers (closures over state) ──

  function renderEvaluations() {
    if (!agent) return <EmptyState icon={<Beaker24Regular />} title="Select an agent" body="Pick an agent above to view its evaluation runs and LLM-judge scores." />;
    if (!snap?.agents.configured && snap?.agents.gate) {
      return <GateBar gate={snap.agents.gate} />;
    }
    if (evalGate) return <MessageBar intent="warning"><MessageBarBody>{evalGate}</MessageBarBody></MessageBar>;
    if (!evalRuns) return <Spinner size="tiny" label="Loading eval runs…" labelPosition="after" />;
    if (evalRuns.length === 0) {
      return <EmptyState
        icon={<Beaker24Regular />}
        title="No eval runs yet"
        body={`Run an evaluation for “${agent}” from the AI Foundry Agents playground (Evaluate) — each run appears here with per-turn LLM-judge scores and a regression comparison.`}
        primaryAction={{ label: 'Open AI Foundry Agents', href: '/copilot' }}
      />;
    }
    const threshold = selectedEval?.passThreshold ?? 4;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
        {regression && regression.status !== 'no-baseline' && <RegressionBanner reg={regression} />}
        <div className={s.chips}>
          <Text size={200} className={s.sub}>Run:</Text>
          <Dropdown
            aria-label="Select eval run"
            value={selectedEval?.name ?? ''}
            selectedOptions={selectedEval ? [selectedEval.id] : []}
            onOptionSelect={(_e, d) => d.optionValue && setSelectedEvalId(d.optionValue)}
            style={{ minWidth: '260px' }}
          >
            {evalRuns.map((r) => (
              <Option key={r.id} value={r.id} text={r.name}>
                {r.name} · {r.avgScore.toFixed(1)}/5 · {new Date(r.createdAt).toLocaleDateString()}
              </Option>
            ))}
          </Dropdown>
          {selectedEval && (
            <>
              <Badge appearance="tint" color="informative">avg {selectedEval.avgScore.toFixed(2)}/5</Badge>
              <Badge appearance="tint" color="brand">{Math.round(selectedEval.passRate * 100)}% pass</Badge>
              <Badge appearance="outline" color="danger">{failingEvalRows(selectedEval).length} failing</Badge>
              {selectedEval.model && <Badge appearance="outline">{selectedEval.model}</Badge>}
            </>
          )}
        </div>
        {selectedEval && (
          <div style={{ overflowX: 'auto' }}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th className={s.th} style={{ width: '30%' }}>Prompt</th>
                  <th className={s.th}>Answer</th>
                  <th className={s.th} style={{ width: '84px' }}>Score</th>
                  <th className={s.th} style={{ width: '28%' }}>Judge rationale</th>
                </tr>
              </thead>
              <tbody>
                {selectedEval.results.map((row, i) => {
                  const fail = row.score < threshold;
                  return (
                    <tr key={i} className={fail ? (row.score === 0 ? s.rowWarn : s.rowFail) : undefined}>
                      <td className={s.td}>{row.prompt}</td>
                      <td className={s.td}><span className={s.answer}>{(row.answer || '').slice(0, 400) || <em className={s.sub}>no answer</em>}</span></td>
                      <td className={s.td}>
                        <Badge appearance="filled" color={scoreBadgeColor(row.score, threshold)}>
                          {row.score === 0 ? 'n/a' : `${row.score}/5`}
                        </Badge>
                      </td>
                      <td className={mergeClasses(s.td, s.sub)}>{row.rationale || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  function renderRedTeam() {
    const items = snap?.redTeam.items ?? [];
    if (snap?.redTeam.error) return <MessageBar intent="warning"><MessageBarBody>{snap.redTeam.error}</MessageBarBody></MessageBar>;
    if (items.length === 0) {
      return <EmptyState
        icon={<ShieldError24Regular />}
        title="No red-team scans yet"
        body="Create an AI Red-Team item and run a scan to measure a model deployment's refusal rate against curated adversarial probes. Completed scans appear here."
        primaryAction={{ label: 'Browse item catalog', href: '/browse' }}
      />;
    }
    const active = items.find((i) => i.id === rtItemId) ?? null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
        <div className={s.scoreGrid}>
          {items.map((it) => {
            const r = it.latestRun;
            const on = it.id === rtItemId;
            return (
              <button key={it.id} className={mergeClasses(s.runItem, on && s.runItemActive)} onClick={() => setRtItemId(on ? null : it.id)}>
                <div className={s.rowTop}>
                  <Text weight="semibold" className={s.ellipsis} style={{ flex: '1 1 auto' }}>{it.displayName}</Text>
                  {r ? <Badge appearance="filled" color={r.attackSuccessRate > 5 ? 'danger' : r.attackSuccessRate > 0 ? 'warning' : 'success'}>{r.refusalRate.toFixed(0)}% refused</Badge>
                     : <Badge appearance="outline">no runs</Badge>}
                </div>
                <Caption1 className={s.sub}>
                  {r ? `${r.total} probes · ${r.unsafe} unsafe · ${r.partial} partial · ${fmtTime(r.finishedAt)}` : `${it.runCount} run(s)`}
                </Caption1>
              </button>
            );
          })}
        </div>
        {active && (
          <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM }}>
            <Subtitle2>{active.displayName} — latest scan probes</Subtitle2>
            {rtLoading ? <Spinner size="tiny" label="Loading probes…" labelPosition="after" /> :
              !rtRows || rtRows.length === 0 ? <Text className={s.sub}>No probe rows on the latest run (or the scan is owned by another user).</Text> :
              <div style={{ overflowX: 'auto', marginTop: tokens.spacingVerticalS }}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th className={s.th} style={{ width: '120px' }}>Category</th>
                      <th className={s.th}>Probe</th>
                      <th className={s.th} style={{ width: '96px' }}>Verdict</th>
                      <th className={s.th}>Response</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rtRows.map((row: any, i: number) => {
                      const bad = row.verdict === 'unsafe';
                      const warn = row.verdict === 'partial';
                      return (
                        <tr key={i} className={bad ? s.rowFail : warn ? s.rowWarn : undefined}>
                          <td className={s.td}>{row.category}</td>
                          <td className={s.td}>{row.prompt}</td>
                          <td className={s.td}>
                            <Badge appearance="filled" color={bad ? 'danger' : warn ? 'warning' : 'success'}>{row.verdict}</Badge>
                          </td>
                          <td className={mergeClasses(s.td, s.sub)}>{(row.response || '').slice(0, 300)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>}
          </div>
        )}
      </div>
    );
  }

  function renderTraces() {
    if (!agent) return <EmptyState icon={<Timeline24Regular />} title="Select an agent" body="Pick an agent above to see its run traces, token/cost/latency and per-step timeline." />;
    if (!snap?.agents.configured && snap?.agents.gate) return <GateBar gate={snap.agents.gate} />;
    if (traceGate) return <MessageBar intent="warning"><MessageBarBody>{traceGate}</MessageBarBody></MessageBar>;
    if (!traceRuns) return <Spinner size="tiny" label="Loading traces…" labelPosition="after" />;
    if (traceRuns.length === 0) {
      return <EmptyState icon={<Timeline24Regular />} title="No runs traced yet" body={`Run “${agent}” in the Agents playground — each run is persisted here with its real token usage, cost estimate, latency, tier and step timeline.`} primaryAction={{ label: 'Open AI Foundry Agents', href: '/copilot' }} />;
    }
    return (
      <div className={s.splitWrap}>
        <SplitPane direction="horizontal" defaultSize="38%" minSize={220} storageKey="agent-quality-traces" dividerLabel="Resize trace list">
          <div className={s.pane}>
            <div className={s.paneHead}>Runs ({traceRuns.length})</div>
            <div className={mergeClasses(s.paneScroll, s.runList)}>
              {traceRuns.map((t) => {
                const on = t.threadId === selectedThread;
                const failed = t.status !== 'completed';
                return (
                  <button key={t.threadId} className={mergeClasses(s.runItem, on && s.runItemActive)} onClick={() => setSelectedThread(t.threadId)}>
                    <div className={s.rowTop}>
                      {failed ? <ErrorCircle16Filled style={{ color: tokens.colorPaletteRedForeground1 }} /> : <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />}
                      <Text size={200} weight="semibold" className={s.ellipsis} style={{ flex: '1 1 auto' }}>{t.model || 'run'}</Text>
                      <Caption1 className={s.sub}>{fmtMs(t.latencyMs)}</Caption1>
                    </div>
                    <div className={s.chips}>
                      <Caption1 className={s.sub}>{t.totalTokens} tok · ${t.costUsd.toFixed(4)}</Caption1>
                    </div>
                    <Caption1 className={s.sub}>{fmtTime(t.createdAt)}</Caption1>
                  </button>
                );
              })}
            </div>
          </div>
          <div className={s.pane}>
            <div className={s.paneHead}>Trace inspector</div>
            <div className={s.paneScroll}>{renderTraceInspector()}</div>
          </div>
        </SplitPane>
      </div>
    );
  }

  function renderTraceInspector() {
    if (!selectedThread) return <Text className={s.sub}>Select a run on the left to inspect its transcript, model tier, and per-step timeline.</Text>;
    if (threadLoading) return <Spinner size="tiny" label="Loading trace…" labelPosition="after" />;
    if (!threadDetail) return <Text className={s.sub}>Trace transcript unavailable (it may have been evicted by the retention cap).</Text>;
    const d = threadDetail;
    const failed = d.status !== 'completed';
    const steps = (d.steps || []).map((st, i) => {
      const start = st.createdAt ? st.createdAt * 1000 : undefined;
      const end = st.completedAt ? st.completedAt * 1000 : undefined;
      const durationMs = start !== undefined && end !== undefined && end >= start ? end - start : undefined;
      return { id: st.id || `step-${i}`, type: st.type || 'step', status: st.status || 'unknown', durationMs } as ThreadStep;
    });
    const maxDur = Math.max(1, ...steps.map((x) => x.durationMs || 0));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 }}>
        <div className={s.chips}>
          <Badge appearance="filled" color={failed ? 'danger' : 'success'}>{d.status}</Badge>
          {d.model && <Badge appearance="tint" color="brand">{d.model}</Badge>}
          {d.tier && <Tooltip content="Agent runtime tier (Foundry Agent Service / MAF)" relationship="label"><Badge appearance="outline">tier: {d.tier}</Badge></Tooltip>}
          {typeof d.latencyMs === 'number' && <Badge appearance="outline">{fmtMs(d.latencyMs)}</Badge>}
          {typeof d.costUsd === 'number' && <Badge appearance="outline">${d.costUsd.toFixed(4)}</Badge>}
          {d.usage && <Badge appearance="outline">{d.usage.totalTokens} tok</Badge>}
        </div>
        <div>
          <Caption1 className={s.tileLabel}>Question</Caption1>
          <Body1 className={s.answer}>{d.question}</Body1>
        </div>
        <div>
          <Caption1 className={s.tileLabel}>Answer</Caption1>
          <Body1 className={s.answer}>{d.answer || <em className={s.sub}>no answer produced</em>}</Body1>
        </div>
        <div>
          <Caption1 className={s.tileLabel}>Step timeline</Caption1>
          {steps.length === 0 ? <Text className={s.sub}>No step spans recorded for this run.</Text> :
            <div className={s.timeline}>
              {steps.map((st) => {
                const bad = st.status === 'failed' || st.status === 'cancelled' || st.status === 'expired';
                return (
                  <div key={st.id} className={s.step}>
                    {bad ? <Warning16Filled style={{ color: tokens.colorPaletteRedForeground1 }} /> : <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />}
                    <Text size={200} className={s.ellipsis} style={{ width: '150px', minWidth: '120px' }}>{st.type}</Text>
                    <div className={s.barTrack}><div className={s.bar} style={{ width: `${Math.round(((st.durationMs || 0) / maxDur) * 100)}%`, backgroundColor: bad ? tokens.colorPaletteRedForeground1 : tokens.colorBrandBackground }} /></div>
                    <Caption1 className={s.sub} style={{ width: '64px', textAlign: 'right' }}>{fmtMs(st.durationMs)}</Caption1>
                  </div>
                );
              })}
            </div>}
        </div>
      </div>
    );
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function RegressionBanner({ reg }: { reg: EvalRegression }) {
  const s = useStyles();
  const intent = reg.status === 'regressed' ? 'error' : reg.status === 'improved' ? 'success' : 'info';
  const sign = reg.avgScoreDelta > 0 ? '+' : '';
  return (
    <MessageBar intent={intent as any}>
      <MessageBarBody>
        <MessageBarTitle>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <BranchCompare20Regular /> {reg.status === 'regressed' ? 'Regression vs baseline' : reg.status === 'improved' ? 'Improved vs baseline' : 'Stable vs baseline'}
          </span>
        </MessageBarTitle>
        Δ avg score {sign}{reg.avgScoreDelta.toFixed(2)} · Δ pass-rate {reg.passRateDelta >= 0 ? '+' : ''}{(reg.passRateDelta * 100).toFixed(1)}%
        {reg.regressedPrompts.length > 0 && (
          <div className={s.catBars}>
            {reg.regressedPrompts.slice(0, 5).map((p, i) => (
              <div key={i} className={s.catRow}>
                <Badge appearance="filled" color={p.crossedFail ? 'danger' : 'warning'}>{p.baselineScore}→{p.latestScore}</Badge>
                <Text size={200} className={s.ellipsis} style={{ flex: '1 1 auto' }}>{p.prompt}</Text>
              </div>
            ))}
          </div>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}

function GateBar({ gate }: { gate: Gate }) {
  return (
    <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>AI Foundry agents not configured</MessageBarTitle>
        {gate.error}{gate.hint ? ` — ${gate.hint}` : ''}
        {gate.missing ? ` Set ${gate.missing} on the Console app (Admin → Runtime configuration).` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}

export default AgentQualityPanel;
