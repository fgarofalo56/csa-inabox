'use client';

/**
 * expression-field — THE reusable value control every pipeline / dataset /
 * linked-service property field uses when ADF allows that value to be a
 * dynamic `@{…}` expression.
 *
 * WHY THIS WRAPPER EXISTS
 * -----------------------
 * `dynamic-content.tsx` already ships the rich "Add dynamic content" builder
 * (Monaco editor + categorized function/system-variable/param/activity palette
 * + client-side Evaluate against the last real ADF run). That component is the
 * engine. This module is the THIN, ERGONOMIC wrapper every property form binds
 * to, exposing the small prop API a form field actually has on hand:
 *
 *   <ExpressionField
 *     label value onChange
 *     supportsDynamic?            // reuse the Wave-1 ConfigField flag
 *     availableParams?            // string[] of pipeline parameter names
 *     availableVariables?         // string[] of pipeline variable names
 *     activityNames?              // string[] of sibling activity names
 *     inForEach?                  // offer @item()/@iterationItem() only here
 *     multiline? />
 *
 * - When `supportsDynamic === false`, NO @-expression is allowed: we render a
 *   plain Fluent Input / Textarea (no "Add dynamic content" affordance, no
 *   chip) so the field can't be turned into an expression where ADF wouldn't
 *   accept one. (Wave-1 `ConfigField.supportsDynamic` semantics.)
 * - Otherwise we delegate to the rich builder (`DynamicContentField`), which
 *   shows the ⚡ "Add dynamic content" link and a "dynamic" chip when the value
 *   is an @-expression.
 *
 * The value is stored VERBATIM (an ADF interpolated string, `@…` / `@{…}`) on
 * the pipeline / dataset / linked-service JSON and round-trips on the real PUT
 * via adf-client / synapse-artifacts-client. No mocks, no freeform JSON —
 * structured per loom-no-freeform-config + no-vaporware.
 *
 * `useDynamicContext()` gathers a pipeline's params / variables / sibling
 * activity names into the exact prop bag this control expects, so callers wire
 * the whole picker with one hook instead of threading three arrays by hand.
 */

import { useMemo } from 'react';
import {
  Badge, Caption1, Field, Input, Textarea, makeStyles, tokens,
} from '@fluentui/react-components';
import { Code16Regular } from '@fluentui/react-icons';
import { ExpressionField as DynamicContentField } from './dynamic-content';
import type {
  PipelineActivity, PipelineParameter, PipelineSpec, PipelineVariable,
} from './types';

// Re-export the rich builder under an explicit name so existing imports of the
// engine keep working and new code can reach it directly when needed.
export { ExpressionField as DynamicContentField } from './dynamic-content';

const useStyles = makeStyles({
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  exprPreview: {
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    overflowWrap: 'anywhere',
  },
});

/** A value is an ADF expression when it starts with `@` (after trimming). */
export function isDynamicExpression(v: unknown): boolean {
  return typeof v === 'string' && v.trimStart().startsWith('@');
}

/**
 * The bag of options the dynamic-content picker offers. Built by
 * `useDynamicContext()` (or assembled by hand) and spread onto `<ExpressionField/>`.
 */
export interface DynamicContext {
  /** Pipeline parameter names — offered as `@pipeline().parameters.<name>`. */
  availableParams: string[];
  /** Pipeline variable names — offered as `@variables('<name>')`. */
  availableVariables: string[];
  /** Sibling activity names — offered as `@activity('<name>').output`. */
  activityNames: string[];
  /** Rich param/variable/activity objects, when the caller has them. */
  parameters?: PipelineParameter[];
  variables?: PipelineVariable[];
  activities?: PipelineActivity[];
}

export interface ExpressionFieldProps {
  label?: string;
  /** Field hint rendered under the control. */
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Render a multiline Textarea instead of a single-line Input. */
  multiline?: boolean;
  required?: boolean;
  disabled?: boolean;

  /**
   * Whether this field accepts an ADF `@{…}` expression. Reuses the Wave-1
   * `ConfigField.supportsDynamic` flag. Defaults to true. When false, a plain
   * Input/Textarea renders with NO dynamic-content affordance.
   */
  supportsDynamic?: boolean;

  /** Pipeline parameter names to offer in the picker. */
  availableParams?: string[];
  /** Pipeline variable names to offer in the picker. */
  availableVariables?: string[];
  /** Sibling activity names whose `.output` can be referenced. */
  activityNames?: string[];

  /**
   * Whether this field sits inside a ForEach activity. Only then are the
   * iteration accessors `@item()` / `@iterationItem()` offered — elsewhere they
   * would never resolve. Defaults to false.
   */
  inForEach?: boolean;

  /** Exclude the current activity from the activity-output list. */
  selfName?: string;
  /** Pipeline item id — lets Evaluate pre-fill sample values from the last run. */
  pipelineId?: string;
  /** Workspace id — used by the Evaluate pre-fill API call. */
  workspaceId?: string;

  /**
   * Optional rich objects (param/variable/activity definitions). When supplied
   * they take precedence over the `available*` / `activityNames` string arrays
   * — they carry types/defaults the picker + Evaluate use. Spread a
   * `useDynamicContext()` result here.
   */
  parameters?: PipelineParameter[];
  variables?: PipelineVariable[];
  activities?: PipelineActivity[];
}

