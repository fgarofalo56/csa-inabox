import { describe, it, expect } from 'vitest';
import {
  isContainerType, branchesOf, totalInnerCount, branchLabel,
  readBranchActivities, writeBranchActivities,
  getLevelActivities, setLevelActivities, containerAt,
  pathHasLoop, pathHasConditional, canAddTypeAtLevel,
  popDrill, miniPreviewSections,
  type DrillPath,
} from '../drill-path';
import type { PipelineActivity } from '../types';

// ---------------------------------------------------------------------------
// Fixtures — an ADF-shaped tree with a ForEach containing an If, and a Switch
// with a default + one named case. Matches concepts-nested-activities JSON.
// ---------------------------------------------------------------------------
function tree(): PipelineActivity[] {
  return [
    {
      name: 'ForEach1', type: 'ForEach', dependsOn: [],
      typeProperties: {
        items: { value: "@variables('x')", type: 'Expression' },
        activities: [
          {
            name: 'If1', type: 'IfCondition', dependsOn: [],
            typeProperties: {
              expression: { value: '@equals(1,1)', type: 'Expression' },
              ifTrueActivities: [{ name: 'WaitT', type: 'Wait', typeProperties: { waitTimeInSeconds: 1 } }],
              ifFalseActivities: [],
            },
          },
        ],
      },
    },
    {
      name: 'Switch1', type: 'Switch', dependsOn: [],
      typeProperties: {
        on: { value: "@variables('c')", type: 'Expression' },
        defaultActivities: [{ name: 'WaitD', type: 'Wait', typeProperties: { waitTimeInSeconds: 2 } }],
        cases: [{ value: 'a', activities: [{ name: 'WaitA', type: 'Wait', typeProperties: {} }] }],
      },
    },
  ];
}

describe('drill-path container model', () => {
  it('identifies the four control-flow container types', () => {
    for (const t of ['ForEach', 'Until', 'IfCondition', 'Switch']) expect(isContainerType(t)).toBe(true);
    for (const t of ['Copy', 'Wait', 'WebActivity', undefined]) expect(isContainerType(t)).toBe(false);
  });

  it('enumerates branches with live counts per container type', () => {
    const [fe, sw] = tree();
    expect(branchesOf(fe)).toEqual([{ branch: undefined, label: 'Activities', count: 1 }]);
    const ifAct = readBranchActivities(fe)[0];
    expect(branchesOf(ifAct).map((b) => [b.label, b.count])).toEqual([['True', 1], ['False', 0]]);
    expect(branchesOf(sw).map((b) => [b.label, b.count])).toEqual([['Default', 1], ["Case 'a'", 1]]);
  });

  it('totalInnerCount sums every branch', () => {
    const [fe, sw] = tree();
    expect(totalInnerCount(fe)).toBe(1);
    expect(totalInnerCount(sw)).toBe(2); // default + case 'a'
  });

  it('branchLabel renders human labels', () => {
    expect(branchLabel(undefined)).toBeUndefined();
    expect(branchLabel('ifTrue')).toBe('True');
    expect(branchLabel('ifFalse')).toBe('False');
    expect(branchLabel('default')).toBe('Default');
    expect(branchLabel({ caseValue: 'a' })).toBe("Case 'a'");
  });
});

describe('read/write branch activities (immutable)', () => {
  it('writeBranchActivities replaces the right array and does not mutate input', () => {
    const [fe] = tree();
    const next = writeBranchActivities(fe, undefined, []);
    expect(readBranchActivities(next)).toEqual([]);
    expect(readBranchActivities(fe)).toHaveLength(1); // original untouched
    expect(next).not.toBe(fe);
  });

  it('writes the named Switch case, leaving default + other cases intact', () => {
    const [, sw] = tree();
    const newAct: PipelineActivity = { name: 'WaitA2', type: 'Wait', typeProperties: {} };
    const next = writeBranchActivities(sw, { caseValue: 'a' }, [newAct]);
    expect(readBranchActivities(next, { caseValue: 'a' })).toEqual([newAct]);
    expect(readBranchActivities(next, 'default')).toHaveLength(1); // default preserved
  });
});

