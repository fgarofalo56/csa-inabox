/**
 * IdentityPicker — stored-value mode (Wave 1C, no-freeform principal adoption).
 *
 * These drive the REAL component; only the network is stubbed. What they pin is
 * the regression that actually reaches users: a surface persists a principal's
 * object id, and on the next open the directory cannot resolve it — a leaver
 * whose Entra object was deleted, a guest from a tenant this console cannot
 * read, an SPN in another cloud, or simply a Console UAMI whose Graph AppRoles
 * were never consented (`groups`-claim-style: nothing the user did wrong).
 *
 * The sibling `azure-resource-picker.tsx` computes its selection by FINDING the
 * stored value in the fetched list, so in every one of those cases it renders
 * blank and saves blank — silently discarding a live grant. This picker must
 * not, and cannot be allowed to regress into, that shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { IdentityPicker, type IdentityHit } from '../identity-picker';

const STORED_OID = 'deadbeef-1111-2222-3333-444444444444';

const LIVE_USER: IdentityHit = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  type: 'user', displayName: 'Ada Lovelace', upn: 'ada@contoso.com',
};
const LIVE_GROUP: IdentityHit = {
  id: 'cccccccc-1111-2222-3333-444444444444',
  type: 'group', displayName: 'Finance Analysts',
};

/** URL -> response body. Anything unmapped 500s, so a silent extra call is loud. */
let routes: Array<[RegExp, { status?: number; body: unknown }]> = [];
const calls: string[] = [];

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    calls.push(u);
    for (const [re, r] of routes) {
      if (re.test(u)) {
        const status = r.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => r.body };
      }
    }
    return { ok: false, status: 500, json: async () => ({ ok: false, error: `unrouted ${u}` }) };
  }));
}

