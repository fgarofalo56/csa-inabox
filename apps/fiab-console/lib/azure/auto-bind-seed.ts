/**
 * AUTO-BIND SEEDING — author a Loom item's OWN content into the backing Azure
 * object the auto-bind engine just created.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES (#3549)
 * ---------------------------------------------------------------------------
 *
 * Two subsystems touch a bundle-installed item, and the gap between them
 * silently orphaned real content:
 *
 *   INSTALL TIME  `lib/install/provisioners/*` stamps the bundle's authored
 *                 content onto the Cosmos item (`state.content`) and THEN tries
 *                 to author the backing Azure object. When the estate env vars
 *                 are unset the provisioner returns `status:'remediation'`
 *                 BEFORE authoring anything, so no ADF pipeline / ADX database
 *                 / Event Hub exists and no binding key is stamped. Its
 *                 remediation says "re-run install once the env var is set".
 *
 *   OPEN TIME     the editor's bind GET calls `autoBindOnOpen` on EVERY open.
 *                 Finding no binding and nothing under the deterministic name,
 *                 the engine falls through to `create()` — which by design
 *                 authors an EMPTY object, because that is the right answer for
 *                 a blank item a user just created.
 *
 * So the platform manufactured an EMPTY TWIN of content it was already holding,
 * bound the item to it, and reported `ok:true` forever after. Live on
 * 2026-08-15: 36 of 41 pipelines in `adf-loom-default-centralus` had
 * `activities: []` as a genuinely published ARM resource — `lastPublishTime`
 * and `etag` and all. "Trigger now" ran them and did nothing, successfully.
 *
 * Per `.claude/rules/auto-bind-by-default.md` §3 a stale/missing binding must
 * self-heal on next open rather than degrade, and a remediation the platform
 * could have performed itself is a defect. So the first bind SEEDS.
 *
 * ---------------------------------------------------------------------------
 * WHICH PATH REACHES WHICH PROVIDER
 * ---------------------------------------------------------------------------
 * Worth knowing, because it is why fixing `create()` fixes all five and not
 * just the two the bug report named:
 *
 *   autoBindOnCreate   `item-crud.createOwnedItem` calls it for EVERY item, and
 *                      the bundle install passes `state` (content included) to
 *                      that same call — so the item already carries its content
 *                      when the engine runs, BEFORE the provisioner gets its
 *                      turn to config-gate. All five providers seed here.
 *                      Deadline-bounded (8s) and never-throwing, unchanged.
 *   autoBindOnOpen     wired into the two PIPELINE bind routes only. Pipelines
 *                      therefore also self-heal on open — which is the path
 *                      that produced #3549's 36 empty pipelines, because those
 *                      items predated auto-bind-on-create.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REUSES THE INSTALL-TIME SEEDERS RATHER THAN RESTATING THEM
 * ---------------------------------------------------------------------------
 *
 * `auto-bind-providers.ts` opens with the reason the engine exists at all: the
 * five per-item provisioners "each re-derived this logic (and its naming)
 * independently", and they diverged. Content translation is exactly that kind
 * of logic — the bundle's `config` bag has to be split into activity-root
 * siblings (`policy`/`linkedServiceName`/`description`) and `typeProperties`,
 * Databricks activities have to be given a linked service or ADF 400s the PUT,
 * `.alter-merge … policy caching` has to be rewritten to `.alter …` or ADX
 * rejects it. A second implementation of any of that would drift.
 *
 * So each seed below calls the SAME function the installer calls, which is what
 * stops the two drifting.
 *
 * PRECISELY WHAT "the same" DOES AND DOES NOT MEAN. For the pipeline and KQL
 * paths the shared function is the whole of what install ran, so an auto-bound
 * object matches what install would have produced (minus the on-demand RUN,
 * which must not fire merely because a user opened an editor).
 *
 * For the LAKEHOUSE it is deliberately NOT identical, and the difference is
 * documented rather than implied:
 *   - the extraction into `_seed-lakehouse-adls` changed the installer's own
 *     behaviour in two ways — a mid-build 401/403 now short-circuits to a
 *     remediation instead of logging and continuing, and the folder-create loop
 *     now runs AFTER the Synapse serverless setup. Both are pinned by
 *     `lib/install/__tests__/lakehouse-extraction-behaviour.test.ts`.
 *   - `seedLakehouseFromContent` additionally SKIPS the Synapse OPENROWSET view
 *     layer (see its own docstring for why).
 *
 * Server-only. Every import is dynamic, matching `auto-bind-providers.ts`: it
 * keeps the Azure control-plane clients out of the module graph until a seed
 * actually runs.
 */
