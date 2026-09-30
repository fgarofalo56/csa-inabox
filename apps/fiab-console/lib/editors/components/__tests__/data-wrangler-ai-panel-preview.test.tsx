/**
 * DataWranglerAiPanel — the live transform preview action.
 *
 *   - With no preview source, the Preview button stays FOCUSABLE but inert
 *     (`disabledFocusable` -> aria-disabled="true", no `disabled` attribute),
 *     and the reason is VISIBLE text on the surface, not only in the hover
 *     tooltip. The reason is the host's when one is given, otherwise the
 *     generic "select a file" reason.
 *   - A warming job is polled with POST, and the candidate code travels in the
 *     request body, never in the URL.
 *   - A poll answered with a non-2xx status (422 transform error, 502 dead
 *     session, a non-JSON gateway page) shows the reason in the Preview failed
 *     bar rather than a parse error or a generic message.
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

const SOURCE = { lakehouseId: 'lh-1', container: 'landing', path: 'lakehouses/S--lh-1/Files/a.csv' };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function renderPanel(props: Record<string, unknown>) {
  renderWithProviders(
    <DataWranglerAiPanel
      columns={['name']} rows={[[' a ']]} numericColNames={[]}
      renderResultGrid={() => <div data-testid="result-grid" />}
      {...(props as any)}
    />,
  );
}

async function showSuggestion() {
  fireEvent.click(screen.getByRole('button', { name: /Generate cleaning suggestions/ }));
  await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument());
}

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
  renderPanel(props);
  await showSuggestion();
  return mock;
}

/**
 * Kick-off answers 200 warming; the POLL answers `poll` (a real Response, so
 * its status and content-type are whatever the case needs -- installFetchMock
 * can only answer 200 JSON).
 */
async function withPollAnswer(poll: () => Response) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/lakehouse/ai-clean-suggest')) return json({ ok: true, suggestions: [SUGGESTION] });
    if (u.includes('/api/lakehouse/transform-preview')) {
      const body = JSON.parse(String(init?.body || '{}'));
      return body.jobId ? poll() : json({ ok: true, status: 'warming', jobId: 'lhjob1.handle' });
    }
    return json({ ok: true });
  }) as any);
  renderPanel({ previewSource: SOURCE });
  await showSuggestion();
  fireEvent.click(screen.getByRole('button', { name: 'Run this transform on a sample' }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/transform-preview')).length).toBe(1));
  await vi.advanceTimersByTimeAsync(2100);
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/transform-preview')).length).toBe(2));
  await waitFor(() => expect(screen.getByText('Preview failed')).toBeInTheDocument());
  return calls;
}

describe('DataWranglerAiPanel — live preview action', () => {
  it('keeps the withheld Preview focusable and shows the host reason as visible text', async () => {
    const reason = 'X-reason: this lakehouse is read-only for you.';
    const { calls } = await withSuggestion({ previewSource: null, previewUnavailableReason: reason });
    const btn = screen.getByRole('button', { name: reason });
    // Breaks if the button goes back to `disabled` (not focusable: the
    // attribute is set) or loses the aria-disabled state (clickable).
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toHaveAttribute('disabled');
    // Breaks if the reason lives only in the tooltip: the tooltip is not in
    // the DOM until hover, so the only element holding this text is the
    // visible MessageBar the button's aria-describedby points at.
    const visible = screen.getByText(reason);
    expect(visible.id).toBeTruthy();
    expect(btn.getAttribute('aria-describedby')).toContain(visible.id);
    // Breaks if a click on the inert button still posts a preview.
    fireEvent.click(btn);
    expect(calls.filter((c) => c.url.includes('/transform-preview'))).toHaveLength(0);
  });

  it('falls back to the generic reason when the host gives none, and shows it', async () => {
    await withSuggestion({ previewSource: null });
    const btn = screen.getByRole('button', { name: /select a file first/ });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    // Breaks if the fallback reason is not rendered as visible text.
    expect(screen.getByText(/select a file first/)).toBeInTheDocument();
  });

  it('shows no reason bar and an enabled Preview when a source is given', async () => {
    await withSuggestion({ previewSource: SOURCE });
    const btn = screen.getByRole('button', { name: 'Run this transform on a sample' });
    // Breaks if the gate inverts (a sourced panel rendered inert or with the bar).
    expect(btn).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText('Live preview unavailable')).toBeNull();
  });

  it('polls a warming job with POST and sends the code in the body, not the URL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = await withSuggestion({ previewSource: SOURCE });
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

  it('shows a 422 transform error from the poll as a transform error', async () => {
    await withPollAnswer(() => new Response(
      JSON.stringify({ ok: false, status: 'transform_error', error: "name 'Fx' is not defined" }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));
    // Breaks if a non-2xx poll is reported by status alone ("HTTP 422") or the
    // transform_error branch is skipped (no "Transform error:" prefix).
    expect(screen.getByText(/Transform error: name 'Fx' is not defined/)).toBeInTheDocument();
  });

  it('shows the route reason for a 502 poll', async () => {
    const msg = 'Spark session 7 is dead, so the preview could not run. Start a new preview.';
    await withPollAnswer(() => new Response(
      JSON.stringify({ ok: false, status: 'error', error: msg }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    ));
    // Breaks if a non-2xx poll body is not read (the route's reason is lost).
    expect(screen.getByText(msg)).toBeInTheDocument();
  });

  it('reports a non-JSON gateway page by status instead of a parse error', async () => {
    await withPollAnswer(() => new Response('<html>Bad Gateway</html>', {
      status: 502, headers: { 'content-type': 'text/html' },
    }));
    // Breaks if the body is parsed with a bare r.json(): the bar would show the
    // JSON SyntaxError ("Unexpected token '<'") instead of the HTTP 502 text.
    expect(screen.getByText(/The transform preview.*HTTP 502/)).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected token/)).toBeNull();
  });
});
