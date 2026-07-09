/**
 * Trigger-model compiler tests (FGC-13). Pure KQL/validation logic — no Azure
 * I/O. Asserts the per-object grouping + stateful change-detection each Fabric
 * Activator rule kind compiles to, plus the validation gates.
 */
import { describe, it, expect } from 'vitest';
import {
  compileTriggerModelKql,
  validateTriggerModel,
  describeTriggerModel,
  objectKeyDimension,
  coerceRuleKind,
  coercePropertyCondition,
  isActivatorRuleKind,
  isPropertyConditionType,
  hasObjectKey,
  type TriggerModelInput,
} from '../activator-trigger-model';

describe('type guards + coercion', () => {
  it('recognizes known kinds/conditions and defaults unknowns', () => {
    expect(isActivatorRuleKind('property')).toBe(true);
    expect(isActivatorRuleKind('nope')).toBe(false);
    expect(isPropertyConditionType('no-data-for')).toBe(true);
    expect(isPropertyConditionType('nope')).toBe(false);
    expect(coerceRuleKind(undefined)).toBe('event');
    expect(coerceRuleKind('split-event')).toBe('split-event');
    expect(coercePropertyCondition('bogus')).toBe('becomes');
  });
  it('hasObjectKey is false for blank keys', () => {
    expect(hasObjectKey({ objectKey: '' })).toBe(false);
    expect(hasObjectKey({ objectKey: '  ' })).toBe(false);
    expect(hasObjectKey({ objectKey: 'device_id' })).toBe(true);
  });
});

describe('Event rule (flat)', () => {
  it('compiles a numeric predicate over every row', () => {
    const q = compileTriggerModelKql({ ruleKind: 'event', property: 'latency_ms', operator: 'GreaterThan', value: 200, table: 'Telemetry' });
    // Event rule delegates to the flat predicate against the table.
    expect(q).toContain('Telemetry');
    expect(q).toContain('> 200');
  });
});

describe('Split-Event rule (per object)', () => {
  it('groups by the object key and projects it', () => {
    const q = compileTriggerModelKql({ ruleKind: 'split-event', objectKey: 'device_id', property: 'temp', operator: 'GreaterThanOrEqual', value: 80, table: 'Sensors' });
    expect(q).toContain('column_ifexists("device_id"');
    expect(q).toContain('>= 80');
    expect(q).toContain('project _key');
    expect(q).toContain('isnotempty(_key)');
  });
});

describe('Property rule — Decreases by', () => {
  it('computes per-object percent change vs the previous sample', () => {
    const q = compileTriggerModelKql({
      ruleKind: 'property', objectKey: 'asset_id', property: 'throughput',
      propertyConditionType: 'decreases-by', changePercent: 10, table: 'Assets',
    });
    expect(q).toContain('prev(_v)');
    expect(q).toContain('prev(_key)');
    expect(q).toContain('_prevV != 0');
    // decrease of ≥10% ⇒ pctChange ≤ -10
    expect(q).toContain('<= -10');
    // ordered per object for prev() to be meaningful
    expect(q).toContain('order by tostring(_key) asc, _ts asc');
  });
});

describe('Property rule — Increases by', () => {
  it('fires when percent change ≥ +percent', () => {
    const q = compileTriggerModelKql({
      ruleKind: 'property', objectKey: 'device_id', property: 'errors',
      propertyConditionType: 'increases-by', changePercent: 25, table: 'T',
    });
    expect(q).toContain('>= 25');
  });
});

describe('Property rule — Exits range', () => {
  it('fires when the value leaves [min, max]', () => {
    const q = compileTriggerModelKql({
      ruleKind: 'property', objectKey: 'device_id', property: 'psi',
      propertyConditionType: 'exits-range', rangeMin: 20, rangeMax: 60, table: 'Pumps',
    });
    expect(q).toContain('_v < 20 or _v > 60');
  });
});

describe('Property rule — No data for (heartbeat)', () => {
  it('finds objects whose newest event is older than N minutes', () => {
    const q = compileTriggerModelKql({
      ruleKind: 'property', objectKey: 'device_id',
      propertyConditionType: 'no-data-for', noDataMinutes: 15, table: 'Beats', timestampColumn: 'ts',
    });
    expect(q).toContain('summarize _lastSeen = max(_ts)');
    expect(q).toContain('now() - _lastSeen > 15m');
    expect(q).toContain('column_ifexists("ts"');
  });
});

describe('Property rule — Becomes', () => {
  it('detects a transition INTO the target value', () => {
    const q = compileTriggerModelKql({
      ruleKind: 'property', objectKey: 'device_id', property: 'state',
      propertyConditionType: 'becomes', value: 'FAULT', table: 'M',
    });
    // current == target AND previous != target
    expect(q).toContain('== "FAULT"');
    expect(q).toContain('!= "FAULT"');
    expect(q).toContain('prev(_key)');
  });
});

describe('validation', () => {
  it('requires an object key for split + property rules', () => {
    expect(validateTriggerModel({ ruleKind: 'split-event' })).toMatch(/object key/i);
    expect(validateTriggerModel({ ruleKind: 'property', propertyConditionType: 'becomes', property: 'x' })).toMatch(/object key/i);
  });
  it('requires a positive percent for increases/decreases', () => {
    expect(validateTriggerModel({ ruleKind: 'property', objectKey: 'k', property: 'p', propertyConditionType: 'increases-by', changePercent: 0 })).toMatch(/percent/i);
  });
  it('requires max > min for exits-range', () => {
    expect(validateTriggerModel({ ruleKind: 'property', objectKey: 'k', property: 'p', propertyConditionType: 'exits-range', rangeMin: 50, rangeMax: 10 })).toMatch(/max/i);
  });
  it('requires minutes for no-data-for', () => {
    expect(validateTriggerModel({ ruleKind: 'property', objectKey: 'k', propertyConditionType: 'no-data-for', noDataMinutes: 0 })).toMatch(/minutes/i);
  });
  it('passes a well-formed property rule and event rule', () => {
    expect(validateTriggerModel({ ruleKind: 'event' })).toBeNull();
    expect(validateTriggerModel({ ruleKind: 'property', objectKey: 'device_id', property: 'temp', propertyConditionType: 'exits-range', rangeMin: 0, rangeMax: 100 })).toBeNull();
  });
});

describe('dimension + describe', () => {
  it('exposes the object key as the alert dimension', () => {
    expect(objectKeyDimension({ objectKey: 'device_id' })).toEqual({ name: 'device_id' });
    expect(objectKeyDimension({})).toBeNull();
  });
  it('summarizes each kind for the wizard preview', () => {
    const base: TriggerModelInput = { objectKey: 'device_id', property: 'temp' };
    expect(describeTriggerModel({ ...base, ruleKind: 'property', propertyConditionType: 'no-data-for', noDataMinutes: 5 })).toMatch(/no data for 5/i);
    expect(describeTriggerModel({ ...base, ruleKind: 'split-event', operator: 'GreaterThan', value: 5 })).toMatch(/per device_id/i);
  });
});
