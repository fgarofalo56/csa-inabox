'use client';

/**
 * Typed per-activity property forms — the Loom one-for-one of each Azure Data
 * Factory / Synapse activity's Settings panel (ui-parity.md). Instead of making
 * users hand-write the `typeProperties` JSON, each known activity type declares
 * a field schema here; <ActivityForm/> renders the matching typed controls
 * (text / number / toggle / dropdown / expression) and reads-writes the
 * activity's typeProperties by dotted path. Expression-capable fields use
 * <ExpressionField/> so the portal's "Add dynamic content" + IntelliSense is
 * available exactly where Azure offers it.
 *
 * Activity types WITHOUT a schema fall back to the raw typeProperties JSON
 * editor in properties-panel.tsx — so nothing regresses, and coverage grows by
 * adding rows here. Grounded in:
 *   https://learn.microsoft.com/azure/data-factory/control-flow-* (per activity)
 */

import { Field, Input, Dropdown, Option, Switch, Caption1 } from '@fluentui/react-components';
import { ExpressionField } from './dynamic-content';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from './types';

type FieldKind = 'text' | 'number' | 'bool' | 'select' | 'multiselect' | 'expr' | 'expr-multiline';

interface FieldSpec {
  /** Dotted path under activity.typeProperties (e.g. 'waitTimeInSeconds', 'value'). */
  path: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
  /** Options for select. */
  options?: Array<{ value: string; label: string }>;
  /** Placeholder for text/expr. */
  placeholder?: string;
}

