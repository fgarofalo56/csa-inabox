/**
 * The ONE place a compiled policy artifact's backend-resolution options are
 * built.
 *
 * ## Why this file exists
 *
 * `compileAll(set, opts)` is called from three places — the reconcile loop
 * (publish), the engine-rules route (serve), and the admin policy-code route
 * (the artifact an operator actually reads). Each one used to build its own
 * option object, and every divergence between them was invisible by
 * construction: the compiler is a pure function, so a test that feeds both
 * sides the same options can never catch an option that only ONE side passes.
 *
 * Two live defects came out of exactly that shape:
 *
 * 1. Reconcile hand-built `{ ucVariant, tenantId }` and dropped
 *    `trinoDefaultCatalog`, so under a non-default `LOOM_TRINO_ICEBERG_CATALOG`
 *    a 2-part `sales.orders` compiled to `iceberg.sales.orders` on the publish
 *    side and `lake.sales.orders` on the serve side. The enforcement receipt
 *    could then never converge, and the engine governed a different table than
 *    the document an admin inspected named.
 * 2. `trinoGroupProvider` was observed on the reconcile path and then handed
 *    only to functions that do not read it (`buildTrinoRulesDocument` /
 *    `buildTrinoRego`), never to the compiler — the sole consumer and the sole
 *    producer of `artifact.warnings`. The reconcile-path artifact therefore
 *    warned that every group-keyed rule "will not match" even when a group file
 *    WAS published. Fail-safe (it over-warns, never under-warns), but it asserts
 *    a state the code did not establish — the `deploy-integrity.md` R7 class.
 * 3. The admin route called `compileAll(set)` with no options at all, so the
 *    artifact an operator reads carried BOTH defects at once.
 *
 * A shared async reader cannot drift the way three hand-copied literals did.
 *
 * ## What is OBSERVED vs. configured
 *
 * `trinoGroupProvider` is deliberately not an env flag. The engine can only
 * resolve a caller's groups once a group file with real members has been
 * PUBLISHED, so the published document is the only honest source. Hardcoding
 * `true` would suppress the warning that tells an operator their group-keyed
 * denies and masks are inert; hardcoding `false` is the bug above.
 */

import type { CompileOptions } from './compile';

/**
 * Resolve the backend options for a one-pass compile of `tenantId`'s policy set.
 *
 * Never throws: a Cosmos or UC-backend lookup failure degrades to the
 * conservative option set (Databricks UC variant, no group provider) rather
 * than failing the compile, because a compiled PREVIEW that cannot render is
 * strictly worse than one that over-warns.
 */
export async function resolveCompileOptions(tenantId: string): Promise<CompileOptions> {
  let ucVariant: 'databricks' | 'oss' = 'databricks';
  try {
    const { resolveUcBackend } = await import('@/lib/azure/uc-backend');
    ucVariant = resolveUcBackend();
  } catch {
    /* default databricks — the OSS override is opt-in via env */
  }

  // OBSERVED, never asserted. A published group file with real members is the
  // only thing that makes a group-keyed rule matchable at the engine.
  let trinoGroupProvider = false;
  try {
    const { readTrinoEngineRules } = await import('./trino-engine-rules');
    const published = await readTrinoEngineRules(tenantId);
    trinoGroupProvider = Boolean(published?.groupFile?.trim());
  } catch {
    // Unreadable publication state is NOT evidence that a provider exists.
    // Staying false keeps the warning on, which is the fail-safe direction.
    trinoGroupProvider = false;
  }

  const { trinoCompileOptionsFromEnv } = await import('./compilers/trino');
  return {
    ucVariant,
    tenantId,
    ...trinoCompileOptionsFromEnv(),
    trinoGroupProvider,
  };
}
