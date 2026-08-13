/**
 * REGRESSION GUARD — approving an access request must never grant tenant admin.
 *
 * THE DEFECT (found 2026-08-13 while researching the access-management design).
 * `onboardingGroupId()` read:
 *
 *     LOOM_ONBOARDING_ENTRA_GROUP_ID || LOOM_TENANT_ADMIN_GROUP_ID
 *
 * `LOOM_ONBOARDING_ENTRA_GROUP_ID` is set by NO bicep module, param file or
 * workflow — measured, `grep -rn … platform/fiab/bicep .github/workflows` returns
 * 0. So the first operand was ALWAYS empty and the fallback was unconditional:
 * approving an access request added the requester to the group `isTenantAdmin()`
 * keys on. Both `create-user` and `invite-guest` call it, and the Console UAMI
 * holds `GroupMember.ReadWrite.All`, so the write would have succeeded.
 *
 * It never fired only because the path had not been used successfully yet. That
 * is luck, and luck is not a control.
 *
 * WHY THIS GUARD IS SHAPED THIS WAY: it asserts on the FUNCTION's return value
 * under the exact environment that produced the bug (onboarding unset, admin
 * group set), rather than grepping for the `||` — a future refactor that keeps
 * the escalation but rewrites the expression would slip past a text match, and
 * this will not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onboardingGroupId } from '../provision';

const ONBOARDING = 'LOOM_ONBOARDING_ENTRA_GROUP_ID';
const ADMIN = 'LOOM_TENANT_ADMIN_GROUP_ID';

const ADMIN_GROUP = '11111111-1111-1111-1111-111111111111';
const ONBOARDING_GROUP = '22222222-2222-2222-2222-222222222222';

describe('onboardingGroupId — never escalates to the tenant-admin group', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved[ONBOARDING] = process.env[ONBOARDING];
    saved[ADMIN] = process.env[ADMIN];
    // Silence the deliberate operator warning; the warning itself is asserted below.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('EXACT REGRESSION: onboarding unset + admin group set must NOT return the admin group', () => {
    delete process.env[ONBOARDING];
    process.env[ADMIN] = ADMIN_GROUP;

    const got = onboardingGroupId();

    // This is the whole point. Before the fix this returned ADMIN_GROUP, and the
    // caller then added the approved requester to it via GroupMember.ReadWrite.All.
    expect(got).not.toBe(ADMIN_GROUP);
    expect(got).toBeUndefined();
  });

  it('returns the onboarding group when it IS configured', () => {
    process.env[ONBOARDING] = ONBOARDING_GROUP;
    process.env[ADMIN] = ADMIN_GROUP;
    expect(onboardingGroupId()).toBe(ONBOARDING_GROUP);
  });

  it('an empty / whitespace onboarding value is treated as unset, not as a group id', () => {
    process.env[ONBOARDING] = '   ';
    process.env[ADMIN] = ADMIN_GROUP;
    expect(onboardingGroupId()).toBeUndefined();
  });

  it('with neither set it returns undefined rather than an empty string', () => {
    delete process.env[ONBOARDING];
    delete process.env[ADMIN];
    // An empty string is falsy but is NOT a valid group id; callers branch on
    // undefined, so returning '' would be a different bug.
    expect(onboardingGroupId()).toBeUndefined();
  });

  it('TELLS the operator why no group was granted — a silent skip is its own defect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env[ONBOARDING];
    process.env[ADMIN] = ADMIN_GROUP;

    onboardingGroupId();

    expect(warn).toHaveBeenCalled();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain(ONBOARDING);
    // It must name the escalation it is refusing, not just say "not set".
    expect(said).toContain(ADMIN);
  });

  it('NEGATIVE CONTROL: the admin group id used here is one the fixture would surface if leaked', () => {
    // Guards against a future refactor that makes every assertion vacuous by
    // returning undefined unconditionally: prove the function CAN return a value.
    process.env[ONBOARDING] = ADMIN_GROUP;
    expect(onboardingGroupId()).toBe(ADMIN_GROUP);
  });
});
