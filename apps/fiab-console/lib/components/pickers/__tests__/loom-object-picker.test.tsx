/**
 * LoomObjectPicker — the two properties that make this a new primitive instead
 * of a fourth copy of the sibling pickers' bugs (Vitest, jsdom).
 *
 *   1. A STORED VALUE THE LOADER DID NOT RETURN STILL RENDERS AND STILL SAVES.
 *      `azure-resource-picker.tsx:120` computes `selected` by FINDING the value
 *      in the fetched list and its `onSelect` emits `onChange(null)` when the id
 *      is absent; `connection-picker.tsx` does `byId.get(value)`;
 *      `report/loom-item-source-picker.tsx` hides the control entirely on an
 *      empty list. All three render a blank control over a record that has a
 *      value — and the next save writes the blank back. These tests fail if that
 *      behaviour is reintroduced here.
 *
 *   2. AN EMPTY / FAILED LOAD NEVER DISABLES THE CONTROL.
 *      "No results + a dead control" is what `auto-bind-by-default.md` forbids,
 *      and it is exactly what `phase3/workspace-picker.tsx`
 *      (`disabled={loading || workspaces.length === 0}`) does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  LoomObjectPicker, mergeStoredValue, normalizeStoredValue, type LoomObjectLoad,
} from '../loom-object-picker';

const OPTIONS = [
  { id: 'dp-1', name: 'Curated sales', caption: 'gold' },
  { id: 'dp-2', name: 'Customer 360' },
];

function mount(props: Partial<React.ComponentProps<typeof LoomObjectPicker>> = {}) {
  const onChange = vi.fn();
  const load = vi.fn(async (): Promise<LoomObjectLoad> => ({ options: OPTIONS }));
  const view = render(
    <FluentProvider theme={webLightTheme}>
      <LoomObjectPicker label="Upstream data product" value="" onChange={onChange} load={load} {...props} />
    </FluentProvider>,
  );
  return { onChange, load, view };
}

describe('mergeStoredValue — the preservation rule, as a pure property', () => {
  it('keeps a stored id the loader did not return, and flags it unresolved', () => {
    const { options, unresolved } = mergeStoredValue(OPTIONS, 'dp-GONE');
    expect(unresolved).toBe(true);
    expect(options.map((o) => o.id)).toContain('dp-GONE');
    // Every discovered option survives too — preservation never costs the list.
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining(['dp-1', 'dp-2']));
  });

  it('does not duplicate or flag a stored id that IS in the list', () => {
    const { options, unresolved } = mergeStoredValue(OPTIONS, 'dp-1');
    expect(unresolved).toBe(false);
    expect(options.filter((o) => o.id === 'dp-1')).toHaveLength(1);
  });

  it('preserves a stored id even when the list came back EMPTY (the 403 / outage case)', () => {
    const { options, unresolved } = mergeStoredValue([], 'dp-GONE');
    expect(unresolved).toBe(true);
    expect(options).toEqual([{ id: 'dp-GONE', name: 'dp-GONE' }]);
  });

  it('an empty stored value adds nothing', () => {
    expect(mergeStoredValue(OPTIONS, '')).toEqual({ options: OPTIONS, unresolved: false });
  });

  it('normalization is ONE function, so merge and lookup cannot disagree', () => {
    // The asymmetry this locks out: merge trimmed, lookup did not. For ' dp-1 '
    // the merge said "resolved" (no warning) while the lookup found nothing
    // (blank control) — a blank required field over a stored value, undisclosed.
    expect(normalizeStoredValue(' dp-1 ')).toBe('dp-1');
    const merged = mergeStoredValue(OPTIONS, ' dp-1 ');
    expect(merged.unresolved).toBe(false);
    expect(merged.options.some((o) => o.id === normalizeStoredValue(' dp-1 '))).toBe(true);
  });
});

describe('LoomObjectPicker', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the discovered options', async () => {
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    fireEvent.click(dd);
    await waitFor(() => expect(screen.getByText('Curated sales')).toBeInTheDocument());
    expect(screen.getByText('Customer 360')).toBeInTheDocument();
  });

  it('an UNRESOLVABLE stored value still renders, stays selected, and is never auto-cleared', async () => {
    const { onChange } = mount({ value: 'dp-GONE' });
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    // The stored id is displayed even though the loader never returned it.
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('dp-GONE'));
    // …and it is disclosed as unresolved rather than silently shown as valid.
    expect(screen.getByText(/not in the list you can see right now/i)).toBeInTheDocument();
    // The picker must not emit a change the user did not make — the sibling
    // picker's `onChange(null)` on a missing id is the silent-data-loss bug.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a stored value with whitespace RESOLVES — merge and lookup use the same normalization', async () => {
    const { onChange } = mount({ value: ' dp-1 ' });
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('Curated sales'));
    // It resolved, so no unresolved warning may be shown.
    expect(screen.queryByText(/not in the list you can see right now/i)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an unresolvable stored value survives a RELOAD that still cannot resolve it', async () => {
    const { onChange } = mount({ value: 'dp-GONE' });
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('dp-GONE'));
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('dp-GONE'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays USABLE when the list is empty — no disabled dead end, and a guided way out', async () => {
    const load = vi.fn(async (): Promise<LoomObjectLoad> => ({ options: [] }));
    mount({ load, emptyTitle: 'No other data products yet' });
    await waitFor(() => expect(screen.getByText('No other data products yet')).toBeInTheDocument());
    const dd = screen.getByRole('combobox', { name: 'Upstream data product' });
    expect(dd).not.toBeDisabled();
    // A guided empty state with a real action, not a bare "no results".
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('an empty list still shows (and keeps) an existing value', async () => {
    const load = vi.fn(async (): Promise<LoomObjectLoad> => ({ options: [] }));
    const { onChange } = mount({ load, value: 'dp-GONE' });
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('dp-GONE'));
    expect(dd).not.toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('surfaces a load ERROR verbatim and leaves the control usable', async () => {
    const load = vi.fn(async (): Promise<LoomObjectLoad> => ({
      options: [], error: 'Databricks workspace not configured: set LOOM_DATABRICKS_HOSTNAME.',
    }));
    mount({ load, value: 'dp-GONE' });
    await waitFor(() =>
      expect(screen.getByText(/set LOOM_DATABRICKS_HOSTNAME/)).toBeInTheDocument());
    const dd = screen.getByRole('combobox', { name: 'Upstream data product' });
    expect(dd).not.toBeDisabled();
    expect((dd as HTMLInputElement).value).toBe('dp-GONE');
  });

  it('a THROWN loader is an error, not an empty list', async () => {
    const load = vi.fn(async (): Promise<LoomObjectLoad> => { throw new Error('network down'); });
    mount({ load });
    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument());
    // An empty state would claim "there are none", which is a different fact.
    expect(screen.queryByText(/Nothing to pick yet/)).toBeNull();
  });

  it('an ERROR carries the Fix-it (G2), not just prose', async () => {
    const load = vi.fn(async (): Promise<LoomObjectLoad> => ({ options: [], error: 'not configured' }));
    const onFix = vi.fn();
    mount({ load, fixIt: { label: 'Fix it', onClick: onFix } });
    const fix = await screen.findByRole('button', { name: 'Fix it' });
    fireEvent.click(fix);
    expect(onFix).toHaveBeenCalled();
  });

  it('a STRUCTURED gate renders the host-supplied gate slot instead of the plain bar', async () => {
    const load = vi.fn(async (): Promise<LoomObjectLoad> => ({
      options: [], error: 'Set LOOM_AML_WORKSPACE.', gate: { gateId: 'svc-model-serving', missing: 'LOOM_AML_WORKSPACE' },
    }));
    mount({ load, gateSlot: <div data-testid="host-gate">real Fix-it wizard</div> });
    await waitFor(() => expect(screen.getByTestId('host-gate')).toBeInTheDocument());
    // The weaker generic bar must not ALSO render — one gate, one renderer.
    expect(screen.queryByText(/Could not list upstream data product/i)).toBeNull();
  });

  it('yields the picked id to onChange', async () => {
    const { onChange } = mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    fireEvent.click(dd);
    fireEvent.click(await screen.findByText('Customer 360'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('dp-2'));
  });

  it('a SLOW superseded load cannot overwrite the newer one', async () => {
    // Supersession happens when the SCOPE changes mid-flight (`loadKey`), not on
    // Refresh — Refresh is disabled while a load is in flight, so it cannot
    // overlap. Last-write-wins here would render the previous scope's list.
    let call = 0;
    const load = vi.fn(async (): Promise<LoomObjectLoad> => {
      call += 1;
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 80));
        return { options: [{ id: 'stale', name: 'STALE' }] };
      }
      return { options: [{ id: 'fresh', name: 'FRESH' }] };
    });
    const onChange = vi.fn();
    const view = render(
      <FluentProvider theme={webLightTheme}>
        <LoomObjectPicker label="Upstream data product" value="" onChange={onChange} load={load} loadKey="ws-A" />
      </FluentProvider>,
    );
    // Change the scope before the first load resolves.
    view.rerender(
      <FluentProvider theme={webLightTheme}>
        <LoomObjectPicker label="Upstream data product" value="" onChange={onChange} load={load} loadKey="ws-B" />
      </FluentProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 140));

    fireEvent.click(screen.getByRole('combobox', { name: 'Upstream data product' }));
    await waitFor(() => expect(screen.getByText('FRESH')).toBeInTheDocument());
    expect(screen.queryByText('STALE')).toBeNull();
  });

  it('a host-owned `source` is rendered as-is and is NOT re-fetched by the picker', async () => {
    // The N+1 fix: a surface with several pickers over one population fetches
    // once and hands the result to each. A picker that still called `load`
    // would defeat it silently.
    const load = vi.fn(async (): Promise<LoomObjectLoad> => ({ options: OPTIONS }));
    const reload = vi.fn();
    render(
      <FluentProvider theme={webLightTheme}>
        <LoomObjectPicker
          label="Upstream data product"
          value="dp-2"
          onChange={vi.fn()}
          source={{ options: OPTIONS, error: null, hint: null, gate: null, loading: false, reload }}
        />
      </FluentProvider>,
    );
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('Customer 360'));
    expect(load).not.toHaveBeenCalled();
    // Refresh delegates to the HOST's reloader, so one click refreshes the
    // shared list rather than this instance's private copy.
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(reload).toHaveBeenCalled();
  });
});
