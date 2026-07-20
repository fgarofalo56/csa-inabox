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

export interface ReasoningTraceData {
  plan: { step: number; source: string; subQuery: string; rationale?: string }[];
  steps: ReasoningStepView[];
  verify: { verdict: 'pass' | 'partial' | 'fail'; reason: string };
  modelTier?: string;
  reasoningConfigured?: boolean;
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
  if (plan.length === 0 && steps.length === 0) return null;
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

      {data.verify?.reason && (
        <Caption1 style={{ color: tokens.colorNeutralForeground2, display: 'block', marginTop: tokens.spacingVerticalS }}>
          <strong>Verify:</strong> {data.verify.reason}
        </Caption1>
      )}
    </details>
  );
}
