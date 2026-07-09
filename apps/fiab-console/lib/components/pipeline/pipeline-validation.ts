/**
 * pipeline-validation — pure, pre-run authoring validation for pipeline
 * activities (Fabric / ADF Studio parity).
 *
 * Fabric's pipeline designer shows a RED SUPERSCRIPT DOT on any properties-panel
 * tab (General / Source / Destination / Mapping / Settings) that has a missing
 * required field, and surfaces the same problems in an "Authoring errors" list —
 * BEFORE the pipeline is ever run. This module is the single source of truth for
 * that computation, driven entirely by the data-driven activity schema
 * (`ACTIVITIES[].settings` — every field's `required` / `path` / `showIf` is
 * verbatim from the Microsoft Learn activity docs, see activity-catalog.ts).
 *
 * It is deliberately UI-free (no React, no Fluent) so it is unit-testable and can
 * be shared by the properties panel (tab dots), the designer (authoring-errors
 * list + node error rings), and any future pre-run gate. Nothing here calls a
 * backend — it is a static analysis of the in-memory activity tree.
 */

import { activityByType, findForActivity, type ActivitySettingField } from './activity-catalog';
import type { PipelineActivity } from './types';

/**
 * Properties-panel tab ids a validation issue can land on. Mirrors
 * PropertiesPanel's `TabId` so the panel can render a dot per tab. Only the tabs
 * that can carry a REQUIRED field are meaningful for dots (general / source /
 * sink / settings / source-sink); the rest never produce issues.
 */
export type PipelineTabId =
  | 'general'
  | 'source'
  | 'sink'
  | 'mapping'
  | 'copy-settings'
  | 'source-sink'
  | 'settings'
  | 'parameters'
  | 'user-props';

/** One missing-required-field problem on a single activity. */
export interface ActivityIssue {
  /** Which properties-panel tab surfaces the offending field. */
  tab: PipelineTabId;
  /** Human field label (e.g. "Notebook path"). */
  label: string;
  /** Field key / path (for de-dup + anchoring). */
  key: string;
  /** One-line problem statement. */
  message: string;
}

/** Every issue found on one activity, with the activity's identity. */
export interface ActivityValidation {
  name: string;
  type: string;
  issues: ActivityIssue[];
}

/**
 * Walk a dotted / indexed path (`scripts[0].text`, `expression.value`,
 * `linkedServiceName.referenceName`) into `obj`. Returns `undefined` for any
 * missing segment. Pure; never throws.
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  // Normalise `a[0].b` → `a.0.b` so a single split handles object keys + array
  // indices uniformly.
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Resolve a settings field's live value off an activity (root vs typeProperties). */
export function activityFieldValue(activity: PipelineActivity, field: ActivitySettingField): unknown {
  const path = field.path || field.key;
  const base = field.rootPath ? (activity as unknown) : (activity.typeProperties ?? {});
  return getByPath(base, path);
}

/**
 * Evaluate a field's `showIf` gate against the activity. A field only counts as
 * required when it is actually visible. Comparison is string-based (matches the
 * renderer's `String(value) === equals`).
 */
export function isFieldVisible(activity: PipelineActivity, field: ActivitySettingField): boolean {
  const showIf = field.showIf;
  if (!showIf) return true;
  // showIf.key is a typeProperties path (never a root path in the inventory).
  const v = getByPath(activity.typeProperties ?? {}, showIf.key);
  return String(v ?? '') === String(showIf.equals);
}

/** True when a value is "not provided" for required-field purposes. */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  // Reference objects (dataset / linked-service) resolve to their string
  // referenceName via `path`, so a bare object here means "set" — treat as
  // provided. Numbers / booleans are always provided.
  return false;
}

/** The Copy activity's bound source dataset name (inputs[0]), or ''. */
function copySourceDataset(activity: PipelineActivity): string {
  const inputs = (activity.inputs as Array<{ referenceName?: string }> | undefined) || [];
  return (inputs[0]?.referenceName || '').trim();
}

/** The Copy activity's bound sink dataset name (outputs[0]), or ''. */
function copySinkDataset(activity: PipelineActivity): string {
  const outputs = (activity.outputs as Array<{ referenceName?: string }> | undefined) || [];
  return (outputs[0]?.referenceName || '').trim();
}

