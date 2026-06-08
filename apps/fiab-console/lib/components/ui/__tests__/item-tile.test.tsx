/**
 * ItemTile — vitest jsdom render tests for the new `footer` badge-row slot.
 *
 * The OneLake catalog card brings endorsement / owner-avatar / domain badges to
 * parity with the Fabric OneLake Explore card. Those live in a bottom row that
 * ItemTile renders only when a `footer` node is supplied — there must be NO
 * empty row when an item has no governance signals (per the acceptance
 * criteria). These assertions exercise the real component (no mocked render):
 *   - footer content renders when provided,
 *   - the footer container is absent (not just empty) when `footer` is omitted,
 *   - the existing header `badge` slot is unaffected by the new prop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme, Badge } from '@fluentui/react-components';
import { ItemTile } from '../item-tile';

function renderTile(props: React.ComponentProps<typeof ItemTile>) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ItemTile {...props} />
    </FluentProvider>,
  );
}

afterEach(cleanup);

describe('ItemTile footer slot', () => {
  it('renders footer content when a footer node is supplied', () => {
    renderTile({
      type: 'lakehouse',
      title: 'sales_lakehouse',
      footer: <Badge>Certified</Badge>,
    });
    expect(screen.getByText('Certified')).toBeTruthy();
  });

  it('renders NO footer row when footer is omitted (no empty chip)', () => {
    const { container } = renderTile({
      type: 'warehouse',
      title: 'finance_wh',
      meta: 'Refreshed just now',
    });
    // The tile is the single root card div; its only direct children are the
    // header block and (optionally) the meta text — never an empty footer.
    const tile = container.querySelector('[role], div')!;
    const directDivs = Array.from(tile.children).filter((c) => c.tagName === 'DIV');
    // header is a div; footer would be a second div. With no footer + meta as a
    // <span>/Text, there is at most one direct child div (the header).
    expect(directDivs.length).toBeLessThanOrEqual(1);
    expect(screen.queryByText('Certified')).toBeNull();
  });

  it('keeps the header badge slot working alongside footer', () => {
    renderTile({
      type: 'lakehouse',
      title: 'lh',
      badge: <Badge>Preview</Badge>,
      footer: <Badge>Promoted</Badge>,
    });
    expect(screen.getByText('Preview')).toBeTruthy();
    expect(screen.getByText('Promoted')).toBeTruthy();
  });
});