import type { AutoBindContext, AutoBindSeedResult } from './auto-bind';

/**
 * The item's authored content, or null when there is nothing to seed.
 *
 * `kind` is the discriminator every content bundle carries
 * (`lib/apps/content-bundles/types.ts`). Requiring it to MATCH the backing
 * service is what stops a mis-typed item writing, say, a lakehouse's
 * `deltaTables` into a pipeline. A blank item created from the catalog picker
 * has no `state.content` at all and correctly seeds nothing.
 */
export function authoredContent<T = any>(ctx: AutoBindContext, kinds: readonly string[]): T | null {
  const raw = ctx.state?.content;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !kinds.includes(kind)) return null;
  return raw as T;
}

/** Nothing to author — a correct, non-error outcome for a blank item. */
const NOTHING: AutoBindSeedResult = { seeded: false };

/** Normalize an unknown throw into a seed error string. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ===========================================================================
// data-pipeline → ADF / Synapse pipeline activities
// ===========================================================================

/**
 * Author the bundle's activity graph into the pipeline `create()` just made.
 *
 * Delegates to `upsertAndRunDevPipeline({ skipRun: true })` — the installer's
 * own seeder — so the activity translation, the Databricks linked-service
 * normalization, and the linked-service/dataset auto-stubbing are all the
 * install-time behaviour exactly. `skipRun` is the ONLY difference: install
 * proves the pipeline by triggering a run, but an editor open must not bill a
 * pipeline execution or re-fire its side effects.
 *
 * THIS FUNCTION IS THE UNTRUSTED-CONTENT ENTRY POINT. `ctx.state.content` is
 * whatever the item carries, and `POST /api/cosmos-items/[type]` writes
 * `state` straight from the request body before calling `autoBindOnCreate`. So
 * the reference stubbing it drives is create-if-absent (see
 * `_seed-dev-pipeline.ensurePipelineReferences`): a name that already belongs to
 * something Loom did not create is used as-is, never overwritten.
 *
 * SCOPE OF THAT PROTECTION, stated so it is not read as more than it is. It
 * covers the REFERENCES (linked services and datasets) only. The PIPELINE
 * document itself is guarded by the engine, which seeds solely on a create or
 * after `isEmpty` — and `isEmpty` today asks only whether `activities` is an
 * empty array, WITHOUT checking `loom-autoprovisioned`. So a pre-existing
 * EMPTY pipeline whose name and factory a caller can choose is still
 * seedable through this path. That gap is pre-existing, is NOT closed here,
 * and is filed separately by the reviewer.
 *
 * `runPipelineSeed` is parameterized by adapter so ADF and Synapse share it;
 * the two differ only in which client PUTs the document.
 */
export async function seedPipelineFromContent(
  backend: 'adf' | 'synapse',
  name: string,
  ctx: AutoBindContext,
): Promise<AutoBindSeedResult> {
  const content = authoredContent<{ activities?: unknown[] }>(ctx, ['adf-pipeline', 'synapse-pipeline']);
  // No authored graph → an empty pipeline is the CORRECT outcome (a blank item
  // the user is about to author on the canvas). Not an error.
  if (!content || !Array.isArray(content.activities) || content.activities.length === 0) return NOTHING;

  try {
    const { upsertAndRunDevPipeline } = await import('@/lib/install/provisioners/_seed-dev-pipeline');
    const adapter = backend === 'adf' ? await adfSeedAdapter() : await synapseSeedAdapter();
    const seed = await upsertAndRunDevPipeline(adapter, name, content, { skipRun: true });

    if (!seed.upserted) {
      // The installer's own honest-gate shapes: an unresolvable reference
      // (typically Databricks on an estate with none) or an RBAC refusal. The
      // pipeline object still exists and the item is still bound — report the
      // reason rather than pretending the graph landed.
      const why =
        seed.needsReference?.message
        || (seed.authGate ? `${seed.authGate.status}: ${seed.authGate.message}` : undefined)
        || seed.error
        || 'pipeline document was not accepted; see install steps.';
      return { seeded: false, error: why };
    }
    // Adoption is a SUCCESS (see the skip-semantics note on
    // `upsertAndRunDevPipeline`) — the graph landed and the references resolve.
    // It is still stated rather than implied: the engine persists this string
    // to `state.autoBind.seedDetail` and the bind GET returns it, so which
    // objects Loom did NOT author is recoverable from the item itself.
    // (Round 2 of this review caught that it was computed and DROPPED — the
    // record had no such field. `AutoBindRecord.seedDetail` is that fix.)
    const adopted = seed.adoptedReferences?.length
      ? `; used ${seed.adoptedReferences.length} pre-existing reference(s) as-is: ${seed.adoptedReferences.join(', ')}`
      : '';
    return { seeded: true, detail: `${content.activities.length} activities${adopted}` };
  } catch (e) {
    return { seeded: false, error: errText(e) };
  }
}

