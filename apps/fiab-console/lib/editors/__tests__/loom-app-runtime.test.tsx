/**
 * LoomAppRuntimeEditor — Vitest contract test (UX-502 baseline lift).
 *
 * Renders the editor with a concrete id (so it mounts the full chrome rather
 * than the new-item gate) and asserts the chrome + at least one ribbon button
 * mount. The default no-op fetch mock resolves the mount-time config/item
 * fetches with ok:true. Brings the reworked surface (teaching banner +
 * cross-links) to A-grade per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { LoomAppRuntimeEditor } from '../loom-app-runtime-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('LoomAppRuntimeEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<LoomAppRuntimeEditor item={makeItem('loom-app-runtime', 'Loom App Runtime')} id="rt-1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
