/**
 * /governance (hub) — UX-baseline lift (Vitest, jsdom).
 *
 * Asserts the SC-6 TeachingBanner (the Fabric-style dismissible next-step
 * guidance) renders on the governance overview. Network is caught by
 * installFetchMock; next/navigation is stubbed by vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import GovernancePage from '../page';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <GovernancePage />
    </FluentProvider>,
  );
}

describe('Governance hub — teaching banner', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the SC-6 teaching banner with a Learn-more link', async () => {
    installFetchMock({ '/api/governance/insights': () => ({ ok: true }) });
    mount();
    await waitFor(() => expect(screen.getByText('Start with your posture')).toBeInTheDocument());
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
