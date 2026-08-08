/**
 * R16 — the COMPILE-TIME half of the typed client-route map (B-R15-17).
 *
 * These assertions live here, in the console's vitest suite, for one reason:
 * this is a lane that HAS `apps/fiab-console/node_modules`, and therefore has
 * `typescript/bin/tsc`. Their first home was `scripts/ci/__tests__/`, which runs
 * in the `guardrails` job — a job that installs no console dependencies. There,
 * every fixture failed with `Error: Cannot find module '…/typescript/bin/tsc'`,
 * and the failure mode is worth recording because it is the exact trap this
 * repo keeps re-discovering:
 *
 *   the NEGATIVE test failed loudly, but every POSITIVE test PASSED — because
 *   they assert `doesNotMatch(/error TS/)`, and "Cannot find module" contains no
 *   `error TS`. A missing compiler read as "the code type-checks cleanly".
 *
 * So the suite would have reported 5 green type assertions while type-checking
 * nothing at all. `assertCompilerPresent()` below closes that: it fails, loudly,
 * if tsc is absent, rather than letting absence masquerade as success.
 *
 * The pure-logic half (generator, regex derivation, R17 guard) stays in
 * `scripts/ci/__tests__/client-route-map.test.mjs`, which needs no toolchain.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CONSOLE_ROOT = path.resolve(__dirname, '..', '..');
const TSC = path.join(CONSOLE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const GENERATED = path.join(CONSOLE_ROOT, 'lib', 'api-routes.generated.d.ts');

function assertCompilerPresent(): void {
  if (!fs.existsSync(TSC)) {
    throw new Error(
      `TypeScript compiler not found at ${TSC}. These are COMPILE-TIME assertions; ` +
      'without tsc they would pass vacuously (a missing binary emits no "error TS"). ' +
      'Run pnpm install in apps/fiab-console.',
    );
  }
}

/**
 * Type-check a one-file fixture against the console's real `@/*` path mapping.
 *
 * The fixture is written INTO the console tree, not a temp dir, so `@/lib/...`
 * resolves the way it does in production — a temp-dir fixture would fail to
 * resolve for an unrelated reason and the negative test would "pass" on it.
 * A generated tsconfig is used because `--paths` is not settable on the CLI
 * (TS6064), which was itself a source of exactly this class of false pass.
 */
function typecheck(body: string): string {
  const stem = `__route_type_probe_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(CONSOLE_ROOT, `${stem}.ts`);
  const cfg = path.join(CONSOLE_ROOT, `${stem}.tsconfig.json`);
  try {
    fs.writeFileSync(file, body);
    fs.writeFileSync(cfg, JSON.stringify({
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        lib: ['es2022', 'dom'],
        baseUrl: '.',
        paths: { '@/*': ['./*'] },
        types: [],
      },
      files: [`./${stem}.ts`],
    }));
    const r = spawnSync(process.execPath, [TSC, '-p', cfg], { cwd: CONSOLE_ROOT, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // A CONFIG error (TS5xxx/TS6xxx) or a crashed compiler is not a verdict
    // about the route map. Surface it rather than letting a negative test
    // "succeed" on it.
    expect(out, `tsc CONFIGURATION error — the fixture never type-checked:\n${out}`)
      .not.toMatch(/error TS[56]\d{3}/);
    expect(out, `tsc did not run:\n${out}`).not.toMatch(/Cannot find module/);
    return out;
  } finally {
    for (const f of [file, cfg]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  }
}

const TSC_TIMEOUT = 120_000;

describe('R16 — clientFetch rejects an unknown BFF route at compile time', () => {
  beforeAll(() => {
    assertCompilerPresent();
    expect(fs.existsSync(GENERATED), 'lib/api-routes.generated.d.ts is missing — run: node scripts/ci/generate-client-route-map.mjs').toBe(true);
  });

  it('a KNOWN route type-checks', { timeout: TSC_TIMEOUT }, () => {
    const out = typecheck([
      "import { clientFetch } from '@/lib/client-fetch';",
      "export const a = () => clientFetch('/api/loom/workspaces');",
      '',
    ].join('\n'));
    expect(out, `a real route must compile:\n${out}`).not.toMatch(/error TS/);
  });

  it('an UNKNOWN route FAILS TO COMPILE (this is the whole point)', { timeout: TSC_TIMEOUT }, () => {
    const out = typecheck([
      "import { clientFetch } from '@/lib/client-fetch';",
      "export const a = () => clientFetch('/api/loom/workspacs');",
      '',
    ].join('\n'));
    expect(out, `a bogus route MUST be a compile error, got:\n${out}`).toMatch(/error TS/);
    expect(out, `the diagnostic must name the problem, not read as an opaque mismatch:\n${out}`)
      .toMatch(/No BFF route matches/);
  });

  it('a dynamic segment accepts a concrete value', { timeout: TSC_TIMEOUT }, () => {
    const out = typecheck([
      "import { clientFetch } from '@/lib/client-fetch';",
      "export const a = () => clientFetch('/api/items/lakehouse/abc123');",
      '',
    ].join('\n'));
    expect(out, out).not.toMatch(/error TS/);
  });

  it('a query string is stripped before matching', { timeout: TSC_TIMEOUT }, () => {
    const out = typecheck([
      "import { clientFetch } from '@/lib/client-fetch';",
      "export const a = () => clientFetch('/api/loom/workspaces?take=5');",
      '',
    ].join('\n'));
    expect(out, out).not.toMatch(/error TS/);
  });

  it('a computed `string` path stays unconstrained (the R17 guard covers those)', { timeout: TSC_TIMEOUT }, () => {
    const out = typecheck([
      "import { clientFetch } from '@/lib/client-fetch';",
      'export const a = (u: string) => clientFetch(u);',
      '',
    ].join('\n'));
    expect(out, out).not.toMatch(/error TS/);
  });

  it('a partially-concrete template (prefix + ${string}) still compiles', { timeout: TSC_TIMEOUT }, () => {
    // The EXACT shape that broke five real call sites before the Extract<>
    // clause was added (lib/components/admin/access-report-panel.tsx:100 among
    // them). TS infers `/api/access-governance/report${string}` — WIDER than the
    // union member — so only the reverse assignability direction can accept it.
    //
    // The fixture must reproduce the inference, not merely resemble it: an
    // earlier version assigned the template to a `const`, TS widened it to plain
    // `string`, and the test passed with the Extract<> clause DELETED.
    const out = typecheck([
      "import { clientFetch } from '@/lib/client-fetch';",
      'export const a = (qs: string) =>',
      '  clientFetch(`/api/access-governance/report${qs ? `?${qs}` : \'\'}`);',
      '',
    ].join('\n'));
    expect(out, out).not.toMatch(/error TS/);
  });
});
