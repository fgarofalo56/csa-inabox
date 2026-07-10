/**
 * /governance/data-quality — UX-baseline lift (Vitest, jsdom).
 *
 * Asserts the SC-6 TeachingBanner renders and, when the rule store is empty,
 * the Rules tab shows the SC-4 GuidedEmptyState launcher (not a bare table
 * empty string). Network is caught by installFetchMock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import DataQualityPage from '../page';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <DataQualityPage />
    </FluentProvider>,
  );
}

describe('Data quality — teaching banner + guided empty state', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the teaching banner and a guided empty state when no rules exist', async () => {
    installFetchMock({ '/api/dq/rules': () => ({ ok: true, rules: [] }) });
    mount();
    await waitFor(() => expect(screen.getByText('Author, run, then enforce')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('No data-quality rules yet')).toBeInTheDocument());
    // The launcher card runs a real path (opens the New-rule dialog); its body
    // copy is unique to the guided empty state.
    expect(screen.getByText(/Define a not-null, unique, range, regex/)).toBeInTheDocument();
  });
});
