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
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
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

  /**
   * S2 (review, 2026-08-16). This test was titled "keeps a hostname it cannot
   * resolve rather than blanking the field" and asserted only that a combobox
   * existed, on a page whose `host` starts `''`. It would have passed with the
   * preservation logic DELETED — a green run over an empty population, which is
   * the exact family this PR's own body is about.
   *
   * `CatalogLineagePage` owns `host` internally and takes no prop, so a stored
   * value cannot be injected. It CAN be driven: pick a workspace, then re-run
   * discovery against a list that no longer contains it. That is the real
   * defect shape — a saved binding whose resource the caller can no longer see
   * — and it fails if `selected` is ever re-derived from the fetched list.
   */
  it('keeps a resolved hostname when a later discovery no longer returns it', async () => {
    routeFetch([[/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [WORKSPACE], select: 'properties.workspaceUrl' }]]);
    wrap(<CatalogLineagePage />);

    await waitFor(() => expect(screen.getByText(/1 resource/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('combobox').find((c) => (c as HTMLInputElement).placeholder?.includes('Select a resource'))!);
    fireEvent.click(await screen.findByRole('option', { name: /adb-1/ }));
    await waitFor(() => {
      expect(screen.getAllByRole('combobox').some((c) => (c as HTMLInputElement).value.includes('adb-1'))).toBe(true);
    });

    // The workspace vanishes from discovery — RBAC revoked, or a Gov boundary
    // where the UAMI can no longer enumerate it. Re-run via the Refresh button.
    routeFetch([[/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [], select: 'properties.workspaceUrl' }]]);
    fireEvent.click(screen.getByRole('button', { name: /refresh resource list/i }));

    await waitFor(() => expect(screen.getByText(/0 resources/i)).toBeInTheDocument());
    // The stored value survives, badged as unverified rather than blanked.
    const kept = screen.getAllByRole('combobox').find((c) => (c as HTMLInputElement).value.includes('adb-123456'));
    expect(kept, 'the resolved hostname was blanked when discovery stopped returning it').toBeDefined();
    expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument();
  });

  it('is not a dead end when discovery returns nothing on first open', async () => {
    routeFetch([[/\/api\/azure\/resources/, { ok: true, via: 'user', resources: [], select: 'properties.workspaceUrl' }]]);
    wrap(<CatalogLineagePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The escape hatch is REACHABLE — `auto-bind-by-default` forbids "no
    // results" over a control the user cannot use.
    fireEvent.click(await screen.findByRole('button', { name: /enter manually/i }));
    const manual = await screen.findByLabelText('Workspace URL');
    expect((manual as HTMLInputElement).disabled).toBe(false);
  });
});

/**
 * Wave 1A residue — the ADX wizards' ingestion-mapping NAME (#3519).
 *
 * The cluster/leader ids on this editor were adopted in #3587, but two boxes
 * kept asking for a value that is fully enumerable off the bound database:
 * `.show database ingestion mappings`, already served by
 * `GET /api/adx/ingestion-mappings`. Typing it is not a cosmetic annoyance —
 * a mapping is TABLE-SCOPED in Kusto, so a name that is valid for one target
 * table is rejected by the cluster for another, and the free box could not
 * tell the analyst that.
 *
 * Both directions are asserted, because only asserting the picker would let a
 * "picker with zero options over an empty database" regression pass: with no
 * mapping on the database the typed box must still be REACHABLE
 * (`auto-bind-by-default.md` forbids the dead end).
 */
describe('KQL database wizards — the ingestion mapping name was typed', () => {
  const ITEM = {
    slug: 'kql-database', displayName: 'KQL Database', restType: 'KQLDatabase',
    category: 'Real-Time Intelligence', description: 'fixture',
  } as any;

  /** `fetchJson` (lib/api/workspaces) reads `res.ok`, so the stub must carry it. */
  function okRes(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as any;
  }

  const DB = {
    ok: true, cluster: 'https://adx-loom.eastus2.kusto.windows.net', database: 'loomdb',
    details: {}, tables: [{ name: 'T1' }, { name: 'T2' }], tableCount: 2,
  };

  /** Route by URL, with the mapping list swapped per test. */
  function routeEditor(mappingsBody: unknown) {
    fetchMock.mockImplementation((url: any) => {
      const u = String(url);
      if (/\/api\/adx\/ingestion-mappings/.test(u)) return Promise.resolve(okRes(mappingsBody));
      if (/\/api\/adx\/tables/.test(u)) return Promise.resolve(okRes({ ok: true, tables: [{ name: 'T1' }, { name: 'T2' }] }));
      if (/\/data-connections/.test(u)) return Promise.resolve(okRes({ ok: true, namespace: 'ns', eventHubs: ['h1'], tables: ['T1', 'T2'], connections: [] }));
      if (/\/api\/items\/kql-database\//.test(u)) return Promise.resolve(okRes(DB));
      return Promise.resolve(okRes({ ok: true }));
    });
  }

  async function openGetData() {
    const { KqlDatabaseEditor } = await import('@/lib/editors/phase3/kql-database-editor');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FluentProvider theme={webLightTheme}><KqlDatabaseEditor item={ITEM} id="kqldb-1" /></FluentProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Get data' }));
    return screen.findByText(/Get data — ingest a file/);
  }

  it('offers the database’s mappings for the picked table instead of a free-text box', async () => {
    routeEditor({ ok: true, mappings: [{ name: 'm1', table: 'T1', kind: 'json' }, { name: 'm2', table: 'T2', kind: 'csv' }] });
    await openGetData();

    const picker = await screen.findByLabelText('Ingestion mapping name');
    // A <select>, not an <input> — this is the assertion that is RED at head.
    expect(picker.tagName, 'the mapping name is still a free-text box').toBe('SELECT');
    // The blank "identity mapping" choice survives: a mapping is optional.
    expect(within(picker as HTMLElement).getByRole('option', { name: /identity mapping/i })).toBeInTheDocument();

    // Target table drives the list — a mapping bound to T2 is not a legal
    // reference when ingesting into T1.
    fireEvent.change(screen.getByPlaceholderText('events'), { target: { value: 'T1' } });
    await waitFor(() => {
      const names = Array.from((picker as HTMLSelectElement).options).map((o) => o.value);
      expect(names).toContain('m1');
      expect(names, 'a mapping scoped to another table was offered').not.toContain('m2');
    });
    expect(screen.queryByPlaceholderText('EventMapping'), 'the free-text mapping box is still rendered').toBeNull();
  });

  it('still lets the name be typed when the database has no mapping at all', async () => {
    routeEditor({ ok: true, mappings: [] });
    await openGetData();
    const box = await screen.findByLabelText('Ingestion mapping name');
    expect(box.tagName).toBe('INPUT');
    expect((box as HTMLInputElement).disabled).toBe(false);
  });

  /**
   * R7: an unreadable list is not an empty list. The route answers `ok:false`
   * on a real 403/503 from the cluster, and the copy under the box must not
   * convert that into "none exist" — the same substitution
   * `deploy-integrity.md` R7 was written for.
   */
  it('does not claim the database has no mappings when the list could not be READ', async () => {
    routeEditor({ ok: false, error: 'Forbidden (principal lacks Database Viewer)' });
    await openGetData();
    await screen.findByLabelText('Ingestion mapping name');
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/No ingestion mapping is defined/i)).toBeNull();
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
