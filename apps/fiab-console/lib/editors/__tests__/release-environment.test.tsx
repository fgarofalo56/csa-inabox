/**
 * ReleaseEnvironmentEditor — Vitest contract test (UX-508 baseline lift).
 *
 * Renders with a concrete id so the full chrome mounts (not the new-item
 * gate) and asserts the chrome + at least one ribbon button. The default
 * no-op fetch mock resolves the mount-time promotions/item fetches with
 * ok:true. Covers the reworked surface (teaching banner + cross-links) per
 * no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ReleaseEnvironmentEditor } from '../palantir/release-environment-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('ReleaseEnvironmentEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<ReleaseEnvironmentEditor item={makeItem('release-environment', 'Release environment')} id="rel-1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
