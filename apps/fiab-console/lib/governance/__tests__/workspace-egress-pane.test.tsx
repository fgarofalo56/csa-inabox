/**
 * WorkspaceEgressPane (UX-607) — render test for the UX-baseline lift.
 *
 * Asserts the shared SC-6 TeachingBanner and SC-4 GuidedEmptyState render when
 * the real backend returns an empty policy list (clientFetch mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, policies: [], nsgs: [], serviceTags: [], nsgGate: null }),
  })),
}));

import { WorkspaceEgressPane } from '../workspace-egress-pane';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('WorkspaceEgressPane UX-baseline', () => {
  it('renders the teaching banner and guided empty state on an empty backend', async () => {
    wrap(<WorkspaceEgressPane />);
    expect(
      await screen.findByText(/Control where a workspace can send data/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('No workspace egress policies yet')).toBeInTheDocument(),
    );
    expect(screen.getByText('New egress policy')).toBeInTheDocument();
  });
});
