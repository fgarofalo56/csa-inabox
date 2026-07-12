/**
 * pin-store — pure-logic coverage (node env, no jsdom).
 *
 * `nextPins` is the load-bearing reducer that decides pin membership: pinning
 * appends, pinning again removes (toggle), and unrelated pins are preserved and
 * order-stable. This is the logic that was effectively dead before the fix (no
 * surface ever invoked it), so it's tested directly. No mocks (no-vaporware.md).
 */
import { describe, it, expect } from 'vitest';
import { nextPins, type PinnedItem } from '../pin-store';

const ws: PinnedItem = { id: 'workspace:1', label: 'Sales', href: '/workspaces/1', type: 'workspace' };
const lake: PinnedItem = { id: 'item:lakehouse:9', label: 'bronze', href: '/items/lakehouse/9', type: 'lakehouse' };

describe('nextPins', () => {
  it('appends a new pin to an empty list', () => {
    expect(nextPins([], ws)).toEqual([ws]);
  });

  it('appends a normalised copy (only the 4 known fields)', () => {
    const dirty = { ...ws, extra: 'nope' } as unknown as PinnedItem;
    const out = nextPins([], dirty);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: ws.id, label: ws.label, href: ws.href, type: ws.type });
    expect((out[0] as Record<string, unknown>).extra).toBeUndefined();
  });

  it('removes (toggles off) an item that is already pinned, by id', () => {
    const out = nextPins([ws, lake], { ...lake, label: 'renamed' });
    expect(out).toEqual([ws]);
  });

  it('preserves existing pins and order when appending', () => {
    const out = nextPins([ws], lake);
    expect(out).toEqual([ws, lake]);
  });

  it('does not mutate the input array', () => {
    const input = [ws];
    const out = nextPins(input, lake);
    expect(input).toEqual([ws]);
    expect(out).not.toBe(input);
  });
});
