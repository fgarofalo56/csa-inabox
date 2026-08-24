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
 * The specifier for W9's Cosmos-backed history store.
 *
 * ── ONE LEVEL, NOT TWO. THIS SHIPPED WRONG (review of #4014) ──────────────
 * From the EMITTED `lib/brain/run/cli.js`, `../history/cosmos-store` resolves to
 * `lib/brain/history/cosmos-store`. The first version used `../../` — copied
 * from `azure/history-writer.ts`, which sits one directory DEEPER and therefore
 * correctly needs two levels — and resolved to `lib/history/cosmos-store`, which
 * does not exist. Measured against a stub tree mirroring the emit layout:
 *
 *     ../../history/cosmos-store  ->  MODULE_NOT_FOUND
 *     ../history/cosmos-store     ->  resolves
 *
 * Nothing caught it: no test referenced this function, `cli-buildable.test.ts`
 * walks STATIC import specifiers and cannot follow a runtime-assembled one, and
 * the live Commercial receipt was taken with the history writer swapped for the
 * in-memory one. Three gates, none with this path in its population.
 *
 * Exported so `__tests__/history-wiring.test.ts` resolves THIS value rather than
 * a copy of it — a test that restates the specifier is a test of its own copy.
 */
export const HISTORY_STORE_SPECIFIER = ['..', 'history', 'cosmos-store'].join('/');

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
  const spec = HISTORY_STORE_SPECIFIER;
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

/**
 * The estate id, derived the SAME way the console derives it.
 *
 * ── WHY THIS IS NOT A LITERAL IN THE WORKFLOW (review of #4014, S4) ───────
 * `LOOM_ESTATE_ID` is emitted by NO bicep module — grepping `platform/fiab/bicep`
 * for it returns zero matches — and `lib/estate/pause-orchestrator.ts`'s
 * `resolveEstateId()` SYNTHESIZES `loom:<sub8>:<rg>` when it is unset. So a
 * literal typed into the workflow would disagree with whatever the console
 * resolves, and this lane's findings (and the graph versions it writes with the
 * same id) would land in a Cosmos partition nothing else reads.
 * `auto-bind-by-default.md` §5: the value must be produced by the deploy, not
 * typed in.
 *
 * This is a deliberate DUPLICATE of `resolveEstateId()`'s algorithm rather than
 * an import, because importing `pause-orchestrator` would drag
 * `pause-actuator` + `capacity-preflight` into the CLI's alias-free emit
 * closure. `__tests__/estate-id.test.ts` imports BOTH and asserts they agree
 * across a matrix of inputs, so the duplication cannot drift silently.
 */
export function resolveScanEstateId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.LOOM_ESTATE_ID || '').trim();
  if (explicit) return explicit;
  const sub = (env.LOOM_SUBSCRIPTION_ID || '').trim();
  const rg = (env.LOOM_ADMIN_RG || env.LOOM_ACA_RG || env.LOOM_DLZ_RG || '').trim();
  if (sub && rg) return `loom:${sub.slice(0, 8)}:${rg}`;
  return 'loom:unbound';
}

/** Everything `main()` needs that is not an Azure client. Injected so it is testable. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly appendFile: (path: string, text: string) => void;
  readonly env: NodeJS.ProcessEnv;
}

const NODE_IO: CliIo = {
  stdout: (t) => process.stdout.write(t),
  appendFile: (p, t) => appendFileSync(p, t, 'utf8'),
  env: process.env,
};

/**
 * Run a scan, report it everywhere, and return the process exit code.
 *
 * ── WHY THIS IS SEPARATE FROM `main()` (review of #4014, G1) ──────────────
 * `main()` builds real Azure clients, so no test could reach the exit mapping it
 * used — and the reviewer's `cli-exit-from-verdict-only` arm proved it:
 * replacing `exitCodeForOutcome(outcome)` with the narrow verdict-only mapping
 * made a POPULATION REGRESSION exit 0 while the workflow printed "Scan
 * completed", and the whole 116-test suite stayed green. That is the SAME
 * regression already fixed inside `scan.ts`, one layer up, undefended, because
 * the composition root was outside every test's population.
 *
 * Splitting the deps from the wiring puts the process's own mapping under test.
 */
export async function runAndReport(
  deps: Parameters<typeof runBrainScan>[0],
  io: CliIo = NODE_IO,
): Promise<number> {
  const outcome = await runBrainScan({
    ...deps,
    // The verdict reaches the log BEFORE anything is persisted. A Cosmos failure
    // after this point still fails the run — it just cannot hide what the run
    // had already established about the estate.
    onVerdict: (v) => io.stdout(`${renderVerdictHeadline(v)}\n`),
  });

  io.stdout(`${renderRunReport(outcome)}\n`);

  const summaryPath = io.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) io.appendFile(summaryPath, `${renderStepSummary(outcome)}\n`);

  const outputPath = io.env.GITHUB_OUTPUT;
  if (outputPath) {
    io.appendFile(
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
    );
  }

  return exitCodeForOutcome(outcome);
}

export async function main(): Promise<number> {
  const estateId = resolveScanEstateId();
  if (estateId === 'loom:unbound') {
    throw new Error(
      'the estate id could not be established. Set LOOM_SUBSCRIPTION_ID and LOOM_ADMIN_RG (the ' +
        'workflow reads both from the deploy), or LOOM_ESTATE_ID explicitly. The scan refuses ' +
        "to guess: a wrong estate id writes this estate's findings into another's Cosmos " +
        'partition, and writes graph versions nothing else reads. This is the same derivation ' +
        'lib/estate/pause-orchestrator.ts#resolveEstateId uses, so the console and this lane ' +
        'agree by construction.',
    );
  }
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
  // The UAMI leg is added ONLY when a client id is present. On the in-VNet ACA
  // runner that is the console UAMI — the identity that already holds Cosmos
  // Data Contributor on the account, which is why this lane needs no new role
  // assignment. Off the runner the leg is absent rather than present-and-failing,
  // so there is no IMDS probe to time out before the fallback (review of #4014).
  const uamiClientId = (process.env.LOOM_UAMI_CLIENT_ID || '').trim();
  const chain = uamiClientId ? [new ManagedIdentityCredential({ clientId: uamiClientId })] : [];
  const credential = new ChainedTokenCredential(...chain, new DefaultAzureCredential());
  const getToken = async (s: string): Promise<string | null> => {
    const token = await credential.getToken(s);
    return token?.token ?? null;
  };

  const fetchImpl = globalThis.fetch as unknown as FetchLike;
  const scoped = subscriptions ? { subscriptions } : {};

  return runAndReport({
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
  });
}

/**
 * Was this module run directly?
 *
 * Exported and pure so the predicate itself is testable. It is NOT the only
 * defense against the scan silently not running — the workflow asserts the
 * `verdict` job output is non-empty, which catches ANY silent no-op rather than
 * just this one. The reviewer's `cli-entrypoint-never-fires` arm showed why that
 * second layer is needed: neutering this predicate made `node cli.js` exit 0
 * having produced nothing at all, while the workflow printed "Scan completed."
 */
export function isDirectInvocation(argv1: string | undefined): boolean {
  return typeof argv1 === 'string' && /brain[\\/]run[\\/]cli\.(js|ts)$/.test(argv1);
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
const invokedDirectly = isDirectInvocation(process.argv[1]);

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
