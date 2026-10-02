/**
 * AiFunctionsHelper — an unsaved item opens as guidance, not as a failure.
 *
 * The route answers a POST for `/items/<type>/new` with 200
 * `{ ok:false, code:'unsaved_item' }` (route.ts `unsavedItemGate`). The helper
 * must render that as a warning titled "Save this item first", never as the
 * red "AI function failed" bar: a freshly created item must not open red
 * (ux-baseline.md item 6).
 *
 * What breaks these tests:
 *   - the helper's `j.code === 'unsaved_item'` branch removed: the coded reply
 *     falls into the generic `!j.ok` branch, "AI function failed" renders and
 *     "Save this item first" does not (first test goes red on both asserts);
 *   - the branch widened to every `!j.ok` reply: the positive control below
 *     shows "Save this item first" for an ordinary failure and goes red.
 * The positive control (an ordinary failure still renders the error bar) is
 * what keeps the first test from being satisfied by a helper that never shows
 * an error at all.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import { AiFunctionsHelper } from '../ai-functions-helper';

// `MessageBar`'s `intent` prop is not itself text in the DOM — without this
// pass-through, a test can find the title/body strings while the bar renders
// red (`intent="error"`) instead of amber, and still go green. Mirrored from
// the warning the round-4 review measured: `findByText` alone cannot
// distinguish the two intents.
vi.mock('@fluentui/react-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluentui/react-components')>();
  const MessageBar = (props: React.ComponentProps<typeof actual.MessageBar>) => (
    <actual.MessageBar {...props} data-intent={props.intent ?? 'info'} />
  );
  return { ...actual, MessageBar };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PROBE = { ok: true, engine: 'notebook', govPath: false, dbxAvailable: true, gated: false };

function renderHelper(itemId: string) {
  renderWithProviders(
    <AiFunctionsHelper
      open
      onOpenChange={() => {}}
      itemType="notebook"
      itemId={itemId}
      warehouseId="wh1"
      table="main.s.t"
      columns={['txt']}
    />,
  );
}

async function clickRun() {
  const run = await screen.findByRole('button', { name: /^Run$/ });
  // The button is disabled while the boundary probe is in flight.
  await waitFor(() => expect(run).not.toBeDisabled());
  fireEvent.click(run);
}

describe('AiFunctionsHelper: the unsaved-item reply', () => {
  it("renders 'Save this item first' as a warning, not 'AI function failed'", async () => {
    const { calls } = installFetchMock({
      '/ai-function?probe=1': () => PROBE,
      '/ai-function': () => ({
        ok: false,
        code: 'unsaved_item',
        error: 'AI functions run in the name of a saved item.',
      }),
    });
    renderHelper('new');
    await clickRun();

    const title = await screen.findByText('Save this item first');
    expect(title).toBeInTheDocument();
    // What breaks this: `intent="warning"` changed to `intent="error"` on the
    // unsaved notice (`ai-functions-helper.tsx`) — the title text alone does
    // not change, only the bar's color/role, so only the intent attribute
    // catches it.
    expect(title.closest('[data-intent]')?.getAttribute('data-intent')).toBe('warning');
    expect(screen.getByText(/AI functions run in the name of a saved item\./)).toBeInTheDocument();
    expect(screen.queryByText('AI function failed')).toBeNull();
    // The POST was made (the warning is the route's answer, not a client-side
    // short-circuit that would hide a route regression).
    expect(calls.some((c) => c.url.endsWith('/items/notebook/new/ai-function') && c.init?.method === 'POST')).toBe(true);
  });

  it('positive control: an ordinary failure still renders the error bar', async () => {
    installFetchMock({
      '/ai-function?probe=1': () => PROBE,
      '/ai-function': () => ({ ok: false, engine: 'databricks', error: 'Warehouse is STOPPED.' }),
    });
    renderHelper('nb-1');
    await clickRun();

    const title = await screen.findByText('AI function failed');
    expect(title).toBeInTheDocument();
    // The mirror of the assertion above: an ordinary failure must stay red,
    // not drift to warning.
    expect(title.closest('[data-intent]')?.getAttribute('data-intent')).toBe('error');
    expect(screen.getByText(/Warehouse is STOPPED\./)).toBeInTheDocument();
    expect(screen.queryByText('Save this item first')).toBeNull();
  });
});
