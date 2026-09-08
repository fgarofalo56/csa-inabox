/**
 * LOOM BRAIN — the purity guard, and the record of the mutation receipt.
 *
 * ── PART 1: THE PURITY GUARD ───────────────────────────────────────────────
 * The program's non-negotiable rule is RECOMMEND ONLY: nothing in the Brain may
 * delete, scale or mutate an Azure resource. The measured reason is blast radius
 * — 12 of the 13 Container App environments across these subscriptions are NOT
 * Loom's, so a wrong ownership inference reaches someone else's production.
 *
 * The strongest form of that guarantee is structural: the graph substrate has no
 * client to mutate WITH. This guard reads every source file under
 * `lib/brain/graph` plus `lib/brain/types.ts` and asserts none of them imports an
 * Azure SDK, calls `fetch`, or reaches the filesystem.
 *
 * TWO THINGS THIS GUARD DOES THAT MOST DO NOT, because this repo has repeatedly
 * shipped guards that watch nothing:
 *
 *   1. IT ASSERTS ITS OWN POPULATION. A guard that globbed zero files would pass
 *      silently forever. The file count is asserted to be non-zero AND to
 *      include the modules by name, so deleting a module does not quietly
 *      shrink what is watched.
 *
 *   2. IT CARRIES AN EMBEDDED CONTROL. The forbidden-pattern matcher is run
 *      against a synthetic string that DOES contain a violation, proving the
 *      matcher can actually fire. Without that, a broken regex and a clean
 *      codebase are indistinguishable — both produce zero hits.
 *
 * ── PART 2: THE MUTATION RECEIPT ───────────────────────────────────────────
 * The `''`-becomes-dangling behaviour was verified by MUTATION, not by
 * inspection. In `graph/extractors/bicep.ts`, immediately after
 * `parseValueExpression`, this line was inserted:
 *
 *     if (parsed.emptyValue) continue;   // MUTATION: drop empty wires entirely
 *
 * i.e. exactly the failure the design exists to prevent — an empty value
 * producing NO edge rather than a dangling one. MEASURED, both runs:
 *
 *     clean      RC=0   8 files, 103 passed
 *     mutated    RC=1   2 files failed, 6 tests failed / 97 passed
 *
 * The six that turn red:
 *
 *   • bicep-extractor            — "emits a DANGLING edge for `value: ''`"
 *   • bicep-extractor            — "preserves the raw value verbatim"
 *   • bicep-extractor            — "a ternary whose branches are BOTH empty"
 *   • bicep-extractor            — "records an empty wire with no binding as skipped"
 *   • bicep-extractor            — "reports its population"
 *   • capacity-broker.acceptance — "THE EVIDENCE CHAIN survives"
 *
 * ── THE INSTRUCTIVE PART: WHAT STAYS GREEN ─────────────────────────────────
 * "THE FINDING: the broker has ZERO inbound `configured` edges" PASSES under the
 * mutation. Under it the broker is still unreachable — it is just unreachable
 * for no stated reason. The mutation removes the RECEIPT and leaves the VERDICT
 * intact. That is why the evidence assertions live in their own `it` blocks
 * rather than as extra expectations inside the reachability test: folded in,
 * they would be masked by a passing verdict and the mutation would become
 * undetectable.
 *
 * Also measured, and worth recording because it corrected a prediction made
 * while writing this: "the graph build report states the population" was
 * expected to fail and did NOT. `edgesByResolution.dangling > 0` still holds
 * under the mutation because the LIVE container-app-env extractor was not
 * mutated and still emits its own empty-value edge for `LOOM_BROKER_URL`. So a
 * whole-graph count is a WEAKER witness than a per-edge assertion — a second
 * source of dangling edges masks the loss of the first. Detector authors: assert
 * the specific edge, not the aggregate.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as brainGraph from '../../graph';

const GRAPH_DIR = join(__dirname, '..', '..', 'graph');
const TYPES_FILE = join(__dirname, '..', '..', 'types.ts');

/**
 * EVERY regular file under `dir`, whatever its extension.
 *
 * This used to filter to `.ts` INSIDE the predicate, and that filter was the
 * hole: the guard's population was defined by the same expression that read it,
 * so a `graph/shell.mjs` (or `.js`, or `.cjs`) dropped into the substrate was
 * not a violation the guard reported — it was a file the guard could not see.
 * A filter inside the predicate cannot go red; it can only shrink what is
 * watched. The extension is now asserted as its OWN test over this full list.
 */
