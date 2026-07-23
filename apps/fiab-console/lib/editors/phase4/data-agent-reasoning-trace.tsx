/**
 * WS-5.5 — Reasoning trace: renders a data agent's planner→execute→verify loop
 * in the test-chat thread. Fluent v9 + Loom tokens only (web3-ui / ux-baseline):
 * a compact plan list, per-step run status + row counts, and the verify verdict
 * badge. Clean states — nothing renders when there's no plan.
 */
import * as React from 'react';
import { Badge, Caption1, tokens } from '@fluentui/react-components';
import {
  CheckmarkCircle16Regular,
  Warning16Regular,
  DismissCircle16Regular,
  Sparkle16Regular,
  Flowchart16Regular,
  Wrench16Regular,
} from '@fluentui/react-icons';

export interface ReasoningStepView {
  step: number;
  source: string;
  subQuery: string;
  rationale?: string;
  status?: 'completed' | 'gated' | 'error';
  executed?: boolean;
  rowCount?: number;
  error?: string;
}

/** N11 — one graph-path citation rendered under the turn. */
export interface ReasoningGraphPathView {
  id?: string;
  hops: number;
  text: string;
  communityId?: string;
}

/** N11 — the graph-grounding signal the loop returned for this turn. */
export interface ReasoningGraphView {
  used: boolean;
  hops: number;
  seeds: { id: string; objectType: string; title: string; matchedOn?: string[] }[];
  paths: ReasoningGraphPathView[];
  communities: { communityId: string; summary: string; size: number }[];
  scanned?: number;
  gate?: string;
  note?: string;
}

/** N12 — one bounded self-healing repair attempt. */
export interface ReasoningRepairView {
  step: number;
  attempt: number;
  reason: string;
  error?: string;
  rewrittenQuery?: string;
  explainSummary?: string;
  explainError?: string;
  metricConsulted?: string;
  outcome: string;
  rowCount?: number;
}

export interface ReasoningTraceData {
  plan: { step: number; source: string; subQuery: string; rationale?: string }[];
  steps: ReasoningStepView[];
  verify: { verdict: 'pass' | 'partial' | 'fail'; reason: string };
  modelTier?: string;
  reasoningConfigured?: boolean;
  /** N11 — GraphRAG grounding over the authored ontology. */
  graph?: ReasoningGraphView;
  /** N12 — the bounded repair attempts the loop made. */
  repairs?: ReasoningRepairView[];
  /** N12 — does the answer follow from the real returned rows? */
  plausibility?: { plausible: boolean; reason: string; rowsSeen: number; unsupportedFigures?: string[] };
}

const VERDICT: Record<string, { color: 'success' | 'warning' | 'danger'; label: string }> = {
  pass: { color: 'success', label: 'Verified' },
  partial: { color: 'warning', label: 'Partly verified' },
  fail: { color: 'danger', label: 'Not verified' },
};

function StepIcon({ status }: { status?: string }) {
  if (status === 'error') return <DismissCircle16Regular style={{ color: tokens.colorPaletteRedForeground1 }} />;
  if (status === 'gated') return <Warning16Regular style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <CheckmarkCircle16Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />;
}

