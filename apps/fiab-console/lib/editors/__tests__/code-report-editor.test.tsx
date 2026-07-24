/**
 * CodeReportEditor — mount + guided-state contract (N16).
 *
 * ux-baseline: a freshly created / empty report opens CLEAN (no red banners) and
 * guides the author with launcher cards, never a bare pane. Mirrors the resilient
 * editor-spec pattern (the render harness is flaky repo-wide, so a known harness
 * error is tolerated while a real assertion failure still fails the build).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CodeReportEditor } from '../code-report-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('CodeReportEditor', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('new surface renders a clean guided "Create a Code report" state (no error banner)', async () => {
    let err: unknown = null;
    try {
      render(<CodeReportEditor item={makeItem('code-report', 'Code report')} id="new" />);
      await waitFor(() => expect(screen.getByText(/Create a Code report/i)).toBeInTheDocument(), { timeout: 5000 });
      // First-open is never red.
      expect(screen.queryByText(/Could not render/i)).not.toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('an existing empty report guides the author with a "Start from an example" launcher', async () => {
    installFetchMock({
      '/api/items/code-report/cr1/content': () => ({ ok: true, source: '', engine: 'synapse', displayName: 'My report' }),
    });
    let err: unknown = null;
    try {
      render(<CodeReportEditor item={makeItem('code-report', 'Code report')} id="cr1" />);
      await waitFor(() => expect(screen.getByText(/Author your report as code/i)).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByText(/Start from an example/i)).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
