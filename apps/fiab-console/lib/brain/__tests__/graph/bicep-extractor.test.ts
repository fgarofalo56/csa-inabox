/**
 * LOOM BRAIN — the bicep extractor.
 *
 * The load-bearing assertions:
 *
 *   • `value: ''` produces a DANGLING edge, not silence and not a resolved one.
 *     This is the founding `loom-capacity-broker` finding and the thing
 *     `mutation.test.ts` attacks directly.
 *   • CRLF and LF produce IDENTICAL output. This repo is mixed — console `.ts`
 *     is CRLF in the working tree while bicep is LF — and a parser that assumes
 *     one silently matches nothing on the other, which reads exactly like "this
 *     file has no env entries": a clean, confident, wrong answer.
 *   • Entries the scanner cannot read are REPORTED, not dropped. An extractor
 *     that returns nothing over a file it failed to parse is indistinguishable
 *     from one that returned nothing over a file with no wires.
 */
import { describe, it, expect } from 'vitest';
import {
  azureResourceNodeId,
  extractFromBicep,
  type NodeId,
} from '../../graph';

const SUB = '11111111-1111-1111-1111-111111111111';
const CONSOLE_ID = azureResourceNodeId(
  `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/loom-console`,
);
const BROKER_ID = azureResourceNodeId(
  `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/loom-capacity-broker`,
) as NodeId;

const PATH = 'platform/fiab/bicep/modules/admin-plane/main.bicep';

/** Verbatim shape of the real `env:` block, including the founding line. */
const ENV_BLOCK_LINES = [
  "        env: [",
  "            { name: 'LOOM_ONELAKE_URL', value: '' }",
  "            { name: 'LOOM_DIRECTLAKE_URL', value: directLakeSvcActive ? 'https://${loomDirectLake!.outputs.fqdn}' : '' }",
  "            { name: 'LOOM_BROKER_URL', value: '' }",
  "        ]",
];

function run(text: string) {
  return extractFromBicep([
    {
      path: PATH,
      text,
      consumer: CONSOLE_ID,
      envVarBindings: { LOOM_BROKER_URL: BROKER_ID },
      moduleTargets: { loomDirectLake: 'loom-direct-lake.internal.example.io' },
    },
  ]);
}

describe('extractFromBicep — the empty wire', () => {
  const result = run(ENV_BLOCK_LINES.join('\n'));

  it("emits a DANGLING edge for `value: ''` — it is not dropped", () => {
    const broker = result.edges.find((e) => e.evidence.symbol === 'LOOM_BROKER_URL');
    expect(broker).toBeDefined();
    expect(broker!.emptyValue).toBe(true);
    expect(broker!.targetRef).toBe('');
    expect(broker!.intendedTo).toBe(BROKER_ID);
  });

  it('preserves the raw value verbatim, so the receipt shows the empty string', () => {
    const broker = result.edges.find((e) => e.evidence.symbol === 'LOOM_BROKER_URL')!;
    // Not "no value found". The wire is there and it carries ''.
    expect(broker.evidence.rawValue).toBe("''");
    expect(broker.evidence.artifact).toBe(PATH);
    expect(broker.evidence.line).toBe(4);
    expect(broker.provenance).toBe('declared');
  });

  it('a NON-empty wire is not marked empty — the flag discriminates', () => {
    const dl = result.edges.find((e) => e.evidence.symbol === 'LOOM_DIRECTLAKE_URL')!;
    expect(dl.emptyValue).toBe(false);
    expect(dl.targetRef).toBe('loom-direct-lake.internal.example.io');
  });

  it('a ternary whose branches are BOTH empty is an empty wire', () => {
    const r = run("            { name: 'LOOM_X', value: someFlag ? '' : '' }");
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.emptyValue).toBe(true);
  });

  it('records an empty wire with no binding as skipped, and STILL emits the edge', () => {
    // LOOM_ONELAKE_URL is empty and has no envVarBindings entry.
    const onelake = result.edges.find((e) => e.evidence.symbol === 'LOOM_ONELAKE_URL')!;
    expect(onelake.emptyValue).toBe(true);
    expect(onelake.intendedTo).toBeNull();
    expect(result.skipped.some((s) => s.subject.includes('LOOM_ONELAKE_URL'))).toBe(true);
  });
});

describe('extractFromBicep — line endings', () => {
  it('CRLF and LF produce IDENTICAL edges', () => {
    const lf = run(ENV_BLOCK_LINES.join('\n'));
    const crlf = run(ENV_BLOCK_LINES.join('\r\n'));

    // Guard the fixture itself: if the CRLF string somehow carried no \r, this
    // test would pass while proving nothing.
    expect(ENV_BLOCK_LINES.join('\r\n')).toContain('\r\n');

    expect(crlf.edges.length).toBe(lf.edges.length);
    expect(crlf.edges.length).toBeGreaterThan(0);
    for (let i = 0; i < lf.edges.length; i++) {
      expect(crlf.edges[i]!.evidence.symbol).toBe(lf.edges[i]!.evidence.symbol);
      expect(crlf.edges[i]!.evidence.line).toBe(lf.edges[i]!.evidence.line);
      expect(crlf.edges[i]!.evidence.rawValue).toBe(lf.edges[i]!.evidence.rawValue);
      expect(crlf.edges[i]!.emptyValue).toBe(lf.edges[i]!.emptyValue);
    }
  });

  it('a lone-CR file is handled too', () => {
    const cr = run(ENV_BLOCK_LINES.join('\r'));
    expect(cr.edges.length).toBe(run(ENV_BLOCK_LINES.join('\n')).edges.length);
  });
});

