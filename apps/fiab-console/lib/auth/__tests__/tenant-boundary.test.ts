/**
 * #3843 — the ONE implementation of the cross-tenant comparison.
 *
 * These specs exist to pin the property that every shipped hole violated: the
 * boundary must answer `unconfirmed` — NOT "no conflict" — when either side is
 * absent, and `unconfirmed` must never satisfy a grant predicate. Four separate
 * defects (#3823, #3825, #3840, #3843) were all the same truthiness-guarded
 * shape `a.tid && b.tid && a.tid !== b.tid`, which returns a value that READS
 * like enforcement and decides nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTenantMatch,
  sameTenantConfirmed,
  tenantUnconfirmedCause,
} from '../tenant-boundary';

const HOME = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '22222222-2222-2222-2222-222222222222';

describe('classifyTenantMatch — three answers, never two', () => {
  it('SAME-TENANT when both tids are known and equal', () => {
    expect(classifyTenantMatch(HOME, HOME)).toBe('same-tenant');
  });

  it('DIFFERENT-TENANT when both are known and differ', () => {
    expect(classifyTenantMatch(HOME, FOREIGN)).toBe('different-tenant');
  });

  // THE WHOLE POINT. The old shape collapsed each of these into "no conflict"
  // and fell through to the grant underneath it.
  it('UNCONFIRMED when the CALLER has no tid — not "no conflict"', () => {
    expect(classifyTenantMatch(undefined, HOME)).toBe('unconfirmed');
    expect(classifyTenantMatch(null, HOME)).toBe('unconfirmed');
    expect(classifyTenantMatch('', HOME)).toBe('unconfirmed');
    expect(classifyTenantMatch('   ', HOME)).toBe('unconfirmed');
  });

  it('UNCONFIRMED when the RESOURCE has no tid (the legacy workspace doc)', () => {
    expect(classifyTenantMatch(HOME, undefined)).toBe('unconfirmed');
    expect(classifyTenantMatch(HOME, null)).toBe('unconfirmed');
    expect(classifyTenantMatch(HOME, '')).toBe('unconfirmed');
  });

  it('UNCONFIRMED when BOTH are absent — two unknowns are not a match', () => {
    expect(classifyTenantMatch(undefined, undefined)).toBe('unconfirmed');
    expect(classifyTenantMatch('', '')).toBe('unconfirmed');
  });

  // Entra object ids are GUIDs and GUID equality is case-insensitive; refusing a
  // differently-cased spelling of the SAME tenant would be a false negative.
  it('normalises case and surrounding whitespace', () => {
    expect(classifyTenantMatch(HOME.toUpperCase(), HOME)).toBe('same-tenant');
    expect(classifyTenantMatch(` ${HOME} `, HOME)).toBe('same-tenant');
    expect(classifyTenantMatch(HOME.toUpperCase(), FOREIGN)).toBe('different-tenant');
  });
});

describe('sameTenantConfirmed — the predicate a GRANT may depend on', () => {
  it('TRUE only on a positive match', () => {
    expect(sameTenantConfirmed(HOME, HOME)).toBe(true);
  });

  it('FALSE on a measured mismatch', () => {
    expect(sameTenantConfirmed(HOME, FOREIGN)).toBe(false);
  });

  // FAIL CLOSED. Each of these is a documented, supported state in this product
  // (a pre-rel-T11 workspace doc has no `tid`; `UserClaims.tid` is optional), and
  // each of them used to fall THROUGH into a tenant-wide admin grant.
  it('FALSE — never a fall-through — when the caller tid is missing', () => {
    expect(sameTenantConfirmed(undefined, HOME)).toBe(false);
  });

  it('FALSE — never a fall-through — when the resource tid is missing', () => {
    expect(sameTenantConfirmed(HOME, undefined)).toBe(false);
  });

  it('FALSE when both are missing', () => {
    expect(sameTenantConfirmed(undefined, undefined)).toBe(false);
  });

  // A behavioural restatement of the same property, written the way the defect
  // was written, so a reader comparing the two shapes can see them diverge.
  it('DIVERGES from the truthiness-guarded shape exactly where the holes were', () => {
    const oldShape = (callerTid?: string, docTid?: string) =>
      !(callerTid && docTid && docTid !== callerTid); // "not refused" == granted
    for (const [caller, doc] of [
      [undefined, HOME],
      [HOME, undefined],
      [undefined, undefined],
    ] as [string | undefined, string | undefined][]) {
      expect(oldShape(caller, doc)).toBe(true); // the old code GRANTED here
      expect(sameTenantConfirmed(caller, doc)).toBe(false); // this one refuses
    }
    // …and agrees everywhere the old shape actually decided something.
    expect(oldShape(HOME, HOME)).toBe(sameTenantConfirmed(HOME, HOME));
    expect(oldShape(HOME, FOREIGN)).toBe(sameTenantConfirmed(HOME, FOREIGN));
  });
});

describe('tenantUnconfirmedCause — says what was observed, never more (R7)', () => {
  it('names the caller-side absence', () => {
    expect(tenantUnconfirmedCause(undefined, HOME)).toContain('no `tid` claim');
  });

  it('names the record-side absence', () => {
    expect(tenantUnconfirmedCause(HOME, undefined)).toContain('does not state which Entra tenant');
  });

  it('names BOTH when both hold', () => {
    const cause = tenantUnconfirmedCause(undefined, undefined) ?? '';
    expect(cause).toContain('no `tid` claim');
    expect(cause).toContain('does not state which Entra tenant');
  });

  it('is null when there is nothing to explain', () => {
    expect(tenantUnconfirmedCause(HOME, HOME)).toBeNull();
    // A measured mismatch is a refusal the CALLER words — this must not leak
    // which other tenant owns the record.
    expect(tenantUnconfirmedCause(HOME, FOREIGN)).toBeNull();
  });
});
