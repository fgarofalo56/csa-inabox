/**
 * #3544 — a Power Platform / Dataverse ADMISSION refusal must render the
 * `svc-powerplatform` gate with its inline Fix-it, not a bare MessageBar.
 *
 * WHY THIS ASSERTS THE COMPONENT AND NOT ONE OF THE NINE EDITORS. Every one of
 * the nine `<ErrorBar>` sites shares this ONE component, so rendering an editor
 * would exercise its fetch plumbing and its mount-time gates — not the decision
 * under test — and a failure would not name which half broke. The editors' own
 * contract tests already cover that they mount.
 *
 * THE NEGATIVE CASE IS THE LOAD-BEARING ONE. A classifier that returned true
 * for everything would pass the positive assertion while sending an operator
 * hit by a 400 to a tenant role-grant that was never the cause — a remediation
 * the code never established (`deploy-integrity.md` R7). So the non-admission
 * error is asserted to still render the plain error bar with NO Fix-it.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ErrorBar,
  isPowerPlatformAdmissionError,
  COPILOT_STUDIO_ADMISSION_GATE_ID,
} from '../copilot-studio-editors';
import { getGate } from '@/lib/gates/registry';

/** The exact prose Dataverse/BAP return, as quoted in the registry grantNote. */
const ADMISSION_PROSE = [
  'The user is not a member of the organization.',
  'Cross-tenant access blocked by tenant isolation policy.',
  'Principal not found in the environment.',
  // Casing varies across BAP and Dataverse endpoints for the same message.
  'THE USER IS NOT A MEMBER OF THE ORGANIZATION',
];

/** Failures that are NOT an admission refusal and must NOT get a role-grant. */
const NON_ADMISSION = [
  'Bot with id 4c2a not found.',
  'Request payload is invalid: displayName is required.',
  'Too many requests. Retry after 30 seconds.',
  'Copilot Studio call failed (HTTP 502).',
];

describe('isPowerPlatformAdmissionError', () => {
  for (const msg of ADMISSION_PROSE) {
    it(`classifies as admission: ${msg.slice(0, 44)}`, () => {
      expect(isPowerPlatformAdmissionError(msg)).toBe(true);
    });
  }
  for (const msg of NON_ADMISSION) {
    it(`does NOT classify as admission: ${msg.slice(0, 44)}`, () => {
      expect(isPowerPlatformAdmissionError(msg)).toBe(false);
    });
  }
  it('treats null/empty as not an admission refusal', () => {
    expect(isPowerPlatformAdmissionError(null)).toBe(false);
    expect(isPowerPlatformAdmissionError(undefined)).toBe(false);
    expect(isPowerPlatformAdmissionError('')).toBe(false);
  });
});

describe('the gate the classifier resolves to', () => {
  it('exists in the registry and carries a role-grant Fix-it', () => {
    const gate = getGate(COPILOT_STUDIO_ADMISSION_GATE_ID);
    expect(gate, `gate '${COPILOT_STUDIO_ADMISSION_GATE_ID}' is not in the registry`).toBeTruthy();
    // A gate id the registry does not know renders HonestGate's generic bar,
    // which has no Fix-it — so the wiring would look done and do nothing.
    expect(gate!.fixit?.kind).toBe('role-grant');
  });

  it('names every Copilot Studio editor surface, with no "not yet wired" label', () => {
    const gate = getGate(COPILOT_STUDIO_ADMISSION_GATE_ID)!;
    const paths = (gate.surfaces || []).map((s: { path: string }) => s.path);
    for (const p of [
      '/items/copilot-studio-agent', '/items/copilot-knowledge', '/items/copilot-topic',
      '/items/copilot-action', '/items/copilot-channel', '/items/copilot-analytics',
      '/items/copilot-template-library',
    ]) {
      expect(paths, `${p} missing from ${COPILOT_STUDIO_ADMISSION_GATE_ID} surfaces`).toContain(p);
    }
    const labels = (gate.surfaces || []).map((s: { label?: string }) => s.label || '').join(' | ');
    expect(labels).not.toMatch(/not yet wired/i);
  });
});

describe('ErrorBar', () => {
  it('renders the gate with an inline Fix-it on an admission refusal', () => {
    render(<ErrorBar error="The user is not a member of the organization." surface="Copilot Studio topics" />);
    // The G2 control: a button that OPENS the remediation, not prose about it.
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
    // And the registry link, so the gate is discoverable from the surface.
    expect(screen.getByRole('link', { name: /gate registry/i })).toBeInTheDocument();
    // The verbatim failure is still shown — the gate does not hide the cause.
    expect(screen.getByText(/not a member of the organization/i)).toBeInTheDocument();
  });

  it('leaves a NON-admission failure as a plain error bar with no Fix-it', () => {
    render(<ErrorBar error="Request payload is invalid: displayName is required." surface="Copilot Studio topics" />);
    expect(screen.queryByRole('button', { name: /fix it/i })).toBeNull();
    expect(screen.getByText(/Copilot Studio call failed/i)).toBeInTheDocument();
    expect(screen.getByText(/displayName is required/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no error', () => {
    const { container } = render(<ErrorBar error={null} />);
    expect(container.textContent).toBe('');
  });
});
