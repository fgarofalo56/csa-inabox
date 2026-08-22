/**
 * `useItemState` — a browser-only seed must never masquerade as saved (#3687).
 *
 * ## The defect
 *
 * Both `useItemState` hooks — `lib/editors/phase4/shared.tsx` (which backs the
 * 8 editors whose Save is bound to `disabled: saving || dirty === false`) and
 * `lib/editors/palantir/shared.tsx` — render their `fallback` synchronously and
 * then, on load, only touched state when the server had some. A freshly created
 * item therefore showed realistic seed config that existed ONLY in the browser,
 * with `dirty === false`, so SaveBar/SaveStrip read **"Saved"** over a
 * **disabled** button. Every server-side action read Cosmos, found nothing, and
 * behaved as if the on-screen config did not exist — because it didn't — and
 * the user's only route to persisting it was to make an unrelated edit first.
 *
 * ## Why the fixtures below send `state: {}` and not `state: undefined`
 *
 * This is the part that decides whether the fix is real or theatre. EVERY item
 * GET route normalises its response with `state: item.state || {}` —
 * `app/api/items/_lib/palantir-crud.ts:183` for the whole palantir family, and
 * the identical line in `variable-library`, `user-data-function`, `plan`,
 * `ontology`, `map`, `graph-model`, `data-agent`, `operations-agent`, … So
 * `doc.state` is NEVER `undefined` over the wire, the old
 * `if (doc.state && typeof doc.state === 'object')` was ALWAYS TRUE, and its
 * `else` branch was unreachable in production.
 *
 * A spec that fed `state`-less fixtures would therefore pass against a fix that
 * does nothing at all — a guard with zero population. `{}` IS the population,
 * so `{}` is what these specs send.
 *
 * ## Control pairs — these run in BOTH directions so the fix cannot overshoot
 *
 *   empty server state  → dirty TRUE   (Save live, no banner)
 *   real  server state  → dirty FALSE  (back-compat: the other ~16 editors)
 *   FAILED read         → dirty FALSE  (Save must stay disabled — enabling it
 *                                       would PATCH `fallback` over a document
 *                                       nobody read: the C19 data-loss bug)
 *   empty `fallback`    → dirty FALSE  (nothing displayed-but-unpersisted, so
 *                                       "unsaved" would be noise, not truth)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useItemState as usePhase4ItemState } from '../phase4/shared';
import { useItemState as usePalantirItemState } from '../palantir/shared';
import { hasPersistedItemState } from '../item-state-seed';
import { VariableLibraryEditor } from '../phase4/variable-library-editor';
import { makeItem, renderWithProviders } from './test-helpers';

const ID = '00000000-0000-0000-0000-00000000368f';

/** The seed a real editor passes — non-empty, exactly like variable-library's. */
function seed(): Record<string, unknown> {
  return {
    variables: [
      { name: 'ENV', type: 'string', default: 'dev' },
      { name: 'BatchSize', type: 'number', default: '5000' },
    ],
  };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Answer the item's own GET with `body`; every other call is a no-op 200.
 * The route is matched EXACTLY (not `includes(ID)`) so sibling endpoints that
 * embed the same id — `/<id>/resolve`, `/<id>/publish` — cannot accidentally
 * be served the item document.
 */
function installItemGet(body: unknown, status = 200) {
  const itemRoute = new RegExp(`/api/items/[^/]+/${ID}(\\?|$)`);
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = String(url);
    if (itemRoute.test(u)) return json(body, status);
    return json({ ok: true }, 200);
  }) as any);
}

const EMPTY_DOC = { id: ID, displayName: 'vl', state: {}, updatedAt: null };
const SAVED_DOC = {
  id: ID,
  displayName: 'vl',
  state: { variables: [{ name: 'ENV', type: 'string', default: 'prod' }] },
  updatedAt: '2026-08-20T00:00:00.000Z',
};

/**
 * Probes that render a hook's load lifecycle as text. A probe rather than
 * `renderHook` keeps this spec independent of the testing-library hook API.
 */
function Phase4Probe({ fallback }: { fallback: Record<string, unknown> }) {
  const { loading, dirty, error } = usePhase4ItemState('variable-library', ID, fallback);
  return <div data-testid="probe">{loading ? 'loading' : `dirty=${String(dirty)} error=${String(error)}`}</div>;
}

