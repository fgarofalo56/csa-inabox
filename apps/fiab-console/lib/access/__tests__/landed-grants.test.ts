/**
 * lib/access/landed-grants — which grants a request CREATED, and keeping that
 * record across a retry. Each assertion names the defect that breaks it.
 */
import { describe, it, expect } from 'vitest';
import { denialKeptWarning, grantLedgerId, grantResult, keptTail, mergeGrantResults, landedGrants } from '../landed-grants';

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

describe('what an approver is told about kept grants (A5)', () => {
  // The two audiences get DIFFERENT text, so a swap of the admin / non-admin
  // branches (the Access report offered to someone who cannot open it, and
  // withheld from the one who can) turns every equality below red.
  const kept = [{ status: 'active' as const, scopeType: 'adls-container' as const, scopeRef: 'gold', detail: 'Revoke failed: ARM 500' }];
  const recorded = [{ scopeType: 'adls-container', scopeRef: 'gold', ledgerId: grantLedgerId('req-oid', kept[0]), recorded: true }];

  it('a denial warning offers the Access report to a tenant admin only', () => {
    const list = '1 grant(s) made for this request were not revoked and remain in place: adls-container gold (Revoke failed: ARM 500)';
    expect(denialKeptWarning(kept, true)).toBe(`${list}. Review them in the Access report.`);
    expect(denialKeptWarning(kept, false)).toBe(`${list}. A tenant admin can review and remove the kept grants.`);
  });

  it('a stopped decision names the Access report as the record only when the ledger row was written', () => {
    const list = ' 1 grant(s) were not removed and remain in place: adls-container gold (Revoke failed: ARM 500).';
    expect(keptTail(kept, true, 'req-oid', recorded)).toBe(`${list} They are recorded in the Access report; review them there.`);
    expect(keptTail(kept, false, 'req-oid', recorded))
      .toBe(`${list} They are recorded in the Access report; a tenant admin can review and remove the kept grants.`);
    // Breaks if 'recorded' were read as true regardless of the row: false here.
    const unwritten = [{ ...recorded[0], recorded: false }];
    expect(keptTail(kept, true, 'req-oid', unwritten)).toBe(`${list} Review them in the Access report.`);
    expect(keptTail(kept, false, 'req-oid', unwritten)).toBe(`${list} A tenant admin can review and remove the kept grants.`);
    expect(keptTail([], true, 'req-oid', recorded)).toBe('');
  });
});
