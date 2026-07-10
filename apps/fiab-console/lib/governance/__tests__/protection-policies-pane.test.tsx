/**
 * ProtectionPoliciesPane (UX-608) — render test for the UX-baseline lift.
 *
 * Asserts the shared SC-6 TeachingBanner and SC-4 GuidedEmptyState render when
 * the real backend returns an empty policy list (clientFetch mocked). The
 * guided empty state's launcher card must be a real, clickable control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, policies: [], labels: [] }),
  })),
}));

import { ProtectionPoliciesPane } from '../protection-policies-pane';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('ProtectionPoliciesPane UX-baseline', () => {
  it('renders the teaching banner and guided empty state on an empty backend', async () => {
    wrap(<ProtectionPoliciesPane />);
    expect(
      await screen.findByText(/Restrict labeled data to an exact allow-list/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('No protection policies yet')).toBeInTheDocument(),
    );
    // The guided launcher card is a real, focusable control.
    expect(screen.getByText('New protection policy')).toBeInTheDocument();
  });
});
