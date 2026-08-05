/**
 * WDL ⇄ graph round-trip tests.
 *
 * These are the load-bearing tests for the workflow designer: if the model
 * loses or mangles a field, the designer will silently corrupt a REAL customer
 * workflow on save. Every assertion below is mutation-proved (see the PR body)
 * — each one fails when the specific behaviour it names is broken.
 */
import { describe, it, expect } from 'vitest';
import {
  wdlToGraph,
  graphToWdl,
  autoLayout,
  removeNode,
  renameNode,
  connectNodes,
  disconnectNodes,
  wouldCycle,
  uniqueOperationName,
  validateGraph,
  emptyDefinition,
  LOOM_LAYOUT_KEY,
  NODE_VGAP,
  NODE_HGAP,
  type WdlDefinition,
} from '../wdl-model';

/** A realistic workflow exercising triggers, http, branch, scope, non-default runAfter. */
const REAL: WdlDefinition = {
  $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
  contentVersion: '1.0.0.0',
  parameters: { apiKey: { type: 'SecureString', defaultValue: '' } },
  triggers: {
    When_a_HTTP_request_is_received: {
      type: 'Request',
      kind: 'Http',
      inputs: { schema: { type: 'object', properties: { id: { type: 'string' } } } },
    },
  },
  actions: {
    Fetch_order: {
      type: 'Http',
      inputs: { method: 'GET', uri: 'https://api.contoso.com/orders/@{triggerBody()?[\'id\']}' },
      runAfter: {},
    },
    Parse_order: {
      type: 'ParseJson',
      inputs: { content: '@body(\'Fetch_order\')', schema: { type: 'object' } },
      runAfter: { Fetch_order: ['Succeeded'] },
    },
    Check_total: {
      type: 'If',
      expression: { and: [{ greater: ['@body(\'Parse_order\')?[\'total\']', 100] }] },
      actions: {
        Notify: {
          type: 'Http',
          inputs: { method: 'POST', uri: 'https://hooks.contoso.com/big-order' },
          runAfter: {},
        },
      },
      else: {
        actions: {
          Log_small: { type: 'Compose', inputs: 'small order', runAfter: {} },
        },
      },
      runAfter: { Parse_order: ['Succeeded'] },
    },
    Handle_failure: {
      type: 'Terminate',
      inputs: { runStatus: 'Failed', runError: { message: 'fetch failed' } },
      // Non-default runAfter status — the classic thing a naive model drops.
      runAfter: { Fetch_order: ['Failed', 'TimedOut'] },
    },
  },
  outputs: {},
};

