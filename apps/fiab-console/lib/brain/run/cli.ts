/**
 * LOOM BRAIN W10 — the workflow entrypoint (#3936).
 *
 * Run by `.github/workflows/loom-brain-scan.yml`, once per cloud boundary. This
 * is the composition root: the only file in the lane that reads environment,
 * constructs the real Azure clients and maps a verdict onto a process exit code.
 * Everything it wires is a port, so nothing below it needs an Azure tenant to be
 * proven.
 *
 * ── EXIT CODES ─────────────────────────────────────────────────────────────
 *     0   OK      — the estate was scanned; counts are in the summary
 *     0   PAUSED  — the estate is stopped; NOTHING was scanned
 *     2   UNREACHABLE — RED
 *     3   POPULATION REGRESSION — the estate was scanned and the SCAN got worse
 *     1   an unexpected defect (a throwing detector, a mis-shaped module, …)
 *
 * 1, 2 and 3 are distinct on purpose: "this program is broken", "the estate
 * could not be reached" and "I reached it and looked at a fifth of what I looked
 * at yesterday" send an engineer to three completely different places, and one
 * non-zero code would conflate them.
 *
 * PAUSED exiting 0 is the decision that needs defending. Actions has only
 * pass/fail; a paused estate failing the lane nightly is how an operator learns
 * to ignore it, and an ignored lane is a decorative one — the exact failure
 * `deploy-integrity.md` R1 calls a silently-broken path. So the verdict is
 * carried in THREE places a green check cannot hide: the first line of the log,
 * the step-summary headline, and a job output (`verdict`). A passing job never
 * implies a completed scan.
 *
 * ── THE HISTORY WRITER IS LAZY, AND THAT IS LOAD-BEARING ───────────────────
 * `LazyW9GraphHistoryWriter` resolves W9's module on the FIRST CAPTURE, which
 * only ever happens on the OK path. Constructing it eagerly would let a missing
 * or mis-shaped history module turn a PAUSED run RED — reintroducing the exact
 * nightly-red-on-a-paused-estate failure this lane was built to eliminate, via
 * a completely different route.
 *
 * ── NOTHING HERE DISCARDS A RESULT ─────────────────────────────────────────
 * No `catch {}` that returns a default, no `|| true`, no silent fallback. The
 * single `catch` re-raises as exit 1 after printing the error in full, which is
 * the opposite of swallowing it.
 */

import { appendFileSync } from 'node:fs';
import { armBase, armScope, cloudBoundaryLabel } from '../../azure/cloud-endpoints';
import { WIRE_BINDINGS } from '../../../app/api/admin/brain/_lib/wire-bindings';
import { ArmEstateProbe, type FetchLike } from './azure/arm-probe';
import { ArgGraphSource } from './azure/arg-graph-source';
import { W9GraphHistoryWriter, resolveHistoryModule } from './azure/history-writer';
import { CosmosFindingStore } from './cosmos-finding-store';
import { renderRunReport, renderStepSummary, renderVerdictHeadline } from './report';
import { exitCodeForOutcome, runBrainScan } from './scan';
import type { CaptureRequest, GraphHistoryWriter, GraphVersionReceipt } from './ports';

/**
 * A required environment value.
 *
 * THROWS rather than defaulting. A defaulted estate id writes one estate's
 * findings into another's partition, and a defaulted scope silently narrows the
 * population a verdict ranges over — both are silent-wrong, which is worse than
 * a loud stop.
 */
export function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(
      `${name} is not set. The Brain scan refuses to guess it: a defaulted estate id writes ` +
        "one estate's findings into another's partition, and a defaulted scope silently " +
        'narrows the population the verdict ranges over.',
    );
  }
  return v.trim();
}

export function optionalList(name: string): readonly string[] | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return items.length > 0 ? items : undefined;
}

/**
 * Resolves W9's writer on first capture — never at construction.
 *
 * There is no fallback and no null writer: if the module cannot be resolved the
 * capture THROWS, the scan fails, and the operator is told exactly what is
 * missing. A scan that wrote findings with no graph version would have no
 * `before`, so "an edge that should not have formed" becomes unanswerable.
 */
export class LazyW9GraphHistoryWriter implements GraphHistoryWriter {
  private delegate: GraphHistoryWriter | null = null;

  async capture(req: CaptureRequest): Promise<GraphVersionReceipt> {
    if (this.delegate === null) {
      this.delegate = new W9GraphHistoryWriter({
        store: await makeHistoryStore(),
        module: await resolveHistoryModule(),
      });
    }
    return this.delegate.capture(req);
  }
}

/**
 * W9's Cosmos-backed history store.
 *
 * Resolved at runtime for the same reason as W9's module itself (#3935 is in
 * flight on its own branch). Both export shapes are accepted because W9's
 * surface is still settling; ANYTHING ELSE THROWS. There is deliberately no
 * in-memory fallback — a graph version written to a process that is about to
 * exit is not a `before`.
 */
export async function makeHistoryStore(
  importer: (spec: string) => Promise<unknown> = (spec) => import(/* @vite-ignore */ spec),
): Promise<unknown> {
  const spec = ['..', '..', 'history', 'cosmos-store'].join('/');
  const mod = (await importer(spec)) as Record<string, unknown>;
  const Klass = mod.CosmosGraphHistoryStore;
  if (typeof Klass === 'function') return new (Klass as new () => unknown)();
  const factory = mod.cosmosGraphHistoryStore;
  if (typeof factory === 'function') return (factory as () => unknown)();
  throw new Error(
    `'${spec}' exports neither 'CosmosGraphHistoryStore' nor 'cosmosGraphHistoryStore'. The ` +
      'scan REFUSES to continue without somewhere to write the graph version — a findings ' +
      'backlog with no "before" cannot answer "an edge that should not have formed", and a ' +
      'prune recommendation off a single snapshot would delete something mid-deploy.',
  );
}

