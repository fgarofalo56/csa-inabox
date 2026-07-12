/**
 * GetDataGallery — vitest render + interaction (report "Get data" popup).
 *
 * Locks the fixes for the broken Get-data popup:
 *   1. The "Use a Loom item" source (the ONLY entry to existing Loom sources)
 *      renders in the gallery AND stays reachable while the connector search
 *      box has text — it was gated behind `!q`, so any search stranded the user
 *      with "no option to select existing Loom sources".
 *   2. Every dismiss path is wired: the header Close (X) and the footer Cancel
 *      both call onDismiss so the popup can always be closed.
 *
 * Renders the REAL component under a FluentProvider with a URL-keyed fetch mock
 * (no network) per the editor test harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { render } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '../../__tests__/test-helpers';
import { GetDataGallery } from '../get-data-gallery';

function renderGallery(props: Partial<React.ComponentProps<typeof GetDataGallery>> = {}) {
  const onChosen = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <FluentProvider theme={webLightTheme}>
      <GetDataGallery open onChosen={onChosen} onDismiss={onDismiss} {...props} />
    </FluentProvider>,
  );
  return { ...utils, onChosen, onDismiss };
}

describe('GetDataGallery (report Get data popup)', () => {
  beforeEach(() => {
    // The gallery loads connections on open; return an empty list so the
    // catalog + Loom hero render without any recents.
    installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [] }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('always offers the "Use a Loom item" source — even while searching connectors', async () => {
    renderGallery();

    // Loom source is present on open.
    expect(await screen.findByLabelText(/Use a Loom item as the data source/i)).toBeTruthy();

    // Type a query that matches NO connector — the Loom source must remain
    // reachable (regression: it was hidden the moment `q` was non-empty).
    const search = screen.getByLabelText(/Search connectors/i);
    fireEvent.change(search, { target: { value: 'zzz-no-such-connector' } });

    await waitFor(() => {
      // Connector catalog collapses to its empty state…
      expect(screen.getByText(/No connectors match/i)).toBeTruthy();
    });
    // …but the Loom-item source is STILL offered.
    expect(screen.getByLabelText(/Use a Loom item as the data source/i)).toBeTruthy();
  });

  it('dismisses via the header Close (X)', async () => {
    const { onDismiss } = renderGallery();
    const closeBtn = await screen.findByLabelText(/Close Get data/i);
    fireEvent.click(closeBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses via the footer Cancel', async () => {
    const { onDismiss } = renderGallery();
    await screen.findByLabelText(/Use a Loom item as the data source/i);
    // The DialogActions Cancel button (footer) dismisses the popup.
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancels[cancels.length - 1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
