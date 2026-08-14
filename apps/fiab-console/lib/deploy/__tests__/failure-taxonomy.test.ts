/**
 * failure-taxonomy.test.ts — the TypeScript half of the taxonomy conformance.
 *
 * Runs the TS classifier over the SAME corpus the Node classifier is run over
 * by scripts/ci/__tests__/deploy-classify.test.mjs. The two implementations
 * exist because a .mjs cannot import a .ts and the console cannot import from
 * scripts/ (its image build context is apps/fiab-console). Duplicating an
 * algorithm is exactly as dangerous as duplicating a table, so both are pinned
 * to one artifact: __fixtures__/failure-corpus.json. Either drifting turns its
 * own suite red.
 *
 * The R6/R7 assertions below are deliberately NOT a re-statement of the .mjs
 * suite's — they cover the console-facing surface (renderDiagnosis,
 * isPlatformRemediable) that CI never calls.
 */

import { describe, expect, it } from 'vitest';

import corpus from '../__fixtures__/failure-corpus.json';
import taxonomy from '../failure-taxonomy.json';
import {
  classifyDeployFailure,
  renderDiagnosis,
  isPlatformRemediable,
  isRetryableClass,
  classExitCode,
  allFailureClasses,
  type FailureClass,
} from '../failure-taxonomy';

describe('failure taxonomy — shared corpus conformance', () => {
  it('the corpus is large enough to measure something', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of corpus.cases) {
    it(`corpus: ${c.name}`, () => {
      const d = classifyDeployFailure(c.input);
      expect(d.class).toBe(c.expect.class);
      expect(d.signalId).toBe(c.expect.signalId);
      expect(d.retryable).toBe(c.expect.retryable);
    });
  }
});

describe('R7 — a diagnosis may only assert what it established', () => {
  it('carries the literal signal strings it matched, and the line each was on', () => {
    const input =
      'ERROR: Failed to schedule the task: QuotaExceeded: standardDDSv5Family Cores, Location: centralus';
    const d = classifyDeployFailure(input);
    expect(d.class).toBe('quota');
    expect(d.evidence.length).toBeGreaterThan(0);
    for (const e of d.evidence) {
      expect(input.toLowerCase()).toContain(e.signal);
      expect(e.line).toContain('QuotaExceeded');
    }
  });

  it('unknown names no cause, is not a pass, and is not `defect`', () => {
    const d = classifyDeployFailure('ERROR: (NeverSeenBefore) the frobnicator declined');
    expect(d.class).toBe('unknown');
    expect(d.signalId).toBeNull();
    expect(d.evidence).toEqual([]);
    expect(d.retryable).toBe(false);
    expect(d.remediation).toBeNull();
    expect(d.exitCode).not.toBe(0);

    const msg = renderDiagnosis(d, { step: 'provision' });
    expect(msg).toMatch(/could not classify/i);
    expect(msg).not.toMatch(/does not exist/i);
    expect(msg).not.toMatch(/not found/i);
  });

  it('an UNREACHABLE registry is never rendered as an ABSENT image', () => {
    // The exact incident deploy-integrity.md R7 was written about: a 2>/dev/null
    // turned a permission denial into an empty string and the empty string into
    // "the tag does not exist", which sent two investigations down the wrong path.
    const unreachable = classifyDeployFailure(
      'ERROR: client with IP 20.1.2.3 is not allowed access. Refer to https://aka.ms/acr/firewall',
    );
    expect(unreachable.signalId).toBe('config.acr-unreachable');
    expect(renderDiagnosis(unreachable)).not.toMatch(/tag does not exist|not in the registry/i);

    const denied = classifyDeployFailure('denied: requested access to the resource is denied');
    expect(denied.signalId).not.toBe('config.image-tag-absent');

    // Absence may be claimed ONLY when the registry actually answered.
    const answered = classifyDeployFailure('ERROR: The specified tag does not exist in the repository');
    expect(answered.signalId).toBe('config.image-tag-absent');
  });

  it('a null/undefined input is unknown, never a silent success', () => {
    expect(classifyDeployFailure(null).class).toBe('unknown');
    expect(classifyDeployFailure(undefined).class).toBe('unknown');
    expect(classifyDeployFailure('').class).toBe('unknown');
  });
});

