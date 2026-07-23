'use client';

/**
 * E5 — Copilot Quality panel (Admin → Copilot quality).
 *
 * The real-data admin view for the in-product Copilot eval harness
 * (azure-functions/copilot-evaluator, E1–E4). It reads the scored `eval-run` /
 * `eval-result` docs the evaluator writes to Cosmos `loom-copilot-evals` and
 * renders, per Copilot surface: a letter-graded scorecard (retrieval hit-rate /
 * MRR / judge grounding + a trend sparkline), a per-surface run-history trend
 * chart, a worst-questions table (forbidden-phrase hits + lowest grounding), and
 * a per-question drill-in (expected vs retrieved chunks + the judge rationale) —
 * plus a "Run now" that POSTs the E2 HTTP trigger and floor status vs
 * content/evals/eval-floors.json (E3).
 *
 * Every number reads a REAL backend (no-vaporware.md); a surface with no runs
 * renders a guided EmptyState (never a fabricated 0), and the svc-copilot-
 * evaluator gate surfaces the shared HonestGate + Fix-it (G2) when the Function
 * is not wired. Azure OpenAI / AI Search / Cosmos only — no Fabric dependency.
 * Fluent v9 + Loom tokens, sibling look (agent-quality), SplitPane for the
 * drill-in (web3-ui.md / ux-baseline G3).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Dropdown, Option, Spinner, Subtitle2, Text,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle, Menu, MenuTrigger,
  MenuPopover, MenuList, MenuItem, MenuButton, Skeleton, SkeletonItem,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, Play16Regular, Beaker24Regular,
  DataTrending24Regular, TargetArrow16Regular, SearchInfo24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import {
  fmtScore5, fmtPct, fmtDeltaPct, isSearchSurface, searchDomainLabel,
  type SurfaceSummary, type OverallStats, type RunRef, type TrendPoint,
  type QualityGrade,
} from '@/lib/admin/copilot-quality';
import type { CopilotEvalResultDoc } from '@/lib/azure/copilot-evals-model';

// ── Wire shapes ──────────────────────────────────────────────────────────────

interface Snapshot {
  ok: boolean;
  summaries: SurfaceSummary[];
  overall: OverallStats;
  evaluator: { configured: boolean; missing: string[] };
  floorsAvailable: boolean;
  generatedAt: string;
}
interface DrillResp {
  ok: boolean;
  surface: string;
  runs: RunRef[];
  selectedRunId: string | null;
  results: CopilotEvalResultDoc[];
  worst: CopilotEvalResultDoc[];
}

// ── Styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  spacer: { flex: '1 1 auto' },
  overallRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0, textAlign: 'left', cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  tileActive: { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow16 },
  tileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' },
  tileName: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '1 1 auto' },
  metricRow: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  metric: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  metricVal: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  metricLabel: {
    fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold,
  },
  sub: { color: tokens.colorNeutralForeground3 },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  floorDots: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
  gradePill: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: '24px', height: '24px', paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusCircular, fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForegroundOnBrand, flexShrink: 0,
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left', fontSize: tokens.fontSizeBase100, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap',
  },
  td: {
    padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    verticalAlign: 'top', fontSize: tokens.fontSizeBase200,
  },
  rowBtn: {
    color: tokens.colorNeutralForeground1, cursor: 'pointer', textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowFail: { backgroundColor: tokens.colorStatusDangerBackground1 },
  rowWarn: { backgroundColor: tokens.colorStatusWarningBackground1 },
  chartWrap: { width: '100%', minWidth: 0, overflowX: 'auto' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  answer: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: tokens.colorNeutralForeground2 },
  chunkList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS, minWidth: 0 },
  chunk: { fontSize: tokens.fontSizeBase200, fontFamily: tokens.fontFamilyMonospace, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  drillGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))', gap: tokens.spacingHorizontalL, minWidth: 0 },
  skelRow: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  skelTile: { width: '260px', height: '140px' },
});

// ── Small helpers ────────────────────────────────────────────────────────────

const gradeColor: Record<QualityGrade, string> = {
  A: tokens.colorPaletteGreenBackground3,
  B: tokens.colorPaletteGreenBackground3,
  C: tokens.colorPaletteYellowBackground3,
  D: tokens.colorPaletteDarkOrangeBackground3,
  F: tokens.colorPaletteRedBackground3,
};

function GradePill({ grade }: { grade: QualityGrade | null }) {
  const s = useStyles();
  if (!grade) return <Badge appearance="outline" color="informative">no runs</Badge>;
  return <span className={s.gradePill} style={{ backgroundColor: gradeColor[grade] }}>{grade}</span>;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtMs(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const floorMarkColor: Record<'ok' | 'below' | 'na', string> = {
  ok: tokens.colorPaletteGreenForeground1,
  below: tokens.colorPaletteRedForeground1,
  na: tokens.colorNeutralForeground4,
};

function FloorDot({ mark, label }: { mark: 'ok' | 'below' | 'na'; label: string }) {
  const text = mark === 'ok' ? `${label}: above floor` : mark === 'below' ? `${label}: BELOW floor` : `${label}: no floor set`;
  return (
    <Tooltip content={text} relationship="label">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS }}>
        <span style={{ width: '8px', height: '8px', borderRadius: tokens.borderRadiusCircular, backgroundColor: floorMarkColor[mark], display: 'inline-block' }} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
      </span>
    </Tooltip>
  );
}

/** Tiny inline sparkline (SVG) of a 0..1 series (pass-rate by default). */
function Sparkline({ points, accessor }: { points: TrendPoint[]; accessor: (p: TrendPoint) => number | null }) {
  const vals = points.map(accessor).map((v) => (v === null || v === undefined || !Number.isFinite(v) ? null : v));
  const present = vals.filter((v): v is number => v !== null);
  if (present.length < 2) return <Caption1 style={{ color: tokens.colorNeutralForeground4 }}>trend after ≥2 runs</Caption1>;
  const w = 120, h = 28, pad = 2;
  const max = Math.max(...present, 0.0001);
  const min = Math.min(...present, 0);
  const span = max - min || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const coords = vals.map((v, i) => {
    if (v === null) return null;
    const x = pad + i * step;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');
  const last = present[present.length - 1];
  const first = present[0];
  const up = last >= first;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="trend sparkline" style={{ display: 'block' }}>
      <polyline points={coords} fill="none" stroke={up ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Per-surface run-history trend chart (SVG multi-line: hit-rate + pass-rate + grounding/5). */
function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) {
    return <Text style={{ color: tokens.colorNeutralForeground3 }}>Two or more runs are needed to chart a trend for this surface.</Text>;
  }
  const w = 640, h = 200, padL = 34, padR = 12, padT = 12, padB = 22;
  const n = points.length;
  const xAt = (i: number) => padL + (i * (w - padL - padR)) / (n - 1);
  const yAt = (v: number) => padT + (1 - v) * (h - padT - padB); // 0..1 domain
  const line = (accessor: (p: TrendPoint) => number | null) =>
    points
      .map((p, i) => {
        const raw = accessor(p);
        if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
        return `${xAt(i).toFixed(1)},${yAt(raw).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  const series = [
    { label: 'Hit-rate', color: tokens.colorPaletteBlueForeground2, get: (p: TrendPoint) => p.retrievalHitRate },
    { label: 'Pass-rate', color: tokens.colorPaletteGreenForeground1, get: (p: TrendPoint) => p.passRate },
    { label: 'Grounding/5', color: tokens.colorPalettePurpleForeground2, get: (p: TrendPoint) => (p.groundingAvg === null ? null : p.groundingAvg / 5) },
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS }}>
        {series.map((s) => (
          <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <span style={{ width: '12px', height: '3px', backgroundColor: s.color, display: 'inline-block', borderRadius: tokens.borderRadiusCircular }} />
            <Caption1>{s.label}</Caption1>
          </span>
        ))}
      </div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="per-surface quality trend" preserveAspectRatio="xMidYMid meet">
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={padL} y1={yAt(g)} x2={w - padR} y2={yAt(g)} stroke={tokens.colorNeutralStroke3} strokeWidth={1} />
            <text x={padL - 6} y={yAt(g) + 3} textAnchor="end" fontSize={9} fill={tokens.colorNeutralForeground3}>{Math.round(g * 100)}</text>
          </g>
        ))}
        {series.map((s) => (
          <polyline key={s.label} points={line(s.get)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </svg>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function CopilotQualityPanel() {
  const s = useStyles();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillResp | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [question, setQuestion] = useState<CopilotEvalResultDoc | null>(null);

  const loadSnapshot = useCallback(() => {
    setLoading(true); setErr(null);
    clientFetch('/api/admin/copilot-quality', { cache: 'no-store' }, 25_000)
      .then((r) => (r.status === 401 || r.status === 403 ? null : r.json()))
      .then((j: Snapshot | null) => {
        if (!j) { setErr('Sign in as a tenant admin to view Copilot quality telemetry.'); return; }
        if (j.ok) setSnap(j);
        else setErr('Failed to load the Copilot quality snapshot.');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSnapshot(); }, [loadSnapshot]);

  // Auto-select the first surface WITH runs for the drill-in (first-open clean).
  useEffect(() => {
    if (!snap || selected) return;
    const firstWithRuns = snap.summaries.find((x) => x.totals) ?? snap.summaries[0];
    if (firstWithRuns) setSelected(firstWithRuns.surface);
  }, [snap, selected]);

  // Load the per-surface drill-in when the selection or run changes.
  useEffect(() => {
    if (!selected) { setDrill(null); return; }
    setDrillLoading(true);
    const q = selectedRunId ? `?runId=${encodeURIComponent(selectedRunId)}` : '';
    clientFetch(`/api/admin/copilot-quality/${encodeURIComponent(selected)}${q}`, { cache: 'no-store' }, 25_000)
      .then((r) => r.json())
      .then((j: DrillResp) => {
        if (j.ok) { setDrill(j); if (!selectedRunId) setSelectedRunId(j.selectedRunId); }
        else setDrill(null);
      })
      .catch(() => setDrill(null))
      .finally(() => setDrillLoading(false));
  }, [selected, selectedRunId]);

  const runNow = useCallback((surfaces?: string[]) => {
    setRunning(true); setRunMsg(null);
    clientFetch('/api/admin/copilot-quality/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(surfaces ? { surfaces } : {}),
    }, 130_000)
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
      .then(({ status, body }) => {
        if (status === 200 && body?.ok) {
          setRunMsg({ intent: 'success', text: `Evaluation triggered (${surfaces ? surfaces.join(', ') : 'all surfaces'}). Refreshing scores…` });
          setTimeout(loadSnapshot, 1500);
          if (selected) { setSelectedRunId(null); }
        } else if (status === 503) {
          setRunMsg({ intent: 'error', text: 'The evaluator Function is not wired in this deployment — use Fix it below to deploy it.' });
        } else {
          setRunMsg({ intent: 'error', text: `Run failed (${status})${body?.error ? `: ${body.error}` : ''}.` });
        }
      })
      .catch((e) => setRunMsg({ intent: 'error', text: `Run failed: ${String(e)}` }))
      .finally(() => setRunning(false));
  }, [loadSnapshot, selected]);

  // ── Loading / auth states ──
  if (loading && !snap) {
    return (
      <div>
        <Skeleton aria-label="Loading Copilot quality">
          <div className={s.skelRow}>
            {[0, 1, 2, 3].map((i) => <SkeletonItem key={i} className={s.skelTile} />)}
          </div>
        </Skeleton>
      </div>
    );
  }
  if (err && !snap) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody><MessageBarTitle>Sign-in required</MessageBarTitle> {err}</MessageBarBody>
      </MessageBar>
    );
  }

  const summaries = snap?.summaries ?? [];
  const copilotSummaries = summaries.filter((x) => !isSearchSurface(x.surface));
  const searchSummaries = summaries.filter((x) => isSearchSurface(x.surface));
  const overall = snap?.overall;
  const evaluatorGated = snap ? !snap.evaluator.configured : false;
  const anyRuns = summaries.some((x) => x.totals);
  const selectedSummary = summaries.find((x) => x.surface === selected) ?? null;

  return (
    <div>
      {/* Toolbar */}
      <div className={s.toolbar} style={{ marginBottom: tokens.spacingVerticalL }}>
        <Beaker24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Text weight="semibold">Copilot quality</Text>
        {overall && (
          <div className={s.overallRow}>
            <Badge appearance="tint" color="brand">{overall.surfacesWithRuns}/{overall.surfaces} surfaces scored</Badge>
            <Badge appearance="tint" color="informative">hit-rate {fmtPct(overall.avgRetrievalHitRate)}</Badge>
            <Badge appearance="tint" color="informative">grounding {fmtScore5(overall.avgGroundingAvg)}</Badge>
            {overall.belowFloor > 0
              ? <Badge appearance="filled" color="danger">{overall.belowFloor} below floor</Badge>
              : anyRuns ? <Badge appearance="tint" color="success">all above floor</Badge> : null}
          </div>
        )}
        <div className={s.spacer} />
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement>
            <MenuButton size="small" appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play16Regular />} disabled={running}>
              {running ? 'Running…' : 'Run now'}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem onClick={() => runNow()}>Run all surfaces</MenuItem>
              {selected && <MenuItem onClick={() => runNow([selected])}>Run “{selected}” only</MenuItem>}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={loadSnapshot} disabled={loading}>Refresh</Button>
      </div>

      {runMsg && (
        <MessageBar intent={runMsg.intent} style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{runMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      {/* Honest gate + Fix-it when the evaluator Function is not wired (G2). */}
      {evaluatorGated && (
        <HonestGate
          gateId="svc-copilot-evaluator"
          surface="Copilot quality"
          missing={snap?.evaluator.missing}
          onResolved={loadSnapshot}
        />
      )}

      {/* Scorecard */}
      <Section
        title="Per-surface scorecard"
        actions={<LearnPopover
          title="Copilot quality scorecard"
          content="One tile per Copilot surface, graded from its latest eval run: retrieval hit-rate (does the retriever surface the expected doc chunks), MRR, and the LLM-judge grounding score (1–5, judged at the top reasoning tier). The floor dots compare each metric to its E3 ratcheted floor. Click a tile to drill into its run history and worst questions. Every number is a real Cosmos read from the copilot-evaluator harness."
          learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai"
        />}
      >
        {copilotSummaries.length === 0
          ? <EmptyState
              icon={<Beaker24Regular />}
              title={evaluatorGated ? 'Deploy the evaluator to start scoring Copilot quality' : 'No eval runs yet'}
              body={evaluatorGated
                ? 'The copilot-evaluator Function scores every Copilot surface against the golden eval sets (content/evals). Deploy it with the Fix it button above (default-ON in bicep), then Run now to produce the first scores.'
                : 'Click “Run now” to execute the golden eval sets against the live retrieval + judge path — each surface then appears here with its grade, trend, and worst questions.'}
              primaryAction={{ label: 'View gate registry', href: '/admin/gates' }}
            />
          : (
            <TileGrid minTileWidth={280}>
              {copilotSummaries.map((sum) => <ScoreTile key={sum.surface} sum={sum} active={sum.surface === selected} onSelect={() => { setSelected(sum.surface); setSelectedRunId(null); }} />)}
            </TileGrid>
          )}
      </Section>

      {/* SRCH1 — Search relevance (federated catalog-search golden queries) */}
      {searchSummaries.length > 0 && (
        <Section
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
            <SearchInfo24Regular style={{ color: tokens.colorBrandForeground1 }} /> Search relevance
          </span>}
          actions={<LearnPopover
            title="Federated-search relevance"
            content="Golden query → expected-result sets (content/evals/search) scored against the REAL federated catalog search users type into (/catalog): hit-rate@k, MRR, and NDCG@k. Same evaluator machinery + ratcheted floors as the Copilot evals — a broken index or ranking change drops the score below floor and fails check-eval-regression. Click a domain to drill into its worst queries (expected vs retrieved items)."
            learnMoreHref="https://learn.microsoft.com/azure/search/search-what-is-azure-search"
          />}
        >
          <TileGrid minTileWidth={280}>
            {searchSummaries.map((sum) => <ScoreTile key={sum.surface} sum={sum} active={sum.surface === selected} onSelect={() => { setSelected(sum.surface); setSelectedRunId(null); }} />)}
          </TileGrid>
        </Section>
      )}

      {/* Drill-in: run history trend + worst questions for the selected surface */}
      {selectedSummary && selectedSummary.totals && (
        <Section
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
            <DataTrending24Regular style={{ color: tokens.colorBrandForeground1 }} /> {selected} — run history &amp; worst questions
          </span>}
          actions={<LearnPopover
            title="Surface drill-in"
            content="The selected surface's run history (pick any run), its metric trend across runs, and the worst-scoring questions for the chosen run — forbidden-phrase auto-fails (the no-Fabric-dependency / no-vaporware assertions) first, then retrieval misses and lowest judge grounding. Open a question to see the expected vs retrieved chunks and the judge's rationale."
            learnMoreHref="https://learn.microsoft.com/azure/search/search-what-is-azure-search"
          />}
        >
          {renderDrill()}
        </Section>
      )}

      <QuestionDialog result={question} onClose={() => setQuestion(null)} />
    </div>
  );

  // ── Sub-renderers ──

  function renderDrill() {
    if (drillLoading && !drill) return <Spinner size="tiny" label="Loading run history…" labelPosition="after" />;
    if (!drill || drill.runs.length === 0) {
      return <EmptyState icon={<DataTrending24Regular />} title="No runs for this surface yet" body={`Run “${selected}” to populate its history and per-question scores.`} />;
    }
    const worst = drill.worst ?? [];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 }}>
        <div className={s.chips}>
          <Text size={200} className={s.sub}>Run:</Text>
          <Dropdown
            aria-label="Select run"
            value={runLabel(drill.runs.find((r) => r.runId === drill.selectedRunId) ?? drill.runs[0])}
            selectedOptions={drill.selectedRunId ? [drill.selectedRunId] : []}
            onOptionSelect={(_e, d) => d.optionValue && setSelectedRunId(d.optionValue)}
            style={{ minWidth: '280px' }}
          >
            {drill.runs.map((r) => <Option key={r.runId} value={r.runId} text={runLabel(r)}>{runLabel(r)}</Option>)}
          </Dropdown>
          {drillLoading && <Spinner size="tiny" />}
        </div>

        <div className={s.chartWrap}><TrendChart points={selectedSummary!.trend} /></div>

        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>Worst questions ({worst.length})</Subtitle2>
          {worst.length === 0
            ? <Text className={s.sub}>No results recorded for this run.</Text>
            : (
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th} style={{ width: '38%' }}>Question</th>
                    <th className={s.th}>Retrieval</th>
                    <th className={s.th}>Grounding</th>
                    <th className={s.th}>Verdict</th>
                    <th className={s.th}>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {worst.map((row) => {
                    const bad = row.forbiddenHit || (row.judgeStatus === 'scored' && row.judge && row.judge.grounding <= 2);
                    const warn = !row.pass && !bad;
                    return (
                      <tr key={row.questionId} className={mergeClasses(s.rowBtn, bad ? s.rowFail : warn ? s.rowWarn : undefined)}
                        onClick={() => setQuestion(row)} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setQuestion(row); }}>
                        <td className={s.td}><span className={s.ellipsis} style={{ display: 'block', maxWidth: '360px' }}>{row.question}</span></td>
                        <td className={s.td}>
                          <Badge appearance="filled" color={row.retrievalHit ? 'success' : 'danger'}>{row.retrievalHit ? `hit · MRR ${row.mrr.toFixed(2)}` : 'miss'}</Badge>
                        </td>
                        <td className={s.td}>{renderJudgeCell(row)}</td>
                        <td className={s.td}>
                          {row.forbiddenHit
                            ? <Badge appearance="filled" color="danger">forbidden phrase</Badge>
                            : <Badge appearance="filled" color={row.pass ? 'success' : 'danger'}>{row.pass ? 'pass' : 'fail'}</Badge>}
                        </td>
                        <td className={mergeClasses(s.td, s.sub)}>{fmtMs(row.latencyMs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
      </div>
    );
  }

  function renderJudgeCell(row: CopilotEvalResultDoc) {
    if (row.judgeStatus === 'scored' && row.judge) {
      const g = row.judge.grounding;
      return <Badge appearance="filled" color={g >= 4 ? 'success' : g >= 3 ? 'warning' : 'danger'}>{g}/5</Badge>;
    }
    if (row.judgeStatus === 'deferred') return <Tooltip content="Judge deferred (daily cap or no judge deployment) — retrieval-only, treated as no-change" relationship="label"><Badge appearance="outline">deferred</Badge></Tooltip>;
    if (row.judgeStatus === 'auto-fail') return <Badge appearance="outline" color="danger">auto-fail</Badge>;
    return <Badge appearance="outline">error</Badge>;
  }
}

// ── Score tile ───────────────────────────────────────────────────────────────

function ScoreTile({ sum, active, onSelect }: { sum: SurfaceSummary; active: boolean; onSelect: () => void }) {
  const s = useStyles();
  const t = sum.totals;
  const search = isSearchSurface(sum.surface);
  return (
    <button className={mergeClasses(s.tile, active && s.tileActive)} onClick={onSelect} aria-label={`${search ? 'Search domain' : 'Copilot surface'} ${sum.surface}`}>
      <div className={s.tileHead}>
        <span className={s.tileName}>{search ? searchDomainLabel(sum.surface) : sum.surface}</span>
        {search && <Badge appearance="outline" color="informative">search</Badge>}
        <GradePill grade={sum.grade} />
      </div>
      {!t ? (
        <Caption1 className={s.sub}>No eval runs yet — Run now to score this surface.</Caption1>
      ) : (
        <>
          <div className={s.metricRow}>
            <div className={s.metric}>
              <span className={s.metricVal}>{fmtPct(t.retrievalHitRate)}</span>
              <span className={s.metricLabel}>hit-rate {fmtDeltaPct(sum.delta?.retrievalHitRate)}</span>
            </div>
            <div className={s.metric}>
              <span className={s.metricVal}>{search ? fmtPct(t.ndcgAvg) : fmtScore5(t.groundingAvg)}</span>
              <span className={s.metricLabel}>{search ? 'ndcg' : 'grounding'}</span>
            </div>
            <div className={s.metric}>
              <span className={s.metricVal}>{fmtPct(t.passRate)}</span>
              <span className={s.metricLabel}>{search ? 'hit@k' : 'pass'} {fmtDeltaPct(sum.delta?.passRate)}</span>
            </div>
          </div>
          {sum.floorStatus && (
            <div className={s.floorDots}>
              <TargetArrow16Regular style={{ color: tokens.colorNeutralForeground3 }} />
              <FloorDot mark={sum.floorStatus.retrievalHitRate} label="hit" />
              {!search && <FloorDot mark={sum.floorStatus.groundingAvg} label="grnd" />}
              <FloorDot mark={sum.floorStatus.passRate} label={search ? 'hit@k' : 'pass'} />
            </div>
          )}
          <div className={s.chips}>
            <Sparkline points={sum.trend} accessor={(p) => p.passRate} />
          </div>
          <Caption1 className={mergeClasses(s.sub, s.ellipsis)}>
            {t.questions} Q · {sum.runCount} run{sum.runCount === 1 ? '' : 's'} · {fmtTime(sum.latestFinishedAt)}
            {sum.latestTrigger ? ` · ${sum.latestTrigger}` : ''}
          </Caption1>
        </>
      )}
    </button>
  );
}

// ── Per-question drill-in dialog ─────────────────────────────────────────────

function QuestionDialog({ result, onClose }: { result: CopilotEvalResultDoc | null; onClose: () => void }) {
  const s = useStyles();
  return (
    <Dialog open={!!result} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Question — {result?.questionId}</DialogTitle>
          <DialogContent>
            {result && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 }}>
                <div className={s.chips}>
                  <Badge appearance="filled" color={result.retrievalHit ? 'success' : 'danger'}>{result.retrievalHit ? `retrieval hit · MRR ${result.mrr.toFixed(2)}` : 'retrieval miss'}</Badge>
                  {result.judgeStatus === 'scored' && result.judge
                    ? <Badge appearance="filled" color={result.judge.grounding >= 4 ? 'success' : 'warning'}>grounding {result.judge.grounding}/5</Badge>
                    : <Badge appearance="outline">judge {result.judgeStatus}</Badge>}
                  <Badge appearance="outline" color={result.pass ? 'success' : 'danger'}>{result.pass ? 'pass' : 'fail'}</Badge>
                  {result.forbiddenHit && <Badge appearance="filled" color="danger">forbidden phrase</Badge>}
                  {result.tier && <Badge appearance="tint">tier: {result.tier}</Badge>}
                  {result.backend && <Badge appearance="outline">retriever: {result.backend}</Badge>}
                  <Badge appearance="outline">{fmtMs(result.latencyMs)}</Badge>
                </div>

                <div>
                  <Caption1 className={s.metricLabel}>Question</Caption1>
                  <Body1 className={s.answer}>{result.question}</Body1>
                </div>

                <div className={s.drillGrid}>
                  <div style={{ minWidth: 0 }}>
                    <Caption1 className={s.metricLabel}>Expected chunks</Caption1>
                    <div className={s.chunkList}>
                      {result.expectedChunks.length === 0 ? <Text className={s.sub}>—</Text> :
                        result.expectedChunks.map((c) => <Tooltip key={c} content={c} relationship="label"><span className={s.chunk}>{c}</span></Tooltip>)}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <Caption1 className={s.metricLabel}>Retrieved chunks</Caption1>
                    <div className={s.chunkList}>
                      {result.retrievedChunks.length === 0 ? <Text className={s.sub}>none retrieved</Text> :
                        result.retrievedChunks.map((c, i) => {
                          const hit = result.expectedChunks.some((e) => e.split('#')[0].toLowerCase() === c.split('#')[0].toLowerCase());
                          return <Tooltip key={`${c}-${i}`} content={c} relationship="label"><span className={s.chunk} style={{ color: hit ? tokens.colorPaletteGreenForeground1 : tokens.colorNeutralForeground2 }}>{i + 1}. {c}</span></Tooltip>;
                        })}
                    </div>
                  </div>
                </div>

                {result.judge && (
                  <div>
                    <Caption1 className={s.metricLabel}>Judge rationale (grounding {result.judge.grounding}/5 · relevance {result.judge.relevance}/5 · completeness {result.judge.completeness}/5)</Caption1>
                    <Body1 className={s.answer}>{result.judge.rationale || '—'}</Body1>
                  </div>
                )}

                <div>
                  <Caption1 className={s.metricLabel}>Copilot answer</Caption1>
                  <Body1 className={s.answer}>{result.answer || <em className={s.sub}>no answer produced</em>}</Body1>
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function runLabel(r?: RunRef): string {
  if (!r) return '';
  const when = r.finishedAt ? new Date(r.finishedAt).toLocaleString() : r.runId;
  const g = r.totals.groundingAvg === null ? 'deferred' : `${r.totals.groundingAvg}`;
  return `${when} · ${r.trigger} · hit ${Math.round(r.totals.retrievalHitRate * 100)}% · grnd ${g}`;
}

export default CopilotQualityPanel;
