/**
 * MirroredDatabricksEditor — the create dialog's failed-pairing gate (#4183).
 *
 * The API half of #4183 (a truthful `ok:false` envelope carrying a
 * gate-registry `gateId`) landed in #4316 and is pinned by
 * `app/api/items/mirrored-databricks/__tests__/create-envelope.test.ts`. The
 * editor, however, still rendered only `pairing.gate` prose — so the `gateId`
 * the route went to the trouble of attaching reached a dead end, and the
 * operator was left reading a paragraph telling them to go set a value by
 * hand. That is the state `ux-baseline.md` G2 and `auto-bind-by-default.md` §5
 * both forbid.
 *
 * These tests pin the affordance in BOTH directions, because a Fix-it that
 * renders unconditionally would be its own defect:
 *   - a pairing failure WITH a registry id renders the inline Fix-it, and
 *   - a pairing failure with NO registry id (PAIR_CREATE_FAILED) renders the
 *     honest reason and NO Fix-it — claiming a gate that does not resolve
 *     would assert something the code did not establish (deploy-integrity R7).
 *
 * WHY THE ABSENCE TEST ASSERTS MORE THAN "no Fix-it button" (measured, not
 * assumed). The first cut of this suite asserted only
 * `queryByRole('button', {name:/Fix it/i})` on the no-registry-id case, and the
 * narrow mutation — dropping the `cGateId` conjunct from the editor's render
 * condition — SURVIVED it 3/3, RC=0. Reason: with a null id `HonestGate`
 * resolves `gateId ?? envelope?.id ?? ''`, `getGate('')` misses, and the
 * unknown-id branch renders a bar carrying NO "Fix it" button — so the only
 * thing the test looked at was unchanged while the mutant mounted a second,
 * wrongly-titled warning bar on the exact input the docblock claimed to
 * protect. The absence case therefore asserts the unknown-id bar's own tells:
 * its "<surface> needs configuration" title and the absence of the registry
 * branch's "Gate registry" link. Note that asserting the string "is not in the
 * registry" would NOT work — `detail` is always passed, so `resolvedDetail` is
 * truthy and that fallback never prints.
 *
 * Transport is mocked; the real editor and the real HonestGate render. Queries
 * go through `screen` (document-rooted) rather than the render container,
 * because Fluent's Dialog and MessageBar content mounts in a portal.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: any[]) => fetchMock(...a),
}));

import { MirroredDatabricksEditor } from '../mirrored-databricks-editor';

function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

/** The create POST body this test wants the editor to receive back. */
let createResponse: unknown;

afterEach(cleanup);
beforeEach(() => {
  fetchMock.mockReset();
  createResponse = null;
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    if (url.startsWith('/api/loom/workspaces')) {
      return jsonRes({ ok: true, workspaces: [{ id: 'ws1', name: 'Analytics' }] });
    }
    if (url.startsWith('/api/items/mirrored-databricks/catalogs')) {
      return jsonRes({ ok: true, catalogs: [] });
    }
    if (url.startsWith('/api/items/mirrored-databricks?') && init?.method === 'POST') {
      return jsonRes(createResponse);
    }
    if (url.startsWith('/api/items/mirrored-databricks?')) {
      return jsonRes({ ok: true, workspaceId: 'ws1', mirrors: [] });
    }
    return jsonRes({ ok: true });
  });
});

/**
 * Drive the real create flow: pick the workspace, open the dialog, fill the two
 * required fields, submit. Returns once the create POST has resolved.
 */
