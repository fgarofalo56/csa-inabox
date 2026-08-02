/**
 * The Loom-namespaced Spark conf keys that DECLARE a job's lineage datasets.
 *
 * ## Why these two strings live in a leaf module of their own
 *
 * They are read on the SERVER (`parseSparkDatasets` in `synapse-emitters.ts`,
 * during the LU-8 harvest) and written on the CLIENT (the #2625 Fix-it wizard,
 * `components/lineage/lineage-conf.ts` + `spark-lineage-fixit-dialog.tsx`).
 * Both halves must agree on the spelling exactly — a rename on one side that
 * misses the other silently orphans everything the wizard writes.
 *
 * They cannot be shared via `synapse-emitters.ts` itself: that module reaches
 * `lib/lineage/openlineage` → `thread-edges` → … → `lib/auth/session`, which
 * imports `next/headers`. Importing a plain string constant from it therefore
 * drags the whole server auth chain into the client bundle and `next build`
 * fails with "You're importing a component that needs next/headers" — an error
 * `tsc --noEmit` cannot see, because the types resolve perfectly well.
 *
 * So the constants live HERE, in a module with **zero imports**, and
 * `synapse-emitters.ts` re-exports them for its existing server-side callers.
 * Keep this file dependency-free: adding an import to it re-opens the boundary
 * hole it exists to close.
 */

/** Comma/semicolon-separated storage roots the job READS. */
export const SPARK_CONF_INPUTS = 'spark.loom.lineage.inputs';

/** Comma/semicolon-separated storage roots the job WRITES. */
export const SPARK_CONF_OUTPUTS = 'spark.loom.lineage.outputs';
