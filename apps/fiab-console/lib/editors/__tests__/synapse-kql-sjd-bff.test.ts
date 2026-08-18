/**
 * Synapse workspace KQL-script + Spark-job-definition family — BFF route
 * existence + realness test, plus client-shape unit tests.
 *
 * Real test (per .claude/rules/no-vaporware.md): verifies the BFF route files
 * the Workspace Resources navigator + the two new editors fetch actually exist
 * on disk AND wire a real Synapse backing client (not a stub), and that the
 * artifact-client factory helpers emit the correct shapes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  emptyKqlScriptProperties,
  emptySparkJobDefinitionProperties,
  synapseKustoPoolUri,
} from '@/lib/azure/synapse-artifacts-client';

const SYNAPSE_API = resolve(__dirname, '..', '..', '..', 'app', 'api', 'synapse');

// route family → segments that MUST exist (the primary action endpoints).
const REQUIRED_ROUTES: Record<string, string[]> = {
  kqlscripts:           ['', '[name]', '[name]/run'],
  sparkjobdefinitions:  ['', '[name]', '[name]/run'],
};

function readRoute(family: string, sub: string): string | null {
  const path = sub ? join(SYNAPSE_API, family, sub, 'route.ts') : join(SYNAPSE_API, family, 'route.ts');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function looksReal(src: string): boolean {
  return /from '@\/lib\/azure\/synapse-(artifacts|dev)-client'/.test(src);
}

/**
 * Does this route enforce a session?
 *
 * Two shapes count, because there are two legitimate ones. A hand-rolled
 * `getSession()` prologue is the older form; a route-toolkit wrapper
 * (`withSession` and friends) is the one `scripts/ci/check-route-toolkit.mjs`
 * ratchets the codebase TOWARD — it runs the identical check with a
 * byte-compatible envelope and adds the try/catch → 500 discipline, so it is
 * strictly stronger, not weaker.
 *
 * Matching only the literal `getSession(` made this assertion fail the moment
 * `sparkjobdefinitions/[name]/run` was migrated, while the route was better
 * guarded than before — a control keyed to the SHAPE of the fix rather than to
 * the property being enforced. The wrapper regex is the one the guard itself
 * uses (TOOLKIT_RE), including its explicit-type-argument branch, so a route
 * written `withSession<{ name: string }>(…)` is recognised as the call it is.
 */
const TOOLKIT_RE =
  /\bwith(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess|Capability)(?:<[^()]*>)?\s*\(/;
function enforcesSession(src: string): boolean {
  return /getSession\(/.test(src) || TOOLKIT_RE.test(src);
}

describe('Synapse KQL-script + Spark-job-definition BFF routes', () => {
  for (const [family, subs] of Object.entries(REQUIRED_ROUTES)) {
    for (const sub of subs) {
      const label = sub ? `${family}/${sub}` : `${family} (collection)`;
      it(`${label} — route.ts exists and wires a real Synapse client`, () => {
        const src = readRoute(family, sub);
        expect(src, `expected route file for ${label}`).toBeTruthy();
        if (!src) return;
        expect(looksReal(src), `route ${label} must import a real synapse client`).toBe(true);
        // Every route validates the session + honest-gates the workspace.
        expect(enforcesSession(src), `route ${label} must check session`).toBe(true);
        expect(/synapseConfigGate|not_configured/.test(src), `route ${label} must honest-gate the workspace`).toBe(true);
      });
    }
  }

  // The negative control. Widening `enforcesSession` to accept the toolkit
  // wrappers is only safe if it still REFUSES a route that enforces nothing —
  // otherwise the assertion above has quietly become unfalsifiable, which is
  // the failure mode the widening was at risk of introducing.
  it('the session check still FAILS a route that enforces nothing', () => {
    const unguarded = [
      "import { listSparkBatchJobs } from '@/lib/azure/synapse-dev-client';",
      'export async function GET() { return Response.json({ ok: true }); }',
    ].join('\n');
    expect(enforcesSession(unguarded)).toBe(false);

    // …and it accepts BOTH legitimate shapes, so neither form can regress
    // silently into the other's blind spot.
    expect(enforcesSession('const s = getSession();')).toBe(true);
    expect(enforcesSession('export const GET = withSession(async () => {});')).toBe(true);
    expect(enforcesSession('export const GET = withSession<{ name: string }>(async () => {});')).toBe(true);
    // A mention in prose is not enforcement.
    expect(enforcesSession('// this route uses withSession one day')).toBe(false);
  });
});

describe('Synapse artifact-client factory shapes', () => {
  it('emptyKqlScriptProperties pins a KustoPool connection', () => {
    const p = emptyKqlScriptProperties('pool1', 'db1');
    expect(p?.content?.currentConnection?.type).toBe('KustoPool');
    expect(p?.content?.currentConnection?.poolName).toBe('pool1');
    expect(p?.content?.currentConnection?.databaseName).toBe('db1');
    expect(typeof p?.content?.query).toBe('string');
  });

  it('emptyKqlScriptProperties leaves connection unset when no pool given', () => {
    const p = emptyKqlScriptProperties();
    expect(p?.content?.currentConnection?.poolName).toBeUndefined();
    expect(p?.content?.currentConnection?.type).toBe('KustoPool');
  });

  it('emptySparkJobDefinitionProperties targets the given Spark pool', () => {
    const p = emptySparkJobDefinitionProperties('sparkpool1');
    expect(p.targetBigDataPool.referenceName).toBe('sparkpool1');
    expect(p.targetBigDataPool.type).toBe('BigDataPoolReference');
    expect(p.language).toBe('PySpark');
    expect(p.jobProperties).toBeTruthy();
  });

  it('synapseKustoPoolUri builds a workspace-scoped Kusto pool URI', () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'myws';
    const uri = synapseKustoPoolUri('mypool');
    // Commercial default host suffix.
    expect(uri).toBe('https://mypool.myws.kusto.azuresynapse.net');
  });
});