async function createMirror(user: ReturnType<typeof userEvent.setup>) {
  render(<FluentProvider theme={webLightTheme}><MirroredDatabricksEditor item={'mirrored-databricks' as any} id="new" /></FluentProvider>);

  // Workspace picker — "New mirror" stays disabled until one is chosen. The
  // Fluent Dropdown only mounts its Options once opened.
  const combo = await screen.findByRole('combobox', { name: /Workspace/i });
  await waitFor(() => expect((combo as HTMLInputElement).disabled).toBe(false));
  await user.click(combo);
  await user.click(await screen.findByRole('option', { name: 'Analytics' }));

  // More than one control opens the dialog (toolbar trigger + empty-state CTA);
  // any enabled one is a valid entry point.
  const newBtn = await waitFor(() => {
    const b = screen.getAllByRole('button', { name: /New mirror/i })
      .find((el) => !(el as HTMLButtonElement).disabled);
    if (!b) throw new Error('no enabled "New mirror" button yet');
    return b;
  });
  await user.click(newBtn);

  // The dialog surface mounts before its content, so wait on a field rather
  // than on the surface — otherwise this races the first render. Query by
  // LABEL, not by role: the Unity Catalog field renders as a freeform Input or
  // as a Dropdown depending on whether the catalogs probe returned any, and
  // this test must not depend on which of the two it got.
  const name = await screen.findByLabelText(/Display name/i, undefined, { timeout: 5000 });
  await user.type(name, 'Sales mirror');
  const catalog = await screen.findByLabelText(/Unity Catalog name/i, undefined, { timeout: 5000 });
  await user.type(catalog, 'sales');

  await user.click(screen.getByRole('button', { name: /Create mirror/i }));
}

/** A marker long enough that an accidental substring match is implausible. */
const GATE_PROSE = 'DUPPROBE-Databricks workspace not configured for this deployment.';