export async function main(): Promise<number> {
  const estateId = required('LOOM_ESTATE_ID');
  const runId = required('LOOM_BRAIN_RUN_ID');
  // The POWER-PROBE scope. Required, never defaulted.
  //
  // MEASURED 2026-08-24 against the live Commercial estate: ZERO of the 63
  // container apps carry the `loom-estate-id` tag, so a tag-scoped probe finds
  // nothing and the lane goes red every night — the "gate that always fails"
  // twin of the failure this whole design exists to avoid. The resource group
  // the platform deploys into is EVIDENCE of ownership; a tag that is not there
  // is not. An UNSCOPED probe would be worse still: of the 13 managed
  // environments visible across these subscriptions ONE is Loom's, so "the
  // estate is paused" would depend on someone else's blog being up.
  const resourceGroups = optionalList('LOOM_BRAIN_RESOURCE_GROUPS');
  if (resourceGroups === undefined) {
    throw new Error(
      'LOOM_BRAIN_RESOURCE_GROUPS is not set. The power probe refuses to run unscoped: it ' +
        'would range over every container app the run identity can read — 34 of the 63 on ' +
        'this estate are NOT Loom\'s — and "the estate is paused" would then depend on ' +
        "someone else's workload. Set it to the Loom admin-plane resource group(s).",
    );
  }
  const cloud = cloudBoundaryLabel();
  const base = armBase();
  const scope = armScope();
  const subscriptions = optionalList('LOOM_BRAIN_SUBSCRIPTIONS');

  const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } =
    await import('@azure/identity');
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
  const chain = uamiClientId ? [new ManagedIdentityCredential({ clientId: uamiClientId })] : [];
  const credential = new ChainedTokenCredential(...chain, new DefaultAzureCredential());
  const getToken = async (s: string): Promise<string | null> => {
    const token = await credential.getToken(s);
    return token?.token ?? null;
  };

  const fetchImpl = globalThis.fetch as unknown as FetchLike;
  const scoped = subscriptions ? { subscriptions } : {};

  const outcome = await runBrainScan({
    estateId,
    cloud,
    runId,
    probe: new ArmEstateProbe({
      armBase: base,
      armScope: scope,
      getToken,
      fetchImpl,
      resourceGroups,
      ...scoped,
    }),
    // The GRAPH ranges wider than the probe, deliberately. PRP §1 decision 4:
    // "Reports cover ALL subscriptions. Cleanup recommendations are scoped by
    // ownership." Narrowing the graph to Loom's own RGs would hide exactly the
    // cross-boundary edges a reachability query exists to find.
    graphSource: new ArgGraphSource({
      armBase: base,
      armScope: scope,
      getToken,
      fetchImpl,
      estateId,
      bindings: WIRE_BINDINGS,
      ...scoped,
    }),
    history: new LazyW9GraphHistoryWriter(),
    findings: new CosmosFindingStore(),
    source: `workflow:loom-brain-scan:${runId}`,
    // The verdict reaches the log BEFORE anything is persisted. A Cosmos failure
    // after this point still fails the run — it just cannot hide what the run
    // had already established about the estate.
    onVerdict: (v) => process.stdout.write(`${renderVerdictHeadline(v)}\n`),
  });

  process.stdout.write(`${renderRunReport(outcome)}\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${renderStepSummary(outcome)}\n`, 'utf8');

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(
      outputPath,
      [
        `verdict=${outcome.verdict.kind}`,
        `population_regression=${outcome.populationRegression === null ? 'false' : 'true'}`,
        `regressions=${outcome.counts?.regressions ?? 0}`,
        `new_findings=${outcome.counts?.new ?? 0}`,
        `findings_produced=${outcome.counts?.findingsProduced ?? 0}`,
        `detectors_blind=${outcome.counts?.detectorsBlind ?? 0}`,
        `graph_version=${outcome.graphVersion?.versionId ?? ''}`,
        '',
      ].join('\n'),
      'utf8',
    );
  }

  return exitCodeForOutcome(outcome);
}

/**
 * The process shim.
 *
 * Gated on `process.argv[1]` naming THIS file — i.e. "was I run directly?" —
 * rather than on an environment variable. Three reasons, in order of weight:
 *
 *   1. Nothing about a run's OUTCOME may be reachable from an environment
 *      variable. That is the whole design of `./verdict.ts`, and an env-gated
 *      entrypoint sits uncomfortably close to the boolean-that-skips-the-run
 *      this lane exists to avoid, even though it only decides invocation.
 *   2. `scripts/ci/check-env-sync.mjs` (via `check-bicep-sync.mjs`) requires
 *      every `LOOM_*` env var read under `apps/fiab-console` to be EMITTED by
 *      the platform bicep. A `LOOM_BRAIN_CLI` marker would fail that check —
 *      correctly, because this process is launched by a workflow and its
 *      environment does not come from a container app. Renaming it to dodge the
 *      prefix would have been keying to the guard's spelling rather than to its
 *      point; removing the variable answers the point.
 *   3. It makes the module importable by a test with no setup at all.
 */
/* c8 ignore start — exercised by the workflow, not by vitest. */
const invokedDirectly =
  typeof process.argv[1] === 'string' && /brain[\\/]run[\\/]cli\.(js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // NOT a swallow: the error is printed in full and the process fails with a
      // code distinct from UNREACHABLE, so "this program is broken" and "the
      // estate could not be reached" stay separable.
      process.stderr.write(
        'LOOM BRAIN SCAN — UNEXPECTED FAILURE (this is a defect in the scan, not a verdict ' +
          `about the estate):\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