describe('wdlToGraph / graphToWdl round-trip', () => {
  it('round-trips a realistic workflow byte-for-byte (layout off)', () => {
    const graph = wdlToGraph(REAL);
    const back = graphToWdl(graph, REAL, { persistLayout: false });
    expect(back).toEqual(REAL);
  });

  it('preserves non-Succeeded runAfter statuses', () => {
    const graph = wdlToGraph(REAL);
    const edge = graph.edges.find((e) => e.target === 'Handle_failure');
    expect(edge?.statuses).toEqual(['Failed', 'TimedOut']);
    const back = graphToWdl(graph, REAL, { persistLayout: false });
    expect(back.actions?.Handle_failure?.runAfter).toEqual({ Fetch_order: ['Failed', 'TimedOut'] });
  });

  it('preserves nested If actions AND the else branch', () => {
    const graph = wdlToGraph(REAL);
    const ifNode = graph.nodes.find((n) => n.id === 'Check_total');
    expect(Object.keys(ifNode?.scopes || {}).sort()).toEqual(['actions', 'else']);
    expect(ifNode?.scopes?.actions.nodes.map((n) => n.id)).toEqual(['Notify']);
    expect(ifNode?.scopes?.else.nodes.map((n) => n.id)).toEqual(['Log_small']);

    const back = graphToWdl(graph, REAL, { persistLayout: false });
    expect(back.actions?.Check_total?.actions?.Notify?.inputs).toEqual({
      method: 'POST',
      uri: 'https://hooks.contoso.com/big-order',
    });
    expect(back.actions?.Check_total?.else?.actions?.Log_small?.inputs).toBe('small order');
  });

  it('preserves an unknown sibling key on an operation (forward compatibility)', () => {
    const withUnknown: WdlDefinition = {
      ...REAL,
      actions: {
        ...REAL.actions,
        Fetch_order: {
          ...REAL.actions!.Fetch_order,
          // A field this model does not know about — e.g. one Azure adds later.
          trackedProperties: { correlationId: '@triggerBody()?[\'id\']' },
          operationOptions: 'DisableAsyncPattern',
        },
      },
    };
    const back = graphToWdl(wdlToGraph(withUnknown), withUnknown, { persistLayout: false });
    expect(back.actions?.Fetch_order?.trackedProperties).toEqual({
      correlationId: '@triggerBody()?[\'id\']',
    });
    expect(back.actions?.Fetch_order?.operationOptions).toBe('DisableAsyncPattern');
  });

  it('preserves the trigger kind discriminator and its schema', () => {
    const graph = wdlToGraph(REAL);
    const trig = graph.nodes.find((n) => n.kind === 'trigger');
    expect(trig?.type).toBe('Request');
    expect(trig?.operationKind).toBe('Http');
    const back = graphToWdl(graph, REAL, { persistLayout: false });
    expect(back.triggers?.When_a_HTTP_request_is_received?.kind).toBe('Http');
    expect(back.triggers?.When_a_HTTP_request_is_received?.inputs).toEqual(
      REAL.triggers!.When_a_HTTP_request_is_received.inputs,
    );
  });

  it('a trigger never emits a runAfter (Azure rejects that)', () => {
    const back = graphToWdl(wdlToGraph(REAL), REAL, { persistLayout: false });
    expect(back.triggers?.When_a_HTTP_request_is_received).not.toHaveProperty('runAfter');
  });

  it('the first action emits an EMPTY runAfter, not a missing one', () => {
    const back = graphToWdl(wdlToGraph(REAL), REAL, { persistLayout: false });
    expect(back.actions?.Fetch_order?.runAfter).toEqual({});
  });

  it('preserves top-level parameters and schema', () => {
    const back = graphToWdl(wdlToGraph(REAL), REAL, { persistLayout: false });
    expect(back.parameters).toEqual({ apiKey: { type: 'SecureString', defaultValue: '' } });
    expect(back.$schema).toBe(REAL.$schema);
  });

  it('handles an empty definition without throwing', () => {
    const g = wdlToGraph(emptyDefinition());
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    const back = graphToWdl(g, emptyDefinition(), { persistLayout: false });
    expect(back.triggers).toEqual({});
    expect(back.actions).toEqual({});
  });

  it('tolerates null/undefined input', () => {
    expect(wdlToGraph(null).nodes).toEqual([]);
    expect(wdlToGraph(undefined).edges).toEqual([]);
  });

  it('normalizes a malformed runAfter status list to Succeeded', () => {
    const bad: WdlDefinition = {
      triggers: {},
      actions: {
        A: { type: 'Compose', inputs: 1, runAfter: {} },
        B: { type: 'Compose', inputs: 2, runAfter: { A: 'not-an-array' as unknown as string[] } },
      },
    };
    const g = wdlToGraph(bad);
    expect(g.edges.find((e) => e.target === 'B')?.statuses).toEqual(['Succeeded']);
  });
});

describe('layout persistence', () => {
  it('persists node positions into metadata under the Loom key', () => {
    const graph = wdlToGraph(REAL);
    graph.nodes[0] = { ...graph.nodes[0], position: { x: 42, y: 84 } };
    const back = graphToWdl(graph, REAL);
    const layout = (back.metadata as Record<string, any>)[LOOM_LAYOUT_KEY];
    expect(layout[graph.nodes[0].id]).toEqual({ x: 42, y: 84 });
  });

  it('restores saved positions on the next open instead of auto-laying out', () => {
    const graph = wdlToGraph(REAL);
    graph.nodes[0] = { ...graph.nodes[0], position: { x: -7, y: 999 } };
    const saved = graphToWdl(graph, REAL);
    const reopened = wdlToGraph(saved);
    expect(reopened.nodes.find((n) => n.id === graph.nodes[0].id)?.position).toEqual({ x: -7, y: 999 });
  });

  it('does not clobber pre-existing metadata keys', () => {
    const withMeta: WdlDefinition = { ...REAL, metadata: { somethingElse: 'keep me' } };
    const back = graphToWdl(wdlToGraph(withMeta), withMeta);
    expect((back.metadata as Record<string, unknown>).somethingElse).toBe('keep me');
  });
});

