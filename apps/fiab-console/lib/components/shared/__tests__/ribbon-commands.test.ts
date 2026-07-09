/**
 * SC-9 — deriveCommandsFromRibbon: pure flattening of a Ribbon definition into
 * registry commands. No DOM.
 */
import { describe, it, expect } from 'vitest';
import { deriveCommandsFromRibbon } from '../ribbon-commands';
import type { RibbonTab } from '@/lib/components/ribbon';

const noop = () => {};

const tabs: RibbonTab[] = [
  {
    id: 'home',
    label: 'Home',
    groups: [
      {
        label: 'Save',
        actions: [
          { label: 'Save', onClick: noop },
          { label: 'Decorative', /* no onClick → not runnable */ },
          { label: 'Disabled', onClick: noop, disabled: true },
          {
            label: 'Get data',
            onClick: noop,
            dropdownItems: [
              { label: 'From lakehouse', onClick: noop },
              { label: 'Dead entry' /* no onClick → dropped */ },
            ],
          },
        ],
      },
    ],
  },
];

describe('deriveCommandsFromRibbon', () => {
  it('emits a command only for wired actions and flattens dropdown items', () => {
    const cmds = deriveCommandsFromRibbon(tabs, 'pipeline');
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain('Save');
    expect(labels).toContain('Get data');
    expect(labels).toContain('From lakehouse'); // dropdown item flattened
    expect(labels).not.toContain('Decorative'); // no onClick
    expect(labels).not.toContain('Dead entry'); // dropdown item with no onClick
  });

  it('buckets commands under the ribbon tab label and prefixes ids by surface', () => {
    const cmds = deriveCommandsFromRibbon(tabs, 'pipeline');
    for (const c of cmds) {
      expect(c.group).toBe('Home');
      expect(c.id.startsWith('pipeline:')).toBe(true);
    }
  });

  it('carries a disabled predicate for disabled actions', () => {
    const cmds = deriveCommandsFromRibbon(tabs, 'nb');
    const disabled = cmds.find((c) => c.label === 'Disabled');
    expect(disabled?.disabled?.()).toBe(true);
    const save = cmds.find((c) => c.label === 'Save');
    expect(save?.disabled).toBeUndefined();
  });

  it('runs the underlying action handler', () => {
    let hit = 0;
    const t: RibbonTab[] = [{ id: 'h', label: 'Home', groups: [{ label: 'G', actions: [{ label: 'A', onClick: () => { hit += 1; } }] }] }];
    const cmds = deriveCommandsFromRibbon(t, 's');
    cmds[0].run();
    expect(hit).toBe(1);
  });

  it('dedupes commands that would collide on id', () => {
    const dup: RibbonTab[] = [{
      id: 'h', label: 'Home',
      groups: [{ label: 'G', actions: [{ label: 'A', onClick: noop }, { label: 'A', onClick: noop }] }],
    }];
    const cmds = deriveCommandsFromRibbon(dup, 's');
    expect(cmds.filter((c) => c.label === 'A')).toHaveLength(1);
  });
});
