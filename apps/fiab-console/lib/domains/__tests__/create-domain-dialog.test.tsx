/**
 * CreateDomainDialog — multi-library picker wiring (#1483 Wave 1).
 *
 * Verifies in a real render that:
 *   1. The library selector shows all four curated libraries with Federal
 *      Civilian selected by default, and the DEFAULT browse is the unchanged
 *      #1481 Federal Civilian experience (DHS card, fedciv caption copy).
 *   2. Switching to another library re-drives the SAME picker (Defense &
 *      Intelligence enterprises appear, fedciv cards disappear, selection
 *      clears).
 *   3. Selection→seed wiring hits the REAL create path: clicking Create POSTs
 *      /api/admin/domains once per planned node — parent enterprise first,
 *      then the picked child — with the library node's seed payload
 *      (no-vaporware: the library only changes seed content, not the path).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => clientFetchMock(...args),
}));

import { CreateDomainDialog } from '../create-domain-dialog';

beforeEach(() => {
  clientFetchMock.mockReset();
  clientFetchMock.mockResolvedValue({
    ok: true, status: 200, json: async () => ({ ok: true }),
  } as Response);
});

afterEach(() => cleanup());

function renderDialog(existing: Array<{ id: string; name: string; parentId?: string }> = []) {
  const onCreated = vi.fn();
  const utils = render(
    <FluentProvider theme={webLightTheme}>
      <CreateDomainDialog open onOpenChange={() => {}} existing={existing} onCreated={onCreated} />
    </FluentProvider>,
  );
  return { onCreated, ...utils };
}

/**
 * Find the browse CARD for an abbrev. The abbrev can also appear in the live
 * preview badge, so target the occurrence inside a card <button>.
 */
async function findCard(abbrev: string): Promise<HTMLElement> {
  const hits = await screen.findAllByText(abbrev);
  const inButton = hits.find((el) => el.closest('button'));
  expect(inButton, `browse card for ${abbrev}`).toBeTruthy();
  return inButton!;
}

describe('CreateDomainDialog — multi-library picker (#1483 W1)', () => {
  it('offers all four curated libraries with Federal Civilian selected + browsed by default', async () => {
    renderDialog();
    const group = await screen.findByRole('radiogroup', { name: 'Curated library' });
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(within(group).getByText('Federal Civilian')).toBeTruthy();
    expect(within(group).getByText('Defense & Intelligence')).toBeTruthy();
    expect(within(group).getByText('State & Local Government')).toBeTruthy();
    expect(within(group).getByText('Commercial / Cross-Industry')).toBeTruthy();

    // Zero-regression: the default browse is the #1481 fedciv experience.
    expect(await findCard('DHS')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search agencies…')).toBeTruthy();
    expect(screen.getByText(/departments & independent\s+agencies and/)).toBeTruthy();
  });

  it('switching libraries re-drives the picker and clears the selection', async () => {
    renderDialog();
    // Select a fedciv enterprise first, then switch libraries.
    fireEvent.click(await findCard('DHS'));
    expect(screen.getByText('1 selected:')).toBeTruthy();

    const group = screen.getByRole('radiogroup', { name: 'Curated library' });
    fireEvent.click(within(group).getByText('Defense & Intelligence'));

    // Defense enterprises browse in; fedciv cards + old selection are gone.
    expect(await findCard('USA')).toBeTruthy(); // Department of the Army
    expect(await findCard('IC')).toBeTruthy(); // Intelligence Community
    expect(screen.queryByText('1 selected:')).toBeNull();
    expect(screen.queryAllByText('DHS')).toHaveLength(0);
    expect(screen.getByPlaceholderText('Search commands & agencies…')).toBeTruthy();
  });

  it('creating from a NEW library POSTs the real endpoint parent-first with the node seed payload', async () => {
    renderDialog();
    const group = await screen.findByRole('radiogroup', { name: 'Curated library' });
    fireEvent.click(within(group).getByText('Defense & Intelligence'));

    // Drill into the Intelligence Community (double-click drills in) and pick
    // NSA — child only, so the parent enterprise must be auto-included by the
    // seed plan.
    fireEvent.dblClick(await findCard('IC'));
    fireEvent.click(await findCard('NSA'));
    fireEvent.click(screen.getByText(/^Create 1 domain$/));

    await waitFor(() => expect(clientFetchMock).toHaveBeenCalledTimes(2));
    const bodies = clientFetchMock.mock.calls.map(([url, init]) => {
      expect(url).toBe('/api/admin/domains');
      expect((init as RequestInit).method).toBe('POST');
      return JSON.parse((init as RequestInit).body as string);
    });
    // Parent enterprise first, picked child second — real seed payload shape.
    expect(bodies[0].id).toBe('intel-community');
    expect(bodies[0].parentId).toBeUndefined();
    expect(bodies[1]).toMatchObject({
      id: 'nsa',
      name: 'National Security Agency',
      parentId: 'intel-community',
    });
    expect(typeof bodies[1].description).toBe('string');
    expect(bodies[1].themeColor).toMatch(/^#/);
  });
});
