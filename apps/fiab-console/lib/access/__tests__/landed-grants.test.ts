/**
 * lib/access/landed-grants — which grants a request CREATED, and keeping that
 * record across a retry. Each assertion names the defect that breaks it.
 */
import { describe, it, expect } from 'vitest';
import { grantResult, mergeGrantResults, landedGrants } from '../landed-grants';

describe('grantResult', () => {
  it('created follows preexisting; an idempotent detail is not created; unknown stays unknown', () => {
    // Breaks if `created` were inferred from the absence of "(idempotent)" alone:
    // the unknown case (no preexisting, no detail) would read `true`, and a
    // denial would revoke a role the principal may have held before.
    expect(grantResult({ status: 'active', roleAssignmentId: 'ra', preexisting: false }, 'adls-container', 'gold').created).toBe(true);
    expect(grantResult({ status: 'active', preexisting: true }, 'kql-database', 'db').created).toBe(false);
    expect(grantResult({ status: 'active', detail: 'Role already assigned at this scope (idempotent).' }, 'adls-container', 'gold').created).toBe(false);
    expect(grantResult({ status: 'active', detail: 'Granted viewers on ADX database db.' }, 'kql-database', 'db').created).toBeUndefined();
    expect(grantResult({ status: 'error', detail: 'ARM 403' }, 'adls-container', 'gold').created).toBe(false);
    // `preexisting` itself is not stored on the result.
    expect('preexisting' in grantResult({ status: 'active', preexisting: false }, 'adls-container', 'gold')).toBe(false);
  });
});

describe('mergeGrantResults', () => {
  const created = { status: 'active' as const, scopeType: 'adls-container' as const, scopeRef: 'gold', roleAssignmentId: 'ra-gold', created: true };

  it('a retry that finds the assignment in place keeps the earlier created entry', async () => {
    // Breaks if the retry's idempotent result replaces it: the role-assignment id
    // this request created would be lost, and a denial could not revoke it.
    const retry = [{ status: 'active' as const, scopeType: 'adls-container' as const, scopeRef: 'gold', detail: '(idempotent)', created: false }];
    expect(mergeGrantResults([created], retry)).toEqual([created]);
  });

  it('a new result for a scope with no earlier created entry is kept as-is', () => {
    // Pairs the test above: breaks if every retry result were replaced by an earlier one.
    const fresh = [{ status: 'error' as const, scopeType: 'adls-container' as const, scopeRef: 'silver', created: false }];
    expect(mergeGrantResults([created], fresh)).toEqual(fresh);
  });
});

describe('landedGrants', () => {
  it('keeps only active results', () => {
    // Breaks if a pending/error scope were treated as a live assignment.
    const rs = [
      { status: 'active' as const, scopeType: 'adls-container' as const, scopeRef: 'a' },
      { status: 'pending' as const, scopeType: 'adls-container' as const, scopeRef: 'b' },
      { status: 'error' as const, scopeType: 'adls-container' as const, scopeRef: 'c' },
    ];
    expect(landedGrants(rs).map((r) => r.scopeRef)).toEqual(['a']);
  });
});
