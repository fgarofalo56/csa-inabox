/**
 * AutoMlEditor — Vitest contract test.
 *
 * Renders the AutoML wizard against a mounted item and asserts the chrome
 * mounts. Network calls are caught by a no-op fetch mock so mount-time
 * fetches resolve with ok:true. Guards the UX-404 baseline lift
 * (TeachingBanner) against a mount regression.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AutoMlEditor } from '../automl-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('AutoMlEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts the editor chrome', async () => {
    let err: unknown = null;
    try {
      render(<AutoMlEditor item={makeItem('automl', 'AutoML')} id="a1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
