/**
 * Unit tests for the pure approval-policy + SoD engine (access-governance W2).
 */
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_STAGES, FINAL_STAGE, defaultPlan, planFromPolicy, resolveApprovalPlan,
  effectiveStages, nextStage, actorMayApprove, effectiveConflicts, evaluateSod,
} from '../approval-policy';
import type { ApprovalPolicy } from '@/lib/types/approval-policy';

const policy = (o: Partial<ApprovalPolicy>): ApprovalPolicy => ({
  id: 'p', tenantId: 't', kind: 'approval-policy', name: 'x',
  scope: { kind: 'default' }, stages: CANONICAL_STAGES.map((k) => ({ key: k, enabled: true })),
  enabled: true, createdAt: '', updatedAt: '', ...o,
});

describe('defaultPlan / planFromPolicy', () => {
  it('default plan equals the legacy 4-tier sequence', () => {
    expect(defaultPlan().stages).toEqual(CANONICAL_STAGES);
  });
  it('respects an enabled subset but always keeps the final stage, in canonical order', () => {
    const plan = planFromPolicy(policy({
      stages: [
        { key: 'manager', enabled: false },
        { key: 'privacy', enabled: false },
        { key: 'approver', enabled: true },
        { key: 'access-provider', enabled: true },
      ],
    }));
    expect(plan.stages).toEqual(['approver', 'access-provider']);
  });
  it('forces the final stage on even if a policy disables it', () => {
    const plan = planFromPolicy(policy({
      stages: [{ key: 'manager', enabled: true }, { key: 'access-provider', enabled: false }],
    }));
    expect(plan.stages[plan.stages.length - 1]).toBe(FINAL_STAGE);
  });
  it('captures named approvers per stage', () => {
    const plan = planFromPolicy(policy({
      enforceApprovers: true,
      stages: [
        { key: 'manager', enabled: true, approvers: [{ type: 'user', id: 'u1' }] },
        { key: 'access-provider', enabled: true },
      ],
    }));
    expect(plan.approvers?.manager?.[0].id).toBe('u1');
    expect(plan.enforceApprovers).toBe(true);
  });
});

describe('resolveApprovalPlan precedence', () => {
  const pkgPol = policy({ id: 'pkg', scope: { kind: 'package', ref: 'PK1' }, stages: [{ key: 'access-provider', enabled: true }] });
  const typePol = policy({ id: 'type', scope: { kind: 'resource-type', ref: 'data-product' }, stages: [{ key: 'approver', enabled: true }, { key: 'access-provider', enabled: true }] });
  const defPol = policy({ id: 'def', scope: { kind: 'default' } });
  it('package match wins over resource-type + default', () => {
    expect(resolveApprovalPlan([defPol, typePol, pkgPol], { packageId: 'PK1', itemType: 'data-product' }).policyId).toBe('pkg');
  });
  it('resource-type wins over default when no package match', () => {
    expect(resolveApprovalPlan([defPol, typePol], { itemType: 'data-product' }).policyId).toBe('type');
  });
  it('falls back to the built-in default when nothing matches or all disabled', () => {
    expect(resolveApprovalPlan([policy({ enabled: false })], {}).policyId).toBeUndefined();
    expect(resolveApprovalPlan([], {}).stages).toEqual(CANONICAL_STAGES);
  });
});

describe('effectiveStages / nextStage', () => {
  it('uses the snapshot when present, else canonical', () => {
    expect(effectiveStages({ stages: ['approver', 'access-provider'] })).toEqual(['approver', 'access-provider']);
    expect(effectiveStages(undefined)).toEqual(CANONICAL_STAGES);
  });
  it('advances and detects the final stage', () => {
    expect(nextStage(['approver', 'access-provider'], 'approver')).toBe('access-provider');
    expect(nextStage(['approver', 'access-provider'], 'access-provider')).toBeNull();
  });
});

describe('actorMayApprove', () => {
  const plan = { stages: CANONICAL_STAGES, enforceApprovers: true, approvers: { manager: [{ type: 'user' as const, id: 'u1' }] } };
  it('tenant admin always passes', () => {
    expect(actorMayApprove(plan, 'manager', 'other', true).allowed).toBe(true);
  });
  it('passes when enforcement is off or no named approvers', () => {
    expect(actorMayApprove({ stages: CANONICAL_STAGES }, 'manager', 'x', false).allowed).toBe(true);
    expect(actorMayApprove(plan, 'privacy', 'x', false).allowed).toBe(true); // no approvers named for privacy
  });
  it('allows a named user and blocks a non-approver', () => {
    expect(actorMayApprove(plan, 'manager', 'u1', false).allowed).toBe(true);
    expect(actorMayApprove(plan, 'manager', 'nope', false).allowed).toBe(false);
  });
  it('does not hard-block on a group binding (deferred to W4)', () => {
    const gplan = { stages: CANONICAL_STAGES, enforceApprovers: true, approvers: { manager: [{ type: 'group' as const, id: 'g1' }] } };
    expect(actorMayApprove(gplan, 'manager', 'x', false).allowed).toBe(true);
  });
});

describe('SoD', () => {
  const all = [
    { id: 'A', sodConflictsWith: ['B'] },
    { id: 'B', sodConflictsWith: [] as string[] },
    { id: 'C', sodConflictsWith: ['A'] },
  ];
  it('computes conflicts bidirectionally', () => {
    // A lists B; C lists A → requesting A conflicts with B and C.
    expect(effectiveConflicts('A', ['B'], all).sort()).toEqual(['B', 'C']);
  });
  it('blocks when a held package conflicts', () => {
    expect(evaluateSod(['B', 'C'], ['C'], 'block')).toEqual({ status: 'block', conflicts: ['C'] });
  });
  it('warns instead of blocking when mode is warn', () => {
    expect(evaluateSod(['B'], ['B'], 'warn').status).toBe('warn');
  });
  it('is ok when nothing held conflicts', () => {
    expect(evaluateSod(['B', 'C'], ['Z'], 'block')).toEqual({ status: 'ok', conflicts: [] });
  });
});
