/**
 * AskAffordance — silent-failure regression (loom-apex A3, page-errors.md #8).
 *
 * Before the fix, `await postAsk()` ran UN-TRIED: a clientFetch reject
 * (network / 20 s timeout) left `loading` stuck true — disabled input, ghost
 * "Thinking…" turn — plus an unhandled rejection beacon. This spec pins the
 * fixed behavior: the transport failure surfaces as a visible error
 * MessageBar ("Ask request failed"), the ghost turn is removed, and the
 * spinner/input are released so the user can retry their question.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { AskAffordance } from '../AskAffordance';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AskAffordance surfaceKind="warehouse" itemId="item-1" itemType="warehouse" alwaysOpen />
    </FluentProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AskAffordance transport-failure honesty (A3)', () => {
  it('surfaces a visible error and releases the spinner when postAsk rejects', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/ask')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();

    const input = screen.getByRole('textbox', { name: 'Ask a question about this data' });
    fireEvent.change(input, { target: { value: 'why is revenue down?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Honest error state, titled for transport failure (not "AI not configured").
    await waitFor(() => expect(screen.getByText('Ask request failed')).toBeInTheDocument());

    // Spinner released: the input is enabled again (loading=false)…
    expect(input).not.toBeDisabled();
    // …and the ghost "Thinking…" turn was removed.
    expect(screen.queryByText('Thinking…')).toBeNull();
  });

  it('still renders the configuration gate as a warning for a structured !ok response', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/ask')) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Azure OpenAI is not configured.', missing: 'LOOM_AOAI_ENDPOINT' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as any;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any;
    });
    mount();

    const input = screen.getByRole('textbox', { name: 'Ask a question about this data' });
    fireEvent.change(input, { target: { value: 'sum of sales' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('AI not configured')).toBeInTheDocument());
    expect(screen.getByText('Azure OpenAI is not configured.')).toBeInTheDocument();
    expect(input).not.toBeDisabled();
  });
});
