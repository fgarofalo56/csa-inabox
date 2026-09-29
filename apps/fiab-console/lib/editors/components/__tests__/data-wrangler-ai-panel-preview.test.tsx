/**
 * DataWranglerAiPanel — the live transform preview action.
 *
 *   - With no preview source, the Preview button is disabled and its accessible
 *     name (Tooltip relationship="label") is the host's reason when one is given,
 *     otherwise the generic "select a file" reason.
 *   - A warming job is polled with POST, and the candidate code travels in the
 *     request body, never in the URL.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import { DataWranglerAiPanel } from '../data-wrangler-ai-panel';

const SUGGESTION = {
  id: 'sg-1', kind: 'trim', column: 'name', title: 'Trim whitespace', rationale: '', severity: 'info',
  code: 'df = df.withColumn("name", F.trim("name"))',
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function withSuggestion(props: Record<string, unknown>) {
  const mock = installFetchMock({
    '/api/lakehouse/ai-clean-suggest': () => ({ ok: true, suggestions: [SUGGESTION] }),
    '/api/lakehouse/transform-preview': (_u, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      return body.jobId
        ? { ok: true, status: 'available', jobId: body.jobId, columns: ['name'], rows: [['a']], rowCount: 1 }
        : { ok: true, status: 'warming', jobId: 'lhjob1.handle' };
    },
  });
  renderWithProviders(
    <DataWranglerAiPanel
      columns={['name']} rows={[[' a ']]} numericColNames={[]}
      renderResultGrid={() => <div data-testid="result-grid" />}
      {...(props as any)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Generate cleaning suggestions/ }));
  await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument());
  return mock;
}

describe('DataWranglerAiPanel — live preview action', () => {
  it('names the host reason when the source is withheld', async () => {
    const reason = 'Save the lakehouse first. Live preview runs on a file of a saved lakehouse.';
    await withSuggestion({ previewSource: null, previewUnavailableReason: reason });
    const btn = screen.getByRole('button', { name: reason });
    // Breaks if the reason prop is ignored (the generic "select a file" text wins).
    expect(btn).toBeDisabled();
  });

  it('falls back to the generic reason when the host gives none', async () => {
    await withSuggestion({ previewSource: null });
    expect(screen.getByRole('button', { name: /select a file first/ })).toBeDisabled();
  });

  it('polls a warming job with POST and sends the code in the body, not the URL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = await withSuggestion({
      previewSource: { lakehouseId: 'lh-1', container: 'landing', path: 'lakehouses/S--lh-1/Files/a.csv' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run this transform on a sample' }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/transform-preview')).length).toBe(1));
    await vi.advanceTimersByTimeAsync(3100);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/transform-preview')).length).toBe(2));
    const poll = calls.filter((c) => c.url.includes('/transform-preview'))[1];
    expect(poll.init?.method).toBe('POST');
    // Breaks if the poll goes back to a GET with ?code= in the query.
    expect(poll.url).not.toContain('code=');
    expect(JSON.parse(String(poll.init?.body))).toEqual({ lakehouseId: 'lh-1', jobId: 'lhjob1.handle', code: SUGGESTION.code });
  });
});
