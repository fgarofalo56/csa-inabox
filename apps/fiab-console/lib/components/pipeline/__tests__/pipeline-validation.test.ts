import { describe, it, expect } from 'vitest';
import {
  getByPath, isEmptyValue, isFieldVisible, activityFieldValue,
  validateActivity, tabIssueCounts, activityIssueCount,
  validateLevel, countIssuesDeep, activityDisplayLabel,
} from '../pipeline-validation';
import {
  ACTIVITY_CATALOG, ACTIVITY_CATEGORY_ORDER, activityPickerGroups, byCategory, findByKey,
} from '../activity-catalog';
import type { PipelineActivity } from '../types';

// ── path helpers ────────────────────────────────────────────────────────────
describe('getByPath', () => {
  it('walks dotted paths', () => {
    expect(getByPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getByPath({ expression: { value: '@x' } }, 'expression.value')).toBe('@x');
  });
  it('walks indexed array paths (scripts[0].text)', () => {
    expect(getByPath({ scripts: [{ text: 'SELECT 1' }] }, 'scripts[0].text')).toBe('SELECT 1');
  });
  it('returns undefined for missing segments and nullish input', () => {
    expect(getByPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
    expect(getByPath({}, '')).toBeUndefined();
  });
});

describe('isEmptyValue', () => {
  it('treats null/undefined/blank/[] as empty', () => {
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue('')).toBe(true);
    expect(isEmptyValue('   ')).toBe(true);
    expect(isEmptyValue([])).toBe(true);
  });
  it('treats real values as provided', () => {
    expect(isEmptyValue('x')).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(['a'])).toBe(false);
    expect(isEmptyValue({ referenceName: 'ds' })).toBe(false);
  });
});

describe('isFieldVisible (showIf gate)', () => {
  const del: PipelineActivity = {
    name: 'Delete1', type: 'Delete', dependsOn: [],
    typeProperties: { enableLogging: false },
  };
  it('hides a field whose showIf does not match', () => {
    const field = { key: 'x', label: 'Log LS', kind: 'text' as const, showIf: { key: 'enableLogging', equals: 'true' } };
    expect(isFieldVisible(del, field)).toBe(false);
  });
  it('shows a field whose showIf matches', () => {
    const on: PipelineActivity = { ...del, typeProperties: { enableLogging: true } };
    const field = { key: 'x', label: 'Log LS', kind: 'text' as const, showIf: { key: 'enableLogging', equals: 'true' } };
    expect(isFieldVisible(on, field)).toBe(true);
  });
  it('always shows a field with no showIf', () => {
    expect(isFieldVisible(del, { key: 'x', label: 'X', kind: 'text' as const })).toBe(true);
  });
});

describe('activityFieldValue (root vs typeProperties)', () => {
  it('reads a rootPath field off the activity root', () => {
    const a: PipelineActivity = {
      name: 'N1', type: 'DatabricksNotebook', dependsOn: [],
      typeProperties: { notebookPath: '/x' },
      linkedServiceName: { referenceName: 'dbx', type: 'LinkedServiceReference' },
    } as PipelineActivity;
    const field = { key: 'linkedServiceName.referenceName', path: 'linkedServiceName.referenceName', rootPath: true, label: 'LS', kind: 'text' as const, required: true };
    expect(activityFieldValue(a, field)).toBe('dbx');
  });
  it('reads a normal field off typeProperties', () => {
    const a: PipelineActivity = { name: 'W1', type: 'Wait', dependsOn: [], typeProperties: { waitTimeInSeconds: 5 } };
    expect(activityFieldValue(a, { key: 'waitTimeInSeconds', label: 'Wait', kind: 'number' })).toBe(5);
  });
});

// ── per-activity validation ─────────────────────────────────────────────────
describe('validateActivity', () => {
  it('flags a missing name on the General tab', () => {
    const a: PipelineActivity = { name: '', type: 'Wait', dependsOn: [], typeProperties: { waitTimeInSeconds: 5 } };
    const v = validateActivity(a);
    expect(v.issues.some((i) => i.tab === 'general' && i.key === 'name')).toBe(true);
  });

  it('flags a fresh Copy as missing Source + Sink datasets on their tabs', () => {
    const copy = findByKey('Copy')!.build('Copy1');
    const v = validateActivity(copy);
    const tabs = v.issues.map((i) => i.tab);
    expect(tabs).toContain('source');
    expect(tabs).toContain('sink');
  });

  it('clears the Copy Source/Sink issues once datasets are bound', () => {
    const copy = findByKey('Copy')!.build('Copy1');
    copy.inputs = [{ referenceName: 'srcDs', type: 'DatasetReference' }];
    copy.outputs = [{ referenceName: 'dstDs', type: 'DatasetReference' }];
    const v = validateActivity(copy);
    expect(v.issues.some((i) => i.tab === 'source' || i.tab === 'sink')).toBe(false);
  });

  it('flags a schema-required field (Databricks notebookPath + linkedService) on Settings', () => {
    const nb = findByKey('Notebook')!.build('Notebook1'); // DatabricksNotebook, blank path + LS
    const v = validateActivity(nb);
    // Both the linked service and the notebook path are required + empty.
    expect(v.issues.every((i) => i.tab === 'settings' || i.tab === 'general')).toBe(true);
    expect(v.issues.some((i) => /notebook path/i.test(i.label))).toBe(true);
  });

  it('does not flag a Wait activity that has its required field set', () => {
    const wait = findByKey('Wait')!.build('Wait1'); // waitTimeInSeconds: 5
    expect(validateActivity(wait).issues.length).toBe(0);
  });

  it('respects showIf — a hidden required field is not flagged', () => {
    // Delete with logging off: logStorageSettings LS is showIf enableLogging=true.
    const del = findByKey('Delete')!.build('Delete1');
    del.typeProperties = { ...del.typeProperties, enableLogging: false };
    // Bind the required dataset so only the (hidden) log LS could remain.
    (del.typeProperties as any).dataset = { referenceName: 'ds', type: 'DatasetReference' };
    const v = validateActivity(del);
    expect(v.issues.some((i) => /logging linked service/i.test(i.label))).toBe(false);
  });
});

