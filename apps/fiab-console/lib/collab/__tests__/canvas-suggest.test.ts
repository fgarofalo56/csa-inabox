/**
 * Unit tests for the PURE W7 ghost-node suggestion engine helpers:
 *  - buildSuggestMessages (grounds the prompt in graph + catalog + goal)
 *  - normalizeSuggestion (rejects off-catalog type / empty label; keeps config)
 */
import { describe, it, expect } from 'vitest';
import {
  buildSuggestMessages,
  normalizeSuggestion,
  type CanvasTopology,
} from '@/lib/collab/canvas-suggest';

const topology: CanvasTopology = {
  itemType: 'eventstream',
  canvasKind: 'a real-time eventstream',
  nodes: [{ id: 'source-0', type: 'source:eventhub', label: 'Orders', role: 'source' }],
  edges: [],
  catalog: [
    { type: 'transform', title: 'Transform events', description: 'filter / aggregate / join' },
    { type: 'destination', title: 'Add destination', description: 'route to a sink' },
  ],
  goal: 'land orders in a lakehouse',
};

describe('buildSuggestMessages', () => {
  it('produces a system + user message grounding the graph, catalog and goal', () => {
    const msgs = buildSuggestMessages(topology);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('MUST pick the "nodeType" from the provided catalog');
    const user = msgs[1].content;
    expect(user).toContain('source-0');
    expect(user).toContain('type="transform"');
    expect(user).toContain('type="destination"');
    expect(user).toContain('land orders in a lakehouse');
  });

  it('renders an empty-canvas outline when there are no nodes/edges', () => {
    const user = buildSuggestMessages({ ...topology, nodes: [], edges: [], goal: undefined })[1].content;
    expect(user).toContain('(canvas is empty)');
    expect(user).toContain('(no connections yet)');
  });
});

describe('normalizeSuggestion', () => {
  const catalog = new Set(['transform', 'destination']);

  it('accepts a valid pick and preserves config', () => {
    const s = normalizeSuggestion(
      { nodeType: 'destination', label: 'Add a lakehouse sink', reason: 'source has no destination', config: { name: 'sink1' } },
      catalog,
    );
    expect(s).toMatchObject({ nodeType: 'destination', label: 'Add a lakehouse sink' });
    expect(s?.config).toEqual({ name: 'sink1' });
  });

  it('rejects a nodeType not in the catalog', () => {
    expect(normalizeSuggestion({ nodeType: 'rocket', label: 'Fly', reason: 'x' }, catalog)).toBeNull();
  });

  it('rejects an empty label', () => {
    expect(normalizeSuggestion({ nodeType: 'transform', label: '  ', reason: 'x' }, catalog)).toBeNull();
  });

  it('drops an empty config object and defaults a blank reason', () => {
    const s = normalizeSuggestion({ nodeType: 'transform', label: 'Add filter', reason: '', config: {} }, catalog);
    expect(s?.config).toBeUndefined();
    expect(s?.reason).toBe('Suggested from the current canvas.');
  });
});
