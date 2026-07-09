import { describe, it, expect } from 'vitest';
import {
  rowActionsFor, groupActionsFor, isDestructiveAction, canConfirmDelete,
  KIND_ROUTE, RESOURCE_JSON_TYPE, VIEW_JSON_KINDS, CLONE_KINDS, RENAME_KINDS,
  ALL_GROUP_VALUES,
  type RowKind, type GroupKind, type RowActionKey,
} from '../factory-resource-actions';

// ----------------------------------------------------------------------------
// The pure per-type action model behind the Factory Resources right-click menus.
// Asserting it here (no DOM) locks the ADF-Studio parity action set per resource
// type + the delete-confirm gate, independent of the tree's rendering.
// ----------------------------------------------------------------------------

const ALL_ROW_KINDS: RowKind[] = [
  'pipeline', 'dataset', 'dataflow', 'trigger',
  'linkedService', 'integrationRuntime', 'cdc',
  'globalParam', 'managedPrivateEndpoint',
];

const keys = (kind: RowKind, ctx = {}): RowActionKey[] => rowActionsFor(kind, ctx).map((a) => a.key);

describe('rowActionsFor — per-type action map', () => {
  it('every resource type exposes at least Delete + View JSON', () => {
    for (const kind of ALL_ROW_KINDS) {
      const k = keys(kind);
      expect(k, `${kind} has delete`).toContain('delete');
      expect(k, `${kind} has viewJson`).toContain('viewJson');
    }
  });

  it('pipeline: Open, Bind, Rename, Clone, View JSON, Delete (in order)', () => {
    expect(keys('pipeline')).toEqual(['open', 'bind', 'rename', 'clone', 'viewJson', 'delete']);
  });

  it('dataset / dataflow: Open, Rename, Clone, View JSON, Delete', () => {
    expect(keys('dataset')).toEqual(['open', 'rename', 'clone', 'viewJson', 'delete']);
    expect(keys('dataflow')).toEqual(['open', 'rename', 'clone', 'viewJson', 'delete']);
  });

  it('trigger: shows Start when stopped and Stop when running', () => {
    expect(keys('trigger', { running: false })[0]).toBe('start');
    expect(keys('trigger', { running: true })[0]).toBe('stop');
    // never both
    expect(keys('trigger', { running: true })).not.toContain('start');
    expect(keys('trigger', { running: false })).not.toContain('stop');
  });

  it('cdc: Open + Start/Stop (conditional) + View JSON + Delete; no clone/rename', () => {
    const running = keys('cdc', { running: true });
    expect(running).toContain('stop');
    expect(running).not.toContain('start');
    expect(keys('cdc', { running: false })).toContain('start');
    expect(keys('cdc')).not.toContain('clone');
    expect(keys('cdc')).not.toContain('rename');
  });

  it('linkedService: Open + Clone + View JSON + Delete but NO Rename (rename would break refs)', () => {
    const k = keys('linkedService');
    expect(k).toContain('clone');
    expect(k).not.toContain('rename');
    expect(k).toContain('open');
  });

  it('integrationRuntime: Open + View JSON + Delete only (no clone/rename)', () => {
    expect(keys('integrationRuntime')).toEqual(['open', 'viewJson', 'delete']);
  });

  it('globalParam: Edit + View JSON + Delete', () => {
    expect(keys('globalParam')).toEqual(['edit', 'viewJson', 'delete']);
  });

  it('managedPrivateEndpoint: View JSON + Delete only', () => {
    expect(keys('managedPrivateEndpoint')).toEqual(['viewJson', 'delete']);
  });

  it('only the types in CLONE_KINDS / RENAME_KINDS offer clone / rename', () => {
    for (const kind of ALL_ROW_KINDS) {
      expect(keys(kind).includes('clone')).toBe(CLONE_KINDS.includes(kind));
      expect(keys(kind).includes('rename')).toBe(RENAME_KINDS.includes(kind));
    }
  });

  it('Delete is always the last action and is the only destructive one', () => {
    for (const kind of ALL_ROW_KINDS) {
      const acts = rowActionsFor(kind);
      expect(acts[acts.length - 1].key).toBe('delete');
      const destructive = acts.filter((a) => a.destructive).map((a) => a.key);
      expect(destructive).toEqual(['delete']);
    }
  });
});