describe('autoLayout', () => {
  it('ranks by longest dependency depth', () => {
    const runAfter: Record<string, string[]> = { A: [], B: ['A'], C: ['B'], D: ['A'] };
    const pos = autoLayout(['A', 'B', 'C', 'D'], (n) => runAfter[n]);
    expect(pos.A.y).toBe(0);
    expect(pos.B.y).toBe(NODE_VGAP);
    expect(pos.C.y).toBe(NODE_VGAP * 2);
    // D depends only on A, so it shares B's rank.
    expect(pos.D.y).toBe(NODE_VGAP);
  });

  it('spreads siblings on the same rank horizontally, centred', () => {
    const runAfter: Record<string, string[]> = { A: [], B: ['A'], C: ['A'] };
    const pos = autoLayout(['A', 'B', 'C'], (n) => runAfter[n]);
    expect(pos.B.x).toBe(-NODE_HGAP / 2);
    expect(pos.C.x).toBe(NODE_HGAP / 2);
  });

  it('is deterministic across calls', () => {
    const runAfter: Record<string, string[]> = { A: [], B: ['A'], C: ['A'], D: ['B', 'C'] };
    const f = (n: string) => runAfter[n];
    expect(autoLayout(['A', 'B', 'C', 'D'], f)).toEqual(autoLayout(['A', 'B', 'C', 'D'], f));
  });

  it('does not hang on a cyclic dependency', () => {
    const runAfter: Record<string, string[]> = { A: ['B'], B: ['A'] };
    const pos = autoLayout(['A', 'B'], (n) => runAfter[n]);
    expect(Object.keys(pos).sort()).toEqual(['A', 'B']);
  });

  it('places actions below the trigger rank when no layout is saved', () => {
    const g = wdlToGraph(REAL);
    const trig = g.nodes.find((n) => n.kind === 'trigger')!;
    const firstAction = g.nodes.find((n) => n.id === 'Fetch_order')!;
    expect(firstAction.position.y).toBeGreaterThan(trig.position.y);
  });
});

describe('graph editing', () => {
  it('removeNode bridges predecessors to successors so the tail is not orphaned', () => {
    const g = wdlToGraph(REAL);
    const next = removeNode(g, 'Parse_order');
    expect(next.nodes.find((n) => n.id === 'Parse_order')).toBeUndefined();
    // Fetch_order → Check_total is now a direct edge.
    expect(next.edges.some((e) => e.source === 'Fetch_order' && e.target === 'Check_total')).toBe(true);
    expect(next.edges.some((e) => e.source === 'Parse_order' || e.target === 'Parse_order')).toBe(false);
  });

  it('removeNode of a leaf leaves the rest of the chain intact', () => {
    const g = wdlToGraph(REAL);
    const next = removeNode(g, 'Handle_failure');
    expect(next.edges.some((e) => e.target === 'Handle_failure')).toBe(false);
    expect(next.edges.some((e) => e.source === 'Fetch_order' && e.target === 'Parse_order')).toBe(true);
  });

  it('renameNode rewrites every runAfter reference', () => {
    const g = wdlToGraph(REAL);
    const next = renameNode(g, 'Fetch_order', 'Get_order');
    expect(next.nodes.some((n) => n.id === 'Get_order')).toBe(true);
    expect(next.edges.filter((e) => e.source === 'Get_order')).toHaveLength(2);
    expect(next.edges.some((e) => e.source === 'Fetch_order')).toBe(false);

    const back = graphToWdl(next, REAL, { persistLayout: false });
    expect(back.actions?.Parse_order?.runAfter).toEqual({ Get_order: ['Succeeded'] });
    expect(back.actions).not.toHaveProperty('Fetch_order');
  });

  it('renameNode de-duplicates against an existing name', () => {
    const g = wdlToGraph(REAL);
    const next = renameNode(g, 'Fetch_order', 'Parse_order');
    expect(next.nodes.some((n) => n.id === 'Parse_order_2')).toBe(true);
  });

  it('connectNodes adds a dependency and is idempotent', () => {
    const g = wdlToGraph(REAL);
    const a = connectNodes(g, 'Parse_order', 'Handle_failure');
    expect(a.edges.some((e) => e.source === 'Parse_order' && e.target === 'Handle_failure')).toBe(true);
    const b = connectNodes(a, 'Parse_order', 'Handle_failure');
    expect(b.edges.length).toBe(a.edges.length);
  });

  it('connectNodes refuses to make a trigger a runAfter predecessor', () => {
    const g = wdlToGraph(REAL);
    const next = connectNodes(g, 'When_a_HTTP_request_is_received', 'Fetch_order');
    expect(next.edges).toEqual(g.edges);
  });

  it('connectNodes refuses an edge that would create a cycle', () => {
    const g = wdlToGraph(REAL);
    // Check_total already depends (transitively) on Fetch_order.
    const next = connectNodes(g, 'Check_total', 'Fetch_order');
    expect(next.edges).toEqual(g.edges);
  });

  it('wouldCycle detects a transitive loop', () => {
    const g = wdlToGraph(REAL);
    expect(wouldCycle(g, 'Check_total', 'Fetch_order')).toBe(true);
    expect(wouldCycle(g, 'Fetch_order', 'Handle_failure')).toBe(false);
  });

  it('disconnectNodes drops exactly the named edge', () => {
    const g = wdlToGraph(REAL);
    const id = g.edges.find((e) => e.target === 'Parse_order')!.id;
    const next = disconnectNodes(g, id);
    expect(next.edges.some((e) => e.id === id)).toBe(false);
    expect(next.edges.length).toBe(g.edges.length - 1);
  });

  it('an edit → save → reopen cycle keeps the edit', () => {
    const g = wdlToGraph(REAL);
    const edited = removeNode(g, 'Handle_failure');
    const saved = graphToWdl(edited, REAL);
    const reopened = wdlToGraph(saved);
    expect(reopened.nodes.some((n) => n.id === 'Handle_failure')).toBe(false);
    expect(reopened.nodes.some((n) => n.id === 'Check_total')).toBe(true);
  });
});

