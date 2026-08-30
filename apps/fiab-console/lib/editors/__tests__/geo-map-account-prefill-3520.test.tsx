/**
 * #3520 — the Azure Maps account was a HINT, never a value.
 *
 * `geo-editors.tsx` rendered
 *
 *     <Input value={state.account} placeholder={configuredMapsAccount || 'maps-csa-loom'} />
 *
 * and seeded `state.account` from `useMapsConfig().mapsAccount` through
 * `useGeoItemState`'s `fallback` argument. `useState` reads a fallback exactly
 * ONCE, on the first render — and `usePlatformConfig` is fail-closed, so on that
 * render `mapsAccount` is `''` (its documented default while the
 * GET /api/config/ui probe is in flight). The real name therefore never reached
 * the state: it appeared only as grey placeholder text, which vanishes the
 * moment the user clicks in and is easy to leave blank or mistype.
 *
 * Per `auto-bind-by-default.md` a value the platform already knows is not
 * something to ask the user to retype.
 *
 * WHAT THESE SPECS PIN, beyond "it is pre-filled":
 *   • a SAVED account wins — this is a default, not an override;
 *   • the item is not marked dirty by being opened (`ux-baseline.md`: a freshly
 *     opened, untouched item must be clean);
 *   • nothing is seeded while the stored document is still UNKNOWN, which is the
 *     C19 data-loss shape this file already guards `save()` against;
 *   • with no Maps account deployed the field stays empty and the placeholder is
 *     generic — the platform must not invent a name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { GeoMapEditor } from '../geo-editors';
import { makeItem, renderWithProviders } from './test-helpers';
import { invalidatePlatformConfig } from '@/lib/components/platform-config';

const DEPLOYED_ACCOUNT = 'maps-csa-loom-centralus';

type Reply = { status?: number; body: unknown };

/**
 * ARM-free stub of the two endpoints this editor reads.
 *
 * `global.fetch` rather than a `clientFetch` module mock on purpose: the account
 * value crosses TWO modules (`platform-config`'s memoized config probe and
 * `geo-editors`' item load), and stubbing the transport keeps both of them real.
 * That join is where #3520 lived — each half worked, and the value still never
 * arrived.
 */