describe('isDestructiveAction', () => {
  it('flags only delete', () => {
    expect(isDestructiveAction('delete')).toBe(true);
    for (const k of ['open', 'bind', 'start', 'stop', 'viewJson', 'clone', 'rename', 'edit'] as RowActionKey[]) {
      expect(isDestructiveAction(k)).toBe(false);
    }
  });
});

describe('canConfirmDelete — typed-name gate', () => {
  it('enables ONLY on an exact (trimmed) name match', () => {
    expect(canConfirmDelete('pipe1', 'pipe1')).toBe(true);
    expect(canConfirmDelete('  pipe1  ', 'pipe1')).toBe(true); // trims the typed value
    expect(canConfirmDelete('pipe', 'pipe1')).toBe(false);
    expect(canConfirmDelete('PIPE1', 'pipe1')).toBe(false); // case-sensitive
    expect(canConfirmDelete('pipe1 extra', 'pipe1')).toBe(false);
  });

  it('an empty target can never be confirmed', () => {
    expect(canConfirmDelete('', '')).toBe(false);
    expect(canConfirmDelete('   ', '')).toBe(false);
  });

  it('does not trim the TARGET (the confirm text must match the real stored name)', () => {
    // A target that genuinely has surrounding spaces is matched literally.
    expect(canConfirmDelete('a b', 'a b')).toBe(true);
    expect(canConfirmDelete('ab', 'a b')).toBe(false);
  });
});

describe('groupActionsFor — group node menu', () => {
  it('always exposes Refresh, Expand all, Collapse all', () => {
    const g = groupActionsFor('cdc', {}).map((a) => a.key);
    expect(g).toEqual(['refresh', 'expandAll', 'collapseAll']);
  });

  it('prepends "New <type>" only when the group can create', () => {
    expect(groupActionsFor('pipelines', { canCreate: true }).map((a) => a.key)).toEqual(['new', 'refresh', 'expandAll', 'collapseAll']);
    expect(groupActionsFor('pipelines', { canCreate: false }).map((a) => a.key)).toEqual(['refresh', 'expandAll', 'collapseAll']);
  });

  it('MPE group only offers New when a managed VNet exists (canCreate gate)', () => {
    expect(groupActionsFor('managedPrivateEndpoints', { canCreate: false }).some((a) => a.key === 'new')).toBe(false);
    expect(groupActionsFor('managedPrivateEndpoints', { canCreate: true }).some((a) => a.key === 'new')).toBe(true);
  });

  it('a group with no New label never shows New even when canCreate', () => {
    const g = groupActionsFor('notWired' as GroupKind, { canCreate: true }).map((a) => a.key);
    expect(g).not.toContain('new');
  });
});

describe('route + resource-json maps line up with the action model', () => {
  it('every row kind has a create/delete route', () => {
    for (const kind of ALL_ROW_KINDS) {
      expect(KIND_ROUTE[kind], kind).toMatch(/^\/api\/adf\//);
    }
  });

  it('every clone/rename kind has a resource-json getter type (needed to fetch the source def)', () => {
    for (const kind of [...CLONE_KINDS, ...RENAME_KINDS]) {
      expect(RESOURCE_JSON_TYPE[kind], kind).toBeTruthy();
    }
  });

  it('VIEW_JSON_KINDS covers every row kind (View JSON is offered everywhere)', () => {
    for (const kind of ALL_ROW_KINDS) {
      expect(VIEW_JSON_KINDS.includes(kind), kind).toBe(true);
    }
  });

  it('ALL_GROUP_VALUES holds the 10 tree group ids used for Expand all', () => {
    expect(ALL_GROUP_VALUES).toHaveLength(10);
    expect(new Set(ALL_GROUP_VALUES).size).toBe(10); // unique
    expect(ALL_GROUP_VALUES).toContain('g-pipelines');
    expect(ALL_GROUP_VALUES).toContain('g-mpe');
  });
});
