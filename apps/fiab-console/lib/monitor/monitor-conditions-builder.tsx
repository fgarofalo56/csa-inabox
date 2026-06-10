'use client';

/**
 * MonitorConditionsBuilder — a reusable condition/schedule surface for an Azure
 * Monitor scheduled query alert rule (Microsoft.Insights/scheduledQueryRules).
 *
 * It renders in two modes:
 *   - mode='edit'    → full Fluent v9 field controls (operator / threshold /
 *                      evaluation frequency / look-back window / severity),
 *                      used inside the alert editor's Condition + Schedule tabs.
 *   - mode='display' → a compact, read-only one-line summary, used in the
 *                      scheduled-rule table row so the same vocabulary is shown
 *                      in the grid and the editor (no drift).
 *
 * The KQL row count of the query result is what Azure Monitor compares against
 * the threshold (timeAggregation 'Count'), so the operator labels read "row
 * count is above / below / equal …". No Microsoft Fabric — Azure-native only.
 */

import {
  Field, Input, Dropdown, Option, Caption1, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';

/**
 * Operators Azure Monitor scheduled query rules support
 * (GreaterThan | GreaterThanOrEqual | LessThan | LessThanOrEqual | Equal).
 * NOT_EQUAL is intentionally absent — the ARM schema does not accept it for
 * scheduledQueryRules criteria (see monitor-client.ts upsertScheduledQueryRule).
 */
export const MONITOR_OPS: { value: string; label: string; sign: string }[] = [
  { value: 'GreaterThan', label: 'is above ( > )', sign: '>' },
  { value: 'GreaterThanOrEqual', label: 'is above or equal ( ≥ )', sign: '≥' },
  { value: 'LessThan', label: 'is below ( < )', sign: '<' },
  { value: 'LessThanOrEqual', label: 'is below or equal ( ≤ )', sign: '≤' },
  { value: 'Equal', label: 'is equal ( = )', sign: '=' },
];

/** ISO-8601 evaluation cadences. windowSize reuses the same set (must be ≥ freq). */
export const MONITOR_FREQUENCIES: { value: string; label: string; minutes: number }[] = [
  { value: 'PT5M', label: 'Every 5 minutes', minutes: 5 },
  { value: 'PT15M', label: 'Every 15 minutes', minutes: 15 },
  { value: 'PT30M', label: 'Every 30 minutes', minutes: 30 },
  { value: 'PT1H', label: 'Every hour', minutes: 60 },
  { value: 'PT6H', label: 'Every 6 hours', minutes: 360 },
  { value: 'P1D', label: 'Daily', minutes: 1440 },
];

export const MONITOR_SEVERITIES: { value: string; label: string }[] = [
  { value: '0', label: '0 — Critical' },
  { value: '1', label: '1 — Error' },
  { value: '2', label: '2 — Warning' },
  { value: '3', label: '3 — Informational' },
  { value: '4', label: '4 — Verbose' },
];

export function freqLabel(v?: string): string {
  return MONITOR_FREQUENCIES.find((f) => f.value === v)?.label || v || 'PT5M';
}
export function opLabel(v?: string): string {
  return MONITOR_OPS.find((o) => o.value === v)?.label || v || 'GreaterThan';
}
export function opSign(v?: string): string {
  return MONITOR_OPS.find((o) => o.value === v)?.sign || '>';
}
export function freqMinutes(v?: string): number {
  return MONITOR_FREQUENCIES.find((f) => f.value === v)?.minutes ?? 5;
}

const useStyles = makeStyles({
  fieldRow: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  fieldCol: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '210px', flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  summary: { display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  pill: {
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground2,
  },
});

export interface MonitorConditionsBuilderProps {
  mode: 'display' | 'edit';
  /** Which slice to render in edit mode. 'condition' = operator+threshold; 'schedule' = freq+window+severity. */
  section?: 'condition' | 'schedule';
  operator: string;
  threshold: number;
  evaluationFrequency: string;
  windowSize: string;
  severity: number;
  onOperatorChange?: (v: string) => void;
  onThresholdChange?: (v: number) => void;
  onFrequencyChange?: (v: string) => void;
  onWindowChange?: (v: string) => void;
  onSeverityChange?: (v: number) => void;
}

export function MonitorConditionsBuilder(props: MonitorConditionsBuilderProps) {
  const s = useStyles();
  const {
    mode, section = 'condition',
    operator, threshold, evaluationFrequency, windowSize, severity,
    onOperatorChange, onThresholdChange, onFrequencyChange, onWindowChange, onSeverityChange,
  } = props;

  if (mode === 'display') {
    return (
      <span className={s.summary}>
        <Caption1 className={s.pill}>
          row count {opSign(operator)} {threshold}
        </Caption1>
        <Caption1 className={s.pill}>· {freqLabel(evaluationFrequency)}</Caption1>
        <Badge appearance="outline" color={severity <= 1 ? 'danger' : severity === 2 ? 'warning' : 'informative'}>
          Sev {severity}
        </Badge>
      </span>
    );
  }

  if (section === 'condition') {
    return (
      <div className={s.fieldRow}>
        <div className={s.fieldCol}>
          <Field label="Operator">
            <Dropdown
              value={opLabel(operator)}
              selectedOptions={[operator]}
              onOptionSelect={(_, d) => d.optionValue && onOperatorChange?.(d.optionValue)}
            >
              {MONITOR_OPS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
            </Dropdown>
          </Field>
        </div>
        <div className={s.fieldCol}>
          <Field label="Threshold" required>
            <Input
              type="number"
              value={String(threshold)}
              onChange={(_, d) => {
                const n = Number(d.value);
                if (Number.isFinite(n)) onThresholdChange?.(n);
                else if (d.value === '') onThresholdChange?.(0);
              }}
            />
          </Field>
        </div>
        <div className={s.fieldCol}>
          <Caption1 className={s.hint}>
            Azure Monitor evaluates the row count of the KQL result against this threshold.
            The rule fires when the count {opSign(operator)} {threshold}.
          </Caption1>
        </div>
      </div>
    );
  }

  // section === 'schedule'
  const freqMin = freqMinutes(evaluationFrequency);
  const windowMin = freqMinutes(windowSize);
  const windowTooSmall = windowMin < freqMin;
  return (
    <div className={s.fieldRow}>
      <div className={s.fieldCol}>
        <Field label="Evaluation frequency" hint="How often the KQL is run">
          <Dropdown
            value={freqLabel(evaluationFrequency)}
            selectedOptions={[evaluationFrequency]}
            onOptionSelect={(_, d) => d.optionValue && onFrequencyChange?.(d.optionValue)}
          >
            {MONITOR_FREQUENCIES.map((f) => <Option key={f.value} value={f.value}>{f.label}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <div className={s.fieldCol}>
        <Field
          label="Look-back window"
          hint="Time range the KQL spans (must be ≥ frequency)"
          validationState={windowTooSmall ? 'error' : 'none'}
          validationMessage={windowTooSmall ? 'Window must be at least the evaluation frequency.' : undefined}
        >
          <Dropdown
            value={freqLabel(windowSize)}
            selectedOptions={[windowSize]}
            onOptionSelect={(_, d) => d.optionValue && onWindowChange?.(d.optionValue)}
          >
            {MONITOR_FREQUENCIES.map((f) => <Option key={f.value} value={f.value}>{f.label}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <div className={s.fieldCol}>
        <Field label="Severity">
          <Dropdown
            value={MONITOR_SEVERITIES.find((x) => x.value === String(severity))?.label || String(severity)}
            selectedOptions={[String(severity)]}
            onOptionSelect={(_, d) => d.optionValue && onSeverityChange?.(Number(d.optionValue))}
          >
            {MONITOR_SEVERITIES.map((x) => <Option key={x.value} value={x.value}>{x.label}</Option>)}
          </Dropdown>
        </Field>
      </div>
    </div>
  );
}
