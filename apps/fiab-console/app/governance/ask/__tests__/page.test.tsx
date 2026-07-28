/**
 * /governance/ask (B-N14b) — render + behaviour test for the NL governance
 * copilot surface.
 *
 * Asserts the three states that matter for the honesty contract:
 *   1. a guided empty state before any question is asked (never a bare div),
 *   2. an ANSWERED state that renders the cited policy paths, and
 *   3. a REFUSED state that shows the missing-evidence note and NO answer body.
 *
 * clientFetch is mocked — this is a surface test, not a backend test (the
 * retrieval + refusal rules are covered by lib/governance/__tests__).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetch = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => clientFetch(...a) }));

import GovernanceAskPage from '../page';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const BASE = {
  ok: true,
  question: 'Who can read PII in EU?',
  citations: [],
  kindsTouched: [],
  graphSize: 12,
  scanned: 12,
  unavailable: [],
  durationMs: 42,
  graphMs: 12,
};

beforeEach(() => clientFetch.mockReset());
afterEach(cleanup);

describe('/governance/ask', () => {
  it('shows a guided empty state before the first question', () => {
    wrap(<GovernanceAskPage />);
    expect(screen.getByText('Ask your first governance question')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  it('renders the answer with its cited policy paths', async () => {
    clientFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        ...BASE,
        answer: 'alice@contoso.com can read Orders.email [path 1].',
        refused: false,
        citations: [{ id: 'p1', hops: 3, text: 'alice@contoso.com (principal) —[HOLDS]→ Reader (grant) —[GRANTS]→ Orders (asset)' }],
        kindsTouched: ['asset', 'grant', 'principal'],
      }),
    });
    wrap(<GovernanceAskPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Who can read PII in EU?' }));
    await waitFor(() =>
      expect(screen.getByText(/alice@contoso.com can read Orders.email/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Policy paths cited/)).toBeInTheDocument();
    expect(screen.getByText(/—\[HOLDS\]→ Reader \(grant\)/)).toBeInTheDocument();
    expect(screen.getByText('1 cited path')).toBeInTheDocument();
  });

  it('renders the refusal with the missing-evidence note and no answer body', async () => {
    clientFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        ...BASE,
        answer: '',
        refused: true,
        refusalReason: 'no-path',
        note: 'No policy edge connects Email to the European Union.',
      }),
    });
    wrap(<GovernanceAskPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Who can read PII in EU?' }));
    await waitFor(() =>
      expect(screen.getByText('No policy edge connects Email to the European Union.')).toBeInTheDocument(),
    );
    expect(screen.getByText('The policy graph cannot support an answer')).toBeInTheDocument();
    expect(screen.getByText('Refused')).toBeInTheDocument();
  });

  it('discloses a partially-readable governance estate', async () => {
    clientFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        ...BASE,
        answer: 'Two principals hold read grants [path 1].',
        refused: false,
        citations: [{ id: 'p1', hops: 2, text: 'a (principal) —[HOLDS]→ b (grant)' }],
        unavailable: [{ source: 'access-assignment ledger', reason: 'Cosmos timeout' }],
      }),
    });
    wrap(<GovernanceAskPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Who can read PII in EU?' }));
    await waitFor(() =>
      expect(screen.getByText('This answer is based on incomplete governance data')).toBeInTheDocument(),
    );
    expect(screen.getByText(/access-assignment ledger: Cosmos timeout/)).toBeInTheDocument();
  });
});