/**
 * THE control every property field uses for a value that ADF allows to be
 * dynamic. Delegates to the rich `dynamic-content` builder when expressions are
 * allowed; otherwise renders a plain typed control.
 */
export function ExpressionField({
  label, hint, value, onChange, placeholder, multiline, required, disabled,
  supportsDynamic = true,
  availableParams, availableVariables, activityNames, inForEach = false,
  selfName, pipelineId, workspaceId,
  parameters, variables, activities,
}: ExpressionFieldProps) {
  const s = useStyles();

  // Prefer rich objects when present; otherwise synthesize minimal ones from
  // the name arrays so the picker still offers params / variables / activities.
  const resolvedParameters = useMemo<PipelineParameter[]>(() => {
    if (parameters) return parameters;
    return (availableParams ?? []).map((name) => ({ name, type: 'string' as const }));
  }, [parameters, availableParams]);

  const resolvedVariables = useMemo<PipelineVariable[]>(() => {
    if (variables) return variables;
    return (availableVariables ?? []).map((name) => ({ name, type: 'String' as const }));
  }, [variables, availableVariables]);

  const resolvedActivities = useMemo<PipelineActivity[]>(() => {
    if (activities) return activities;
    return (activityNames ?? []).map((name) => ({ name }));
  }, [activities, activityNames]);

  // Static (non-dynamic) field: plain typed control, no expression affordance.
  if (!supportsDynamic) {
    return (
      <div className={s.fieldRow}>
        <Field label={label} hint={hint} required={required}>
          {multiline ? (
            <Textarea
              value={value}
              placeholder={placeholder}
              disabled={disabled}
              rows={3}
              onChange={(_, d) => onChange(d.value)}
            />
          ) : (
            <Input
              value={value}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(_, d) => onChange(d.value)}
            />
          )}
        </Field>
        {isDynamicExpression(value) && (
          <Caption1 className={s.exprPreview}>
            <Code16Regular style={{ verticalAlign: 'middle' }} /> {value}
          </Caption1>
        )}
      </div>
    );
  }

  // Dynamic field: delegate to the rich builder. It renders the ⚡ "Add dynamic
  // content" link, the picker dialog, the Evaluate panel, and the "dynamic"
  // expression chip when the value is an @-expression.
  return (
    <DynamicContentField
      label={label}
      hint={hint}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      multiline={multiline}
      required={required}
      disabled={disabled}
      parameters={resolvedParameters}
      variables={resolvedVariables}
      activities={resolvedActivities}
      selfName={selfName}
      pipelineId={pipelineId}
      workspaceId={workspaceId}
      hideIterationVars={!inForEach}
    />
  );
}

// =============================================================================
// useDynamicContext — gather a pipeline's params / variables / activity names
// =============================================================================

/** A pipeline shape `useDynamicContext()` can read from. */
export interface DynamicContextSource {
  /** Rich param/variable arrays (e.g. the editor's working state). */
  parameters?: PipelineParameter[];
  variables?: PipelineVariable[];
  /** Sibling activities (the pipeline's activity list). */
  activities?: PipelineActivity[];
  /**
   * Or the whole pipeline spec — params/variables/activities are read off
   * `properties`. Used when the source array isn't broken out yet.
   */
  spec?: PipelineSpec;
  /** Current activity name to exclude from the activity-output list. */
  selfName?: string;
}

/**
 * Gather the pipeline's parameters, variables, and sibling activity names into
 * the prop bag `<ExpressionField/>` (and the underlying picker) consume. Pass
 * either broken-out arrays or a whole `PipelineSpec`. The current activity
 * (`selfName`) is excluded from the activity-output list — an activity can't
 * reference its own output.
 *
 * @example
 *   const ctx = useDynamicContext({ parameters, variables, activities, selfName: activity.name });
 *   <ExpressionField label="Path" value={path} onChange={setPath} {...ctx} inForEach={isForEach} />
 */
export function useDynamicContext(source: DynamicContextSource): DynamicContext {
  const { parameters, variables, activities, spec, selfName } = source;

  return useMemo<DynamicContext>(() => {
    // Rich objects: explicit arrays win, else derive from the spec.
    const params: PipelineParameter[] = parameters
      ?? (spec
        ? Object.entries(spec.properties.parameters ?? {}).map(([name, def]) => ({
          name,
          type: (def.type as PipelineParameter['type']) || 'string',
          defaultValue: def.defaultValue,
        }))
        : []);

    const vars: PipelineVariable[] = variables
      ?? (spec
        ? Object.entries(spec.properties.variables ?? {}).map(([name, def]) => ({
          name,
          type: (def.type as PipelineVariable['type']) || 'String',
          defaultValue: def.defaultValue,
        }))
        : []);

    const acts: PipelineActivity[] = (activities ?? spec?.properties.activities ?? [])
      .filter((a) => a.name && a.name !== selfName);

    return {
      parameters: params,
      variables: vars,
      activities: acts,
      availableParams: params.map((p) => p.name),
      availableVariables: vars.map((v) => v.name),
      activityNames: acts.map((a) => a.name),
    };
  }, [parameters, variables, activities, spec, selfName]);
}