/** ADF adapter — the same four calls `lib/install/provisioners/adf-pipeline.ts` wires. */
async function adfSeedAdapter() {
  const { upsertPipeline, runPipeline, listPipelineRuns, upsertLinkedService, upsertDataset, getLinkedService, getDataset } =
    await import('./adf-client');
  const { nullOn404 } = await import('@/lib/install/provisioners/_seed-dev-pipeline');
  return {
    label: 'ADF',
    async upsert(n: string, properties: any) { await upsertPipeline(n, { name: n, properties }); },
    async createRun(n: string, params?: Record<string, unknown>) { return (await runPipeline(n, params)).runId; },
    async getRunStatus(runId: string) {
      const runs = await listPipelineRuns(undefined, 1);
      const match = runs.find((r) => r.runId === runId) || runs[0];
      return match ? { runId, status: match.status, message: match.message } : undefined;
    },
    async upsertLinkedService(n: string, properties: Record<string, unknown>) {
      await upsertLinkedService(n, { name: n, properties } as any);
    },
    async upsertDataset(n: string, properties: Record<string, unknown>) {
      await upsertDataset(n, { name: n, properties } as any);
    },
    // #3549 review, BLOCKER 1. THIS PATH is why the reads exist: unlike the
    // installer, whose content comes from the curated bundle registry, the
    // content here is `state.content` — which reaches the platform verbatim
    // from a request body. Without an existence check a caller could name a
    // production linked service / dataset and have the stubber PUT over it.
    async getLinkedService(n: string) { return nullOn404(() => getLinkedService(n)); },
    async getDataset(n: string) { return nullOn404(() => getDataset(n)); },
  };
}

/** Synapse adapter — mirrors `lib/install/provisioners/synapse-pipeline.ts`. */
async function synapseSeedAdapter() {
  const { upsertPipeline, runPipeline, getPipelineRun, upsertLinkedService, upsertDataset, getLinkedService, getDataset } =
    await import('./synapse-dev-client');
  const { nullOn404 } = await import('@/lib/install/provisioners/_seed-dev-pipeline');
  return {
    label: 'Synapse',
    async upsert(n: string, properties: any) { await upsertPipeline(n, { name: n, properties }); },
    async createRun(n: string, params?: Record<string, unknown>) { return (await runPipeline(n, params)).runId; },
    async getRunStatus(runId: string) {
      const run = await getPipelineRun(runId);
      return { runId, status: run.status, message: run.message };
    },
    async upsertLinkedService(n: string, properties: Record<string, unknown>) { await upsertLinkedService(n, properties); },
    async upsertDataset(n: string, properties: Record<string, unknown>) { await upsertDataset(n, properties); },
    /** See the ADF twin — never PUT over a reference we did not create. */
    async getLinkedService(n: string) { return nullOn404(() => getLinkedService(n)); },
    async getDataset(n: string) { return nullOn404(() => getDataset(n)); },
  };
}

// ===========================================================================
// eventstream → Event Hubs consumer groups + Stream Analytics transform
// ===========================================================================

