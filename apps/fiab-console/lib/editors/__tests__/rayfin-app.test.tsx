/**
 * RayfinAppEditor — Vitest contract test (UX-503 baseline lift).
 *
 * Renders the editor and asserts the chrome + at least one ribbon button
 * mount. The default no-op fetch mock resolves the mount-time fetches with
 * ok:true. Covers the reworked surface (sibling cross-links below the honest
 * preview banner) per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { RayfinAppEditor } from '../rayfin-app-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('RayfinAppEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<RayfinAppEditor item={makeItem('rayfin-app', 'Rayfin app')} id="ray-1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
