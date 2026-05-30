/**
 * drill-path — pure model helpers for ADF/Synapse-style nested control-flow
 * sub-canvases.
 *
 * Container activities (ForEach / Until / IfCondition / Switch) hold their
 * inner activities under `typeProperties`, in the exact ADF JSON shape
 * (Learn: concepts-nested-activities):
 *
 *   ForEach / Until : typeProperties.activities
 *   IfCondition     : typeProperties.ifTrueActivities | ifFalseActivities
 *   Switch          : typeProperties.defaultActivities
 *                     typeProperties.cases[i].activities
 *
 * A `DrillPath` is the trail of (container, branch) steps the user has drilled
 * through. `getLevelActivities` walks the path down the tree to the
 * CURRENT-level activities array; `setLevelActivities` writes a mutated array
 * back into a fresh copy of the whole top-level tree (immutably), so the
 * designer can call onActivitiesChange(updatedTree).
 *
 * Nesting rules enforced (ADF, concepts-nested-activities):
 *   - If / Switch CAN be used inside ForEach / Until.
 *   - If / Switch CANNOT be nested inside If / Switch.
 *   - ForEach / Until support only a single level of nesting (no ForEach/Until
 *     inside a ForEach/Until).
 */

import type { PipelineActivity } from './types';

/** ADF type strings for the four control-flow containers. */
export const CONTAINER_TYPES = ['ForEach', 'Until', 'IfCondition', 'Switch'] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

export function isContainerType(type?: string): type is ContainerType {
  return !!type && (CONTAINER_TYPES as readonly string[]).includes(type);
}

/**
 * Which inner-activity branch of a container a drill step targets.
 *   - ForEach / Until      : undefined (single `activities` array)
 *   - IfCondition          : 'ifTrue' | 'ifFalse'
 *   - Switch (default case) : 'default'
 *   - Switch (a named case) : { caseValue: string }
 */
export type DrillBranch = 'ifTrue' | 'ifFalse' | 'default' | { caseValue: string };

export interface DrillStep {
  /** Container activity name at the parent level. */
  name: string;
  /** Which branch of that container we drilled into. */
  branch?: DrillBranch;
}

export type DrillPath = DrillStep[];

function sameBranch(a: DrillBranch | undefined, b: DrillBranch | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.caseValue === b.caseValue;
}

/** Human label for a branch, used in the breadcrumb (e.g. "True", "Case 'a'"). */
export function branchLabel(branch?: DrillBranch): string | undefined {
  if (branch === undefined) return undefined;
  if (branch === 'ifTrue') return 'True';
  if (branch === 'ifFalse') return 'False';
  if (branch === 'default') return 'Default';
  return `Case '${branch.caseValue}'`;
}

/** The set of branches a container exposes, in display order. */
export interface BranchDef {
  branch: DrillBranch;
  label: string;
  /** Activity count currently in this branch. */
  count: number;
}

/** Read the inner-activities array for a container + branch (never mutates). */
export function readBranchActivities(activity: PipelineActivity, branch?: DrillBranch): PipelineActivity[] {
  const tp = (activity.typeProperties || {}) as Record<string, unknown>;
  const type = activity.type;
  if (type === 'ForEach' || type === 'Until') {
    return Array.isArray(tp.activities) ? (tp.activities as PipelineActivity[]) : [];
  }
  if (type === 'IfCondition') {
    const key = branch === 'ifFalse' ? 'ifFalseActivities' : 'ifTrueActivities';
    return Array.isArray(tp[key]) ? (tp[key] as PipelineActivity[]) : [];
  }
  if (type === 'Switch') {
    if (branch && typeof branch === 'object' && 'caseValue' in branch) {
      const cases = Array.isArray(tp.cases) ? (tp.cases as Array<{ value: string; activities?: PipelineActivity[] }>) : [];
      const c = cases.find((x) => x.value === branch.caseValue);
      return Array.isArray(c?.activities) ? (c!.activities as PipelineActivity[]) : [];
    }
    return Array.isArray(tp.defaultActivities) ? (tp.defaultActivities as PipelineActivity[]) : [];
  }
  return [];
}

/**
 * Return an immutable copy of `activity` with the inner-activities array for
 * the given branch replaced by `next`.
 */
export function writeBranchActivities(
  activity: PipelineActivity,
  branch: DrillBranch | undefined,
  next: PipelineActivity[],
): PipelineActivity {
  const tp = { ...(activity.typeProperties || {}) } as Record<string, unknown>;
  const type = activity.type;
  if (type === 'ForEach' || type === 'Until') {
    tp.activities = next;
  } else if (type === 'IfCondition') {
    const key = branch === 'ifFalse' ? 'ifFalseActivities' : 'ifTrueActivities';
    tp[key] = next;
  } else if (type === 'Switch') {
    if (branch && typeof branch === 'object' && 'caseValue' in branch) {
      const cases = Array.isArray(tp.cases)
        ? (tp.cases as Array<{ value: string; activities?: PipelineActivity[] }>).map((c) => ({ ...c }))
        : [];
      const idx = cases.findIndex((c) => c.value === branch.caseValue);
      if (idx >= 0) cases[idx] = { ...cases[idx], activities: next };
      else cases.push({ value: branch.caseValue, activities: next });
      tp.cases = cases;
    } else {
      tp.defaultActivities = next;
    }
  }
  return { ...activity, typeProperties: tp };
}

