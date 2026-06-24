'use client';

/**
 * copy-fields — render a `ConfigField[]` from the copy-activity-catalog as a
 * structured Fluent form, and resolve a bound dataset to its backing connector
 * `type` so the Source / Sink tabs can pull the right per-store field set.
 *
 * Per loom-no-freeform-config: every Copy source/sink/store/format setting is a
 * typed control (text / number / boolean / select / multiline → ExpressionField
 * when it supports a dynamic @{…} expression), never a JSON textarea. Values
 * write straight onto the activity's `typeProperties.source` / `.sink` so the
 * pipeline PUT (real ARM REST) round-trips them. No mocks, no dead controls.
 */

import {
  Field, Input, Switch, Select, Caption1, tokens,
} from '@fluentui/react-components';
import { ExpressionField } from '../expression-field';
import type { ConfigField } from '@/lib/pipeline/connector-catalog';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from '../types';
import type { AdfDataset, AdfLinkedService } from '@/lib/azure/adf-client';

/**
 * Resolve a bound dataset to the linked-service connector `type` the
 * copy-activity-catalog is keyed on (e.g. 'AzureSqlDatabase','AzureBlobFS').
 * Falls back to undefined → callers use the family fallback.
 */
export function connectorTypeOfDataset(
  ds: AdfDataset | undefined,
  linkedServices: AdfLinkedService[],
): string | undefined {
  const lsName = ds?.properties.linkedServiceName?.referenceName;
  if (!lsName) return undefined;
  return linkedServices.find((ls) => ls.name === lsName)?.properties.type;
}

export interface CopyFieldListProps {
  fields: ConfigField[];
  /** Current value bag (e.g. the `source` or `sink` object). */
  values: Record<string, unknown>;
  /** Patch one key into the value bag (undefined deletes it). */
  onPatch: (key: string, value: unknown) => void;
  /** Dynamic-content context for `supportsDynamic` multiline fields. */
  activity: PipelineActivity;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  /** True when the Copy activity is nested inside a ForEach — only then are the
   *  `@item()` / `@iterationItem()` iterator accessors offered in the picker. */
  inForEach?: boolean;
}

/** Decide if a field's `showIf` condition is currently satisfied. */
function visible(field: ConfigField, values: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const cur = values[field.showIf.key];
  // boolean toggles compare against the string 'true'/'false'; '' means "set".
  if (field.showIf.equals === '') return cur != null && cur !== '';
  if (field.showIf.equals === 'true') return cur === true;
  if (field.showIf.equals === 'false') return cur === false;
  return String(cur ?? '') === field.showIf.equals;
}

export function CopyFieldList({
  fields, values, onPatch, activity, parameters, variables, allActivities,
  inForEach = false,
}: CopyFieldListProps) {
  return (
    <>
      {fields.filter((f) => visible(f, values)).map((f) => {
        const raw = values[f.key];

        if (f.kind === 'boolean') {
          return (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Switch checked={!!raw} onChange={(_, d) => onPatch(f.key, d.checked || undefined)} />
            </Field>
          );
        }

        if (f.kind === 'select') {
          return (
            <Field key={f.key} label={f.label} hint={f.hint} required={f.required}>
              <Select
                value={raw != null ? String(raw) : ''}
                onChange={(_, d) => onPatch(f.key, d.value || undefined)}>
                {(f.options || []).map((o) => (
                  <option key={o.value || '_'} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </Field>
          );
        }

        if (f.kind === 'number') {
          return (
            <Field key={f.key} label={f.label} hint={f.hint} required={f.required}>
              <Input type="number" placeholder={f.placeholder}
                value={raw != null ? String(raw) : ''}
                onChange={(_, d) => onPatch(f.key, d.value ? Number(d.value) : undefined)} />
            </Field>
          );
        }

        if (f.kind === 'multiline' && f.supportsDynamic) {
          return (
            <ExpressionField
              key={f.key}
              label={f.label}
              hint={f.hint}
              value={typeof raw === 'string' ? raw : ''}
              onChange={(v) => onPatch(f.key, v || undefined)}
              multiline
              supportsDynamic
              inForEach={inForEach}
              placeholder={f.placeholder}
              parameters={parameters} variables={variables} activities={allActivities}
              selfName={activity.name}
            />
          );
        }

        if (f.kind === 'multiline') {
          return (
            <Field key={f.key} label={f.label} hint={f.hint} required={f.required}>
              <textarea
                style={{
                  width: '100%', minHeight: 72, padding: tokens.spacingVerticalS,
                  fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
                  border: `1px solid ${tokens.colorNeutralStroke2}`,
                  borderRadius: tokens.borderRadiusMedium,
                  backgroundColor: tokens.colorNeutralBackground1,
                  color: tokens.colorNeutralForeground1, resize: 'vertical',
                }}
                placeholder={f.placeholder}
                value={typeof raw === 'string' ? raw : ''}
                onChange={(e) => onPatch(f.key, e.target.value || undefined)}
              />
            </Field>
          );
        }

        // text (with optional dynamic content)
        if (f.supportsDynamic) {
          return (
            <ExpressionField
              key={f.key}
              label={f.label}
              hint={f.hint}
              value={typeof raw === 'string' ? raw : ''}
              onChange={(v) => onPatch(f.key, v || undefined)}
              supportsDynamic
              inForEach={inForEach}
              placeholder={f.placeholder}
              parameters={parameters} variables={variables} activities={allActivities}
              selfName={activity.name}
            />
          );
        }
        return (
          <Field key={f.key} label={f.label} hint={f.hint} required={f.required}>
            <Input placeholder={f.placeholder}
              value={typeof raw === 'string' ? raw : ''}
              onChange={(_, d) => onPatch(f.key, d.value || undefined)} />
          </Field>
        );
      })}
      {fields.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          This connector has no extra source/sink settings — the dataset and the
          activity Settings tab carry everything it needs.
        </Caption1>
      )}
    </>
  );
}
