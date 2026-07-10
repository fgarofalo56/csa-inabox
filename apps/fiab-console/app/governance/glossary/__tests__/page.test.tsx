/**
 * /governance/glossary — UX-baseline lift (Vitest, jsdom).
 *
 * Asserts the SC-6 TeachingBanner renders and, when Purview is bound but no
 * terms exist yet, the SC-4 GuidedEmptyState launcher shows ("Add term" path).
 * Network is caught by installFetchMock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import GlossaryPage from '../page';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <GlossaryPage />
    </FluentProvider>,
  );
}

describe('Glossary — teaching banner + guided empty state', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the teaching banner and a guided empty state when no terms exist', async () => {
    installFetchMock({ '/api/catalog/glossary': () => ({ ok: true, terms: [] }) });
    mount();
    await waitFor(() => expect(screen.getByText('Standardize your vocabulary')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('No glossary terms yet')).toBeInTheDocument());
    // The launcher card body is unique to the guided empty state.
    expect(screen.getByText(/Name a term and write its definition/)).toBeInTheDocument();
  });
});