describe('uniqueOperationName', () => {
  it('spaces become underscores', () => {
    expect(uniqueOperationName('Fetch order', [])).toBe('Fetch_order');
  });
  it('suffixes on collision', () => {
    expect(uniqueOperationName('HTTP', ['HTTP'])).toBe('HTTP_2');
    expect(uniqueOperationName('HTTP', ['HTTP', 'HTTP_2'])).toBe('HTTP_3');
  });
  it('strips characters Azure rejects in an operation name', () => {
    expect(uniqueOperationName('a/b\\c#d', [])).toBe('abcd');
  });
  it('falls back when the name sanitizes to nothing', () => {
    expect(uniqueOperationName('///', [])).toBe('Action');
  });
});

describe('validateGraph', () => {
  it('flags a workflow with no trigger', () => {
    const g = wdlToGraph({ triggers: {}, actions: { A: { type: 'Compose', runAfter: {} } } });
    expect(g.nodes.length).toBe(1);
    expect(validateGraph(g).some((i) => i.severity === 'error' && /at least one trigger/.test(i.message))).toBe(true);
  });

  it('accepts the realistic workflow with no errors', () => {
    const issues = validateGraph(wdlToGraph(REAL));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags an operation with no type', () => {
    const g = wdlToGraph({
      triggers: { T: { type: 'Recurrence' } },
      actions: { Broken: { runAfter: {} } as never },
    });
    expect(validateGraph(g).some((i) => i.nodeId === 'Broken' && i.severity === 'error')).toBe(true);
  });

  it('flags a runAfter pointing at a step that does not exist', () => {
    const g = wdlToGraph({
      triggers: { T: { type: 'Recurrence' } },
      actions: { A: { type: 'Compose', runAfter: { Ghost: ['Succeeded'] } } },
    });
    expect(validateGraph(g).some((i) => /unknown step 'Ghost'/.test(i.message))).toBe(true);
  });

  it('warns (not errors) when several actions start in parallel', () => {
    const g = wdlToGraph({
      triggers: { T: { type: 'Recurrence' } },
      actions: {
        A: { type: 'Compose', runAfter: {} },
        B: { type: 'Compose', runAfter: {} },
      },
    });
    const issues = validateGraph(g);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.severity === 'warning' && /parallel/.test(i.message))).toBe(true);
  });
});
