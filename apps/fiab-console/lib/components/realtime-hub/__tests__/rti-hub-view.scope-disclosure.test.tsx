/**
 * RtiHubView — scope-disclosure render test (audit-T35).
 *
 * Asserts the persistent "Real-time scope" honest-gap MessageBar renders
 * UNCONDITIONALLY — i.e. before any /api/rti-hub or /api/loom/workspaces fetch
 * resolves, and regardless of session/config state. This is the on-surface
 * disclosure required so no vaporware claim is implied about a Phonograph-style
 * sub-100 ms transactional object store or live ontology writeback.
 *
 * Per no-vaporware.md this test exercises only the real render path; it does
 * not fake backend behavior. fetch is stubbed to never resolve so we prove the
 * disclosure is independent of the data load (it is part of the static surface,
 * not gated behind a successful response).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { RtiHubView } from '../rti-hub-view';

describe('RtiHubView — Real-time scope disclosure (audit-T35)', () => {
  beforeEach(() => {
    // fetch never resolves: the disclosure must render during the loading
    // state, proving it is not gated behind a successful backend response.
    vi.spyOn(global, 'fetch').mockImplementation(
      () => new Promise(() => { /* pending forever */ }) as Promise<Response>,
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the persistent by-design scope MessageBar before data loads', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <RtiHubView />
      </FluentProvider>,
    );

    // Title is always present.
    expect(screen.getByText('Real-time scope')).toBeInTheDocument();

    // Body conveys the three honest gaps: not a Phonograph sub-100ms object
    // store, no live writeback, IL6 out of scope.
    const phonograph = screen.getByText(/Palantir Phonograph-style sub-100/i);
    expect(phonograph).toBeInTheDocument();
    const body = phonograph.closest('div')?.textContent ?? '';
    expect(body).toMatch(/analytics/i);
    expect(body).toMatch(/writeback/i);
    expect(body).toMatch(/Power ?Apps \+ SQL-endpoint/i);
    expect(body).toMatch(/IL6/);
    expect(body).toMatch(/ADR-0001/);
  });
});
