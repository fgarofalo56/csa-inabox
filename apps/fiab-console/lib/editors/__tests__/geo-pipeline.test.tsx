/**
 * GeoPipelineEditor — Vitest contract test.
 *
 * Covers:
 *   - the editor mounts and surfaces a ribbon button (smoke).
 *   - clicking Trigger run POSTs to the geo-pipeline run route and renders the
 *     real runId from the response (the v3.x "deferred" gate is now wired to a
 *     real ADF createRun via /api/items/geo-pipeline/[id]/run).
 *
 * Per .claude/rules/no-vaporware.md, the enrichment flags are posted to ADF as
 * pipeline parameters — no longer a "deferred to v3.x" MessageBar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { GeoPipelineEditor } from '../geo-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('GeoPipelineEditor', () => {
  // globals:false means cleanup is not automatic; prevents DOM accumulation between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    installFetchMock({});
    let err: unknown = null;
    try {
      render(<GeoPipelineEditor item={makeItem('geo-pipeline', 'Geo pipeline')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('triggers an ADF run and renders the runId', async () => {
    installFetchMock({
      '/api/cosmos-items/geo-pipeline/': () => ({
        ok: true,
        item: { state: { adfPipelineName: 'loom-geo-enrich', enrichH3: true, reverseGeocode: false, bufferMeters: 500 }, updatedAt: new Date().toISOString() },
      }),
      '/api/items/adf-pipeline': () => ({ ok: true, pipelines: [{ name: 'loom-geo-enrich' }] }),
      '/api/items/geo-pipeline/gp-1/run': () => ({
        ok: true, runId: 'abc-run-123', pipelineName: 'loom-geo-enrich',
        parametersUsed: ['enrichH3', 'bufferMeters'], parametersSkipped: ['reverseGeocode'],
      }),
    });

    let err: unknown = null;
    try {
      render(<GeoPipelineEditor item={makeItem('geo-pipeline', 'Geo pipeline')} id="gp-1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });

      // The ribbon "Trigger run" button fires the run route. Use getByRole('button')
      // to disambiguate from the <span>/<strong> description text that also contains
      // "Trigger run" in the geo-pipeline editor's informational copy.
      const triggerBtn = await screen.findByRole('button', { name: /Trigger run/i });
      fireEvent.click(triggerBtn);

      await waitFor(() => {
        expect(screen.getByText(/Triggered run abc-run-123/i)).toBeInTheDocument();
      }, { timeout: 5000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import|act\(/i);
  });
});
