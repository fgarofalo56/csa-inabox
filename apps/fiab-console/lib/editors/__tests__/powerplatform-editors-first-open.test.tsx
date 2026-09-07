/**
 * #3688 — the Power Platform family's ONE error surface must route a Dataverse
 * ADMISSION refusal to the `svc-dataverse` gate, and must not greet a freshly
 * created item with a red banner.
 *
 * THE DEFECT THESE PIN.
 *
 *   (a) `ErrorBar` in lib/editors/powerplatform-editors.tsx was a bare
 *       `<MessageBar intent="error">` reading "Power Platform error — <prose>".
 *       All six Power Platform editors funnel through it, and the single most
 *       common message it ever showed is the missing Dataverse Application User
 *       — a one-time grant the PLATFORM performs
 *       (scripts/csa-loom/dataverse-add-appuser.sh, run by the post-deploy
 *       bootstrap). Rendering that as an error with no Fix-it left the operator
 *       with prose and no route out: `ux-baseline.md` G2, and the file carried
 *       ZERO HonestGate mounts.
 *
 *   (b) `useEnvironments` auto-selects the default environment, which fires the
 *       table list immediately — so opening a BRAND NEW dataverse-table on an
 *       estate whose grant has not run yet showed a red banner before the user
 *       had touched anything. `ux-baseline.md`: "no error banners on a freshly
 *       created item; unconfigured states are guided, never red."
 *
 * WHY THIS ASSERTS THE COMPONENT, NOT AN EDITOR. All 21 `<ErrorBar>` call sites
 * share this ONE component, so rendering an editor would exercise its fetch
 * plumbing and mount-time gates instead of the decision under test, and a
 * failure would not name which half broke. Same reasoning as the #3544 sibling
 * spec next to this file.
 *
 * THE NEGATIVE CASES ARE THE LOAD-BEARING ONES. A classifier that returned true
 * for everything, or a `firstOpen` that swallowed every error, would each pass
 * the positive assertion while hiding a real failure or pointing an operator at
 * a grant that was never the cause (R7). Both are asserted against.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBar } from '../powerplatform-editors';
import { getGate } from '@/lib/gates/registry';

/** The exact prose Dataverse/BAP return for the missing Application User. */
const ADMISSION_PROSE = [
  'The user is not a member of the organization.',
  'Cross-tenant access blocked by tenant isolation policy.',
  'Principal not found in the environment.',
  'THE USER IS NOT A MEMBER OF THE ORGANIZATION',
];

/** Failures that are NOT an admission refusal and must NOT get a grant Fix-it. */
const NON_ADMISSION = [
  'Table with logical name acc0unt not found.',
  'Request payload is invalid: SchemaName is required.',
  'Too many requests. Retry after 30 seconds.',
  'Power Platform call failed (HTTP 502).',
];

/** Fluent's intent styling is class-name detail that would make this spec a
 *  snapshot of the design system. The ERROR branch is the only one that emits
 *  the title "Power Platform error", so that string IS the branch, and it is
 *  the same string the pre-fix component rendered for every message. */
const hasPlainErrorBar = () => screen.queryByText('Power Platform error') !== null;

describe('svc-dataverse is a REGISTERED gate, so the Fix-it it renders exists', () => {
  it('resolves from the gate registry', () => {
    const gate = getGate('svc-dataverse');
    expect(gate).toBeTruthy();
    expect(gate!.fixit).toBeTruthy();
  });

  it('its remediation names the script that performs THIS grant, not the sibling one', () => {
    // R7. The note used to name `grant-powerplatform-sp.sh`, which registers the
    // BAP MANAGEMENT APP — the remediation for `svc-powerplatform`. An operator
    // following it would run the wrong script and still be refused.
    const note = getGate('svc-dataverse')!.fixit.grantNote ?? '';
    expect(note).toContain('dataverse-add-appuser.sh');
  });
});

describe('an ADMISSION refusal renders the gate, not a red bar', () => {
  for (const msg of ADMISSION_PROSE) {
    it(`gates: ${msg.slice(0, 44)}`, () => {
      const { unmount } = render(<ErrorBar msg={msg} surface="Dataverse table editor" />);
      // At head this rendered "Power Platform error" with no Fix-it anywhere.
      expect(hasPlainErrorBar()).toBe(false);
      unmount();
    });
  }
});

describe('a NON-admission failure still shows the plain error bar', () => {
  for (const msg of NON_ADMISSION) {
    it(`does not gate: ${msg.slice(0, 44)}`, () => {
      // A grant Fix-it over a 404 or a 429 would send the operator at a grant
      // that was never the problem — the false-remediation class R7 forbids.
      const { unmount } = render(<ErrorBar msg={msg} />);
      expect(hasPlainErrorBar()).toBe(true);
      unmount();
    });
  }
});

describe('first open of a NEW item is guided, never red', () => {
  it('renders a warning bar instead of the error bar when firstOpen', () => {
    render(<ErrorBar msg="Power Platform is not configured." firstOpen />);
    expect(hasPlainErrorBar()).toBe(false);
    expect(screen.getByText('Not connected yet')).toBeTruthy();
  });

  it('STILL SHOWS the failure — suppressing it would be its own defect', () => {
    render(<ErrorBar msg="Power Platform is not configured." firstOpen />);
    expect(screen.getByText(/Power Platform is not configured/)).toBeTruthy();
  });

  it('reverts to the error bar once the user has acted (firstOpen false)', () => {
    // CONTROL. Without this, `firstOpen` could be hard-wired true and every
    // assertion above would still pass while the editor never showed an error.
    render(<ErrorBar msg="Power Platform is not configured." />);
    expect(hasPlainErrorBar()).toBe(true);
  });

  it('an ADMISSION refusal gates on the first-open path too', () => {
    // The guided-warning branch must not out-rank the gate: the gate IS the
    // guided state for this failure, and it is the one with a Fix-it.
    render(<ErrorBar msg="The user is not a member of the organization." firstOpen />);
    expect(screen.queryByText('Not connected yet')).toBeNull();
    expect(hasPlainErrorBar()).toBe(false);
  });
});

describe('nothing renders with no message', () => {
  it('returns null for an empty msg', () => {
    const { container } = render(<ErrorBar msg="" />);
    expect(container.textContent).toBe('');
  });
});
