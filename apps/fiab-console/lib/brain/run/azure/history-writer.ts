/**
 * LOOM BRAIN W10 — the adapter onto W9's graph history (#3936 <- #3935).
 *
 * This is the ONLY module in this lane that names W9's `lib/brain/history`.
 * Everything else talks to the {@link GraphHistoryWriter} port, so W10's tests,
 * its lifecycle and its verdict logic have no dependency on W9 at all.
 *
 * ── WHY THE MODULE IS RESOLVED AT RUNTIME, NOT IMPORTED STATICALLY ─────────
 * W9 (#3935) is IN FLIGHT on its own branch as this lane is written, so
 * `lib/brain/history` is not present on `main` yet. A static
 * `import { captureGraphVersion } from '../../history'` would not compile here
 * and would block W10 on W9's merge, which is exactly the coupling the register
 * split W8–W11 into separate issues to avoid.
 *
 * So the specifier is assembled at runtime and the resolved module is VALIDATED
 * before use. Note carefully what this is NOT: it is not a swallow. There is no
 * fallback, no null writer and no "skip the version if history is unavailable".
 * A missing or mis-shaped module THROWS, with a message naming the exact
 * remediation. A scan that reported findings with no `before` could never say
 * "an edge that should not have formed", which is the whole reason W9 exists —
 * so failing closed is the only correct behaviour.
 *
 * ── WHEN #3935 MERGES ──────────────────────────────────────────────────────
 * Replace `resolveHistoryModule()` with a static import. Nothing else in this
 * lane changes: the port, the scan and every test already speak the final shape.
 * That swap is tracked as a follow-up in the PR body.
 */

import type { CaptureRequest, GraphHistoryWriter, GraphVersionReceipt } from '../ports';

/** The slice of W9's surface this lane uses. Kept minimal on purpose. */
interface HistoryModule {
  captureGraphVersion(args: {
    graph: unknown;
    store: unknown;
    estateId: string;
    collectedProvenances: readonly string[];
    source: string;
  }): Promise<{
    status: 'created' | 'unchanged';
    version: { id: string; counts: { nodes: number; edges: number } };
    pruned: readonly string[];
    notes: readonly string[];
    unchangedReason: string | null;
  }>;
}

/**
 * The exact module specifier, assembled so TypeScript cannot resolve it
 * statically while #3935 is unmerged. Exported for the diagnostic message and
 * for the test that asserts the failure text names it.
 */
export const HISTORY_MODULE_SPECIFIER = ['..', '..', 'history', 'index'].join('/');

export class HistoryModuleUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `the Brain scan could not load the graph-history module ('${HISTORY_MODULE_SPECIFIER}'): ` +
        `${detail} REFUSING to continue. A scan that writes findings with no graph version ` +
        'has no "before", so "an edge that should not have formed" becomes unanswerable and ' +
        'a prune recommendation would rest on a single snapshot.\n' +
        'This message states ONLY what was established: the specifier above did not resolve. ' +
        'It does NOT name a cause, because there are at least two and the code cannot tell ' +
        'them apart from here (deploy-integrity.md R7). Check both:\n' +
        '  1. IS THE MODULE IN THE TREE? `lib/brain/history/` arrives with #3935 (W9). If ' +
        '     that has not merged, it is absent.\n' +
        '  2. IS IT IN THE COMPILED OUTPUT? `lib/brain/run/tsconfig.cli.json` emits a closure ' +
        '     over STATIC imports, and this specifier is assembled at runtime so tsc cannot ' +
        '     see it. Its `include` must cover `lib/brain/history/**`, and the emitted tree ' +
        '     must actually contain `lib/brain/history/index.js`. An earlier revision of this ' +
        '     lane told the operator to "land #3935" as the fix; that was a cause the code had ' +
        '     not established, and it would have sent the next investigation to the wrong PR ' +
        '     while the real defect sat in the emit closure.',
    );
    this.name = 'HistoryModuleUnavailableError';
  }
}

/** Load and VALIDATE W9's module. Throws; never returns a degraded stand-in. */
export async function resolveHistoryModule(
  importer: (spec: string) => Promise<unknown> = (spec) => import(/* @vite-ignore */ spec),
): Promise<HistoryModule> {
  let mod: unknown;
  try {
    mod = await importer(HISTORY_MODULE_SPECIFIER);
  } catch (err) {
    throw new HistoryModuleUnavailableError(
      err instanceof Error ? `${err.name}: ${err.message}.` : String(err),
    );
  }
  const candidate = mod as Partial<HistoryModule> | null;
  if (candidate === null || typeof candidate.captureGraphVersion !== 'function') {
    throw new HistoryModuleUnavailableError(
      'the module resolved but does not export a callable `captureGraphVersion`.',
    );
  }
  return candidate as HistoryModule;
}

export interface W9HistoryWriterOptions {
  /** W9's `GraphHistoryStore` — `CosmosGraphHistoryStore` in production. */
  readonly store: unknown;
  readonly module: HistoryModule;
}

/** Adapts W9's `captureGraphVersion` to this lane's {@link GraphHistoryWriter}. */
export class W9GraphHistoryWriter implements GraphHistoryWriter {
  constructor(private readonly opts: W9HistoryWriterOptions) {}

  async capture(req: CaptureRequest): Promise<GraphVersionReceipt> {
    const result = await this.opts.module.captureGraphVersion({
      graph: req.graph,
      store: this.opts.store,
      estateId: req.estateId,
      collectedProvenances: req.collectedProvenances,
      source: req.source,
    });
    return {
      status: result.status,
      versionId: result.version.id,
      nodes: result.version.counts.nodes,
      edges: result.version.counts.edges,
      pruned: result.pruned,
      notes: [
        ...(result.unchangedReason
          ? [
              `no new version was written (${result.unchangedReason}) — the estate graph did ` +
                'not semantically change since the retained head. That is the dedupe working, ' +
                'not a failure.',
            ]
          : []),
        ...result.notes,
      ],
    };
  }
}
