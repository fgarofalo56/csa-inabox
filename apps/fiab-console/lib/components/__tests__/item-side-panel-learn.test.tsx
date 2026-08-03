/**
 * ItemSidePanel — the Learn drawer is OPT-IN (#2893).
 *
 * The bug: the shared item-editor chrome auto-opened the "Learn about this
 * item" Drawer on arrival for every item type that had learn content. At
 * `size="medium"` that Drawer covers ~45% of a 1280px viewport — exactly the
 * region a pipeline / eventstream canvas occupies. It reproduced on two
 * unrelated editors, so it was the chrome, not an editor.
 *
 * These assertions are the CONTROL PAIR the fix must satisfy in BOTH
 * directions, so it cannot overshoot into "delete the feature":
 *   1. NOT open on arrival (the defect).
 *   2. STILL opens on demand from the visible Learn button (the feature).
 *
 * Plus the second half of #2893 — "Don't show this again" must be genuinely
 * persisted. It used to be written only by the primary button's handler, so
 * ticking it and closing via the header X / Esc silently discarded it. It now
 * persists on toggle and is re-hydrated from the stored preference.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ItemSidePanel } from '../item-side-panel';
import { getLearn } from '@/lib/learn/content';

/** An item type that genuinely ships learn content — otherwise the drawer has
 *  nothing to show and the test would pass for the wrong reason. */
const TYPE = 'adf-pipeline';

type PrefStore = { value: unknown };

function installPrefsFetch(store: PrefStore) {
  const posted: unknown[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation((async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/user-prefs')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        store.value = body.value;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, value: store.value }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as any);
  return { spy, posted };
}

const learnHeading = () => screen.queryByRole('heading', { name: /learn about this item/i })
  ?? document.querySelector('[role="dialog"]');

/** Fluent's Checkbox forwards native props onto the <input>, so the testid may
 *  land on the input itself or on a wrapper depending on the slot. */
function checkboxInput(el: HTMLElement): HTMLInputElement {
  const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
  if (!input) throw new Error('no <input> found for the dismiss checkbox');
  return input as HTMLInputElement;
}

describe('ItemSidePanel — Learn drawer default state (#2893)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('the fixture item type actually has learn content (guards a false pass)', () => {
    expect(getLearn(TYPE)).toBeTruthy();
  });

  it('does NOT open the Learn drawer on arrival, even when nothing is dismissed', async () => {
    installPrefsFetch({ value: null });
    render(<ItemSidePanel type={TYPE} id="00000000-0000-0000-0000-000000000001" />);

    // Wait for the preference lookup to land — the auto-open regression fired
    // inside that .then(), so asserting before it resolves would pass vacuously.
    await waitFor(() => expect(screen.getByTestId('item-learn-hint')).toBeInTheDocument());

    expect(document.querySelector('[data-testid="learn-dismiss"]')).toBeNull();
    expect(screen.queryByText(/don't show this again/i)).toBeNull();
  });

  it('STILL opens the Learn drawer on demand from the visible button', async () => {
    installPrefsFetch({ value: null });
    render(<ItemSidePanel type={TYPE} id="00000000-0000-0000-0000-000000000001" />);
    await waitFor(() => expect(screen.getByTestId('item-learn-hint')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('item-learn-button'));

    await waitFor(() => expect(screen.getByTestId('learn-dismiss')).toBeInTheDocument());
    expect(learnHeading()).toBeTruthy();
  });

  it('hides the first-visit hint when the preference is already dismissed', async () => {
    installPrefsFetch({ value: true });
    render(<ItemSidePanel type={TYPE} id="00000000-0000-0000-0000-000000000001" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('item-learn-hint')).toBeNull());
  });

  it('persists "Don\'t show this again" the moment it is ticked, not on the primary button', async () => {
    const store: PrefStore = { value: null };
    const { posted } = installPrefsFetch(store);
    render(<ItemSidePanel type={TYPE} id="00000000-0000-0000-0000-000000000001" />);
    await waitFor(() => expect(screen.getByTestId('item-learn-hint')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('item-learn-button'));
    const box = await screen.findByTestId('learn-dismiss');

    // Tick it, then close via the drawer's Close button WITHOUT any other
    // interaction. Before the fix the POST only happened inside the primary
    // button's handler, so an X / Esc close threw the choice away.
    fireEvent.click(checkboxInput(box));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ key: `learnDismissed:${TYPE}`, value: true });
    expect(store.value).toBe(true);

    // …and the hint goes away immediately, so the checkbox visibly did something.
    await waitFor(() => expect(screen.queryByTestId('item-learn-hint')).toBeNull());
  });

  it('un-ticking writes false — the preference is reversible, not a one-way door', async () => {
    const store: PrefStore = { value: true };
    const { posted } = installPrefsFetch(store);
    render(<ItemSidePanel type={TYPE} id="00000000-0000-0000-0000-000000000001" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('item-learn-button'));
    const box = await screen.findByTestId('learn-dismiss');
    // Re-hydrated from the stored preference: it opens already ticked.
    await waitFor(() => expect(checkboxInput(box).checked).toBe(true));

    fireEvent.click(checkboxInput(box));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ key: `learnDismissed:${TYPE}`, value: false });
    expect(store.value).toBe(false);
  });
});
