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
 * Transport is mocked; the real editor and the real HonestGate render.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
      pairing: { ok: false, code: 'NO_DATABRICKS', gate: 'Databricks workspace not configured.' },
    };
    await createMirror(user);

    // The honest reason still shows…
    await waitFor(() =>
      expect(screen.getByText(/Mirror created — endpoint not yet queryable/i)).toBeTruthy(),
    );
    // …and the gate is now actionable in-product rather than prose.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Fix it/i }).length).toBeGreaterThan(0));
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
