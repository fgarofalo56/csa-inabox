/**
 * IRM page (UX-604) — render test for the UX-baseline lift.
 *
 * The SC-6 TeachingBanner renders above the analysis toolbar regardless of the
 * backend result, teaching the reviewer to opt indicators in. clientFetch is
 * mocked so the page mounts without a live backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: 'test-stub' }),
  })),
}));

import IrmPage from '../page';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('IRM page UX-baseline', () => {
  it('renders the insider-risk teaching banner', async () => {
    wrap(<IrmPage />);
    expect(
      await screen.findByText(/Tune what counts as insider risk/),
    ).toBeInTheDocument();
  });
});