describe('get/set level activities (drill walk)', () => {
  it('walks the path to the current level', () => {
    const root = tree();
    const intoForEach: DrillPath = [{ name: 'ForEach1' }];
    expect(getLevelActivities(root, intoForEach).map((a) => a.name)).toEqual(['If1']);

    const intoIfTrue: DrillPath = [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifTrue' }];
    expect(getLevelActivities(root, intoIfTrue).map((a) => a.name)).toEqual(['WaitT']);

    const intoIfFalse: DrillPath = [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifFalse' }];
    expect(getLevelActivities(root, intoIfFalse)).toEqual([]);
  });

  it('stale path collapses to []', () => {
    expect(getLevelActivities(tree(), [{ name: 'Ghost' }])).toEqual([]);
  });

  it('setLevelActivities writes back into the full tree immutably', () => {
    const root = tree();
    const path: DrillPath = [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifTrue' }];
    const added: PipelineActivity = { name: 'WaitT2', type: 'Wait', typeProperties: {} };
    const next = setLevelActivities(root, path, [...getLevelActivities(root, path), added]);

    expect(getLevelActivities(next, path).map((a) => a.name)).toEqual(['WaitT', 'WaitT2']);
    // siblings preserved
    expect(getLevelActivities(next, [])[1].name).toBe('Switch1');
    // original untouched
    expect(getLevelActivities(root, path)).toHaveLength(1);
    expect(next).not.toBe(root);
  });

  it('containerAt resolves the container a path points at', () => {
    const root = tree();
    expect(containerAt(root, [])).toBeNull();
    expect(containerAt(root, [{ name: 'ForEach1' }])?.name).toBe('ForEach1');
    expect(containerAt(root, [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifTrue' }])?.name).toBe('If1');
  });
});

describe('nesting limits (ADF concepts-nested-activities)', () => {
  const root = tree();
  it('detects loop / conditional in the path', () => {
    expect(pathHasLoop(root, [{ name: 'ForEach1' }])).toBe(true);
    expect(pathHasConditional(root, [{ name: 'ForEach1' }])).toBe(false);
    expect(pathHasConditional(root, [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifTrue' }])).toBe(true);
  });

  it('allows non-containers anywhere', () => {
    expect(canAddTypeAtLevel(root, [{ name: 'ForEach1' }], 'Wait').allowed).toBe(true);
    expect(canAddTypeAtLevel(root, [{ name: 'ForEach1' }], 'Copy').allowed).toBe(true);
  });

  it('blocks a loop inside a loop, allows If/Switch inside a loop', () => {
    const inLoop: DrillPath = [{ name: 'ForEach1' }];
    expect(canAddTypeAtLevel(root, inLoop, 'ForEach').allowed).toBe(false);
    expect(canAddTypeAtLevel(root, inLoop, 'Until').allowed).toBe(false);
    expect(canAddTypeAtLevel(root, inLoop, 'IfCondition').allowed).toBe(true);
    expect(canAddTypeAtLevel(root, inLoop, 'Switch').allowed).toBe(true);
  });

  it('blocks If/Switch inside an If/Switch', () => {
    const inIf: DrillPath = [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifTrue' }];
    expect(canAddTypeAtLevel(root, inIf, 'IfCondition').allowed).toBe(false);
    expect(canAddTypeAtLevel(root, inIf, 'Switch').allowed).toBe(false);
    // This path is also already inside a ForEach, so a second loop is blocked
    // too (ForEach/Until only support a single nesting level).
    expect(canAddTypeAtLevel(root, inIf, 'ForEach').allowed).toBe(false);
  });

  it('allows a loop inside a TOP-LEVEL conditional (single-level loop nesting)', () => {
    // A tree whose top-level activity is an If — drilling into its True branch
    // means the path has a conditional but no loop yet, so a ForEach is OK.
    const topIf: PipelineActivity[] = [{
      name: 'TopIf', type: 'IfCondition', dependsOn: [],
      typeProperties: { expression: {}, ifTrueActivities: [], ifFalseActivities: [] },
    }];
    const inTopIf: DrillPath = [{ name: 'TopIf', branch: 'ifTrue' }];
    expect(canAddTypeAtLevel(topIf, inTopIf, 'ForEach').allowed).toBe(true);
    expect(canAddTypeAtLevel(topIf, inTopIf, 'Until').allowed).toBe(true);
    // but another If/Switch is still blocked
    expect(canAddTypeAtLevel(topIf, inTopIf, 'IfCondition').allowed).toBe(false);
  });

  it('allows containers at the top level', () => {
    for (const t of ['ForEach', 'Until', 'IfCondition', 'Switch']) {
      expect(canAddTypeAtLevel(root, [], t).allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Drill-back (Backspace) + inline nested mini-preview (N toggle) — Fabric
// "updated canvas experience" (Learn: data-factory/pipeline-canvas-experience
// + data-factory/keyboard-shortcuts).
// ---------------------------------------------------------------------------
describe('popDrill (Backspace = return to previous canvas)', () => {
  it('is a no-op on an empty path', () => {
    expect(popDrill([])).toEqual([]);
  });

  it('pops a single step back to the top level', () => {
    expect(popDrill([{ name: 'ForEach1' }])).toEqual([]);
  });

  it('pops only the last step of a deeper path', () => {
    const path: DrillPath = [{ name: 'ForEach1' }, { name: 'If1', branch: 'ifTrue' }];
    expect(popDrill(path)).toEqual([{ name: 'ForEach1' }]);
  });

  it('does not mutate the input path', () => {
    const path: DrillPath = [{ name: 'ForEach1' }];
    popDrill(path);
    expect(path).toEqual([{ name: 'ForEach1' }]);
  });
});

describe('miniPreviewSections (inline container preview)', () => {
  it('ForEach yields one "Activities" section with the inner tiles', () => {
    const [fe] = tree();
    const secs = miniPreviewSections(fe);
    expect(secs).toHaveLength(1);
    expect(secs[0].label).toBe('Activities');
    expect(secs[0].totalCount).toBe(1);
    expect(secs[0].activities.map((a) => a.name)).toEqual(['If1']);
  });

  it('IfCondition yields True + False sections', () => {
    const [fe] = tree();
    const ifAct = readBranchActivities(fe)[0];
    const secs = miniPreviewSections(ifAct);
    expect(secs.map((s) => [s.label, s.totalCount])).toEqual([['True', 1], ['False', 0]]);
    expect(secs[0].activities.map((a) => a.name)).toEqual(['WaitT']);
    expect(secs[1].activities).toEqual([]);
  });

  it('Switch yields Default + each named case section', () => {
    const [, sw] = tree();
    const secs = miniPreviewSections(sw);
    expect(secs.map((s) => [s.label, s.totalCount])).toEqual([['Default', 1], ["Case 'a'", 1]]);
  });

  it('caps each branch at the limit and reports the true total', () => {
    const fe: PipelineActivity = {
      name: 'FE', type: 'ForEach', dependsOn: [],
      typeProperties: {
        activities: Array.from({ length: 5 }, (_, i) => ({
          name: `W${i}`, type: 'Wait', typeProperties: {},
        })),
      },
    };
    const secs = miniPreviewSections(fe, 3);
    expect(secs[0].activities).toHaveLength(3);
    expect(secs[0].totalCount).toBe(5);
  });

  it('non-container activities yield no sections', () => {
    expect(miniPreviewSections({ name: 'C', type: 'Copy', typeProperties: {} })).toEqual([]);
  });
});