function PalantirProbe({ fallback }: { fallback: Record<string, unknown> }) {
  const { loading, dirty, error } = usePalantirItemState('variable-library', ID, fallback);
  return <div data-testid="probe">{loading ? 'loading' : `dirty=${String(dirty)} error=${String(error)}`}</div>;
}

/** Settle the load and return the probe's rendered verdict. */
async function probeVerdict(): Promise<string> {
  await waitFor(() => {
    expect(screen.getByTestId('probe').textContent).not.toBe('loading');
  });
  return screen.getByTestId('probe').textContent || '';
}

/** The identical four-way contract, run against both hook families. */
function itHonoursTheUnsavedSeedContract(
  family: string,
  Probe: (props: { fallback: Record<string, unknown> }) => ReactElement,
) {
  describe(`useItemState (${family}) — unsaved-seed contract (#3687)`, () => {
    afterEach(() => { cleanup(); vi.restoreAllMocks(); });

    it('marks the item DIRTY when the read succeeds but the record carries no state', async () => {
      installItemGet(EMPTY_DOC);
      render(<Probe fallback={seed()} />);
      expect(await probeVerdict()).toBe('dirty=true error=null');
    });

    it('leaves the item CLEAN when the server has real state (back-compat)', async () => {
      installItemGet(SAVED_DOC);
      render(<Probe fallback={seed()} />);
      expect(await probeVerdict()).toBe('dirty=false error=null');
    });

    it('does NOT mark dirty when the read FAILED — Save stays disabled over an unread doc', async () => {
      installItemGet({ error: 'backend exploded' }, 500);
      render(<Probe fallback={seed()} />);
      // The honest error is reported, but the seed must NOT become persistable:
      // dirty=true here is a Save button that PATCHes `fallback` over content
      // nobody has read (the C19 data-loss shape).
      expect(await probeVerdict()).toBe('dirty=false error=backend exploded');
    });

    it('does NOT mark dirty when the fallback is empty (nothing displayed-but-unpersisted)', async () => {
      installItemGet(EMPTY_DOC);
      render(<Probe fallback={{}} />);
      expect(await probeVerdict()).toBe('dirty=false error=null');
    });
  });
}

itHonoursTheUnsavedSeedContract('phase4', Phase4Probe);
itHonoursTheUnsavedSeedContract('palantir', PalantirProbe);

describe('hasPersistedItemState — the predicate the hooks key on', () => {
  it('is FALSE for every "nothing saved yet" shape, including the `{}` the routes send', () => {
    expect(hasPersistedItemState({})).toBe(false);
    expect(hasPersistedItemState(undefined)).toBe(false);
    expect(hasPersistedItemState(null)).toBe(false);
    expect(hasPersistedItemState('')).toBe(false);
    expect(hasPersistedItemState([])).toBe(false);
  });

  it('is TRUE only when the record genuinely carries keys', () => {
    expect(hasPersistedItemState({ variables: [] })).toBe(true);
    expect(hasPersistedItemState({ source: 'x' })).toBe(true);
  });
});

/**
 * Surface-level proof. The hook specs above prove `dirty`; this proves the
 * thing the USER was actually stuck on — SaveBar's button, which renders
 * "Saved" + `disabled` when `dirty === false`, and "Save (Ctrl+S)" when true.
 */
describe('VariableLibraryEditor — first open of a fresh item (#3687, ux-baseline.md §6)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const editor = () => (
    <VariableLibraryEditor item={makeItem('variable-library', 'Variable library')} id={ID} />
  );

  it('offers a LIVE Save over the unsaved seed, with no error banner', async () => {
    installItemGet(EMPTY_DOC);
    renderWithProviders(editor());

    const save = await screen.findByRole('button', { name: /Save \(Ctrl\+S\)/ });
    expect(save).toBeEnabled();
    // The dead end: a button reading "Saved" over config that was never saved.
    expect(screen.queryByRole('button', { name: /^Saved$/ })).toBeNull();
    // Clean first open — validation surfaces after touch or save-attempt.
    expect(screen.queryByText(/HTTP \d{3}/)).toBeNull();
  });

  it('still shows a settled, disabled Save when the server HAS state', async () => {
    installItemGet(SAVED_DOC);
    renderWithProviders(editor());

    const save = await screen.findByRole('button', { name: /^Saved$/ });
    expect(save).toBeDisabled();
  });
});