/** Enumerate the branches a container exposes (with live counts). */
export function branchesOf(activity: PipelineActivity): BranchDef[] {
  const type = activity.type;
  if (type === 'ForEach' || type === 'Until') {
    return [{ branch: undefined, label: 'Activities', count: readBranchActivities(activity).length }];
  }
  if (type === 'IfCondition') {
    return [
      { branch: 'ifTrue', label: 'True', count: readBranchActivities(activity, 'ifTrue').length },
      { branch: 'ifFalse', label: 'False', count: readBranchActivities(activity, 'ifFalse').length },
    ];
  }
  if (type === 'Switch') {
    const tp = (activity.typeProperties || {}) as Record<string, unknown>;
    const cases = Array.isArray(tp.cases) ? (tp.cases as Array<{ value: string }>) : [];
    return [
      { branch: 'default', label: 'Default', count: readBranchActivities(activity, 'default').length },
      ...cases.map((c) => ({
        branch: { caseValue: c.value } as DrillBranch,
        label: `Case '${c.value}'`,
        count: readBranchActivities(activity, { caseValue: c.value }).length,
      })),
    ];
  }
  return [];
}

/** Total inner-activity count across every branch of a container. */
export function totalInnerCount(activity: PipelineActivity): number {
  return branchesOf(activity).reduce((n, b) => n + b.count, 0);
}

/**
 * Walk `root` down `path` and return the activities array at the CURRENT level.
 * If any step is missing (e.g. a stale path after a delete), returns [].
 */
export function getLevelActivities(root: PipelineActivity[], path: DrillPath): PipelineActivity[] {
  let level = root;
  for (const step of path) {
    const container = level.find((a) => a.name === step.name);
    if (!container) return [];
    level = readBranchActivities(container, step.branch);
  }
  return level;
}

/**
 * Return a fresh copy of `root` where the activities array at `path` is
 * replaced with `next`. Rebuilds the container chain immutably so React Flow
 * + the editor's dirty-tracking see a new reference at every touched level.
 */
export function setLevelActivities(
  root: PipelineActivity[],
  path: DrillPath,
  next: PipelineActivity[],
): PipelineActivity[] {
  if (path.length === 0) return next;
  const [step, ...rest] = path;
  return root.map((a) => {
    if (a.name !== step.name) return a;
    const inner = readBranchActivities(a, step.branch);
    const updatedInner = setLevelActivities(inner, rest, next);
    return writeBranchActivities(a, step.branch, updatedInner);
  });
}

/** Resolve the container activity that a drill step points at, given the parent level. */
export function containerAt(root: PipelineActivity[], path: DrillPath): PipelineActivity | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parentLevel = getLevelActivities(root, parentPath);
  return parentLevel.find((a) => a.name === last.name) || null;
}

// ---------------------------------------------------------------------------
// Nesting limits (ADF concepts-nested-activities)
// ---------------------------------------------------------------------------

/** Has the path already crossed a ForEach/Until at any depth? */
export function pathHasLoop(root: PipelineActivity[], path: DrillPath): boolean {
  let level = root;
  for (const step of path) {
    const container = level.find((a) => a.name === step.name);
    if (!container) return false;
    if (container.type === 'ForEach' || container.type === 'Until') return true;
    level = readBranchActivities(container, step.branch);
  }
  return false;
}

/** Has the path already crossed an If/Switch at any depth? */
export function pathHasConditional(root: PipelineActivity[], path: DrillPath): boolean {
  let level = root;
  for (const step of path) {
    const container = level.find((a) => a.name === step.name);
    if (!container) return false;
    if (container.type === 'IfCondition' || container.type === 'Switch') return true;
    level = readBranchActivities(container, step.branch);
  }
  return false;
}

export interface NestRule {
  /** Can the user drop an activity of `type` at the current level? */
  allowed: boolean;
  /** Reason to show in a tooltip when not allowed. */
  reason?: string;
}

/**
 * Whether a NEW activity of `childType` may be added at the level reached by
 * `path`. Non-container types are always allowed. Container types follow ADF's
 * nesting limits.
 */
export function canAddTypeAtLevel(root: PipelineActivity[], path: DrillPath, childType?: string): NestRule {
  if (!isContainerType(childType)) return { allowed: true };

  const insideLoop = pathHasLoop(root, path);
  const insideConditional = pathHasConditional(root, path);
  const childIsLoop = childType === 'ForEach' || childType === 'Until';
  const childIsConditional = childType === 'IfCondition' || childType === 'Switch';

  if (childIsLoop && insideLoop) {
    return { allowed: false, reason: 'ForEach / Until support only a single level of nesting — you cannot place a loop inside another loop.' };
  }
  if (childIsConditional && insideConditional) {
    return { allowed: false, reason: 'If / Switch cannot be nested inside another If / Switch.' };
  }
  // If/Switch inside a loop is allowed; a loop inside an If/Switch is allowed.
  return { allowed: true };
}

/**
 * Whether the user may DRILL INTO `container` from the level reached by `path`.
 * (Drilling is always allowed for a container that exists; the limit is on
 * ADDING — but we also block drilling into a malformed/non-container.)
 */
export function canDrillInto(container: PipelineActivity): boolean {
  return isContainerType(container.type);
}
