/**
 * GuidedPickerRail — render + contract tests.
 *
 * The shared categorized create / get-data picker renders a left rail of
 * categories, a card grid of guided items (branded icon + badges + footer), and
 * optional Recommended hero(es). These jsdom tests exercise the REAL component
 * and assert:
 *   1. every category + card renders;
 *   2. clicking a category fires onCategoryChange with its key;
 *   3. clicking a card fires that card's onPick (real action — no dead tile);
 *   4. a featured hero renders and fires its onPick;
 *   5. the empty state shows when there are no items;
 *   6. hideRail drops the rail (search-only mode).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Flow24Regular } from '@fluentui/react-icons';
import {
  GuidedPickerRail, type GuidedPickerItem, type GuidedPickerCategory,
} from '../guided-picker-rail';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const CATS: GuidedPickerCategory[] = [
  { key: 'Data Engineering', label: 'Data Engineering', count: 2 },
  { key: 'Power BI', label: 'Power BI', count: 1 },
];

function itemsFor(onPick = () => {}): GuidedPickerItem[] {
  return [
    { key: 'lakehouse', title: 'Lakehouse', description: 'ADLS + Delta.', iconType: 'lakehouse', footer: 'Data Engineering', onPick },
    { key: 'notebook', title: 'Notebook', description: 'Spark notebook.', icon: Flow24Regular, footer: 'Data Engineering', badges: [{ label: 'Preview', color: 'warning' }], onPick },
  ];
}

afterEach(cleanup);

describe('GuidedPickerRail', () => {
  it('renders each category and card', () => {
    wrap(
      <GuidedPickerRail
        categories={CATS}
        activeCategory="Data Engineering"
        onCategoryChange={() => {}}
        items={itemsFor()}
      />,
    );
    expect(screen.getByRole('tab', { name: /Data Engineering/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Power BI/ })).toBeInTheDocument();
    expect(screen.getByText('Lakehouse')).toBeInTheDocument();
    expect(screen.getByText('Notebook')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('fires onCategoryChange with the clicked category key', () => {
    const onCategoryChange = vi.fn();
    wrap(
      <GuidedPickerRail
        categories={CATS}
        activeCategory="Data Engineering"
        onCategoryChange={onCategoryChange}
        items={itemsFor()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Power BI/ }));
    expect(onCategoryChange).toHaveBeenCalledWith('Power BI');
  });

  it('fires a card onPick when the card is clicked', () => {
    const onPick = vi.fn();
    wrap(
      <GuidedPickerRail
        categories={CATS}
        activeCategory="Data Engineering"
        onCategoryChange={() => {}}
        items={itemsFor(onPick)}
      />,
    );
    fireEvent.click(screen.getByText('Lakehouse'));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('renders a featured hero and fires its onPick', () => {
    const onPick = vi.fn();
    const featured: GuidedPickerItem[] = [
      { key: 'loom', title: 'Use a Loom item', description: 'Auto-configured.', iconType: 'lakehouse', recommended: true, onPick },
    ];
    wrap(
      <GuidedPickerRail
        categories={CATS}
        activeCategory="Data Engineering"
        onCategoryChange={() => {}}
        items={itemsFor()}
        featured={featured}
      />,
    );
    const hero = screen.getByText('Use a Loom item');
    expect(hero).toBeInTheDocument();
    fireEvent.click(hero);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when there are no items', () => {
    wrap(
      <GuidedPickerRail
        categories={CATS}
        activeCategory="Data Engineering"
        onCategoryChange={() => {}}
        items={[]}
        emptyTitle="No matching item types"
      />,
    );
    expect(screen.getByText('No matching item types')).toBeInTheDocument();
  });

  it('drops the rail when hideRail is set', () => {
    wrap(
      <GuidedPickerRail
        categories={CATS}
        activeCategory=""
        onCategoryChange={() => {}}
        items={itemsFor()}
        hideRail
      />,
    );
    // No category tab rendered when the rail is hidden.
    expect(screen.queryByRole('tab')).toBeNull();
    // Cards still render.
    expect(screen.getByText('Lakehouse')).toBeInTheDocument();
  });
});