/**
 * Validate ONE activity: return every missing-required-field issue, tagged with
 * the properties-panel tab that surfaces the field.
 *
 * Sources of "required":
 *   - General:  the activity name (always required).
 *   - Copy:     a bound Source dataset (Source tab) + Sink dataset (Sink tab).
 *   - Others:   each `required` field in the data-driven ACTIVITIES[].settings
 *               spec that is visible (showIf) and empty → Settings tab.
 */
export function validateActivity(activity: PipelineActivity): ActivityValidation {
  const issues: ActivityIssue[] = [];
  const type = activity.type || '';

  // General — every activity must be named.
  if (!activity.name || !activity.name.trim()) {
    issues.push({ tab: 'general', label: 'Name', key: 'name', message: 'Activity name is required.' });
  }

  if (type === 'Copy') {
    // Copy configures its source / sink datasets in dedicated tabs, not the
    // schema-driven Settings form (copyTabbed).
    if (!copySourceDataset(activity)) {
      issues.push({ tab: 'source', label: 'Source dataset', key: 'inputs[0]', message: 'Bind a source dataset.' });
    }
    if (!copySinkDataset(activity)) {
      issues.push({ tab: 'sink', label: 'Sink dataset', key: 'outputs[0]', message: 'Bind a sink dataset.' });
    }
    return { name: activity.name, type, issues };
  }

  // Schema-driven required fields (rendered in the Settings tab's ActivityForm).
  const def = activityByType(type);
  if (def) {
    for (const field of def.settings) {
      if (!field.required) continue;
      if (!isFieldVisible(activity, field)) continue;
      if (isEmptyValue(activityFieldValue(activity, field))) {
        issues.push({
          tab: 'settings',
          label: field.label,
          key: field.path || field.key,
          message: `${field.label} is required.`,
        });
      }
    }
  }

  return { name: activity.name, type, issues };
}

/** Count of issues per properties-panel tab for one activity (drives tab dots). */
export function tabIssueCounts(activity: PipelineActivity | null | undefined): Partial<Record<PipelineTabId, number>> {
  const out: Partial<Record<PipelineTabId, number>> = {};
  if (!activity) return out;
  for (const issue of validateActivity(activity).issues) {
    out[issue.tab] = (out[issue.tab] || 0) + 1;
  }
  return out;
}

/** Total issue count for one activity. */
export function activityIssueCount(activity: PipelineActivity | null | undefined): number {
  if (!activity) return 0;
  return validateActivity(activity).issues.length;
}

/**
 * Validate a flat list of activities at one canvas level, returning only those
 * that have at least one issue (for the authoring-errors list + node rings).
 * `label` is the catalog display label for friendlier messages.
 */
export function validateLevel(activities: PipelineActivity[]): ActivityValidation[] {
  const out: ActivityValidation[] = [];
  for (const a of activities) {
    const v = validateActivity(a);
    if (v.issues.length) out.push(v);
  }
  return out;
}

/**
 * The inner activity arrays a container activity holds, flattened. Mirrors the
 * drill-path model (ForEach/Until → activities; If → ifTrue/ifFalse; Switch →
 * cases[].activities + defaultActivities).
 */
function innerActivitiesOf(activity: PipelineActivity): PipelineActivity[] {
  const tp = (activity.typeProperties || {}) as Record<string, unknown>;
  const lists: PipelineActivity[] = [];
  const push = (v: unknown) => { if (Array.isArray(v)) lists.push(...(v as PipelineActivity[])); };
  push(tp.activities);
  push(tp.ifTrueActivities);
  push(tp.ifFalseActivities);
  push(tp.defaultActivities);
  if (Array.isArray(tp.cases)) {
    for (const c of tp.cases as Array<{ activities?: unknown }>) push(c?.activities);
  }
  return lists;
}

/**
 * Recursive total issue count over the whole activity tree (top level + every
 * nested container branch). Drives the ribbon / status "Authoring errors (N)"
 * badge so problems buried inside a ForEach still surface at the top.
 */
export function countIssuesDeep(activities: PipelineActivity[]): number {
  let total = 0;
  for (const a of activities) {
    total += validateActivity(a).issues.length;
    const inner = innerActivitiesOf(a);
    if (inner.length) total += countIssuesDeep(inner);
  }
  return total;
}

/**
 * Best-effort display label for an activity (catalog label, else its wire type).
 * Kept here so the authoring-errors list doesn't need to reach into the catalog.
 */
export function activityDisplayLabel(activity: PipelineActivity): string {
  return findForActivity(activity)?.label || activity.type || 'Activity';
}