describe('tabIssueCounts / activityIssueCount', () => {
  it('buckets issue counts per tab', () => {
    const copy = findByKey('Copy')!.build('Copy1');
    const counts = tabIssueCounts(copy);
    expect(counts.source).toBe(1);
    expect(counts.sink).toBe(1);
    expect(activityIssueCount(copy)).toBe(2);
  });
  it('returns empty for null', () => {
    expect(tabIssueCounts(null)).toEqual({});
    expect(activityIssueCount(undefined)).toBe(0);
  });
});

// ── tree-level validation ───────────────────────────────────────────────────
describe('validateLevel + countIssuesDeep', () => {
  it('returns only activities that have issues', () => {
    const wait = findByKey('Wait')!.build('Wait1');       // clean
    const copy = findByKey('Copy')!.build('Copy1');        // 2 issues
    const level = validateLevel([wait, copy]);
    expect(level.map((v) => v.name)).toEqual(['Copy1']);
  });

  it('counts issues nested inside a ForEach container', () => {
    const foreach = findByKey('ForEach')!.build('ForEach1');
    const innerCopy = findByKey('Copy')!.build('Copy1');   // 2 issues
    (foreach.typeProperties as any).activities = [innerCopy];
    // ForEach's own `items` is pre-filled (@variables('items')) so it is clean;
    // the two issues come entirely from the nested Copy.
    expect(countIssuesDeep([foreach])).toBe(2);
  });

  it('counts issues across If branches and Switch cases', () => {
    const iff = findByKey('IfCondition')!.build('If1');
    const badCopy = findByKey('Copy')!.build('CopyT');     // 2 issues
    (iff.typeProperties as any).ifTrueActivities = [badCopy];
    const sw = findByKey('Switch')!.build('Switch1');
    (sw.typeProperties as any).cases = [{ value: 'a', activities: [findByKey('Copy')!.build('CopyC')] }];
    (sw.typeProperties as any).defaultActivities = [findByKey('Copy')!.build('CopyD')];
    // If: 2 (true branch). Switch: 2 (case) + 2 (default) = 4. Total 6.
    expect(countIssuesDeep([iff, sw])).toBe(6);
  });
});

describe('activityDisplayLabel', () => {
  it('resolves the catalog label for a Copy activity', () => {
    expect(activityDisplayLabel(findByKey('Copy')!.build('Copy1'))).toBe('Copy data');
  });
  it('discriminates Approval from plain Webhook (shared WebHook type)', () => {
    expect(activityDisplayLabel(findByKey('ApprovalWebhook')!.build('Approval1'))).toBe('Approval (Logic App)');
  });
});

// ── categorized activity picker ─────────────────────────────────────────────
describe('activityPickerGroups (categorized searchable picker)', () => {
  it('returns every category in display order with non-empty members', () => {
    const groups = activityPickerGroups();
    expect(groups.map((g) => g.id)).toEqual(ACTIVITY_CATEGORY_ORDER.map((g) => g.id));
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
  });

  it('partitions the whole catalog exactly once across the groups', () => {
    const groups = activityPickerGroups();
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(ACTIVITY_CATALOG.length);
    // No activity appears in two groups.
    const keys = groups.flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes the Wave-4 AI-enrich family as its own group', () => {
    const ai = activityPickerGroups().find((g) => g.id === 'ai-enrich');
    expect(ai).toBeDefined();
    expect(ai!.items.length).toBe(byCategory('ai-enrich').length);
    expect(ai!.items.map((i) => i.key)).toContain('DocumentIntelligenceAnalyze');
  });

  it('drops empty groups when a search filter matches nothing in them', () => {
    const groups = activityPickerGroups((d) => d.label.toLowerCase().includes('copy'));
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    // "Copy data" lives in Move & transform; Control flow should be filtered out.
    expect(groups.some((g) => g.id === 'move-transform')).toBe(true);
    expect(groups.some((g) => g.id === 'control-flow')).toBe(false);
  });
});