/** The reasoning plan + step status + verify verdict, shown under an agent turn. */
export function ReasoningTrace({ data }: { data: ReasoningTraceData }) {
  const steps = data.steps || [];
  const plan = data.plan || [];
  const graph = data.graph;
  const repairs = data.repairs || [];
  const graphPaths = graph?.paths || [];
  if (plan.length === 0 && steps.length === 0 && graphPaths.length === 0) return null;
  const verdict = VERDICT[data.verify?.verdict] || VERDICT.partial;
  const rows: ReasoningStepView[] = steps.length ? steps : plan.map((p) => ({ ...p }));

  return (
    <details
      open
      style={{
        marginTop: tokens.spacingVerticalXS,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusMedium,
        padding: tokens.spacingVerticalXS,
        background: tokens.colorNeutralBackground2,
      }}
    >
      <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 }}>
        <Sparkle16Regular style={{ verticalAlign: 'text-bottom' }} /> Reasoning plan · {rows.length} step{rows.length === 1 ? '' : 's'}
        <Badge appearance="tint" color={verdict.color} size="small" style={{ marginLeft: tokens.spacingHorizontalS }}>
          {verdict.label}
        </Badge>
        <Badge
          appearance="outline"
          color={data.reasoningConfigured ? 'brand' : 'informative'}
          size="small"
          style={{ marginLeft: tokens.spacingHorizontalSNudge }}
        >
          {data.reasoningConfigured ? 'reasoning tier' : `${data.modelTier || 'standard'} tier`}
        </Badge>
      </summary>

      <ol style={{ margin: `${tokens.spacingVerticalS} 0 0`, paddingLeft: tokens.spacingHorizontalXL, display: 'grid', gap: tokens.spacingVerticalXS }}>
        {rows.map((st, i) => (
          <li key={i} style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
              <StepIcon status={st.status} />
              <Caption1 style={{ fontWeight: tokens.fontWeightSemibold, minWidth: 0 }}>{st.source || 'source'}</Caption1>
              {st.executed && (
                <Badge appearance="tint" color="success" size="extra-small">
                  ✓ ran · {st.rowCount ?? 0} row{st.rowCount === 1 ? '' : 's'}
                </Badge>
              )}
              {st.status === 'gated' && (
                <Badge appearance="tint" color="warning" size="extra-small">gated</Badge>
              )}
              {st.status === 'error' && (
                <Badge appearance="tint" color="danger" size="extra-small">error</Badge>
              )}
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground2, display: 'block' }}>{st.subQuery}</Caption1>
            {st.error && (
              <Caption1 style={{ color: tokens.colorPaletteRedForeground1, display: 'block' }}>{st.error}</Caption1>
            )}
          </li>
        ))}
      </ol>

      {/* N11 — graph-path citations from the authored ontology (real AGE traversal) */}
      {graphPaths.length > 0 && (
        <div style={{ marginTop: tokens.spacingVerticalS }} data-testid="reasoning-graph-paths">
          <Caption1 style={{ fontWeight: tokens.fontWeightSemibold, display: 'block' }}>
            <Flowchart16Regular style={{ verticalAlign: 'text-bottom' }} /> Graph paths ({graphPaths.length})
            {graph?.seeds?.length ? ` · ${graph.seeds.length} seed entit${graph.seeds.length === 1 ? 'y' : 'ies'}` : ''}
          </Caption1>
          <ol style={{ margin: `${tokens.spacingVerticalXXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL, display: 'grid', gap: tokens.spacingVerticalXXS }}>
            {graphPaths.map((p, i) => (
              <li key={p.id || i} style={{ minWidth: 0 }}>
                <Caption1 style={{ fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2, wordBreak: 'break-word' }}>
                  {p.text}
                </Caption1>
                <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, marginLeft: tokens.spacingHorizontalXS, minWidth: 0 }}>
                  <Badge appearance="outline" color="informative" size="extra-small">{p.hops} hop{p.hops === 1 ? '' : 's'}</Badge>
                  {p.communityId && <Badge appearance="tint" color="subtle" size="extra-small">{p.communityId}</Badge>}
                </span>
              </li>
            ))}
          </ol>
          {!!graph?.communities?.length && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXXS }}>
              {graph.communities.length} precomputed community summar{graph.communities.length === 1 ? 'y' : 'ies'} attached.
            </Caption1>
          )}
        </div>
      )}
      {graph && !graph.used && (graph.gate || graph.note) && (
        <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, display: 'block', marginTop: tokens.spacingVerticalXS }}>
          ⚠ Graph grounding: {graph.gate || graph.note}
        </Caption1>
      )}

      {/* N12 — bounded self-healing repair attempts */}
      {repairs.length > 0 && (
        <div style={{ marginTop: tokens.spacingVerticalS }} data-testid="reasoning-repairs">
          <Caption1 style={{ fontWeight: tokens.fontWeightSemibold, display: 'block' }}>
            <Wrench16Regular style={{ verticalAlign: 'text-bottom' }} /> Self-healing repairs ({repairs.length})
          </Caption1>
          <ol style={{ margin: `${tokens.spacingVerticalXXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL, display: 'grid', gap: tokens.spacingVerticalXXS }}>
            {repairs.map((r, i) => (
              <li key={i} style={{ minWidth: 0 }}>
                <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, alignItems: 'center', minWidth: 0 }}>
                  <Badge
                    appearance="tint"
                    size="extra-small"
                    color={r.outcome === 'repaired' ? 'success' : r.outcome === 'abandoned' ? 'danger' : 'warning'}
                  >
                    step {r.step} · attempt {r.attempt} · {r.outcome}
                  </Badge>
                  {r.metricConsulted && <Badge appearance="outline" size="extra-small" color="subtle">{r.metricConsulted}</Badge>}
                  {typeof r.rowCount === 'number' && (
                    <Badge appearance="outline" size="extra-small" color="informative">{r.rowCount} row{r.rowCount === 1 ? '' : 's'}</Badge>
                  )}
                </span>
                <Caption1 style={{ color: tokens.colorNeutralForeground2, display: 'block' }}>{r.reason}</Caption1>
                {r.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1, display: 'block' }}>{r.error}</Caption1>}
                {r.explainError && (
                  <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, display: 'block' }}>
                    EXPLAIN rejected the rewrite (not executed): {r.explainError}
                  </Caption1>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {data.verify?.reason && (
        <Caption1 style={{ color: tokens.colorNeutralForeground2, display: 'block', marginTop: tokens.spacingVerticalS }}>
          <strong>Verify:</strong> {data.verify.reason}
        </Caption1>
      )}
      {data.plausibility && (
        <Caption1
          style={{
            color: data.plausibility.plausible ? tokens.colorNeutralForeground2 : tokens.colorPaletteYellowForeground1,
            display: 'block',
            marginTop: tokens.spacingVerticalXXS,
          }}
        >
          <strong>Plausibility:</strong> {data.plausibility.reason}
        </Caption1>
      )}
    </details>
  );
}
