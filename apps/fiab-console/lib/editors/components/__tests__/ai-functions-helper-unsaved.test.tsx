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
        error: 'Save this item first — AI functions run in the name of a saved item.',
      }),
    });
    renderHelper('new');
    await clickRun();

    expect(await screen.findByText('Save this item first')).toBeInTheDocument();
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

    expect(await screen.findByText('AI function failed')).toBeInTheDocument();
    expect(screen.getByText(/Warehouse is STOPPED\./)).toBeInTheDocument();
    expect(screen.queryByText('Save this item first')).toBeNull();
  });
});