describe('MirroredDatabricksEditor create dialog — failed-pairing Fix-it (#4183)', () => {
  it('renders the inline Fix-it when the route names a gate-registry entry', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'NO_DATABRICKS',
      gateId: 'svc-databricks',
      error: 'Databricks workspace not configured (set LOOM_DATABRICKS_HOSTNAME).',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'NO_DATABRICKS', gate: GATE_PROSE },
    };
    await createMirror(user);

    // The gate is actionable in-product rather than prose.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Fix it/i }).length).toBeGreaterThan(0));
    // The id RESOLVED in the registry — the unknown-id fallback bar is absent.
    expect(screen.queryByText(/needs configuration/i)).toBeNull();
    expect(screen.getAllByRole('link', { name: /Gate registry/i }).length).toBeGreaterThan(0);
    // The measured reason is still on screen…
    expect(screen.getAllByText(new RegExp(GATE_PROSE)).length).toBeGreaterThan(0);
    // …exactly ONCE. Before this, the editor printed `pairing.gate` in a
    // warning MessageBar AND passed the same string to HonestGate as `detail`,
    // so the ~70-word NO_DATABRICKS paragraph rendered in two stacked yellow
    // bars (ux-baseline §3 — a touched surface comes up to baseline).
    expect(screen.getAllByText(new RegExp(GATE_PROSE)).length).toBe(1);
    // The "the item does exist" fact the replaced bar carried is not lost.
    expect(screen.getAllByText(/mirror item was created and is readable/i).length).toBe(1);
  });

  it('renders the Fix-it for the Synapse half of the pairing too, not only Databricks', async () => {
    // Without this fixture only `svc-databricks` is exercised, so renaming or
    // dropping the NO_SYNAPSE → svc-synapse mapping would kill that Fix-it with
    // the suite green.
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'NO_SYNAPSE',
      gateId: 'svc-synapse',
      error: 'No Synapse Serverless workspace is configured to serve them.',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'NO_SYNAPSE', gate: 'No Synapse Serverless workspace is configured to serve them.' },
    };
    await createMirror(user);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Fix it/i }).length).toBeGreaterThan(0));
    expect(screen.queryByText(/needs configuration/i)).toBeNull();
    expect(screen.getAllByRole('link', { name: /Gate registry/i }).length).toBeGreaterThan(0);
  });

  it('renders NO Fix-it when the failure has no registry entry', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'PAIR_CREATE_FAILED',
      // no gateId — nothing in the registry resolves this
      error: 'quota exceeded',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'PAIR_CREATE_FAILED', gate: 'quota exceeded' },
    };
    await createMirror(user);

    await waitFor(() =>
      expect(screen.getByText(/Mirror created — endpoint not yet queryable/i)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: /Fix it/i })).toBeNull();
    // The three assertions that kill the narrow mutation (see the docblock):
    // an unconditional HonestGate would mount its unknown-id bar here, which
    // carries neither the honest title above nor these tells.
    expect(screen.queryByText(/needs configuration/i)).toBeNull();
    expect(screen.queryAllByRole('link', { name: /Gate registry/i }).length).toBe(0);
  });

  /**
   * `cPairing` / `cGateId` were cleared in `create()`, on `pairing.ok`, and by
   * the secondary Close button — but the Dialog's `onOpenChange` reset neither,
   * and Escape and a backdrop click both route ONLY through there. So a
   * dismissed failure survived and re-rendered on the next, untouched create
   * (`ux-baseline.md` §6 — a freshly created item opens clean). The
   * stale-`cPairing` half predates #4183; the Fix-it half is new with it.
   *
   * SCOPE OF THIS RECEIPT, stated rather than implied. This drives the
   * no-registry-id failure, not the gated one. The gated variant is NOT
   * measurable in jsdom: `HonestGate` mounts a nested `GateFixitDialog`, and
   * with it present an Escape leaves the outer DialogSurface in the document
   * (`roleDialogs=0` but `surfaces=1`) and the reopen never produces a
   * role-visible dialog. That is Fluent under jsdom, not the editor — measured
   * against a control that opens/Escapes/reopens the SAME dialog with no
   * failure at all and reads `surfaces=1 -> 0 -> 1`, passing. The reset being
   * exercised is one unconditional handler that clears both pieces of state, so
   * this pins the code path; the gated rendering of it is owed a browser
   * receipt (`ux-baseline.md` G1), which this PR does not claim.
   */
  it('a dismissed failure does not re-render on the next create (ux-baseline §6)', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'PAIR_CREATE_FAILED',
      error: 'quota exceeded',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'PAIR_CREATE_FAILED', gate: GATE_PROSE },
    };
    await createMirror(user);
    await waitFor(() => expect(screen.getByText(new RegExp(GATE_PROSE))).toBeTruthy());

    // Dismiss with Escape — NOT the secondary Close button, which always reset.
    await user.keyboard('{Escape}');
    // Wait for the teardown to COMPLETE, not merely for the dialog role to go
    // away. `queryAllByRole('dialog') === 0` goes true while Fluent is still
    // unmounting the surface, and a reopen click landing in that window is
    // swallowed — which made this test pass alone and fail (`Unable to find
    // role="dialog"`, 6.5s) when run in the same vitest invocation as the route
    // suite. The surface count reaching 0 is the signal the teardown observed.
    await waitFor(() => {
      expect(screen.queryAllByRole('dialog').length).toBe(0);
      expect(document.querySelectorAll('.fui-DialogSurface').length).toBe(0);
    }, { timeout: 10000 });

    // Reopen: a fresh, untouched create must not show the previous failure.
    const newBtn = await waitFor(() => {
      const b = screen.getAllByRole('button', { name: /New mirror/i })
        .find((el) => !(el as HTMLButtonElement).disabled);
      if (!b) throw new Error('no enabled "New mirror" button yet');
      return b;
    });
    await user.click(newBtn);
    const live = await screen.findByRole('dialog', undefined, { timeout: 10000 });
    expect(within(live).queryByText(new RegExp(GATE_PROSE))).toBeNull();
    expect(within(live).queryByText(/endpoint not yet queryable/i)).toBeNull();
    expect(within(live).queryByRole('button', { name: /Fix it/i })).toBeNull();
  });

  it('positive control — a successful pairing shows neither the gate nor a Fix-it', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: true,
      created: true,
      mirror: { id: 'm1', state: { sqlEndpoint: 'ep' } },
      pairing: { ok: true, tablesResolved: 3, tablesSkipped: 0 },
    };
    await createMirror(user);

    // A fully paired mirror closes the dialog; no gate, no Fix-it anywhere.
    await waitFor(() => expect(screen.queryByText(/endpoint not yet queryable/i)).toBeNull());
    expect(screen.queryByRole('button', { name: /Fix it/i })).toBeNull();
  });
});