function allEntries(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allEntries(full));
    else out.push(full);
  }
  return out;
}

/**
 * Every way a module can be named in this codebase — static `from`, bare
 * `import 'x'` for side effects, dynamic `import('x')`, and CJS `require('x')`.
 *
 * WHY THIS HELPER EXISTS. Each pattern below used to be hand-written as
 * `from\s+['"]node:fs['"]`, which matched exactly ONE of those four forms and
 * only the `node:`-prefixed spelling. `const fs = await import('node:fs')`,
 * `require('fs')` and `from 'fs'` all sailed through — see the four spelling
 * controls in the CONTROL test. Keying a guard to a SPELLING rather than to the
 * shape is how the same bypass keeps arriving under a new name.
 */
function specifierRe(spec: string): string {
  return `(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*['"]${spec}['"]`;
}

/** A node builtin, bare or `node:`-prefixed, with optional subpath. */
function builtinRe(name: string): string {
  return specifierRe(`(?:node:)?${name}(?:/[A-Za-z0-9_-]+)?`);
}

/**
 * Patterns that would mean the substrate can reach outside itself. Each is
 * exercised against EVERY control below, so a regex that matches nothing
 * anywhere is caught rather than mistaken for a clean result — and every
 * pattern is additionally run against the benign corpus, so a pattern
 * broadened until it matches everything is caught too.
 */
