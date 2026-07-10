/**
 * /governance/access-requests — UX-baseline lift (Vitest, jsdom).
 *
 * Asserts the SC-6 TeachingBanner renders above the multi-tier approval inbox.
 * The inbox's real backend calls (now via clientFetch) are caught by
 * installFetchMock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import AccessRequestsPage from '../page';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AccessRequestsPage />
    </FluentProvider>,
  );
}

describe('Access requests — teaching banner', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the SC-6 teaching banner above the approval inbox', async () => {
    installFetchMock({ '/api/access-requests': () => ({ ok: true, requests: [] }) });
    mount();
    await waitFor(() => expect(screen.getByText('Approve in tier order')).toBeInTheDocument());
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
