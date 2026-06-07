/**
 * ActivatorEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked /api/loom/workspaces + /api/items/activator
 * responses and confirms:
 *   - workspace fetch fires on mount (Loom workspaces, not Power BI groups)
 *   - the workspace picker renders
 *   - the "New reflex" primary button is present (disabled until a workspace
 *     is selected — the editor doesn't auto-pick)
 *   - reflex list fetch fires once the user selects a workspace
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { ActivatorEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('ActivatorEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'Default Workspace' }],
      }),
      '/api/items/activator?workspaceId=': () => ({
        ok: true,
        activators: [
          { id: 'reflex-1', displayName: 'Orders SLA' },
          { id: 'reflex-2', displayName: 'IoT temperature' },
        ],
      }),
      '/api/items/activator/reflex-1/rules': () => ({
        ok: true,
        rules: [{ id: 'r-1', name: 'Alert on overdue', state: 'Active' }],
      }),
    });
    calls = m.calls;
  });

  // vitest.config has globals:false, so @testing-library/react does NOT
  // auto-register afterEach(cleanup). Without this each render() left its tree
  // mounted in document.body, so by the 2nd/3rd test there were multiple
  // editor copies — getByText/getByRole then threw "found multiple elements".
  // Unmount explicitly so every test asserts against a single fresh tree.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('fetches Loom workspaces on mount + renders the picker', async () => {
    render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Activator \(Reflex\)/i)).toBeInTheDocument();
    });
  });

  it('exposes a "New reflex" primary button (the editor renders it disabled until a workspace is chosen)', async () => {
    render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => expect(screen.getByText(/Activator \(Reflex\)/i)).toBeInTheDocument());
    const btns = screen.getAllByRole('button', { name: /New reflex/i });
    expect(btns.length).toBeGreaterThan(0);
  });

  it('loads reflexes after a workspace is selected', async () => {
    const { container } = render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true));
    // Pick the workspace by changing the WorkspacePicker's Select value. Scope
    // to this render's container so the query is unambiguous.
    const select = within(container).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'ws-1' } });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/activator?workspaceId=ws-1'))).toBe(true);
    });
  });

  it('rule wizard exposes the Azure Monitor data-source + evaluation + severity controls and POSTs them', async () => {
    const { container } = render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true));
    fireEvent.change(within(container).getByRole('combobox'), { target: { value: 'ws-1' } });
    // Once a workspace is chosen the first reflex auto-selects and its rules load.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/items/activator/reflex-1/rules'))).toBe(true));

    // Open the rule wizard.
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));

    // The Monitor-native wizard sections render.
    await waitFor(() => expect(screen.getByText(/DATA SOURCE/)).toBeInTheDocument());
    expect(screen.getByText(/EVALUATION/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Source type/i)).toBeInTheDocument();
    const evalFreq = screen.getByLabelText(/Evaluation frequency/i);
    const severity = screen.getByLabelText(/^Severity$/i);

    // Fill the rule via the condition builder (KQL query left empty).
    fireEvent.change(screen.getByLabelText(/Rule name/i), { target: { value: 'Latency SLA breach' } });
    fireEvent.change(screen.getByLabelText(/^Property$/i), { target: { value: 'latency_ms' } });
    fireEvent.change(evalFreq, { target: { value: 'PT15M' } });
    fireEvent.change(screen.getByLabelText(/Window size/i), { target: { value: 'PT15M' } });
    fireEvent.change(severity, { target: { value: '1' } });

    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/api/items/activator/reflex-1/rules') && (c.init?.method === 'POST'));
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.name).toBe('Latency SLA breach');
      expect(body.evaluationFrequency).toBe('PT15M');
      expect(body.windowSize).toBe('PT15M');
      expect(body.severity).toBe(1);
      expect(body.condition.property).toBe('latency_ms');
      expect(body.condition.operator).toBe('GreaterThan');
      // No verbatim KQL → query omitted, condition builder drives the rule.
      expect(body.query).toBeUndefined();
    });
  });

  it('switching the data source to Event Hub swaps the KQL editor for the hub picker', async () => {
    const { container } = render(<ActivatorEditor item={makeItem('activator', 'Activator')} id="act-fixture" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true));
    fireEvent.change(within(container).getByRole('combobox'), { target: { value: 'ws-1' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/items/activator/reflex-1/rules'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));
    await waitFor(() => expect(screen.getByText(/DATA SOURCE/)).toBeInTheDocument());

    // Default KQL source shows the verbatim-query hint.
    expect(screen.getByText(/Verbatim query/i)).toBeInTheDocument();

    // Switch to Event Hub — the KQL hint disappears (replaced by the hub tree).
    fireEvent.change(screen.getByLabelText(/Source type/i), { target: { value: 'eventhub' } });
    await waitFor(() => expect(screen.queryByText(/Verbatim query/i)).toBeNull());
  });
});
