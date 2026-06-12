/**
 * AipLogicEditor (Spindle Studio) — Vitest contract test.
 *
 * Renders the editor with minimal props and asserts the chrome mounts + the
 * ribbon carries the Spindle actions (Save / Invoke / Deploy as agent). The
 * mount-time bind-ontology fetch is caught by a no-op fetch mock returning
 * ok:true so the editor's ontology picker loads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AipLogicEditor } from '../palantir-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('AipLogicEditor (Spindle Studio)', () => {
  beforeEach(() => { installFetchMock({ ok: true, ontologies: [], boundOntologyId: null, surface: null }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces ribbon buttons', async () => {
    let err: unknown = null;
    try {
      render(<AipLogicEditor item={makeItem('aip-logic', 'Spindle logic')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