describe('R6 — retryability is a property of the CLASS, never of the call site', () => {
  it('quota and permission are never retryable', () => {
    expect(isRetryableClass('quota')).toBe(false);
    expect(isRetryableClass('permission')).toBe(false);
    expect(isRetryableClass('config')).toBe(false);
    expect(isRetryableClass('defect')).toBe(false);
    expect(isRetryableClass('unknown')).toBe(false);
  });

  it('only genuinely transient classes are retryable', () => {
    // THE ADMISSION CRITERION, and why exactly these three meet it.
    //
    // A class may be retryable ONLY when the IDENTICAL request, unchanged, can
    // succeed later without any operator action and without any edit to the
    // template. That is the whole test: not "might eventually work if someone
    // fixes something", but "re-send the same bytes and Azure may say yes".
    //
    //   transient             — Azure was momentarily unable to serve the
    //                           request (429 / 5xx / an in-flight operation on
    //                           the same resource). Nothing is wrong with the
    //                           request at all.
    //   eventual-consistency  — the request was already correct; a principal or
    //                           resource created moments earlier has not
    //                           replicated to the service being called yet.
    //   capacity              — ADDED 2026-08-06 for `CapacityNotAvailable`,
    //                           drilled from deploy run 31100384405 (DuckLake
    //                           Postgres, Standard_B1ms, centralus). ARM's own
    //                           remediation text IS "Please retry after some
    //                           time": the SKU is offered in the region, the
    //                           subscription is under its limits, and a zone
    //                           was momentarily full. Re-sending the same
    //                           deployment can succeed with no change to
    //                           anything — which is precisely the criterion
    //                           above. Contrast the two neighbours it must not
    //                           be confused with: `quota` is a subscription
    //                           LIMIT (retrying is deterministic waste — the
    //                           2026-08-05 incident this file exists for), and
    //                           `defect` is retryable NEVER because the fault
    //                           is in Loom's own template. capacity is
    //                           retryable WITHOUT operator intervention, which
    //                           neither of those is.
    //
    // Retryable does not mean unbounded: the capacity class carries
    // defaultMaxAttempts 4 / defaultBackoffSeconds 300 / exitCode 18, and
    // deploy-retry.mjs FAILS CLOSED on budget or wall-clock exhaustion, so an
    // exhausted capacity retry still goes red (R6: "a retry that cannot fail is
    // forbidden").
    //
    // This assertion stays EXHAUSTIVE on purpose. Extending it is a deliberate
    // act that must be argued for here — the same argument the reviewer of the
    // next new class will be held to. Loosening it to `.includes()` would let a
    // class be marked retryable by accident and this file would never notice.
    const retryable = allFailureClasses().filter((c) => isRetryableClass(c));
    expect(retryable.sort()).toEqual(['capacity', 'eventual-consistency', 'transient']);
  });

  it('the rendered message names the cause the operator has to act on', () => {
    expect(renderDiagnosis(classifyDeployFailure('QuotaExceeded on the subscription'))).toMatch(/quota/i);
    expect(
      renderDiagnosis(classifyDeployFailure('ERROR: (AuthorizationFailed) the client does not have authorization')),
    ).toMatch(/role/i);
  });

  it('every class has a distinct, non-zero exit code', () => {
    const codes = allFailureClasses().map((c) => classExitCode(c));
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => c !== 0)).toBe(true);
  });
});

describe('auto-bind-by-default §5 — the platform performs what it can', () => {
  it('flags the failures CSA Loom must fix itself rather than print', () => {
    const platformFixes: [string, string][] = [
      ['ERROR: (MissingSubscriptionRegistration) not registered to use namespace', 'registration'],
      ['ERROR: (PrivateDnsZoneAlreadyExists) the zone already exists', 'config'],
      ['ERROR: (EnterpriseTenantAlreadyExists) an account already exists for this tenant', 'config'],
      ['ERROR: (VnetAddressRangeInUse) overlaps with an existing subnet', 'config'],
      ['ERROR: (PrincipalNotFound) does not exist in the directory', 'eventual-consistency'],
      // #3439: the grant is already in place under a name the template did not
      // choose. ARM enforces uniqueness on the (scope, principalId,
      // roleDefinitionId) triple, not the name, so the create is blocked
      // forever. deploy-retry --remediate now runs
      // scripts/csa-loom/converge-role-assignment.mjs and retries, instead of
      // printing an `az role assignment delete` for a human to run.
      [
        'RoleAssignmentExists: The role assignment already exists. The ID of the existing role assignment is ' +
          '0a2b7dc58eb449709418694f83a6c164.',
        'config',
      ],
    ];
    for (const [input, cls] of platformFixes) {
      const d = classifyDeployFailure(input);
      expect(d.class).toBe(cls as FailureClass);
      expect(isPlatformRemediable(d)).toBe(true);
    }
  });

  it('does NOT claim to self-heal a quota or an RBAC grant it cannot make', () => {
    expect(isPlatformRemediable(classifyDeployFailure('QuotaExceeded'))).toBe(false);
    expect(
      isPlatformRemediable(classifyDeployFailure('ERROR: (AuthorizationFailed) no authorization')),
    ).toBe(false);
  });

  it('an operator-action remediation names the exact command or portal path', () => {
    const quota = classifyDeployFailure('QuotaExceeded: standardDDSv5Family Cores');
    expect(quota.remediationKind).toBe('operator-action');
    expect(quota.portalPath).toBeTruthy();

    const rbac = classifyDeployFailure('ERROR: (AuthorizationFailed) no authorization');
    expect(rbac.remediationKind).toBe('operator-action');
    expect(rbac.grantHint).toMatch(/^az role assignment create/);
  });
});

describe('the table itself', () => {
  it('lists every signal class in classPrecedence (an unlisted class sorts LAST)', () => {
    for (const s of taxonomy.signals) {
      expect(taxonomy.classPrecedence).toContain(s.class);
      expect(Object.keys(taxonomy.classes)).toContain(s.class);
    }
  });

  it('places every NON-retryable class ahead of every retryable one', () => {
    // Ties must resolve toward FAIL FAST: calling a permanent failure transient
    // burns the whole retry budget and then reports "failed after N attempts"
    // without naming the cause — the exact 2026-08-05 quota incident.
    const classes = taxonomy.classPrecedence as FailureClass[];
    const firstRetryable = classes.findIndex((c) => isRetryableClass(c));
    const lastNonRetryable = classes.reduce((acc, c, i) => (isRetryableClass(c) ? acc : i), -1);
    expect(firstRetryable).toBeGreaterThan(lastNonRetryable);
  });

  it('has no signal that would match every input', () => {
    for (const s of taxonomy.signals) {
      const anyOf = (s as { anyOf?: string[] }).anyOf ?? [];
      const allOf = (s as { allOf?: string[] }).allOf ?? [];
      expect(anyOf.length + allOf.length).toBeGreaterThan(0);
    }
  });
});
