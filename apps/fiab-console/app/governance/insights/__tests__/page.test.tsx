/**
 * /governance/insights — UX-baseline lift (Vitest, jsdom).
 *
 * Asserts the SC-6 TeachingBanner renders on the insights dashboard. Network
 * is caught by installFetchMock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import InsightsPage from '../page';

const INSIGHTS = {
  ok: true,
  kpis: {
    totalItems: 3, sensitiveCoveragePct: 50, classificationCoveragePct: 40,
    ownershipCoveragePct: 30, endorsementCoveragePct: 20, complianceScorePct: 60,
    activePolicies: 2, auditEvents30d: 9,
  },
  coverage: [], topClassified: [], policies: [],
};

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <InsightsPage />
    </FluentProvider>,
  );
}

describe('Insights — teaching banner', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the SC-6 teaching banner', async () => {
    installFetchMock({ '/api/governance/insights': () => INSIGHTS });
    mount();
    await waitFor(() => expect(screen.getByText('Close the coverage gaps')).toBeInTheDocument());
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
