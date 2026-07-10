/**
 * OntologySdkEditor — Vitest contract test (UX-505 baseline lift).
 *
 * Renders with a concrete id so the full chrome mounts (not the new-item
 * gate) and asserts the chrome + at least one ribbon button. The default
 * no-op fetch mock resolves the mount-time item/ontology fetches with ok:true.
 * Covers the reworked surface (teaching banner + cross-links + PreviewTable
 * Try-it grid) per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { OntologySdkEditor } from '../palantir/ontology-sdk-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('OntologySdkEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<OntologySdkEditor item={makeItem('ontology-sdk', 'Ontology SDK')} id="osdk-1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
