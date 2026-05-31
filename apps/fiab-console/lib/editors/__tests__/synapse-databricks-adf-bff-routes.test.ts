/**
 * Synapse / Databricks / ADF family — BFF route existence + realness test.
 *
 * Real test (per .claude/rules/no-vaporware.md): verifies that every BFF
 * route file the family editors fetch actually exists on disk AND calls a
 * real Azure backing service (not a stub).
 *
 * Concretely we assert that each route.ts under app/api/items/<family-slug>/
 * imports from `@/lib/azure/*`, `@/lib/databricks/*`, or `@/lib/synapse/*`
 * (which are the modules that wrap real Azure REST clients). A route that
 * only does `return NextResponse.json({})` would not match and would fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const API_ROOT = resolve(__dirname, '..', '..', '..', 'app', 'api', 'items');

// Each family slug → at least one route segment that MUST exist (the
// primary action endpoint the editor relies on for its A-grade flow).
const REQUIRED_ROUTES: Record<string, string[]> = {
  'synapse-dedicated-sql-pool':  ['[id]/query', '[id]/schema', '[id]/state'],
  'synapse-serverless-sql-pool': ['[id]/query', '[id]/schema'],
  'synapse-spark-pool':          ['list', '[id]', '[id]/submit', '[id]/runs'],
  'synapse-pipeline':            ['list', '[id]', '[id]/run', '[id]/runs', '[id]/bind'],
  'databricks-notebook':         ['list', '[id]', '[id]/run', '[id]/runs', '[id]/command', '[id]/context'],
  'databricks-job':              ['', '[id]', '[id]/run', '[id]/runs', '[id]/run-output'],
  'databricks-cluster':          ['', '[id]', '[id]/state', '[id]/events'],
  'databricks-sql-warehouse':    ['[id]/query', '[id]/schema', '[id]/state', '[id]/warehouses', '[id]/edit'],
  'adf-pipeline':                ['', '[id]', '[id]/run', '[id]/runs', '[id]/bind'],
  'adf-dataset':                 ['', '[id]'],
  'adf-trigger':                 ['', '[id]', '[id]/state'],
};

function readRoute(slug: string, sub: string): string | null {
  const path = sub ? join(API_ROOT, slug, sub, 'route.ts') : join(API_ROOT, slug, 'route.ts');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/**
 * Heuristic for "real backend wired" — the route imports a wrapper module
 * (Synapse / Databricks / Azure SDK), references fetch() against an Azure
 * domain, or uses one of the family's known TDS / ARM helpers.
 */
function looksReal(src: string): boolean {
  const realImportPatterns = [
    /from '@\/lib\/azure\//,
    /from '@\/lib\/databricks\//,
    /from '@\/lib\/synapse[-\/]/,
    /azuresynapse\.net/,
    /azuredatabricks\.net/,
    /management\.(usgovcloudapi\.net|azure\.com)/,
    /datafactory\.azure\.com/,
    /@azure\/(identity|arm-|storage-)/,
  ];
  return realImportPatterns.some((re) => re.test(src));
}

describe('Synapse / Databricks / ADF BFF routes — real backend wiring', () => {
  for (const [slug, subs] of Object.entries(REQUIRED_ROUTES)) {
    for (const sub of subs) {
      const label = sub ? `${slug}/${sub}` : `${slug} (collection)`;
      it(`${label} — route.ts exists and wires a real backend`, () => {
        const src = readRoute(slug, sub);
        expect(src, `expected route file for ${label}`).toBeTruthy();
        if (!src) return;
        expect(
          looksReal(src),
          `route ${label} does not appear to import a real Azure backing client; ` +
            `add an import from '@/lib/azure/*', '@/lib/databricks/*', or '@/lib/synapse-*'`,
        ).toBe(true);
      });
    }
  }
});
