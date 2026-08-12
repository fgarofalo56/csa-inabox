/**
 * #3175 — `session.claims.groups` was DECLARED on UserClaims, READ in six
 * places, and WRITTEN nowhere. It was permanently `undefined`, so every
 * group-based authorization path in Loom was dead:
 *
 *   - tenant admin by group could never succeed (only LOOM_TENANT_ADMIN_OID)
 *   - capability grants made to a group never matched
 *   - item ACLs granted to a group never matched
 *
 * The operator hit it as `Failed to load the admin overview: forbidden` while
 * being a member of the configured admin group.
 *
 * This is the "declared, consumed, never produced" shape, and the reason it
 * survived is that nothing asserted the PRODUCER. Type-checking cannot: the
 * field is optional, so omitting it is legal TypeScript. So these tests assert
 * the extraction directly.
 *
 * The undefined-vs-empty distinction below is the substance, not pedantry:
 * `groupsClaimUnavailable()` in lib/auth/domain-role.ts treats empty-or-absent
 * as "ask Graph". Returning `[]` when Entra told us nothing would assert
 * "this user is in no groups" — a claim the code never established — and would
 * suppress the Graph fallback that is the ONLY correct answer for the >200-group
 * overage case.
 */
import { describe, it, expect } from 'vitest';
import { groupsFromIdToken } from '../route';

describe('groupsFromIdToken (#3175)', () => {
  it('copies the groups claim off the id token', () => {
    expect(groupsFromIdToken({ groups: ['716f5ec5-aaaa-bbbb-cccc-000000000001'] }))
      .toEqual(['716f5ec5-aaaa-bbbb-cccc-000000000001']);
  });

  it('copies every group, not just the first', () => {
    const ids = ['g-1', 'g-2', 'g-3'];
    expect(groupsFromIdToken({ groups: ids })).toEqual(ids);
  });

  it('returns UNDEFINED (never []) when the token carries no groups claim', () => {
    // Absent must stay distinguishable from "in no groups", or the Graph
    // fallback is suppressed and the overage case resolves wrongly.
    expect(groupsFromIdToken({ oid: 'x', tid: 'y' })).toBeUndefined();
    expect(groupsFromIdToken(undefined)).toBeUndefined();
  });

  it('returns UNDEFINED for the Entra group-OVERAGE shape', () => {
    // Past ~200 groups Entra drops the inline claim and sends these instead.
    // Concluding "no groups" here would deny a user who is in 200+ groups —
    // including, plausibly, an admin.
    const overage = {
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' } },
    };
    expect(groupsFromIdToken(overage)).toBeUndefined();
  });

  it('returns UNDEFINED for an empty array', () => {
    expect(groupsFromIdToken({ groups: [] })).toBeUndefined();
  });

  it('ignores a non-array groups claim rather than throwing', () => {
    expect(groupsFromIdToken({ groups: 'not-an-array' })).toBeUndefined();
    expect(groupsFromIdToken({ groups: null })).toBeUndefined();
  });

  it('coerces to strings and drops empties', () => {
    expect(groupsFromIdToken({ groups: ['a', '', 'b'] })).toEqual(['a', 'b']);
  });
});
