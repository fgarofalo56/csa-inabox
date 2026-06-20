/**
 * Unit tests for the server-side pipeline structural validator that backs the
 * data-pipeline + adf-pipeline /validate BFF routes (no-vaporware.md: Validate
 * performs a real server-side computation, not a client-only check, and not an
 * ADF REST call that does not exist).
 */
import { describe, it, expect } from 'vitest';
import { validatePipelineSpec } from '../pipeline-validate';

describe('validatePipelineSpec', () => {
  it('passes a well-formed pipeline', () => {
    const r = validatePipelineSpec({
      name: 'p',
      properties: {
        activities: [
          { name: 'Copy1', type: 'Copy' },
          { name: 'Notebook1', type: 'DatabricksNotebook', dependsOn: [{ activity: 'Copy1', dependencyConditions: ['Succeeded'] }] },
        ],
        parameters: { src: { type: 'string' } },
        variables: { counter: { type: 'String' } },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.activities).toHaveLength(2);
  });

  it('flags a missing activities array', () => {
    const r = validatePipelineSpec({ properties: {} as any });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'MISSING_ACTIVITIES')).toBe(true);
  });

  it('flags duplicate activity names', () => {
    const r = validatePipelineSpec({
      properties: { activities: [{ name: 'A', type: 'Wait' }, { name: 'A', type: 'Wait' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'DUPLICATE_ACTIVITY_NAME')).toBe(true);
  });

  it('flags missing type and missing name', () => {
    const r = validatePipelineSpec({
      properties: { activities: [{ name: 'A' }, { type: 'Wait' }] },
    });
    expect(r.issues.some((i) => i.code === 'MISSING_ACTIVITY_TYPE')).toBe(true);
    expect(r.issues.some((i) => i.code === 'MISSING_ACTIVITY_NAME')).toBe(true);
  });

  it('flags a dependsOn that references a non-existent activity', () => {
    const r = validatePipelineSpec({
      properties: { activities: [{ name: 'B', type: 'Wait', dependsOn: [{ activity: 'Ghost', dependencyConditions: ['Succeeded'] }] }] },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'UNRESOLVED_DEPENDENCY')).toBe(true);
  });

  it('flags an invalid dependency condition', () => {
    const r = validatePipelineSpec({
      properties: { activities: [
        { name: 'A', type: 'Wait' },
        { name: 'B', type: 'Wait', dependsOn: [{ activity: 'A', dependencyConditions: ['Sometimes'] }] },
      ] },
    });
    expect(r.issues.some((i) => i.code === 'INVALID_DEPENDENCY_CONDITION')).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const r = validatePipelineSpec({
      properties: { activities: [
        { name: 'A', type: 'Wait', dependsOn: [{ activity: 'B', dependencyConditions: ['Succeeded'] }] },
        { name: 'B', type: 'Wait', dependsOn: [{ activity: 'A', dependencyConditions: ['Succeeded'] }] },
      ] },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'DEPENDENCY_CYCLE')).toBe(true);
  });

  it('flags an undeclared @pipeline().parameters reference as an error', () => {
    const r = validatePipelineSpec({
      properties: { activities: [
        { name: 'W', type: 'Wait', typeProperties: { waitTimeInSeconds: "@pipeline().parameters.delaySeconds" } },
      ] },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'UNDECLARED_PARAMETER')).toBe(true);
  });

  it('warns (but does not fail) on an undeclared variable reference', () => {
    const r = validatePipelineSpec({
      properties: { activities: [
        { name: 'Set1', type: 'SetVariable', typeProperties: { variableName: 'missingVar', value: 'x' } },
      ] },
    });
    expect(r.ok).toBe(true); // warnings don't fail
    expect(r.issues.some((i) => i.code === 'UNDECLARED_VARIABLE' && i.severity === 'warning')).toBe(true);
  });

  it('walks nested control-flow activities (ForEach / If)', () => {
    const r = validatePipelineSpec({
      properties: { activities: [
        { name: 'Loop', type: 'ForEach', typeProperties: { activities: [
          { name: 'Inner', type: 'Wait' },
          { name: 'Inner', type: 'Wait' }, // duplicate within nested scope
        ] } },
      ] },
    });
    expect(r.activities.map((a) => a.name)).toContain('Inner');
    expect(r.issues.some((i) => i.code === 'DUPLICATE_ACTIVITY_NAME')).toBe(true);
  });

  it('accepts a bare properties object (no wrapper)', () => {
    const r = validatePipelineSpec({ activities: [{ name: 'A', type: 'Wait' }] } as any);
    expect(r.ok).toBe(true);
    expect(r.activities).toHaveLength(1);
  });
});
