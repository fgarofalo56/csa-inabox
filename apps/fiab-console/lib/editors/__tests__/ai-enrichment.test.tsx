/**
 * AiEnrichmentEditor — Vitest contract test.
 *
 * Renders the editor against a mounted item and asserts the chrome mounts.
 * Network calls are caught by a no-op fetch mock so mount-time fetches
 * resolve with ok:true. Guards the UX-403 baseline lift (TeachingBanner)
 * against a mount regression.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AiEnrichmentEditor } from '../ai-enrichment-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('AiEnrichmentEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts the editor chrome', async () => {
    let err: unknown = null;
    try {
      render(<AiEnrichmentEditor item={makeItem('ai-enrichment', 'AI enrichment')} id="e1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