beforeEach(() => {
  configure({ defaultHidden: true });
  routes = [];
  calls.length = 0;
  stub();
});
afterEach(() => { configure({ defaultHidden: false }); cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/* ------------------------------------------------------------------ */
/* 1. An unresolvable stored value survives a round trip.              */
/* ------------------------------------------------------------------ */

describe('IdentityPicker stored-value mode — an unresolvable value survives', () => {
  it('renders a stored oid the directory returns NO match for, and never blanks it', async () => {
    // Graph answered. It just has no such object.
    routes = [[/resolve=/, { body: { ok: true, results: [] } }]];
    const onChange = vi.fn();
    wrap(<IdentityPicker kind="all" value={STORED_OID} onChange={onChange} />);

    // The chip paints from `value` on the first frame — before any lookup.
    expect(screen.getByText(STORED_OID)).toBeInTheDocument();
    // …and is still there after the lookup came back empty.
    await waitFor(() => expect(calls.some((u) => u.includes('resolve='))).toBe(true));
    expect(await screen.findByText(/Not resolvable in this directory/i)).toBeInTheDocument();
    expect(screen.getByText(STORED_OID)).toBeInTheDocument();
    // Nothing was emitted — a lookup miss must never rewrite the caller's state.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders a stored oid when the directory cannot be reached at all (Graph 503)', async () => {
    routes = [[/resolve=/, { status: 503, body: { ok: false, error: 'not_configured' } }]];
    wrap(<IdentityPicker kind="all" value={STORED_OID} onChange={() => {}} />);

    expect(await screen.findByText(/Directory lookup unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(STORED_OID)).toBeInTheDocument();
  });

  it('does not claim the principal is missing when it only failed to ask (deploy-integrity R7)', async () => {
    routes = [[/resolve=/, { status: 503, body: { ok: false, error: 'not_configured' } }]];
    wrap(<IdentityPicker kind="all" value={STORED_OID} onChange={() => {}} />);
    await screen.findByText(/Directory lookup unavailable/i);
    // "unavailable" and "not resolvable" are different sentences and the picker
    // must not print the second one for the first cause.
    expect(screen.queryByText(/Not resolvable in this directory/i)).toBeNull();
  });

  it('SAVES the stored value untouched — a save cycle round-trips the original id', async () => {
    // The full render -> save -> reload loop, with a directory that never
    // resolves the value on either pass.
    routes = [[/resolve=/, { body: { ok: true, results: [] } }]];
    let persisted = STORED_OID;
    const save = () => persisted; // what the surface would write

    const first = wrap(<IdentityPicker kind="all" value={persisted} onChange={(id) => { persisted = id; }} />);
    await screen.findByText(/Not resolvable in this directory/i);
    expect(save()).toBe(STORED_OID);
    first.unmount();

    // Reload from what was saved.
    wrap(<IdentityPicker kind="all" value={persisted} onChange={(id) => { persisted = id; }} />);
    expect(await screen.findByText(STORED_OID)).toBeInTheDocument();
    expect(save()).toBe(STORED_OID);
  });

  it('keeps the stored value while a live SEARCH returns an entirely different set', async () => {
    // The azure-resource-picker defect, reproduced as a control: a picker that
    // derived "selected" from the fetched list would drop the chip the moment a
    // search returned rows that do not include it.
    //
    // An earlier revision of this spec never RAN a search — `onChange` was a
    // `vi.fn()`, so `value` never changed, the box never rendered and the `q=`
    // route was never hit. It still caught the defect via the remount, but its
    // name overstated it. The state is driven for real here.
    routes = [
      [/resolve=/, { body: { ok: true, results: [] } }],
      [/[?&]q=/, { body: { ok: true, results: [LIVE_USER, LIVE_GROUP] } }],
    ];
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = React.useState(STORED_OID);
      return <IdentityPicker kind="all" value={v} onChange={(id) => setV(id)} />;
    }
    wrap(<Host />);
    await screen.findByText(STORED_OID);

    // Clear -> the search surface returns; run a REAL search whose results
    // contain neither the stored id nor anything like it.
    await user.click(screen.getByRole('button', { name: /Clear selected principal/i }));
    await user.type(await screen.findByRole('textbox'), 'part');
    expect(await screen.findByText('Ada Lovelace', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(calls.some((u) => u.includes('q=part'))).toBe(true);
    expect(screen.getByText('Finance Analysts')).toBeInTheDocument();

    // Re-mount with the ORIGINAL stored value: nothing the search returned may
    // have displaced it.
    cleanup();
    wrap(<IdentityPicker kind="all" value={STORED_OID} onChange={() => {}} />);
    expect(await screen.findByText(STORED_OID)).toBeInTheDocument();
  });

  it('upgrades the chip to a display name when the directory DOES resolve it', async () => {
    routes = [[/resolve=/, { body: { ok: true, results: [{ ...LIVE_USER, id: STORED_OID }] } }]];
    wrap(<IdentityPicker kind="all" value={STORED_OID} onChange={() => {}} />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText(/Not resolvable|unavailable/i)).toBeNull();
  });

  it('shows a caller-supplied label alongside the raw value when resolution fails', async () => {
    routes = [[/resolve=/, { body: { ok: true, results: [] } }]];
    wrap(<IdentityPicker kind="group" value={STORED_OID} valueLabel="Finance-Analysts" onChange={() => {}} />);
    expect(await screen.findByText('Finance-Analysts')).toBeInTheDocument();
    // The id is still shown: a stale label over an unresolvable id would be a
    // more confident claim than the picker can make.
    expect(screen.getByText(STORED_OID)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 2. Never a disabled dead end.                                       */
/* ------------------------------------------------------------------ */

describe('IdentityPicker — the surface stays usable when search yields nothing', () => {
  it('keeps the search box enabled and says what to try when Graph returns zero rows', async () => {
    routes = [[/[?&]q=/, { body: { ok: true, results: [] } }]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" />);
    const box = screen.getByRole('textbox');
    await user.type(box, 'nobody');

    expect(await screen.findByText(/No user matched/i, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(box).not.toBeDisabled();
    // Still typeable — a zero-result search must not terminate the flow.
    await user.type(box, 'x');
    expect((box as HTMLInputElement).value).toBe('nobodyx');
  });

  it('surfaces the honest gate through HonestGate — Fix-it + registry link, box still enabled', async () => {
    routes = [[/[?&]q=/, {
      status: 503,
      body: {
        ok: false, error: 'not_configured',
        remediation: 'Console UAMI lacks the Microsoft Graph application permissions.',
        hint: { missingEnvVar: 'LOOM_IDENTITY_PICKER_ENABLED', rolesRequired: [{ name: 'User.Read.All', appRoleId: 'df021288-bdef-4463-88db-98f22de89214' }] },
      },
    }]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" />);
    const box = screen.getByRole('textbox');
    await user.type(box, 'ada');

    // G2 shape, not a bare MessageBar: an inline Fix-it plus the registry link.
    expect(await screen.findByRole('button', { name: /Fix it/i }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Gate registry/i })).toHaveAttribute('href', '/admin/gates');
    expect(screen.getByText(/LOOM_IDENTITY_PICKER_ENABLED/)).toBeInTheDocument();
    expect(box).not.toBeDisabled();
  });

  it('a zero-result search does NOT clear an already-stored value', async () => {
    routes = [
      [/resolve=/, { body: { ok: true, results: [] } }],
      [/[?&]q=/, { body: { ok: true, results: [] } }],
    ];
    const onChange = vi.fn();
    wrap(<IdentityPicker kind="user" value={STORED_OID} onChange={onChange} />);
    await screen.findByText(STORED_OID);
    // In stored-value mode the chip replaces the box, so nothing can search it
    // away; and no clear was emitted.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(STORED_OID)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 2b. The escape hatch — reachable, but never the default.            */
/* ------------------------------------------------------------------ */

describe('IdentityPicker — manual-entry escape hatch', () => {
  const GATE = {
    status: 503,
    body: { ok: false, error: 'not_configured', remediation: 'Grant the Console UAMI User.Read.All.' },
  };

  it('is ON by default — the gate must never be a dead end on any adopting surface', async () => {
    // Shipped opt-in for one review cycle, which left ten adopted surfaces with
    // no way to enter a principal at all in a default deployment (the flag is
    // false on every deploy path). Default-on is the fix; opt-OUT is available
    // where hand-entry is genuinely wrong.
    routes = [[/[?&]q=/, GATE]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" />);
    await user.type(screen.getByRole('textbox'), 'ada');
    expect(await screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('honours an explicit opt-OUT', async () => {
    routes = [[/[?&]q=/, GATE]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" allowManualEntry={false} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    await screen.findByRole('button', { name: /Fix it/i }, { timeout: 3000 });
    expect(screen.queryByPlaceholderText(/Entra object id/i)).toBeNull();
  });

  it('stays hidden while the directory is WORKING, even when opted in', async () => {
    routes = [[/[?&]q=/, { body: { ok: true, results: [LIVE_USER] } }]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" allowManualEntry onManualEntry={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    await screen.findByText('Ada Lovelace', {}, { timeout: 3000 });
    expect(screen.queryByPlaceholderText(/Entra object id/i)).toBeNull();
  });

  it('stays hidden on a zero-result search — an empty directory answer is not a discovery failure', async () => {
    routes = [[/[?&]q=/, { body: { ok: true, results: [] } }]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" allowManualEntry onManualEntry={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'nobody');
    await screen.findByText(/No user matched/i, {}, { timeout: 3000 });
    expect(screen.queryByPlaceholderText(/Entra object id/i)).toBeNull();
  });

  it('APPEARS once the directory actually fails, so the surface is never a dead end', async () => {
    routes = [[/[?&]q=/, GATE]];
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" allowManualEntry onManualEntry={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    // The gate still names the remediation…
    expect(await screen.findByText(/Grant the Console UAMI User\.Read\.All/i, {}, { timeout: 3000 })).toBeInTheDocument();
    // …AND the operator can still act, which a gate alone does not give them.
    expect(await screen.findByPlaceholderText(/Entra object id/i)).toBeInTheDocument();
  });

  it('commits a manually entered object id with the ACTIVE kind, so the type is not lost', async () => {
    routes = [[/[?&]q=/, GATE]];
    const onManualEntry = vi.fn();
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="group" allowManualEntry onManualEntry={onManualEntry} />);
    await user.type(screen.getByRole('textbox'), 'fin');
    const box = await screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 });
    await user.type(box, STORED_OID);
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(onManualEntry).toHaveBeenCalledWith(STORED_OID, 'group');
  });

  it('rejects a non-GUID with a REASON rather than a silently dead button', async () => {
    routes = [[/[?&]q=/, GATE]];
    const onManualEntry = vi.fn();
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" allowManualEntry onManualEntry={onManualEntry} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    const box = await screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 });
    await user.type(box, 'not-a-guid');
    const add = screen.getByRole('button', { name: /^Add$/ });
    // The button is LIVE — a disabled control that will not say why is the same
    // dead end in a smaller box.
    expect(add).not.toBeDisabled();
    await user.click(add);
    expect(onManualEntry).not.toHaveBeenCalled();
    expect(await screen.findByText(/not an Entra object id/i)).toBeInTheDocument();
  });

  it('falls back to onChange WITH a synthesized hit when no explicit manual sink is given', async () => {
    // The hit is not decoration: `onChange(id, hit?)` omits the hit on exactly
    // one other path — clearing — so a caller reading `if (!hit)` as "cleared"
    // would discard a manually entered principal. powerbi-governance did.
    routes = [[/[?&]q=/, GATE]];
    const onChange = vi.fn();
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="group" allowManualEntry onChange={onChange} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    const box = await screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 });
    await user.type(box, STORED_OID);
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(onChange).toHaveBeenCalledWith(
      STORED_OID,
      expect.objectContaining({ id: STORED_OID, type: 'group' }),
    );
  });

  it('vanishes when the caller DISABLES the picker after a failure — not an inert box', async () => {
    // `disabled` is hoisted to the render condition rather than sat on the
    // <Input>. This is why, and it is behaviour rather than guard-appeasement:
    // the search effect early-returns while disabled, so an `error` raised
    // BEFORE the caller disabled the picker survives. With `disabled` on the
    // element the hatch would still paint — a box that looks like an option and
    // does nothing, which is worse than no box. Pinned here so the hoist cannot
    // be "simplified" away once the extractor bug that it also sidesteps
    // (`disabled={expr}` read as unconditionally disabled) is fixed upstream.
    routes = [[/[?&]q=/, GATE]];
    const user = userEvent.setup();
    const view = wrap(<IdentityPicker kind="user" allowManualEntry onManualEntry={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    expect(await screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 })).toBeInTheDocument();

    view.rerender(
      <FluentProvider theme={webLightTheme}>
        <IdentityPicker kind="user" allowManualEntry onManualEntry={() => {}} disabled />
      </FluentProvider>,
    );
    expect(screen.queryByPlaceholderText(/Entra object id/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. kind subsetting + commit semantics.                              */
/* ------------------------------------------------------------------ */

describe('IdentityPicker — kind subsets and commit', () => {
  it('renders only the requested tabs for an explicit kind subset', () => {
    wrap(<IdentityPicker kind={['user', 'group']} />);
    expect(screen.getByRole('tab', { name: /Users/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Groups/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Service principals/i })).toBeNull();
  });

  it('emits the picked id AND the full hit so a caller can derive a UPN or an appId', async () => {
    routes = [[/[?&]q=/, { body: { ok: true, results: [LIVE_USER] } }]];
    const onChange = vi.fn();
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" onChange={onChange} />);
    await user.type(screen.getByRole('textbox'), 'ada');
    await user.click(await screen.findByText('Ada Lovelace', {}, { timeout: 3000 }));

    expect(onChange).toHaveBeenCalledWith(
      LIVE_USER.id,
      expect.objectContaining({ id: LIVE_USER.id, upn: 'ada@contoso.com', type: 'user' }),
    );
  });

  it('does not issue a resolve lookup when there is no stored value', async () => {
    wrap(<IdentityPicker kind="user" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((u) => u.includes('resolve='))).toHaveLength(0);
  });

  it('resolves a stored value exactly once across re-renders that CHANGE other props', async () => {
    // The earlier version of this spec rerendered with byte-identical props, so
    // React never re-ran the effect regardless of the `resolvedFor` guard —
    // deleting the guard left it passing. Vary an unrelated prop so the
    // component genuinely re-renders and the effect's identity is exercised.
    routes = [[/resolve=/, { body: { ok: true, results: [] } }]];
    const view = wrap(<IdentityPicker kind="user" value={STORED_OID} onChange={() => {}} label="A" />);
    await screen.findByText(/Not resolvable/i);
    for (const label of ['B', 'C', 'D']) {
      view.rerender(
        <FluentProvider theme={webLightTheme}>
          <IdentityPicker kind="user" value={STORED_OID} onChange={() => {}} label={label} />
        </FluentProvider>,
      );
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((u) => u.includes('resolve='))).toHaveLength(1);
  });

  it('does not spin forever when the effect re-runs mid-flight (StrictMode remount)', async () => {
    // The resolve effect's cleanup released only its `live` flag, not
    // `resolvedFor`. A re-run then hit the "already resolved this value" early
    // return and never cleared `resolving`, so the chip span "Resolving in the
    // directory…" permanently. next.config.mjs enables StrictMode, which
    // double-invokes every effect, so this fired on every developer's first
    // paint. Driven here by changing `apiBase` mid-flight.
    routes = [[/resolve=/, { body: { ok: true, results: [] } }]];
    const view = wrap(<IdentityPicker kind="user" value={STORED_OID} onChange={() => {}} apiBase="/api/a" />);
    view.rerender(
      <FluentProvider theme={webLightTheme}>
        <IdentityPicker kind="user" value={STORED_OID} onChange={() => {}} apiBase="/api/b" />
      </FluentProvider>,
    );
    // Resolution completes and the transient state clears.
    expect(await screen.findByText(/Not resolvable/i, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/Resolving in the directory/i)).toBeNull();
    expect(screen.getByText(STORED_OID)).toBeInTheDocument();
  });

  it('a PICKED principal is not re-resolved — the pick seeds the chip', async () => {
    // Without seeding, committing a pick re-rendered the parent with the new
    // `value`, the chip painted the raw GUID, and a SECOND Graph call went out
    // for a principal the search had just returned — which, if it came back
    // empty, left the chip reading "Not resolvable" about something chosen from
    // that directory seconds earlier.
    routes = [
      [/resolve=/, { body: { ok: true, results: [] } }],
      [/[?&]q=/, { body: { ok: true, results: [LIVE_USER] } }],
    ];
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = React.useState('');
      return <IdentityPicker kind="user" value={v} onChange={(id) => setV(id)} />;
    }
    wrap(<Host />);
    await user.type(screen.getByRole('textbox'), 'ada');
    await user.click(await screen.findByText('Ada Lovelace', {}, { timeout: 3000 }));

    // The chip shows the resolved persona immediately…
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 80));
    // …and no resolve lookup was issued at all.
    expect(calls.filter((u) => u.includes('resolve='))).toHaveLength(0);
    expect(screen.queryByText(/Not resolvable/i)).toBeNull();
  });
});
