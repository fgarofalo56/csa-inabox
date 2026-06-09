import { describe, it, expect } from 'vitest';
import { validateMScript, parseLetBody, appendStep, setQueryBody, buildLetBody } from '@/lib/azure/dataflow-engine-client';
import { buildDataflowTools } from '@/lib/copilot/dataflow-tools';
import type { AoaiTarget } from '@/lib/azure/copilot-orchestrator';

const SECTION = `section Section1;

shared Customers = let
    Source = #table({"Name","Country"}, {{"Anya","Germany"}, {"Bob","USA"}, {"Cara","France"}}),
    #"Changed Type" = Table.TransformColumnTypes(Source, {{"Name", type text}})
in
    #"Changed Type";`;

const FAKE_TARGET: AoaiTarget = { endpoint: 'https://x.openai.azure.com', deployment: 'gpt-4o', apiVersion: '2024-10-21' };

describe('validateMScript', () => {
  it('accepts a well-formed section and counts steps per query', () => {
    const v = validateMScript(SECTION);
    expect(v.ok).toBe(true);
    expect(v.queries).toHaveLength(1);
    expect(v.queries[0]).toEqual({ name: 'Customers', stepCount: 2 });
  });

  it('accepts a bare let..in body (no shared/section)', () => {
    const v = validateMScript('let\n  Source = #table({}, {}),\n  Filtered = Table.SelectRows(Source, each true)\nin\n  Filtered');
    expect(v.ok).toBe(true);
    expect(v.queries[0].stepCount).toBe(2);
  });

  it('rejects empty and non-query text', () => {
    expect(validateMScript('').ok).toBe(false);
    expect(validateMScript('   ').ok).toBe(false);
    expect(validateMScript('not a query').ok).toBe(false);
  });
});

describe('copilot transform apply path (editor parity)', () => {
  it('appends a real filter step that parses back as an Applied Step', () => {
    const body = parseLetBody(
      'let\n    Source = #table({"Country"}, {{"Germany"}})\nin\n    Source',
    );
    expect(body.steps).toHaveLength(1);
    // Mirror the editor: appendStep with a copilot-generated stepName/stepExpr.
    const stepExpr = 'Table.SelectRows(Source, each List.Contains({"Germany","France"}, [Country]))';
    const newBody = appendStep('let\n    Source = #table({"Country"}, {{"Germany"}})\nin\n    Source', {
      key: 'copilot', label: 'Filtered Rows', tab: 'transform', stepName: 'Filtered Rows', expr: () => stepExpr,
    });
    const reparsed = parseLetBody(newBody);
    expect(reparsed.steps.map((s) => s.name)).toEqual(['Source', 'Filtered Rows']);
    expect(reparsed.steps[1].expr).toContain('Table.SelectRows');
    // And it round-trips into the full section.
    const nextSection = setQueryBody(SECTION, 'Customers', newBody);
    expect(validateMScript(nextSection).ok).toBe(true);
  });
});

describe('dataflow_undo_last_step tool (pure, no AOAI)', () => {
  const tools = buildDataflowTools(FAKE_TARGET);
  const undo = tools.find((t) => t.name === 'dataflow_undo_last_step')!;

  it('removes the last applied step and rewires the result', async () => {
    const body = buildLetBody(
      [
        { name: 'Source', expr: '#table({"Country"}, {{"Germany"}})' },
        { name: 'Filtered Rows', expr: 'Table.SelectRows(Source, each true)' },
      ],
      'Filtered Rows',
    );
    const res: any = await undo.handler({ activeQueryName: 'Customers', currentBody: body }, { userOid: 'u', session: { claims: { oid: 't' } } });
    expect(res.ok).toBe(true);
    expect(res.removedStep).toBe('Filtered Rows');
    const after = parseLetBody(res.newBody);
    expect(after.steps.map((s: any) => s.name)).toEqual(['Source']);
    expect(after.result).toBe('Source');
  });

  it('refuses to remove the only remaining step', async () => {
    const body = 'let\n    Source = #table({}, {})\nin\n    Source';
    const res: any = await undo.handler({ activeQueryName: 'Q', currentBody: body }, { userOid: 'u', session: { claims: { oid: 't' } } });
    expect(res.ok).toBe(false);
  });
});

describe('buildDataflowTools registry', () => {
  it('exposes exactly the five Dataflow Copilot capabilities', () => {
    const names = buildDataflowTools(FAKE_TARGET).map((t) => t.name).sort();
    expect(names).toEqual([
      'dataflow_add_transform_step',
      'dataflow_explain_query',
      'dataflow_generate_query_from_nl',
      'dataflow_generate_reference_query',
      'dataflow_undo_last_step',
    ]);
  });
});
