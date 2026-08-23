/**
 * SOURCE-LEVEL GUARD — nothing in `lib/brain/agents/**` can reach Azure.
 *
 * The type system pins `mutatesAzure: false` on every proposal, and the runtime
 * tests prove the output is inert data. Neither of those would stop someone
 * ADDING an ARM call to an agent tomorrow: a proposal could stay a proposal
 * while the module that produced it quietly acquired a `fetch` to
 * `management.azure.com`. This scan is the check for that.
 *
 * ── WHY THIS GUARD REPORTS ITS POPULATION ──────────────────────────────────
 * A source scan whose glob stops matching is GREEN AND BLIND — it reports zero
 * violations over zero files and reads exactly like a clean pass. That failure
 * has been found in this repo repeatedly. So the scan asserts a non-zero file
 * count and a non-zero byte count before it asserts anything about content.
 *
 * ── AND WHY IT CARRIES AN EMBEDDED CONTROL ─────────────────────────────────
 * A scanner that matches nothing also reads as a clean pass. The control below
 * is a synthetic source string containing a real violation, run through the SAME
 * function; if the scanner ever stops firing, the control goes red first.
 *
 * ── THE PATTERNS ARE IMPORT- AND CALL-SHAPED, DELIBERATELY ─────────────────
 * `remediator.ts` legitimately contains the STRINGS `az … delete`, `kubectl
 * delete` and `rm -rf` — they are the destructive-command detector's own
 * patterns. A scan keyed on those words would flag the guard that exists to spot
 * them. So this scans for the shapes that actually reach the network: `fetch(`,
 * an `@azure/` import, `child_process`, a `@/lib/azure/` import.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../agents');

/**
 * The ONE file allowed to reach the shared LLM client, and the ONE specifier it
 * is allowed to reach. Every other cross-boundary import in this directory is a
 * violation.
 */
const LLM_EGRESS_FILE = 'model-client.ts';
const ALLOWED_AZURE_SPECIFIER = '@/lib/azure/aoai-chat-client';

const FORBIDDEN: readonly { name: string; re: RegExp }[] = [
  { name: 'fetch-call', re: /\bfetch\s*\(/ },
  { name: 'xhr', re: /\bXMLHttpRequest\b/ },
  { name: 'azure-sdk-import', re: /from\s+['"]@azure\// },
  { name: 'child-process', re: /child_process/ },
  { name: 'exec', re: /\b(?:execSync|execFileSync|spawnSync)\s*\(/ },
  { name: 'node-http', re: /from\s+['"]node:(?:http|https|net)['"]/ },
  { name: 'axios', re: /from\s+['"]axios['"]/ },
];

/** Any import of `@/lib/azure/...`, static or dynamic. */
const AZURE_LIB_IMPORT = /(?:from|import)\s*\(?\s*['"](@\/lib\/azure\/[^'"]+)['"]/g;

interface Violation {
  readonly file: string;
  readonly pattern: string;
  readonly detail: string;
}

/** Scan one file's source. Exported shape so the control uses the same code path. */
function scanSource(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  for (const p of FORBIDDEN) {
    if (p.re.test(src)) out.push({ file, pattern: p.name, detail: p.re.source });
  }
  for (const m of src.matchAll(AZURE_LIB_IMPORT)) {
    const specifier = m[1]!;
    const allowed = file === LLM_EGRESS_FILE && specifier === ALLOWED_AZURE_SPECIFIER;
    if (!allowed) out.push({ file, pattern: 'azure-lib-import', detail: specifier });
  }
  return out;
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.ts'))
    .filter((n) => statSync(join(dir, n)).isFile())
    .sort();
}

describe('lib/brain/agents — nothing here can call Azure', () => {
  const files = tsFilesIn(AGENTS_DIR);
  const sources = new Map(files.map((f) => [f, readFileSync(join(AGENTS_DIR, f), 'utf8')]));
  const totalBytes = [...sources.values()].reduce((n, s) => n + s.length, 0);

  it('POPULATION — the scan actually examined files', () => {
    // A scan over zero files is green and blind. Assert the population BEFORE
    // asserting anything about what it found.
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(totalBytes).toBeGreaterThan(20_000);
    // Name them, so a file silently dropping out of the glob is visible in the diff.
    expect(files).toEqual([
      'contracts.ts',
      'correlator.ts',
      'critic.ts',
      'explainer.ts',
      'index.ts',
      'model-client.ts',
      'pipeline.ts',
      'remediator.ts',
      'tokens.ts',
    ]);
  });

  it('CONTROL — the scanner fires on a synthetic violation', () => {
    // Without this, a scanner that matched nothing would pass every assertion
    // below and read as a clean bill of health.
    const control = [
      "import { ArmClient } from '@azure/arm-appcontainers';",
      "await fetch('https://management.azure.com/x?api-version=2024-03-01', { method: 'DELETE' });",
      "import { aoaiChat } from '@/lib/azure/copilot-orchestrator';",
    ].join('\n');
    const hits = scanSource('synthetic-control.ts', control);
    expect(hits.map((h) => h.pattern).sort()).toEqual([
      'azure-lib-import',
      'azure-sdk-import',
      'fetch-call',
    ]);
  });

  it('CONTROL — the allowance is scoped to ONE file and ONE specifier', () => {
    const line = `await import('${ALLOWED_AZURE_SPECIFIER}');`;
    // Allowed in model-client.ts …
    expect(scanSource(LLM_EGRESS_FILE, line)).toEqual([]);
    // … and a violation anywhere else.
    expect(scanSource('critic.ts', line).map((h) => h.pattern)).toEqual(['azure-lib-import']);
    // A different azure specifier is a violation even in model-client.ts.
    expect(
      scanSource(LLM_EGRESS_FILE, "await import('@/lib/azure/arm-client');").map((h) => h.pattern),
    ).toEqual(['azure-lib-import']);
  });

  it('no agent source contains a network call or an Azure SDK import', () => {
    const violations = [...sources.entries()].flatMap(([f, src]) => scanSource(f, src));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('model-client.ts reaches exactly ONE azure specifier, and it is the shared chat client', () => {
    const src = sources.get(LLM_EGRESS_FILE)!;
    const specifiers = [...src.matchAll(AZURE_LIB_IMPORT)].map((m) => m[1]!);
    expect(specifiers).toEqual([ALLOWED_AZURE_SPECIFIER]);
  });

  it('no OTHER agent source imports from @/lib/azure at all', () => {
    for (const [f, src] of sources) {
      if (f === LLM_EGRESS_FILE) continue;
      const specifiers = [...src.matchAll(AZURE_LIB_IMPORT)].map((m) => m[1]!);
      expect(specifiers, `${f} imports ${specifiers.join(', ')}`).toEqual([]);
    }
  });
});