/**
 * Author the bundle's stream topology onto the Event Hub `create()` just made.
 *
 * `create()` makes the transport hub and stops, so a bundle eventstream that
 * declares three destinations and a transform landed as a bare hub with no
 * consumer groups and no ASA job — the streaming analogue of `activities: []`.
 *
 * `standUpEventstreamAzure` is the SAME call the installer AND the editor's
 * "Provision to Azure" button make, and it is idempotent: it finds the hub we
 * just created ("already exists; reusing") and adds the consumer groups and the
 * transform. A `partial:true` result (Stream Analytics not configured, or not
 * available in this sovereign boundary) is reported as NOT seeded with the
 * reason — the transport stream IS live and the binding stands, but calling a
 * missing transform layer "seeded" is the streaming shape of the empty-twin
 * defect this module exists to close.
 */
export async function seedEventstreamFromContent(
  _name: string,
  ctx: AutoBindContext,
): Promise<AutoBindSeedResult> {
  const content = authoredContent<{ sources?: unknown[]; destinations?: unknown[]; transforms?: unknown[] }>(
    ctx,
    ['eventstream'],
  );
  if (!content) return NOTHING;
  const declared =
    (Array.isArray(content.sources) ? content.sources.length : 0)
    + (Array.isArray(content.destinations) ? content.destinations.length : 0)
    + (Array.isArray(content.transforms) ? content.transforms.length : 0);
  if (declared === 0) return NOTHING;

  try {
    const { standUpEventstreamAzure, bundleContentToTopology } = await import('./eventstream-standup');
    const topology = bundleContentToTopology(content);
    const steps: string[] = [];
    const result = await standUpEventstreamAzure(ctx.displayName, ctx.itemId, topology, steps);
    const detail =
      `${topology.sinks.length} consumer group(s), ${topology.transforms.length} transform(s)`;
    if (result.partial) {
      // The transport stream IS live and the binding stands, but the transform
      // layer is NOT provisioned. Reporting `seeded:true` here told every wire
      // consumer the content had landed, which is the same "looks complete,
      // isn't" shape #3549 is about — just for streaming. So it is reported as
      // NOT seeded, with the reason, and `seedError` carries the honest hint.
      //
      // WHAT REPAIRS IT, precisely (#3549 review, BLOCKER 2). An earlier draft
      // of this comment claimed "the re-seed path will retry it on a later
      // open". THAT IS NOT TRUE and was never true:
      //   - `maybeRepairSeed` needs BOTH `seedFromContent` and `isEmpty`, and
      //     `eventstreamAutoBind` has no `isEmpty` (see ISEMPTY_OPT_OUTS in
      //     `__tests__/auto-bind-seed.test.ts` for the reasoned opt-out), and
      //   - `autoBindOnOpen` is wired into the two PIPELINE bind routes only,
      //     so nothing re-runs the engine for an eventstream anyway.
      // The repair that DOES exist is the editor's own **Provision to Azure**
      // button (`POST /api/items/eventstream/[id]/provision`), which calls this
      // very same idempotent stand-up: once Stream Analytics is available it
      // adds the ASA job and the item goes fully live. So this is a disclosure
      // with a real in-product fix, not a dead end — and the string below says
      // that rather than promising an automatic retry that does not run.
      // Making it automatic needs `autoBindOnOpen` wired into the eventstream
      // editor, tracked in #3694.
      return {
        seeded: false,
        detail,
        error:
          'Transport stream is live; the transform layer is not provisioned — '
          + `${result.hint || 'Stream Analytics unavailable'} `
          + 'Re-run "Provision to Azure" from the eventstream editor once that is resolved; the stand-up is '
          + 'idempotent and adds only what is missing.',
      };
    }
    return { seeded: true, detail };
  } catch (e) {
    return { seeded: false, error: errText(e) };
  }
}

// ===========================================================================
// eventhouse / kql-database → ADX tables, sample rows, functions, policies
// ===========================================================================

/**
 * Author the bundle's schema + seed rows into the ADX database `create()` just
 * made.
 *
 * `create()` calls ARM `createDatabase` and stops, so a bundle KQL database
 * declaring five tables with sample rows landed EMPTY — and, being a real
 * database, every downstream query returned a clean "no results" rather than an
 * error. Delegates to `applyKqlBundle`, the block lifted verbatim out of
 * `lib/install/provisioners/kql-db.ts`, so the `.alter-merge`-caching rewrite,
 * the `$table` placeholder resolution, the ingest-throttle backoff and the
 * verified `.set-or-append` fallback all apply identically here.
 */
