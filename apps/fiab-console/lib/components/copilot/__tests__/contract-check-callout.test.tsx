/**
 * ContractCheckCallout (B-N14c) — the pre-apply data-contract verdict surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { ContractCheckCallout, type ContractCheckView } from '../contract-check-callout';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const BASE: ContractCheckView = {
  ok: true,
  blocked: false,
  kind: 'sql',
  contractsChecked: [{ id: 'orders', name: 'Orders contract', version: '1.0.0', mode: 'warn-quarantine' }],
  violations: [],
  note: 'Conforms to 1 governing contract(s).',
};

afterEach(cleanup);

describe('ContractCheckCallout', () => {
  it('renders nothing when no contract governs the proposal', () => {
    const { container } = wrap(<ContractCheckCallout check={{ ...BASE, contractsChecked: [], note: 'x' }} />);
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it('renders nothing for a null check', () => {
    const { container } = wrap(<ContractCheckCallout check={null} />);
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it('names the governing contract on a clean verdict', () => {
    wrap(<ContractCheckCallout check={BASE} />);
    expect(screen.getByText('Conforms to the governing data contracts')).toBeInTheDocument();
    expect(screen.getByText('Orders contract v1.0.0')).toBeInTheDocument();
  });

  it('shows the do-not-apply title when a hard-reject contract blocks', () => {
    wrap(
      <ContractCheckCallout
        check={{
          ...BASE,
          ok: false,
          blocked: true,
          note: 'BLOCKED: 1 contract error(s).',
          violations: [{ dataset: 'Orders', column: 'email', rule: 'missingColumn', severity: 'error', detail: "The contract declares 'email' but the sink has no such column." }],
        }}
      />,
    );
    expect(screen.getByText('Data contract violation — do not apply as-is')).toBeInTheDocument();
    expect(screen.getByText('1 error')).toBeInTheDocument();
  });

  it('expands the findings list on demand', () => {
    wrap(
      <ContractCheckCallout
        check={{
          ...BASE,
          violations: [{ dataset: 'Orders', column: 'email', rule: 'classifiedColumnExposed', severity: 'warning', detail: "reads 'email' classified as PII." }],
        }}
      />,
    );
    const toggle = screen.getByRole('button', { name: /Show 1 contract finding/ });
    expect(screen.queryByText(/classified as PII/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(/classified as PII/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('discloses an honest skip when the check did not run', () => {
    wrap(
      <ContractCheckCallout
        check={{ ...BASE, skipped: 'registry-unavailable', skipReason: 'The registry could not be read.' }}
      />,
    );
    expect(screen.getByText('Data contracts not checked')).toBeInTheDocument();
    expect(screen.getByText('The registry could not be read.')).toBeInTheDocument();
  });

  it('honours showSkipped=false for a dense card surface', () => {
    const { container } = wrap(
      <ContractCheckCallout
        check={{ ...BASE, skipped: 'flag-off', skipReason: 'off' }}
        showSkipped={false}
      />,
    );
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });
});