describe('extractFromBicep — multi-line entries and honesty about limits', () => {
  it('reads a value on its own line', () => {
    const r = run(["  {", "    name: 'LOOM_MULTI'", "    value: 'https://target.example.io'", "  }"].join('\n'));
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.evidence.symbol).toBe('LOOM_MULTI');
    expect(r.edges[0]!.targetRef).toBe('https://target.example.io');
    expect(r.edges[0]!.evidence.line).toBe(2);
  });

  it('REPORTS a name entry whose value it could not find, rather than dropping it', () => {
    const r = run("            { name: 'LOOM_NO_VALUE' }");
    expect(r.edges).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.subject).toContain('LOOM_NO_VALUE');
    // The reason must not claim the variable is unset — only that it was unread.
    expect(r.skipped[0]!.reason).toMatch(/NOT evidence that it is unset/i);
  });

  it('ignores non-env `name:` properties so the graph is not flooded', () => {
    const r = run(
      [
        "  resource thing 'Microsoft.App/containerApps@2024-03-01' = {",
        "    name: 'loom-capacity-broker'",
        "    location: location",
        "  }",
      ].join('\n'),
    );
    expect(r.edges).toHaveLength(0);
  });

  it('strips a trailing line comment without eating a value that contains //', () => {
    const withComment = run("  { name: 'LOOM_A', value: 'https://a.example.io' } // wired 2026-08");
    expect(withComment.edges[0]!.targetRef).toBe('https://a.example.io');
  });

  it('reports its population: entries examined, edges emitted, empties, skips', () => {
    const r = run(ENV_BLOCK_LINES.join('\n'));
    expect(r.population.scope).toMatch(/3 env-var-shaped `name:` entries examined/);
    expect(r.population.scope).toMatch(/3 declared edge\(s\) emitted \(2 EMPTY\)/);
    expect(r.population.subject).toBe('edges');
  });

  it('reports the COST of the env-var-shape filter, not just its survivors', () => {
    // `nameEntriesSeen` counts only what survived the SCREAMING_SNAKE filter,
    // so on its own the scope string cannot distinguish "this file had 2 env
    // vars" from "this file had 2 env vars and 4 other `name:` entries I threw
    // away". On the real 187-file tree that gap is 941 of 1,833 entries (51.3%)
    // — over half of what the extractor looked at, reported nowhere.
    const r = run(
      [
        "        name: 'admin-plane'",
        "        env: [",
        "            { name: 'LOOM_BROKER_URL', value: '' }",
        "            { name: 'rg-csa-loom-hub', value: 'x' }",
        "            { name: 'loomDirectLake', value: 'y' }",
        "        ]",
      ].join('\n'),
    );
    // One kept…
    expect(r.population.scope).toMatch(/1 env-var-shaped `name:` entries examined/);
    // …and THREE rejected, each named in a way a bicep author really writes.
    expect(r.population.scope).toMatch(/\(3 `name:` entr\(ies\) REJECTED as not env-var-shaped\)/);
    // Embedded control: the rejects are genuinely absent from the edges, so the
    // count above is reporting a real filter rather than decorating a no-op.
    expect(r.edges.map((e) => e.evidence.symbol)).toEqual(['LOOM_BROKER_URL']);
  });

  it('an EMPTY file is BLIND, not clean', () => {
    const r = run('');
    expect(r.edges).toHaveLength(0);
    // P3 — zero edges over zero input establishes nothing.
    expect(r.population.blind).toBe(true);
  });

  it('a file that DID emit edges is NOT blind, and counts them by provenance', () => {
    // The counterpart the blind-on-empty assertion needs to mean anything.
    // Without it, `blind` could be — and was — hardcoded true by passing an
    // empty array to makePopulation, so the test above passed over ANY input
    // and `byProvenance` stayed all-zero however many edges were emitted.
    // `byProvenance.<p> === 0` is the vacuous-truth signal detector authors are
    // told to read; it has to reflect what this extractor actually produced.
    const r = run(ENV_BLOCK_LINES.join('\n'));
    expect(r.edges).toHaveLength(3);
    expect(r.population.blind).toBe(false);
    expect(r.population.edgesExamined).toBe(r.edges.length);
    expect(r.population.byProvenance.declared).toBe(3);
    // …and provenance does not bleed: this extractor emits `declared` only.
    expect(r.population.byProvenance.configured).toBe(0);
    expect(r.population.byProvenance.imports).toBe(0);
  });
});
