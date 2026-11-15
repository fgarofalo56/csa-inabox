/**
 * LOOM BRAIN — the PURITY guard for the detectors.
 *
 * The program's non-negotiable rule is RECOMMEND ONLY: nothing the Brain builds
 * may delete, scale or mutate an Azure resource. The measured reason is blast
 * radius — of the 13 Container App environments across these six subscriptions,
 * ONE is Loom's; the other 12 are the operator's blog, Sentinel, two Atlas
 * estates and more. A wrong ownership inference plus an actuator reaches someone
 * else's production.
 *
 * The strongest form of that guarantee is structural: this directory has no
 * client to mutate WITH. This guard reads every source file under
 * `lib/brain/detectors` and asserts none of them imports an Azure SDK, calls
 * `fetch`, touches the filesystem, or spawns a process.
 *
 * TWO THINGS IT DOES THAT MOST GUARDS DO NOT, because this repo has repeatedly
 * shipped guards that watch nothing:
 *
 *   1. IT ASSERTS ITS OWN POPULATION. A guard that globbed zero files would pass
 *      silently forever. The file count is asserted non-zero AND the modules are
 *      asserted by name, so deleting one does not quietly shrink the watched set.
 *
 *   2. IT CARRIES AN EMBEDDED CONTROL. Every forbidden-pattern matcher is run
 *      against a synthetic string that DOES violate it. Without that, a broken
 *      regex and a clean directory produce identical output — zero hits — and the
 *      guard passes forever while watching nothing.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as detectors from '../../detectors';

const DETECTORS_DIR = join(__dirname, '..', '..', 'detectors');

/**
 * EVERY regular file under `dir`, whatever its extension. The `.ts` filter used
 * to live INSIDE this collector, so a `detectors/shell.mjs` was not a violation
 * the guard reported, it was a file the guard could not see. The extension is
 * asserted as its own test below instead (#3963 residual B).
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
 * Every way a module can be named: static `from`, bare side-effect `import 'x'`,
 * dynamic `import('x')`, CJS `require('x')`. These patterns used to be keyed to
 * ONE spelling (`from 'node:fs'`), so `from 'fs'`, `await import('node:fs')` and
 * `require('@azure/identity')` all passed (#3963 residual A). Same helper as
 * `__tests__/graph/mutation.test.ts`.
 */
function specifierRe(spec: string): string {
  return `(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*['"]${spec}['"]`;
}

/** A node builtin, bare or `node:`-prefixed, with optional subpath. */
function builtinRe(name: string): string {
  return specifierRe(`(?:node:)?${name}(?:/[A-Za-z0-9_-]+)?`);
}

