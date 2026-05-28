import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_CATALOG, byCategory, findByType, findByKey, nextNameSuffix,
} from '../activity-catalog';

describe('activity-catalog', () => {
  it('exposes both palette categories', () => {
    const mt = byCategory('move-transform');
    const act = byCategory('activities');
    expect(mt.length).toBeGreaterThan(0);
    expect(act.length).toBeGreaterThan(0);
    expect(mt.length + act.length).toBe(ACTIVITY_CATALOG.length);
  });

  it('covers all Fabric activity types required by the parity spec', () => {
    const keys = ACTIVITY_CATALOG.map((a) => a.key);
    const required = [
      'Copy', 'DataflowGen2', 'ExecuteDataFlow', 'Lookup',
      'Notebook', 'SparkJob', 'Script', 'StoredProcedure', 'Web', 'Office365Outlook',
      'SetVariable', 'AppendVariable', 'Filter', 'ForEach', 'IfCondition',
      'Switch', 'Until', 'Wait',
    ];
    for (const k of required) expect(keys).toContain(k);
  });

  it('marks Fabric-only activities as non-runnable with remediation', () => {
    const office = findByKey('Office365Outlook');
    expect(office?.runnable).toBe(false);
    expect(office?.remediation).toBeTruthy();
    const dfg2 = findByKey('DataflowGen2');
    expect(dfg2?.runnable).toBe(false);
    expect(dfg2?.remediation).toBeTruthy();
  });

  it('every catalog entry has a build() that produces a valid PipelineActivity', () => {
    for (const def of ACTIVITY_CATALOG) {
      const a = def.build(`${def.namePrefix}1`);
      expect(a.name).toBe(`${def.namePrefix}1`);
      expect(a.type).toBe(def.type);
      expect(Array.isArray(a.dependsOn)).toBe(true);
      // typeProperties must exist (even if empty) so ADF accepts the JSON
      expect(typeof a.typeProperties).toBe('object');
    }
  });

  it('findByType / findByKey round-trip', () => {
    const def = findByKey('Copy');
    expect(def).toBeDefined();
    expect(findByType(def!.type)?.key).toBe('Copy');
  });

  it('nextNameSuffix increments past existing numeric tails', () => {
    const activities = [
      { name: 'Copy1', type: 'Copy' },
      { name: 'Copy2', type: 'Copy' },
      { name: 'Wait1', type: 'Wait' },
      { name: 'CopyData', type: 'Copy' }, // non-numeric tail ignored
    ];
    expect(nextNameSuffix(activities, 'Copy')).toBe(3);
    expect(nextNameSuffix(activities, 'Wait')).toBe(2);
    expect(nextNameSuffix(activities, 'NewType')).toBe(1);
  });
});
