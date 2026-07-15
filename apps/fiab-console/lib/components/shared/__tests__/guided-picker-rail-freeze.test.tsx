/**
 * GuidedPickerRail — FREEZE reproduction (fix/guided-picker-freeze).
 *
 * Mounts GuidedPickerRail EXACTLY as new-item-dialog used it: the real catalog
 * (FABRIC_ITEM_TYPES / WORKLOAD_CATEGORIES), live per-category counts, filtered
 * cards for the default category, a search slot, and inside a Fluent Dialog
 * surface (the dialog renders it in a portal). A synchronous hang (infinite
 * loop / unbounded work in render) TIMES OUT this test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useMemo, useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  FluentProvider, webLightTheme, Dialog, DialogSurface, DialogBody, DialogContent,
  Input, Switch,
} from '@fluentui/react-components';
import {
  GuidedPickerRail, type GuidedPickerItem, type GuidedPickerCategory, type GuidedPickerBadge,
} from '../guided-picker-rail';
import {
  FABRIC_ITEM_TYPES, WORKLOAD_CATEGORIES, type FabricItemType, type WorkloadCategory,
} from '@/lib/catalog/fabric-item-types';

function isLabs(i: FabricItemType): boolean {
  return Boolean((i as unknown as { labs?: boolean }).labs);
}
function isSearchOnly(i: FabricItemType): boolean {
  return Boolean((i as unknown as { searchOnly?: boolean }).searchOnly);
}

/** A faithful mini-clone of the new-item-dialog browse view (same memos/props). */
function DialogClone() {
  const [category, setCategory] = useState<WorkloadCategory>('Data Engineering');
  const [query, setQuery] = useState('');
  const [showLabs, setShowLabs] = useState(false);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FABRIC_ITEM_TYPES.filter((i) => {
      if (i.deprecated) return false;
      if (i.coreSurface) return false;
      if (i.hiddenFromGallery) return false;
      if (isLabs(i) && !showLabs) return false;
      if (q) {
        return i.displayName.toLowerCase().includes(q)
          || i.description.toLowerCase().includes(q)
          || i.category.toLowerCase().includes(q);
      }
      return i.category === category && !isSearchOnly(i);
    });
  }, [category, query, showLabs]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const i of FABRIC_ITEM_TYPES) {
      if (i.deprecated || i.coreSurface || i.hiddenFromGallery) continue;
      if (isLabs(i) && !showLabs) continue;
      if (isSearchOnly(i)) continue;
      counts[i.category] = (counts[i.category] ?? 0) + 1;
    }
    return counts;
  }, [showLabs]);

  const railCategories: GuidedPickerCategory[] = useMemo(
    () => WORKLOAD_CATEGORIES.map((c) => ({ key: c, label: c, count: categoryCounts[c] ?? 0 })),
    [categoryCounts],
  );

  const pickerItems: GuidedPickerItem[] = useMemo(
    () => items.map((i): GuidedPickerItem => {
      const badges: GuidedPickerBadge[] = [];
      if (i.preview) badges.push({ label: 'Preview', color: 'warning', appearance: 'outline' });
      if (isLabs(i)) badges.push({ label: 'Labs', color: 'brand', appearance: 'tint' });
      if (i.deprecated) badges.push({ label: 'Deprecated', color: 'danger', appearance: 'outline' });
      if (i.noRestApi) badges.push({ label: 'UI only', color: 'informative', appearance: 'outline' });
      return {
        key: i.slug, title: i.displayName, description: i.description,
        iconType: i.slug, footer: i.category, badges, onPick: () => {},
      };
    }),
    [items],
  );

  return (
    <GuidedPickerRail
      categories={railCategories}
      activeCategory={query ? '' : category}
      onCategoryChange={(c) => { setCategory(c as WorkloadCategory); setQuery(''); }}
      items={pickerItems}
      search={
        <div>
          <Input placeholder="Search item types" value={query} onChange={(_, d) => setQuery(d.value)} />
          <Switch label="Show Labs items" checked={showLabs} onChange={(_, d) => setShowLabs(d.checked)} />
        </div>
      }
      emptyTitle="No matching item types"
      emptyBody="Try a different category or search term."
      railAriaLabel="Workload category"
    />
  );
}

afterEach(cleanup);

describe('GuidedPickerRail — freeze reproduction', () => {
  it('mounts inside a Dialog with the full catalog without hanging', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <Dialog open>
          <DialogSurface>
            <DialogBody>
              <DialogContent>
                <DialogClone />
              </DialogContent>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </FluentProvider>,
    );
    // If render returned, there was no synchronous hang. Assert the rail is live.
    expect(screen.getByRole('tab', { name: /Data Engineering/ })).toBeInTheDocument();
  }, 15000);

  it('switching to a Search that spans ALL ~135 catalog cards does not hang', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <DialogClone />
      </FluentProvider>,
    );
    // Type a broad query so EVERY non-hidden catalog item renders as a card at
    // once (the un-virtualized worst case).
    const search = screen.getByPlaceholderText('Search item types');
    fireEvent.change(search, { target: { value: 'a' } });
    // A large single-shot card grid must still render synchronously & fast.
    expect(document.querySelectorAll('[data-guided-card]').length).toBeGreaterThan(50);
  }, 20000);
});