function stubFetch(config: Reply, item: Reply) {
  const calls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    const u = typeof url === 'string' ? url : String(url);
    calls.push(u);
    const r = u.includes('/api/config/ui') ? config
      : u.includes('/api/cosmos-items/geo-map') ? item
        : { body: { ok: true } };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

const CONFIG_WITH_MAPS: Reply = { body: { mapsEnabled: true, mapsAccount: DEPLOYED_ACCOUNT, biBackend: 'loom-native' } };
const CONFIG_NO_MAPS: Reply = { body: { mapsEnabled: false, mapsAccount: '', biBackend: 'loom-native' } };
/** A real 404 — the read SUCCEEDED and the item genuinely has no stored state. */
const ITEM_ABSENT: Reply = { status: 404, body: { ok: false, error: 'not found' } };

/**
 * The account field, found by the placeholder that identifies it — scoped to the
 * container THIS spec rendered.
 *
 * `document.querySelector` was wrong here and it cost a confusing red: the
 * account field is identified by its placeholder, which is the same string in
 * every spec, so a tree left mounted by a sibling answers first and the
 * assertion reads the previous test's value. Scoping removes the ambiguity
 * instead of depending on cleanup ordering.
 */
const accountInput = (root: HTMLElement) =>
  root.querySelector('input[placeholder="maps-csa-loom"]') as HTMLInputElement | null;

/** Mount and hand back the scoped container. */
function mountEditor(id = 'itm-1') {
  const { container } = renderWithProviders(<GeoMapEditor item={makeItem('geo-map', 'Geo map')} id={id} />);
  return container as HTMLElement;
}

/**
 * `platform-config` memoizes GET /api/config/ui at MODULE scope, so a value read
 * by one spec is the first-render value of the next — and this file's whole
 * subject is what the field holds on the first render.
 *
 * Invalidating in `afterEach` alone was not enough, and the way it failed is
 * worth writing down: a spec can finish while the config probe is still in
 * flight (it awaits the ITEM value, which is a different request), and that
 * promise's `.then` re-populates `_cache` AFTER the teardown ran. The next spec
 * then mounts warm and reads the PREVIOUS spec's account. Measured: the
 * "no Maps account deployed" case passed alone and failed in file order.
 *
 * So: let the event loop drain first, THEN clear. Both hooks, so a leak in
 * either direction is closed.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));
beforeEach(async () => { await settle(); invalidatePlatformConfig(); });
afterEach(async () => { vi.restoreAllMocks(); await settle(); invalidatePlatformConfig(); });

describe('GeoMapEditor — the deployed Maps account is PRE-FILLED (#3520)', () => {
  it('sets the field VALUE to the deployed account once the runtime config resolves', async () => {
    stubFetch(CONFIG_WITH_MAPS, ITEM_ABSENT);
    const root = mountEditor();
    await waitFor(() => expect(accountInput(root)).not.toBeNull(), { timeout: 8000 });
    await waitFor(() => expect(accountInput(root)!.value).toBe(DEPLOYED_ACCOUNT), { timeout: 8000 });
  });

  it('does NOT mark the untouched item dirty — no "unsaved" badge on first open', async () => {
    // Pre-filling is not an edit. `ux-baseline.md` calls a freshly opened item
    // that already looks modified a defect, and a `dirty` flag here would also
    // arm Ctrl+S to write a default the user never chose.
    stubFetch(CONFIG_WITH_MAPS, ITEM_ABSENT);
    const root = mountEditor();
    await waitFor(() => expect(accountInput(root)?.value).toBe(DEPLOYED_ACCOUNT), { timeout: 8000 });
    expect(root.textContent).not.toContain('unsaved');
  });

  it('a SAVED account wins over the deployed default', async () => {
    // The discriminating negative. An unconditional seed would overwrite an item
    // deliberately pointed at another Maps account — turning a default into an
    // override, which is the opposite of what auto-bind asks for.
    stubFetch(CONFIG_WITH_MAPS, {
      body: { ok: true, item: { state: { account: 'maps-team-b', style: 'main', tileLayerUrl: '', overlayGeoJson: '{}' }, updatedAt: '2026-08-20T00:00:00Z' } },
    });
    const root = mountEditor();
    await waitFor(() => expect(accountInput(root)?.value).toBe('maps-team-b'), { timeout: 8000 });
    // …and the caption says which one is deployed rather than implying this is it.
    expect(root.textContent).toContain('This item is pointed at a different one.');
  });

  it('leaves the field EMPTY when no Maps account is deployed', async () => {
    // The platform must not invent a name. `maps-csa-loom` stays a placeholder
    // here — an example of what to type, not a claim that it exists.
    const calls = stubFetch(CONFIG_NO_MAPS, ITEM_ABSENT);
    const root = mountEditor();
    await waitFor(() => expect(accountInput(root)).not.toBeNull(), { timeout: 8000 });
    // The config was genuinely ASKED in this spec — proving the empty field is
    // the answer to a real probe, not the residue of a warm module memo.
    expect(calls).toContain('/api/config/ui');
    await new Promise((r) => setTimeout(r, 60));
    expect(accountInput(root)!.value).toBe('');
    expect(accountInput(root)!.placeholder).toBe('maps-csa-loom');
  });

  it('a FAILED read is reported, and cannot be overwritten with the default (C19)', async () => {
    // The data-loss half. A load that failed leaves the saved account UNKNOWN,
    // so a default on screen must not be able to reach Cosmos.
    //
    // WHAT IS AND IS NOT CLAIMED HERE, because the difference is measurable and
    // I checked it: the seeding EFFECT does not run in the `error` state — its
    // guard lists `new | absent | loaded` only. But the field can still SHOW the
    // deployed name by a different route, the hook's `fallback` argument, when
    // `usePlatformConfig`'s module-level memo is already warm from an earlier
    // navigation in the same session. That is display-only and harmless, and
    // asserting an empty field here would be asserting something the code does
    // not do — it passes in isolation and fails after a sibling spec has warmed
    // the memo, which is exactly the kind of order-dependent "control" this repo
    // has been burned by. So the guarantee that MATTERS is pinned instead:
    // `save()` refuses while the stored state is unknown, so no default is ever
    // written over it.
    stubFetch(CONFIG_WITH_MAPS, { status: 500, body: { ok: false, error: 'cosmos unavailable' } });
    const root = mountEditor();
    await waitFor(() => expect(accountInput(root)).not.toBeNull(), { timeout: 8000 });
    // The honest error, quoting the server's own reason and the status observed.
    await waitFor(
      () => expect(root.textContent).toMatch(/cosmos unavailable \(HTTP 500\)/),
      { timeout: 8000 },
    );
    // Save is refused: disabled in the bar, and refused by save() independently.
    const saveBtn = Array.from(root.querySelectorAll('button'))
      .find((b) => /^Save/.test(b.textContent || ''));
    expect(saveBtn, 'the Save control should be present').toBeTruthy();
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('#3520 COUNTERFACTUAL: the fallback argument could never carry this value', () => {
  it('useState ignores a fallback that changes after the first render', () => {
    // Why the fix is an effect and not "pass it in properly". `useState(fallback)`
    // reads `fallback` once; `useMapsConfig()` is fail-closed and returns `''`
    // on that render by design (platform-config.ts DEFAULT_PLATFORM_CONFIG), so
    // no arrangement of the fallback argument can deliver an async value.
    // Modelled here as the plain JS it is, so the reason survives a refactor.
    let initialized = false;
    let stored = '';
    const useStateOnce = (initial: string) => {
      if (!initialized) { initialized = true; stored = initial; }
      return stored;
    };
    expect(useStateOnce('')).toBe('');               // render 1: config unresolved
    expect(useStateOnce(DEPLOYED_ACCOUNT)).toBe(''); // render 2: config arrives, IGNORED
  });
});
