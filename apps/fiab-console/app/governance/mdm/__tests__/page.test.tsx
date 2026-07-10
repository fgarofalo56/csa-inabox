/**
 * MDM page (UX-603) — render test for the UX-baseline lift.
 *
 * Asserts the SC-6 TeachingBanner renders above the tab strip, and the SC-4
 * GuidedEmptyState shows on the Models tab when the backend returns no models.
 * clientFetch is mocked to an empty models list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, models: [] }),
  })),
}));

import GovernanceMdmPage from '../page';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('MDM page UX-baseline', () => {
  it('renders the MDM teaching banner and guided empty state', async () => {
    wrap(<GovernanceMdmPage />);
    expect(
      await screen.findByText(/How master data management builds a golden record/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Define your first golden-record model')).toBeInTheDocument(),
    );
  });
});
