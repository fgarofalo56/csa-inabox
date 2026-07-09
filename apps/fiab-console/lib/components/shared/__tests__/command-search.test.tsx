/**
 * SC-9 — <CommandSearch> render + contract. Registers a couple of surface
 * commands in the shared registry, renders the box, and asserts it surfaces,
 * filters, and runs them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CommandSearch } from '../command-search';
import {
  registerCanvasCommands, __resetCanvasCommands,
} from '@/lib/components/canvas/canvas-command-registry';

function renderSearch() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CommandSearch />
    </FluentProvider>,
  );
}

afterEach(() => {
  __resetCanvasCommands();
  cleanup();
});

describe('CommandSearch', () => {
  it('renders the search box with the Ctrl+Q affordance', () => {
    renderSearch();
    expect(screen.getByRole('combobox', { name: /search surface actions/i })).toBeInTheDocument();
  });

  it('surfaces registered commands grouped by their group header on focus', async () => {
    registerCanvasCommands([
      { id: 'a', label: 'Run all', sub: 'Home · Run', group: 'Home', run: () => {} },
      { id: 'b', label: 'Save notebook', sub: 'Home · Item', group: 'Home', run: () => {} },
    ]);
    renderSearch();
    fireEvent.focus(screen.getByRole('combobox'));
    expect(await screen.findByText('Run all')).toBeInTheDocument();
    expect(screen.getByText('Save notebook')).toBeInTheDocument();
    // Group header rendered.
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('filters the list as the user types', async () => {
    registerCanvasCommands([
      { id: 'a', label: 'Run all', sub: '', group: 'Run', run: () => {} },
      { id: 'b', label: 'Save', sub: '', group: 'Item', run: () => {} },
    ]);
    renderSearch();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'save' } });
    expect(await screen.findByText('Save')).toBeInTheDocument();
    expect(screen.queryByText('Run all')).not.toBeInTheDocument();
  });

  it('runs the selected command on click', async () => {
    let ran = 0;
    registerCanvasCommands([
      { id: 'a', label: 'Do it', sub: '', group: 'G', run: () => { ran += 1; } },
    ]);
    renderSearch();
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('Do it'));
    await waitFor(() => expect(ran).toBe(1));
  });

  it('shows an honest empty state when nothing is registered', () => {
    renderSearch();
    fireEvent.focus(screen.getByRole('combobox'));
    expect(screen.getByText(/no actions registered for this surface yet/i)).toBeInTheDocument();
  });
});