export async function seedKqlDatabaseFromContent(
  name: string,
  ctx: AutoBindContext,
): Promise<AutoBindSeedResult> {
  const content = authoredContent<{ tables?: unknown[]; functions?: unknown[]; ingestionPolicies?: unknown[] }>(
    ctx,
    ['kql-database', 'eventhouse'],
  );
  if (!content) return NOTHING;
  const declared =
    (Array.isArray(content.tables) ? content.tables.length : 0)
    + (Array.isArray(content.functions) ? content.functions.length : 0)
    + (Array.isArray(content.ingestionPolicies) ? content.ingestionPolicies.length : 0);
  if (declared === 0) return NOTHING;

  try {
    const { applyKqlBundle } = await import('@/lib/install/provisioners/_seed-kql-bundle');
    const steps: string[] = [];
    const r = await applyKqlBundle(name, content, steps);

    if (r.authGate) {
      return {
        seeded: false,
        error:
          `ADX ${r.authGate.status} during ${r.authGate.phase}: the Console UAMI needs AllDatabasesAdmin on the cluster. `
          + r.authGate.message,
      };
    }
    // Same honesty bar as the installer: a database whose every table-create or
    // every seed failed is NOT seeded, however green the create was.
    if (r.declaredTables > 0 && r.tableCreateFailures >= r.declaredTables) {
      return { seeded: false, error: `All ${r.declaredTables} table-create command(s) failed; the database has no tables.` };
    }
    if (r.expectedSeedTables > 0 && r.ingestFailures >= r.expectedSeedTables) {
      return { seeded: false, error: `Schema created but all ${r.expectedSeedTables} sample-row ingest(s) failed; no rows landed.` };
    }
    if (r.criticalPolicyFailures > 0) {
      return { seeded: false, error: `${r.criticalPolicyFailures} update-policy command(s) failed; the curated-table feed is not wired.` };
    }
    return { seeded: true, detail: `${r.declaredTables} table(s), ${r.expectedSeedTables} seeded` };
  } catch (e) {
    return { seeded: false, error: errText(e) };
  }
}

// ===========================================================================
// lakehouse → ADLS folder tree + Delta table seed CSVs
// ===========================================================================

/**
 * Author the bundle's folder tree and Delta-table seed data under the lakehouse
 * root `create()` just made.
 *
 * `create()` makes ONE directory — the root — so a bundle lakehouse declaring
 * folders and seeded tables opened onto an empty tree. Delegates to
 * `seedLakehouseAdls`, lifted out of `lib/install/provisioners/lakehouse.ts`,
 * so the DDL column parsing and CSV shaping match the installer exactly.
 *
 * The Synapse serverless OPENROWSET view layer is deliberately NOT part of this
 * seed: it is an optional queryability convenience that the installer itself
 * treats as skippable, and it needs a serverless user DB this path has no
 * business creating. The files are real and browsable either way.
 */
export async function seedLakehouseFromContent(
  root: string,
  coords: Record<string, string>,
  ctx: AutoBindContext,
): Promise<AutoBindSeedResult> {
  const content = authoredContent<{ folders?: unknown[]; deltaTables?: unknown[] }>(ctx, ['lakehouse']);
  if (!content) return NOTHING;
  const declared =
    (Array.isArray(content.folders) ? content.folders.length : 0)
    + (Array.isArray(content.deltaTables) ? content.deltaTables.length : 0);
  if (declared === 0) return NOTHING;

  const container = coords.container;
  if (!container) return { seeded: false, error: 'No ADLS container resolved for this lakehouse.' };

  try {
    const { seedLakehouseAdls } = await import('@/lib/install/provisioners/_seed-lakehouse-adls');
    const steps: string[] = [];
    const r = await seedLakehouseAdls(container as never, root, content, steps);
    if (r.authGate) {
      return {
        seeded: false,
        error:
          `ADLS ${r.authGate.status}: the Console UAMI needs Storage Blob Data Contributor on container '${container}'. `
          + r.authGate.message,
      };
    }
    if (r.createdFolders.length === 0 && r.seeded.length === 0 && r.emptyTables.length === 0) {
      return { seeded: false, error: 'No folder or table could be created under the lakehouse root.' };
    }
    return {
      seeded: true,
      detail: `${r.createdFolders.length} folder(s), ${r.seeded.length} seeded table(s)`,
    };
  } catch (e) {
    return { seeded: false, error: errText(e) };
  }
}