const FORBIDDEN: readonly {
  readonly name: string;
  readonly re: RegExp;
  readonly controls: readonly string[];
}[] = [
  {
    name: 'Azure SDK import',
    re: new RegExp(specifierRe('@azure/[^\'"]+')),
    controls: [
      "import { DefaultAzureCredential } from '@azure/identity';",
      "import '@azure/identity';",
      "const cred = await import('@azure/identity');",
      "const cred = require('@azure/arm-appcontainers');",
    ],
  },
  {
    name: 'network call',
    re: new RegExp(
      [
        '\\bfetch\\s*\\(',
        '\\baxios\\b',
        builtinRe('https?'),
        specifierRe('undici'),
        specifierRe('node-fetch'),
      ].join('|'),
    ),
    controls: [
      'const r = await fetch(url);',
      "import https from 'node:https';",
      "import http from 'http';",
      "const { request } = await import('node:https');",
      "const undici = require('undici');",
      "import fetchPolyfill from 'node-fetch';",
    ],
  },
  {
    name: 'filesystem access',
    re: new RegExp(builtinRe('fs')),
    controls: [
      "import { readFileSync } from 'node:fs';",
      "import { readFile } from 'node:fs/promises';",
      "import { readFileSync } from 'fs';",
      "const fs = await import('node:fs');",
      "const fs = require('fs');",
    ],
  },
  {
    name: 'process spawn',
    re: new RegExp(
      [builtinRe('child_process'), '\\b(?:execSync|execFileSync|spawnSync)\\s*\\('].join('|'),
    ),
    controls: [
      "import { execSync } from 'node:child_process';",
      "import { spawn } from 'child_process';",
      "const cp = await import('node:child_process');",
      "const cp = require('child_process');",
      'const out = execFileSync(bin, args);',
      'const out = spawnSync(bin, args);',
    ],
  },
  {
    // The precise form of "cannot mutate Azure". A name heuristic was tried
    // first and rejected: `^scale` flagged `scaleUnknownCount`, a read-only
    // counter, and the cure for a guard that fires on a legitimate sibling is a
    // SHARPER pattern, never an allowlist entry — an allowlist reason that is
    // true of a healthy sibling is how a guard gets talked down to nothing.
    name: 'ARM write verb',
    re: /\bmethod\s*:\s*['"](PUT|POST|PATCH|DELETE)['"]/i,
    controls: ["await http({ method: 'DELETE', url });", 'await http({ method: "put", url });'],
  },
];

/**
 * NEGATIVE controls. Broadening a pattern until it matches everything is the
 * mirror-image failure of a pattern that matches nothing: both make the guard
 * useless, and only one of them is visible as a red test. Every line here is
 * legitimate substrate code (or something structurally like it) and NO pattern
 * may match any of it.
 */
const BENIGN: readonly string[] = [
  "import type { BrainNode } from '../types';",
  "import { canonicalPath } from './node-id';",
  'const m = NAME_RE.exec(line);',
  'while ((match = re.exec(text)) !== null) out.push(match[1]!);',
  'const scaleUnknownCount = nodes.filter((n) => n.scale === undefined).length;',
  "const method = 'GET';",
  "if (n.resourceType.toLowerCase() === 'microsoft.app/containerapps') return true;",
  'export function fetchPlanFromGraph(graph: BrainGraphView) { return graph.nodes; }',
];

describe('the graph substrate is PURE — it has no client to mutate with', () => {
  const graphEntries = allEntries(GRAPH_DIR);
  const files = [...graphEntries, TYPES_FILE];

  it('EXTENSION: every file under lib/brain/graph is TypeScript, so none escapes the scan', () => {
    // The population contract, stated as its own assertion rather than hidden
    // in the collector's predicate. Drop `graph/shell.mjs` into the substrate
    // and this goes red naming it; under the old `endsWith('.ts')` filter the
    // file was simply never read and every pattern check below stayed green.
    const nonTs = graphEntries.filter((f) => !f.endsWith('.ts')).map((f) => f.replace(/\\/g, '/'));
    expect(
      nonTs,
      'a non-.ts file under lib/brain/graph is not covered by the purity patterns below. ' +
        'Either it does not belong in the substrate, or this guard must be taught to read it — ' +
        'silently skipping it is the one option that is not available.',
    ).toEqual([]);
  });

  it('POPULATION: the guard actually read the modules it claims to watch', () => {
    // A guard over an empty file set is green and blind. Assert the count AND
    // the names, so deleting a module cannot silently shrink the watched set.
    expect(files.length).toBeGreaterThanOrEqual(7);
    const names = files.map((f) => f.replace(/\\/g, '/'));
    for (const expected of [
      'lib/brain/types.ts',
      'lib/brain/graph/graph.ts',
      'lib/brain/graph/node-id.ts',
      'lib/brain/graph/index.ts',
      'lib/brain/graph/extractors/resource-graph.ts',
      'lib/brain/graph/extractors/bicep.ts',
      'lib/brain/graph/extractors/container-app-env.ts',
      'lib/brain/graph/extractors/source-imports.ts',
    ]) {
      expect(names.some((n) => n.endsWith(expected))).toBe(true);
    }
    // …and every file actually had content read off disk.
    for (const f of files) expect(readFileSync(f, 'utf8').length).toBeGreaterThan(0);
  });

  it('CONTROL: every forbidden-pattern matcher can actually fire, in every module form', () => {
    // Without this, a broken regex and a clean codebase produce identical
    // results — zero hits — and the guard would pass forever while watching
    // nothing. Each category now carries a control per SPELLING (static
    // `from`, bare side-effect `import`, dynamic `import(`, CJS `require(`,
    // bare and `node:`-prefixed), because the previous single control only
    // ever proved the one form it was written in.
    for (const p of FORBIDDEN) {
      expect(p.controls.length, `${p.name} has no controls`).toBeGreaterThan(0);
      for (const c of p.controls) {
        expect(p.re.test(c), `${p.name} matcher failed its control: ${c}`).toBe(true);
      }
    }
  });

  it('NEGATIVE CONTROL: no matcher fires on legitimate substrate code', () => {
    // The mirror of the control above. A pattern broadened to `/fs/` would pass
    // every positive control and flag the whole codebase; only a benign corpus
    // catches that, and a guard nobody can keep green gets deleted.
    const hits: string[] = [];
    for (const line of BENIGN) {
      for (const p of FORBIDDEN) if (p.re.test(line)) hits.push(`${p.name} <- ${line}`);
    }
    expect(hits).toEqual([]);
  });

  it('no module imports an Azure SDK, calls the network, or touches fs/child_process', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Strip block and line comments: this module's own documentation quotes
      // several of these patterns, and a guard that fires on its own prose is a
      // guard that gets weakened until it stops firing at all.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const p of FORBIDDEN) {
        if (p.re.test(code)) violations.push(`${file.replace(/\\/g, '/')}: ${p.name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the public surface is non-trivial, so the guards above range over real exports', () => {
    // Population for the export-surface checks. A barrel that exported nothing
    // would make any assertion about its contents vacuously true.
    const surface = Object.keys(brainGraph);
    expect(surface.length).toBeGreaterThan(10);
    expect(surface).toContain('buildGraph');
    expect(surface).toContain('nodesWithNoInboundEdge');
  });
});

describe('the mutation receipt — what the empty-wire branch is load-bearing for', () => {
  /** Each evidence assertion, and the spec file it must live in as its OWN `it`. */
  const EVIDENCE_TESTS: readonly { readonly file: string; readonly name: string }[] = [
    {
      file: 'capacity-broker.acceptance.test.ts',
      name: 'THE EVIDENCE CHAIN survives: the main.bicep line, the symbol, and the empty-string value',
    },
    { file: 'bicep-extractor.test.ts', name: "emits a DANGLING edge for `value: ''` — it is not dropped" },
    {
      file: 'bicep-extractor.test.ts',
      name: 'preserves the raw value verbatim, so the receipt shows the empty string',
    },
  ];

  /** An `it(` whose title is exactly `name`, in either quote style. */
  function itBlockCount(source: string, name: string): number {
    let n = 0;
    for (const q of ['"', "'"]) {
      if (name.includes(q)) continue; // this title cannot be written in that quote
      n += source.split(`it(${q}${name}${q}`).length - 1;
    }
    return n;
  }

  it('every evidence assertion still lives in its OWN `it`, in the file that names it', () => {
    // THIS ASSERTION USED TO RANGE OVER A LOCAL LITERAL ARRAY — `length > 0`
    // and uniqueness of an array declared three lines above. It passed with the
    // real names, with fabricated names, and with `['x']`, so it could not fail
    // and proved nothing. It now reads the actual spec files.
    //
    // The regression it guards, verbatim from the comment it replaces: if
    // someone folds these evidence expectations INTO the reachability test, the
    // empty-wire mutation stops being detectable as a separate red test.
    for (const t of EVIDENCE_TESTS) {
      const source = readFileSync(join(__dirname, t.file), 'utf8');
      expect(source.length, `${t.file} was not read`).toBeGreaterThan(0);
      expect(itBlockCount(source, t.name), `${t.file}: no own \`it\` titled "${t.name}"`).toBe(1);
    }
  });

  it('CONTROL: the `it`-block matcher can return zero, so the check above can fail', () => {
    // Population + falsifiability for the assertion above. Without this, a
    // matcher that counted every string in the file would report 1 for anything
    // and the guard would be back to proving nothing.
    const real = readFileSync(join(__dirname, 'bicep-extractor.test.ts'), 'utf8');
    expect(itBlockCount(real, 'a test title that is deliberately not present anywhere')).toBe(0);
    // …and it must not match a name that appears only as prose, never as an `it`.
    expect(real).toContain('the empty wire'); // present as a describe/comment…
    expect(itBlockCount(real, 'the empty wire')).toBe(0); // …but not as its own `it`
  });
});
