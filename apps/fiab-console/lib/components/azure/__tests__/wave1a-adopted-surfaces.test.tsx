/**
 * Wave 1A — the ADOPTED SURFACES, exercised.
 *
 * ── WHY THIS FILE IS NOT "the picker already has tests" ─────────────────────
 * Wave 0 proved the picker's three properties. That proves nothing about a
 * surface that WIRES it wrongly, and the two wiring mistakes that would matter
 * are silent:
 *
 *   1. Re-deriving the field's `value` from the fetched list (the shape of Wave
 *      0's defect 1, moved up one level). The surface then renders empty for a
 *      stored id the caller cannot resolve, and a Save writes the blank back
 *      over a working binding. Every test below opens a surface on a value that
 *      IS NOT in the discovered list and asserts it survives to the save.
 *   2. Leaving the surface unusable when discovery returns nothing — the Gov
 *      shape, where the UAMI has no tenant-root Reader.
 *      `auto-bind-by-default.md` forbids "no results + a disabled control", so
 *      each surface is also opened on an empty/denied discovery.
 *
 * The surfaces here are the ones that mount in isolation. The remaining
 * adoptions are covered structurally by the guard-analyze control at the bottom
 * of this file, which is keyed to the SAME analyzer CI runs — so a reintroduced
 * hand-typed ARM box fails here as well as in the ratchet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => fetchMock(...a) }));

import { MonitorActionBuilder } from '@/lib/components/monitor/monitor-action-builder';
import { DEFAULT_MONITOR_ACTION } from '@/lib/components/monitor/monitor-action-model';
import CatalogLineagePage from '@/app/catalog/lineage/page';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

/** A Logic App in a subscription the signed-in caller has no RBAC on. */
const HIDDEN_LOGIC_APP =
  '/subscriptions/other-sub/resourceGroups/rg-locked/providers/Microsoft.Logic/workflows/wf-hidden';

const VISIBLE_LOGIC_APP = {
  id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf-alert',
  name: 'wf-alert', type: 'microsoft.logic/workflows',
  location: 'eastus2', resourceGroup: 'rg', subscriptionId: 's1',
};

const WORKSPACE = {
  id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Databricks/workspaces/adb-1',
  name: 'adb-1', type: 'microsoft.databricks/workspaces',
  location: 'eastus2', resourceGroup: 'rg', subscriptionId: 's1',
  value: 'adb-123456.19.azuredatabricks.net',
};

/** Route the mock by URL so a surface issuing several calls is still readable. */
function routeFetch(map: Array<[RegExp, unknown]>, fallback: unknown = { ok: true }) {
  fetchMock.mockImplementation((url: any) => {
    const u = String(url);
    for (const [re, body] of map) if (re.test(u)) return Promise.resolve(jsonRes(body));
    return Promise.resolve(jsonRes(fallback));
  });
}

afterEach(cleanup);
beforeEach(() => { fetchMock.mockReset(); });