const FORBIDDEN: readonly {
  readonly name: string;
  readonly re: RegExp;
  readonly controls: readonly string[];
}[] = [
  {
    name: 'Azure SDK import',
    re: new RegExp(specifierRe('@azure/[^\'"]+')),
    controls: [
      "import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';",
      "import '@azure/identity';",
      "const cred = await import('@azure/identity');",
      "const cred = require('@azure/identity');",
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
      "import https from 'https';",
      "import http from 'http';",
      "const { request } = await import('node:https');",
      "const undici = require('undici');",
    ],
  },
  {
    name: 'filesystem access',
    re: new RegExp(builtinRe('fs')),
    controls: [
      "import { readFileSync } from 'node:fs';",
      "import { writeFileSync } from 'fs';",
      "import { readFile } from 'node:fs/promises';",
      "const fs = await import('node:fs');",
      "const fs = require('fs');",
    ],
  },
  {
    name: 'process spawn',
    re: new RegExp([builtinRe('child_process'), '\\b(?:execSync|execFileSync|spawnSync)\\s*\\('].join('|')),
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
    // The precise form of "cannot mutate Azure". A name heuristic was rejected
    // for the same reason the graph substrate's guard rejected one: `^scale`
    // flags `scaleUnknownCount`, a read-only counter, and the cure for a guard
    // that fires on a healthy sibling is a SHARPER pattern, never an allowlist
    // entry — an allowlist reason that is true of a healthy sibling is how a
    // guard gets talked down to nothing.
    name: 'ARM write verb',
    re: /\bmethod\s*:\s*['"](PUT|POST|PATCH|DELETE)['"]/i,
    controls: ["await http({ method: 'DELETE', url });", 'await http({ method: "put", url });'],
  },
  {
    name: 'self-approving proposal',
    re: /requiresHumanApproval\s*:\s*false|mutatesAzure\s*:\s*true/,
    controls: ['return { kind: "proposal", requiresHumanApproval: false };'],
  },
];

/**
 * NEGATIVE controls: legitimate detector code that NO pattern may match. A
 * pattern broadened to /fs/ passes every positive control and flags the whole
 * directory; only a benign corpus catches that.
 */
const BENIGN: readonly string[] = [
  "import type { BrainGraphView } from '../graph';",
  "import { canonicalPath } from '../graph/node-id';",
  'const scaleUnknownCount = nodes.filter((n) => n.scale === undefined).length;',
  "const method = 'GET';",
  'export function fetchPlanFromGraph(graph: BrainGraphView) { return graph.nodes; }',
  'const requiresHumanApproval = true;',
];

describe('the detectors are PURE — they have no client to mutate with', () => {
  const files = allEntries(DETECTORS_DIR);

  it('EXTENSION: every file under lib/brain/detectors is TypeScript, so none escapes the scan', () => {
    const nonTs = files.filter((f) => !f.endsWith('.ts')).map((f) => f.replace(/\\/g, '/'));
    expect(
      nonTs,
      'a non-.ts file under lib/brain/detectors is not covered by the purity patterns below; ' +
        'either it does not belong here or this guard must be taught to read it',
    ).toEqual([]);
  });

  it('POPULATION: the guard actually read the modules it claims to watch', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    const names = files.map((f) => f.replace(/\\/g, '/'));
    for (const expected of [
      'lib/brain/detectors/index.ts',
      'lib/brain/detectors/detector-kit.ts',
      'lib/brain/detectors/cost-model.ts',
      'lib/brain/detectors/unreachable-service.ts',
      'lib/brain/detectors/dangling-wire.ts',
      'lib/brain/detectors/orphan.ts',
      'lib/brain/detectors/declared-but-dead.ts',
      'lib/brain/detectors/always-on-unused.ts',
      'lib/brain/detectors/config-drift.ts',
    ]) {
      expect(names.some((n) => n.endsWith(expected)), `not watched: ${expected}`).toBe(true);
    }
    for (const f of files) expect(readFileSync(f, 'utf8').length).toBeGreaterThan(0);
  });

  it('CONTROL: every forbidden-pattern matcher can actually fire', () => {
    for (const p of FORBIDDEN) {
      expect(p.controls.length, `${p.name} has no controls`).toBeGreaterThan(0);
      for (const c of p.controls) {
        expect(p.re.test(c), `${p.name} matcher failed its control: ${c}`).toBe(true);
      }
    }
  });

  it('NEGATIVE CONTROL: no matcher fires on legitimate detector code', () => {
    const hits: string[] = [];
    for (const line of BENIGN) {
      for (const p of FORBIDDEN) if (p.re.test(line)) hits.push(`${p.name} <- ${line}`);
    }
    expect(hits).toEqual([]);
  });

  it('no detector imports an Azure SDK, calls the network, or touches fs/child_process', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const p of FORBIDDEN) {
        if (p.re.test(code)) violations.push(`${file.replace(/\\/g, '/')}: ${p.name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the public surface is non-trivial, so the export checks are not vacuous', () => {
    const surface = Object.keys(detectors);
    expect(surface.length).toBeGreaterThan(10);
    expect(surface).toContain('ALL_DETECTORS');
    expect(surface).toContain('runDetectors');
    expect(surface).toContain('unreachableService');
  });

  it('every detector is a function of exactly one argument — the graph', () => {
    // A detector taking a second argument would be a detector that can be handed
    // a client. `Detector` already types this; the runtime check catches a cast.
    for (const d of detectors.ALL_DETECTORS) {
      expect(typeof d).toBe('function');
      expect(d.length).toBeLessThanOrEqual(1);
    }
  });
});
