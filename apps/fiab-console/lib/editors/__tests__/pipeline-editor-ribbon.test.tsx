/**
 * WS-E E3 — `buildPipelineRibbon` was EXTRACTED from `pipeline-editor-core.tsx`
 * (the monolith-creep ratchet: the #3697/#3698 fix pushed that file from 1499 to
 * 1509 LOC against a 1500 warn threshold). The extraction is meant to be a pure
 * move — same toolbar, same enablement rules, same handlers — but nothing in the
 * repo covered that toolbar, so the move had no way to be proven behaviour-
 * preserving beyond `tsc`. These specs are that proof, and they stay useful
 * afterwards: they pin the ADF-Studio-parity toolbar (`ui-parity.md`) and the
 * "no dead buttons" rule (`no-vaporware.md` — every enabled action has a real
 * onClick, every disabled one says WHY in its title).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildPipelineRibbon, type PipelineRibbonArgs } from '../pipeline-editor-ribbon';
import type { RibbonAction } from '@/lib/components/ribbon';

function args(over: Partial<PipelineRibbonArgs> = {}): PipelineRibbonArgs {
  return {
    supportsValidate: true,
    isAdf: true,
    busy: false,
    bound: 'pl-orders',
    dirty: false,
    save: vi.fn(),
    kick: vi.fn(),
    validate: vi.fn(),
    openTriggers: vi.fn(),
    openManagePanel: vi.fn(),
    openManageHub: vi.fn(),
    quickInsert: vi.fn(),
    checkAuthoringErrors: vi.fn(),
    designerRef: { current: { autoAlign: vi.fn(), fitToScreen: vi.fn() } as never },
    ...over,
  };
}

const groups = (a: PipelineRibbonArgs) => buildPipelineRibbon(a)[0].groups;
const groupLabels = (a: PipelineRibbonArgs) => groups(a).map((g) => g.label);
const actions = (a: PipelineRibbonArgs, group: string): RibbonAction[] =>
  groups(a).find((g) => g.label === group)?.actions ?? [];
const action = (a: PipelineRibbonArgs, group: string, label: string) =>
  actions(a, group).find((x) => x.label === label);

describe('buildPipelineRibbon — ADF Studio toolbar parity', () => {
  it('emits one Home tab carrying every toolbar group', () => {
    const tabs = buildPipelineRibbon(args());
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('home');
    expect(groupLabels(args())).toEqual([
      'Save', 'Insert', 'Authoring', 'Validate', 'Manage', 'Run', 'Layout',
    ]);
  });

  it('drops ONLY the Validate group on a runtime without server-side validate (Synapse)', () => {
    expect(groupLabels(args({ supportsValidate: false }))).toEqual([
      'Save', 'Insert', 'Authoring', 'Manage', 'Run', 'Layout',
    ]);
  });

  it('keeps the Fabric Home-ribbon quick-insert set and routes each to its activity key', () => {
    const a = args();
    expect(actions(a, 'Insert').map((x) => x.label)).toEqual([
      'Copy data', 'Dataflow', 'Notebook', 'Lookup', 'Invoke pipeline',
    ]);
    action(a, 'Insert', 'Copy data')!.onClick!();
    action(a, 'Insert', 'Invoke pipeline')!.onClick!();
    expect(a.quickInsert).toHaveBeenNthCalledWith(1, 'Copy');
    expect(a.quickInsert).toHaveBeenNthCalledWith(2, 'ExecutePipeline');
  });

  it('routes the Manage group to the quick panel and the three hub panes', () => {
    const a = args();
    action(a, 'Manage', 'Manage')!.onClick!();
    action(a, 'Manage', 'Linked services')!.onClick!();
    action(a, 'Manage', 'Datasets')!.onClick!();
    action(a, 'Manage', 'Integration runtimes')!.onClick!();
    expect(a.openManagePanel).toHaveBeenCalledTimes(1);
    expect(a.openManageHub).toHaveBeenNthCalledWith(1, 'linked-services');
    expect(a.openManageHub).toHaveBeenNthCalledWith(2, 'datasets');
    expect(a.openManageHub).toHaveBeenNthCalledWith(3, 'integration-runtimes');
  });

  it('runs Debug and Trigger now through kick(), and Add trigger through openTriggers()', () => {
    const a = args();
    action(a, 'Run', 'Debug')!.onClick!();
    action(a, 'Run', 'Trigger now')!.onClick!();
    action(a, 'Run', 'Add trigger')!.onClick!();
    expect(a.kick).toHaveBeenNthCalledWith(1, 'debug');
    expect(a.kick).toHaveBeenNthCalledWith(2, 'run');
    expect(a.openTriggers).toHaveBeenCalledTimes(1);
  });

  it('drives the canvas layout actions through the designer handle', () => {
    const a = args();
    action(a, 'Layout', 'Auto align')!.onClick!();
    action(a, 'Layout', 'Zoom to fit')!.onClick!();
    expect(a.designerRef.current!.autoAlign).toHaveBeenCalledTimes(1);
    expect(a.designerRef.current!.fitToScreen).toHaveBeenCalledTimes(1);
  });

  it('UNBOUND: the pipeline-scoped actions are disabled and say WHY — no dead buttons', () => {
    const a = args({ bound: null });
    // Manage is deliberately EXEMPT: linked services, datasets and integration
    // runtimes are factory/workspace-scoped, so they stay reachable before a
    // pipeline is bound (that is how you create the connection you are about to
    // bind against). Everything else is pipeline-scoped and gates on the bind.
    const gated = groups(a).filter((g) => g.label !== 'Manage').flatMap((g) => g.actions);
    for (const x of gated) {
      expect(x.disabled, `${x.label} should be disabled while unbound`).toBe(true);
      expect(x.onClick, `${x.label} should have no handler while unbound`).toBeUndefined();
    }
    // Layout's two actions are disabled by the same rule but carry no title
    // (they are self-evident); every other one explains the gate.
    for (const x of gated.filter((y) => y.label !== 'Auto align' && y.label !== 'Zoom to fit')) {
      expect(x.title, `${x.label} should explain the gate`).toBe('Bind a pipeline first');
    }
    for (const x of actions(a, 'Manage')) {
      expect(x.disabled, `Manage/${x.label} must stay reachable while unbound`).toBeUndefined();
      expect(x.onClick, `Manage/${x.label} must keep its handler while unbound`).toBeTypeOf('function');
    }
  });

  it('SAVE is enabled only when there are unsaved changes, and says why when not', () => {
    expect(action(args({ dirty: false }), 'Save', 'Save')!.disabled).toBe(true);
    expect(action(args({ dirty: false }), 'Save', 'Save')!.title).toBe('No changes');
    expect(action(args({ dirty: true }), 'Save', 'Save')!.disabled).toBe(false);
  });

  it('RUN is blocked on a dirty spec — an unsaved canvas must not be executed', () => {
    const a = args({ dirty: true });
    for (const label of ['Debug', 'Trigger now']) {
      expect(action(a, 'Run', label)!.disabled).toBe(true);
      expect(action(a, 'Run', label)!.title).toBe('Save the spec first');
    }
  });

  it('BUSY: in-flight labels swap and the actions are disabled', () => {
    const a = args({ busy: true, dirty: true });
    expect(action(a, 'Save', 'Saving…')!.disabled).toBe(true);
    expect(action(args({ busy: true }), 'Validate', 'Validating…')!.disabled).toBe(true);
    expect(action(a, 'Run', 'Running…')!.disabled).toBe(true);
  });

  it('the Manage tooltip names integration runtimes on ADF only', () => {
    expect(action(args({ isAdf: true }), 'Manage', 'Manage')!.title).toContain('integration runtimes');
    expect(action(args({ isAdf: false }), 'Manage', 'Manage')!.title).not.toContain('integration runtimes');
  });
});