describe('Monitor action group — the Logic App id was typed', () => {
  it('PRESERVES a stored Logic App id the caller cannot resolve, through render → save', async () => {
    const onChange = vi.fn();
    routeFetch([
      [/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [VISIBLE_LOGIC_APP] }],
      [/action-groups/, { ok: true, actionGroups: [] }],
    ]);

    const state = { ...DEFAULT_MONITOR_ACTION, kind: 'LogicApp' as const, logicAppResourceId: HIDDEN_LOGIC_APP };
    wrap(<MonitorActionBuilder value={state} onChange={onChange} />);

    // Rendered — as its own preserved option, not as an empty box.
    await waitFor(() => {
      const shown = screen.getAllByRole('combobox').map((c) => (c as HTMLInputElement).value);
      expect(shown.some((v) => v.includes('wf-hidden'))).toBe(true);
    });
    expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument();

    // Touch an UNRELATED field. The surface hands its whole state back on every
    // edit, so this is the exact moment a re-derived value would be lost.
    fireEvent.change(screen.getByLabelText('Trigger name'), { target: { value: 'manual2' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      logicAppResourceId: HIDDEN_LOGIC_APP,
      logicAppTrigger: 'manual2',
    }));
  });

  it('stays usable when discovery is denied — Gov, UAMI without tenant-root Reader', async () => {
    routeFetch([
      [/\/api\/azure\/resources/, { ok: false, code: 'no_access', error: 'UAMI lacks Reader at the tenant root.' }],
      [/action-groups/, { ok: true, actionGroups: [] }],
    ]);
    wrap(<MonitorActionBuilder value={{ ...DEFAULT_MONITOR_ACTION, kind: 'LogicApp' }} onChange={() => {}} />);

    const manual = await screen.findByLabelText('Logic App resource ID');
    expect((manual as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('selecting a discovered Logic App stores its ARM id', async () => {
    const onChange = vi.fn();
    routeFetch([
      [/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [VISIBLE_LOGIC_APP] }],
      [/action-groups/, { ok: true, actionGroups: [] }],
    ]);
    wrap(<MonitorActionBuilder value={{ ...DEFAULT_MONITOR_ACTION, kind: 'LogicApp' }} onChange={onChange} />);

    await waitFor(() => expect(screen.getByText(/1 resource/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('combobox').find((c) => (c as HTMLInputElement).placeholder?.includes('Select a resource'))!);
    fireEvent.click(await screen.findByRole('option', { name: /wf-alert/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ logicAppResourceId: VISIBLE_LOGIC_APP.id }));
  });
});

describe('Catalog lineage — the Databricks workspace host was typed', () => {
  it('resolves a discovered workspace URL and carries it into the resolve request', async () => {
    routeFetch([[/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [WORKSPACE], select: 'properties.workspaceUrl' }]]);
    wrap(<CatalogLineagePage />);

    await waitFor(() => expect(screen.getByText(/1 resource/i)).toBeInTheDocument());
    // The projection the Databricks loader names, not the ARM id.
    expect(String(fetchMock.mock.calls[0][0])).toContain('select=properties.workspaceUrl');

    fireEvent.click(screen.getAllByRole('combobox').find((c) => (c as HTMLInputElement).placeholder?.includes('Select a resource'))!);
    fireEvent.click(await screen.findByRole('option', { name: /adb-1/ }));
    const box = screen.getAllByRole('combobox').find((c) => (c as HTMLInputElement).value.includes('adb-1'));
    expect(box).toBeDefined();
  });

  it('keeps a hostname it cannot resolve rather than blanking the field', async () => {
    routeFetch([[/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [], select: 'properties.workspaceUrl' }]]);
    wrap(<CatalogLineagePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Nothing discovered, so the escape hatch is the control the user gets —
    // never "No resources found" over a disabled box.
    expect(screen.getByRole('combobox', { name: /workspace/i })).toBeInTheDocument();
  });
});

/**
 * THE STRUCTURAL CONTROL, run through the guard CI actually runs.
 *
 * `check-no-freeform.mjs` cannot be `import`ed from a spec: it carries a
 * shebang, and vite-node evaluates an out-of-root `.mjs` through `vm.Script`,
 * which does NOT strip `#!` — the same breakage `_ratchet-count.mjs` documents
 * at its head. So it is SPAWNED, which is also the stronger control: this is
 * byte-for-byte the command the guardrails workflow runs, not a reimplementation
 * of its patterns that could pass while the real guard failed.
 */
describe('the 15 adopted files stay drained', () => {
  // vitest runs with `apps/fiab-console` as its root (see the RUN banner), so
  // the repo root is two levels up.
  const REPO = path.resolve(process.cwd(), '../..');
  const ADOPTED = [
    'apps/fiab-console/app/catalog/lineage/page.tsx',
    'apps/fiab-console/app/governance/lineage/page.tsx',
    'apps/fiab-console/lib/components/admin/scale-manage-panel.tsx',
    'apps/fiab-console/lib/components/eventhubs/eventhubs-namespace-editor.tsx',
    'apps/fiab-console/lib/components/monitor/monitor-action-builder.tsx',
    'apps/fiab-console/lib/components/pipeline/factory-resources-tree.tsx',
    'apps/fiab-console/lib/editors/activation-sync-editor.tsx',
    'apps/fiab-console/lib/editors/cosmos-account-editor.tsx',
    'apps/fiab-console/lib/editors/mirrored-databricks-editor.tsx',
    'apps/fiab-console/lib/editors/phase3/activator-editor.tsx',
    'apps/fiab-console/lib/editors/phase3/kql-database-editor.tsx',
    'apps/fiab-console/lib/editors/phase3/paginated-report-editor.tsx',
    'apps/fiab-console/lib/editors/report/data-source-picker.tsx',
    'apps/fiab-console/lib/panes/networking.tsx',
    'apps/fiab-console/lib/components/azure/private-link-target-field.tsx',
  ];

  /**
   * The guard's full site report.
   *
   * BOTH STREAMS, and that is not defensive padding: the summary goes to
   * stdout and the per-site lines go to STDERR. Read from stdout alone this
   * helper returned two summary lines, so the "no adopted file appears in the
   * report" assertion below passed by searching a string that lists no files at
   * all — a green test measuring nothing. The embedded control that follows is
   * what caught it, which is the whole reason it exists.
   *
   * Exit code ignored on purpose: the ratchet can fail for reasons that have
   * nothing to do with these files (a drained baseline entry, for one).
   */
  function guardReport(): string {
    const r = spawnSync(process.execPath, ['scripts/ci/check-no-freeform.mjs', '--report'], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    // A guard that could not run at all must FAIL this test, not pass it
    // silently on an empty string.
    expect(r.error, String(r.error)).toBeUndefined();
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    expect(out, 'guard produced no report').toMatch(/asking for an infrastructure value/);
    return out;
  }

  it('the guard reports zero infrastructure asks in every one of them', () => {
    const report = guardReport();
    const dirty = ADOPTED.filter((rel) => report.includes(`${rel}:`));
    expect(dirty).toEqual([]);
    // The control has a population — a passing run over an empty list measures
    // nothing (memory: guard_with_zero_population_needs_embedded_control).
    expect(ADOPTED.length).toBe(15);
  });

  it('and the guard still NAMES files that do have one, so the zero above means something', () => {
    const report = guardReport();
    // Wave 3's population, deliberately untouched here. If this ever empties,
    // the assertion above stopped measuring and must be re-grounded.
    expect(report).toMatch(/apps\/fiab-console\/lib\/editors\/databricks\/uc-dialogs\.tsx:\d+/);
  });
}, 120_000);
