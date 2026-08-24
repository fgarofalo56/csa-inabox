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

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FORBIDDEN: readonly { readonly name: string; readonly re: RegExp; readonly control: string }[] = [
  {
    name: 'Azure SDK import',
    re: /from\s+['"]@azure\//,
    control: "import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';",
  },
  {
    name: 'network call',
    re: /\bfetch\s*\(|\baxios\b|from\s+['"]node:https?['"]/,
    control: 'const r = await fetch(url);',
  },
  {
    name: 'filesystem access',
    re: /from\s+['"]node:fs['"]|require\(['"]fs['"]\)/,
    control: "import { readFileSync } from 'node:fs';",
  },
  {
    name: 'process spawn',
    re: /from\s+['"]node:child_process['"]|\bexecSync\s*\(/,
    control: "import { execSync } from 'node:child_process';",
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
    control: "await http({ method: 'DELETE', url });",
  },
  {
    name: 'self-approving proposal',
    re: /requiresHumanApproval\s*:\s*false|mutatesAzure\s*:\s*true/,
    control: 'return { kind: "proposal", requiresHumanApproval: false };',
  },
];

describe('the detectors are PURE — they have no client to mutate with', () => {
  const files = sourceFiles(DETECTORS_DIR);

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
      expect(p.re.test(p.control), `${p.name} matcher failed its own control`).toBe(true);
    }
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