/** Field schema per ADF/Synapse activity `type`. */
export const ACTIVITY_FORMS: Record<string, FieldSpec[]> = {
  Wait: [
    { path: 'waitTimeInSeconds', label: 'Wait time (seconds)', kind: 'expr', required: true,
      hint: 'Seconds to pause before continuing. Accepts an expression.', placeholder: '30' },
  ],
  SetVariable: [
    { path: 'variableName', label: 'Variable name', kind: 'text', required: true,
      hint: 'The pipeline variable to set.' },
    { path: 'value', label: 'Value', kind: 'expr', placeholder: "@pipeline().RunId" },
  ],
  AppendVariable: [
    { path: 'variableName', label: 'Variable name', kind: 'text', required: true },
    { path: 'value', label: 'Value to append', kind: 'expr' },
  ],
  Until: [
    { path: 'expression.value', label: 'Expression', kind: 'expr', required: true,
      hint: 'Loop exits when this boolean expression is true.',
      placeholder: "@equals(activity('Lookup1').output.firstRow.done, true)" },
    { path: 'timeout', label: 'Timeout', kind: 'text', placeholder: '0.12:00:00',
      hint: 'Max duration (d.hh:mm:ss) before the loop fails.' },
  ],
  IfCondition: [
    { path: 'expression.value', label: 'Condition expression', kind: 'expr', required: true,
      placeholder: "@greater(activity('Lookup1').output.count, 0)" },
  ],
  Switch: [
    { path: 'on.value', label: 'On (expression)', kind: 'expr', required: true,
      hint: 'Evaluated value matched against each case.', placeholder: "@activity('Lookup1').output.region" },
  ],
  Filter: [
    { path: 'items.value', label: 'Items', kind: 'expr', required: true,
      placeholder: "@activity('GetMetadata1').output.childItems" },
    { path: 'condition.value', label: 'Condition', kind: 'expr', required: true,
      placeholder: "@endswith(item().name, '.csv')" },
  ],
  ForEach: [
    { path: 'items.value', label: 'Items', kind: 'expr', required: true,
      hint: 'Array to iterate. Reference each element with @item().' },
    { path: 'isSequential', label: 'Sequential', kind: 'bool',
      hint: 'Off = parallel iterations (up to batch count).' },
    { path: 'batchCount', label: 'Batch count', kind: 'number',
      hint: 'Max parallel iterations (1–50) when not sequential.' },
  ],
  Lookup: [
    { path: 'firstRowOnly', label: 'First row only', kind: 'bool',
      hint: 'Return only the first row of the source.' },
  ],
  ExecutePipeline: [
    { path: 'pipeline.referenceName', label: 'Invoked pipeline', kind: 'text', required: true,
      hint: 'Name of the pipeline to execute.' },
    { path: 'waitOnCompletion', label: 'Wait on completion', kind: 'bool' },
  ],
  WebActivity: [
    { path: 'method', label: 'Method', kind: 'select', required: true,
      options: ['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m })) },
    { path: 'url', label: 'URL', kind: 'expr', required: true, placeholder: 'https://api.example.com/run' },
    { path: 'body', label: 'Body', kind: 'expr-multiline', hint: 'Request body (POST/PUT). Accepts an expression.' },
  ],
  Web: [
    { path: 'method', label: 'Method', kind: 'select', required: true,
      options: ['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m })) },
    { path: 'url', label: 'URL', kind: 'expr', required: true },
    { path: 'body', label: 'Body', kind: 'expr-multiline' },
  ],
  Fail: [
    { path: 'message', label: 'Error message', kind: 'expr', required: true },
    { path: 'errorCode', label: 'Error code', kind: 'expr' },
  ],
  DatabricksNotebook: [
    { path: 'notebookPath', label: 'Notebook path', kind: 'text', required: true,
      placeholder: '/Workspace/Repos/csa-loom/medallion/bronze' },
  ],
  SynapseNotebook: [
    { path: 'notebook.referenceName', label: 'Notebook', kind: 'text', required: true },
  ],
  Script: [
    { path: 'scripts[0].text', label: 'Script', kind: 'expr-multiline', required: true,
      placeholder: 'SELECT COUNT(*) FROM gold.fact_sales' },
  ],
  GetMetadata: [
    { path: 'dataset.referenceName', label: 'Dataset', kind: 'text', required: true,
      hint: 'The dataset whose metadata to retrieve (file, folder, or table).' },
    { path: 'fieldList', label: 'Field list', kind: 'multiselect', required: true,
      hint: 'Which metadata fields to return. Reference results via @activity(\'…\').output.<field>.',
      options: [
        'itemName', 'itemType', 'size', 'created', 'lastModified', 'childItems',
        'contentMD5', 'structure', 'columnCount', 'exists',
      ].map((v) => ({ value: v, label: v })) },
  ],
  Delete: [
    { path: 'dataset.referenceName', label: 'Dataset', kind: 'text', required: true,
      hint: 'The file/folder dataset to delete.' },
    { path: 'recursive', label: 'Recursive', kind: 'bool',
      hint: 'Delete files in all subfolders, not just the top level.' },
    { path: 'enableLogging', label: 'Enable logging', kind: 'bool',
      hint: 'Write the list of deleted files to a log store.' },
    { path: 'maxConcurrentConnections', label: 'Max concurrent connections', kind: 'number',
      hint: 'Parallel connections to the store when deleting.' },
  ],
  SqlServerStoredProcedure: [
    { path: 'storedProcedureName', label: 'Stored procedure name', kind: 'expr', required: true,
      placeholder: '[dbo].[usp_LoadGold]',
      hint: 'Name of the stored procedure to run on the linked SQL service.' },
  ],
  WebHook: [
    { path: 'method', label: 'Method', kind: 'select', required: true,
      options: [{ value: 'POST', label: 'POST' }] },
    { path: 'url', label: 'URL', kind: 'expr', required: true, placeholder: 'https://api.example.com/callback' },
    { path: 'timeout', label: 'Timeout', kind: 'text', placeholder: '00:10:00',
      hint: 'How long to wait for the callBackUri before failing (hh:mm:ss).' },
    { path: 'body', label: 'Body', kind: 'expr-multiline', hint: 'Request body. Accepts an expression.' },
    { path: 'reportStatusOnCallBack', label: 'Report status on callback', kind: 'bool',
      hint: 'Let the callback report a failure status back to the activity.' },
  ],
  Validation: [
    { path: 'dataset.referenceName', label: 'Dataset', kind: 'text', required: true,
      hint: 'The file/folder dataset to validate exists.' },
    { path: 'timeout', label: 'Timeout', kind: 'text', placeholder: '7.00:00:00',
      hint: 'Max time to wait for validation (d.hh:mm:ss).' },
    { path: 'sleep', label: 'Sleep (seconds)', kind: 'number',
      hint: 'Seconds between validation retries.' },
    { path: 'minimumSize', label: 'Minimum size (bytes)', kind: 'number',
      hint: 'For a file: minimum size required to pass.' },
    { path: 'childItems', label: 'Folder must contain children', kind: 'bool',
      hint: 'For a folder: require at least one child item.' },
  ],
  SynapseSparkJobDefinitionActivity: [
    { path: 'sparkJob.referenceName', label: 'Spark job definition', kind: 'text', required: true,
      hint: 'The Synapse Spark job definition to run.' },
  ],
};

export function hasActivityForm(type: string | undefined): boolean {
  return !!type && Array.isArray(ACTIVITY_FORMS[type]) && ACTIVITY_FORMS[type].length > 0;
}

// ── dotted-path get/set on a plain object (supports `a.b` and `a[0].b`) ──────
function tokenize(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const part of path.split('.')) {
    const m = part.match(/^([^[]+)((\[\d+\])+)?$/);
    if (!m) { out.push(part); continue; }
    out.push(m[1]);
    const idx = part.match(/\[(\d+)\]/g);
    if (idx) for (const i of idx) out.push(Number(i.replace(/[[\]]/g, '')));
  }
  return out;
}
function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const t of tokenize(path)) { if (cur == null) return undefined; cur = cur[t as any]; }
  return cur;
}
function setPath(obj: any, path: string, value: any): any {
  const toks = tokenize(path);
  const root = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  let cur: any = root;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    const nextIsIndex = typeof toks[i + 1] === 'number';
    const existing = cur[t as any];
    cur[t as any] = nextIsIndex
      ? (Array.isArray(existing) ? [...existing] : [])
      : (existing && typeof existing === 'object' ? { ...existing } : {});
    cur = cur[t as any];
  }
  cur[toks[toks.length - 1] as any] = value;
  return root;
}

export interface ActivityFormProps {
  activity: PipelineActivity;
  onPatch: (patch: Partial<PipelineActivity>) => void;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
}

/** Renders the typed form for the activity's type, or null if none is defined. */
export function ActivityForm({ activity, onPatch, parameters, variables, allActivities }: ActivityFormProps) {
  const schema = activity.type ? ACTIVITY_FORMS[activity.type] : undefined;
  if (!schema) return null;
  const tp = (activity.typeProperties as any) || {};

  const patchTp = (path: string, value: unknown) => {
    onPatch({ typeProperties: setPath(tp, path, value) });
  };

  return (
    <>
      <Caption1>
        Typed configuration for <strong>{activity.type}</strong> — the same fields the Azure portal exposes.
        Expression fields offer <em>Add dynamic content</em> + IntelliSense.
      </Caption1>
      {schema.map((fld) => {
        const raw = getPath(tp, fld.path);
        const strVal = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        if (fld.kind === 'bool') {
          return (
            <Field key={fld.path} label={fld.label} hint={fld.hint}>
              <Switch checked={raw === true || raw === 'true'}
                onChange={(_, d) => patchTp(fld.path, d.checked)} />
            </Field>
          );
        }
        if (fld.kind === 'select') {
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Dropdown
                value={strVal}
                selectedOptions={strVal ? [strVal] : []}
                onOptionSelect={(_, d) => patchTp(fld.path, d.optionValue)}
              >
                {(fld.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
              </Dropdown>
            </Field>
          );
        }
        if (fld.kind === 'multiselect') {
          const selected: string[] = Array.isArray(raw) ? raw.map(String) : [];
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Dropdown
                multiselect
                placeholder="Select one or more…"
                value={selected.join(', ')}
                selectedOptions={selected}
                onOptionSelect={(_, d) => patchTp(fld.path, d.selectedOptions)}
              >
                {(fld.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
              </Dropdown>
            </Field>
          );
        }
        if (fld.kind === 'number') {
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Input type="number" value={strVal} placeholder={fld.placeholder}
                onChange={(_, d) => patchTp(fld.path, d.value === '' ? undefined : Number(d.value))} />
            </Field>
          );
        }
        if (fld.kind === 'text') {
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Input value={strVal} placeholder={fld.placeholder}
                onChange={(_, d) => patchTp(fld.path, d.value)} />
            </Field>
          );
        }
        // expr / expr-multiline
        return (
          <ExpressionField
            key={fld.path}
            label={fld.label}
            hint={fld.hint}
            required={fld.required}
            placeholder={fld.placeholder}
            multiline={fld.kind === 'expr-multiline'}
            value={strVal}
            parameters={parameters}
            variables={variables}
            activities={allActivities}
            selfName={activity.name}
            onChange={(v) => patchTp(fld.path, v)}
          />
        );
      })}
    </>
  );
}
