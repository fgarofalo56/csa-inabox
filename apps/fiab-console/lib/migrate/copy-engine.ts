/**
 * M2 — copy-in ENGINE (server-only): realize a {@link CopyInPlan} as a REAL
 * Azure Data Factory Copy pipeline that lands each assessed source table into
 * ADLS Bronze, then materializes it as a managed Delta table in the target Loom
 * lakehouse/warehouse — the N7b/N7c mirror/CDC substrate run IN REVERSE
 * (external estate → Loom lake).
 *
 * NO SECOND ORCHESTRATOR: this reuses the SAME adf-client primitives the mirror
 * engine's ADF Copy path uses (upsertDataset / upsertPipeline / runPipeline /
 * listActivityRuns) — one delete-then-copy Copy activity per object in ONE
 * pipeline — and the SAME Synapse Livy path the Lakehouse "Load to Table" wizard
 * uses (buildLoadToTablePySpark → submitLivyBatch) for the Delta materialize.
 * It authors no new pipeline runner and reaches no new backend.
 *
 * PHASES:
 *   1. Copy   — ADF Copy: source table → Bronze Parquet under
 *               `migrations/<migrationId>/<db>.<schema>.<name>/`. Real ARM +
 *               real createRun. Row counts read back from the Copy activity
 *               output (`rowsRead`/`rowsCopied`).
 *   2. Delta  — (opt-in, gated) a Synapse Spark job reads each Bronze folder and
 *               writes a managed Delta table in the target lakehouse's `Tables/`
 *               so it appears in the Loom lakehouse editor and reads back with a
 *               real count. Gated honestly on LOOM_SYNAPSE_WORKSPACE + a pool.
 *
 * HONEST GATES (no-vaporware / no-fabric-dependency): the copy needs the env-
 * pinned ADF factory + a source ADF linked service + the ADLS sink linked
 * service. Snowflake is wired via the existing mirror Snowflake linked service;
 * Databricks-UC / Fabric / Power BI sources return an honest connector gate
 * naming the ADF linked service to provide (never a fabricated copy). A Fabric /
 * Power BI estate is only ever a migration SOURCE — the default path reaches no
 * Fabric/OneLake host.
 *
 * IL5 / sovereign: the copy runs IN-BOUNDARY — ADF in the deployment's VNet →
 * the deployment's own ADLS Bronze. SaaS-source connectors stay honest-gated
 * until their connection prerequisite (an ADF linked service) is provided.
 */
import {
  adfConfigGate, upsertDataset, upsertPipeline, runPipeline, listActivityRuns,
  getLinkedService,
  type AdfDataset, type AdfPipeline,
} from '@/lib/azure/adf-client';
import { snowflakeDatasetKind } from '@/lib/azure/snowflake-adf';
import { getAccountName, pathToHttpsUrl } from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
// ONE owner for the Bronze sink linked service, shared with the mirror engine,
// so the migration copy and a mirror can never sink through different bindings.
import { ensureMirrorAdlsLinkedService } from '@/lib/azure/mirror-adf-shared';
import {
  listSparkPools, submitLivyBatch, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { buildLoadToTablePySpark, parseLoadRowCount } from '@/lib/azure/load-to-table-codegen';
import type { MigrationSourceType } from './assessment';
import type { CopyInPlan, CopyObjectPlan } from './copy-plan';
import type { CopyObjectResult } from './copy-job-model';
import { trimSlashes } from '@/lib/util/trim';

/** Bronze landing container (the deployment's own ADLS Gen2). */
const BRONZE = 'bronze';

/**
 * ADF's ceiling on activities in ONE pipeline. Default AND maximum — it is not
 * raisable by support, unlike most Data Factory limits.
 *   https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-data-factory-limits
 */
const ADF_MAX_ACTIVITIES_PER_PIPELINE = 120;

/**
 * Activities this engine authors PER copied object — one Copy plus the gated
 * Delete that retires the previous generation (see `buildCopyActivities`).
 *
 * The cap below is DERIVED from this, deliberately. Issue #4087 asked whether
 * this engine shares the mirror engine's `MAX_TABLES=50` budget; it does not —
 * it had NO cap at all, so a plan with 61+ objects authored a pipeline ADF
 * rejects outright. Writing the cap as a literal would re-open that the moment
 * anyone adds a third activity per object (a validation step, a swap), because
 * a literal does not move when the cost does. This does.
 */
const ACTIVITIES_PER_OBJECT = 2;

/** Most objects one copy-in pipeline can carry without breaching the ceiling. */
export const MAX_COPY_OBJECTS = Math.floor(ADF_MAX_ACTIVITIES_PER_PIPELINE / ACTIVITIES_PER_OBJECT);

/** An honest connector/infra gate — the copy could not start. */
export interface CopyGate {
  missing: string;
  message: string;
}

export type CopyStartResult =
  | { ok: true; pipelineName: string; adfRunId: string; basePath: string; objects: CopyObjectResult[] }
  | { ok: false; gate: CopyGate };

/** ADF resource names allow [A-Za-z0-9_]; derive a stable, safe name. */
function adfSafe(s: string): string {
  const safe = String(s).replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z]/.test(safe) ? safe.slice(0, 120) : `x_${safe}`.slice(0, 120);
}

/** Stable, safe ADF pipeline name for a migration's copy-in run. */
export function copyPipelineName(migrationId: string): string {
  const safe = (migrationId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'migrate';
  return `loom_copyin_${safe}`;
}

/** Is the ADLS Bronze landing zone configured? */
function bronzeConfigured(): boolean {
  if (!process.env.LOOM_BRONZE_URL) return false;
  try { getAccountName(); return true; } catch { return false; }
}

/**
 * The ADF AzureBlobFS (ADLS) linked service the copy sinks through.
 *
 * `LOOM_MIRROR_ADLS_LINKED_SERVICE` is an OVERRIDE, never a prerequisite — same
 * contract as in the mirror engine, and the same module does the work, so the
 * two paths can never disagree about which linked service the Bronze account is
 * reached through. When it is unset (every shipped deployment), Loom creates
 * `loom_mirror_sink_adls` from LOOM_BRONZE_URL with factory-MI auth.
 */
async function adlsLinkedService(): Promise<string | null> {
  const sink = await ensureMirrorAdlsLinkedService();
  return 'gate' in sink ? null : sink.linkedServiceName;
}

/**
 * The pre-existing ADF SOURCE linked service for a migration source, or null.
 * Snowflake reuses the mirror engine's Snowflake linked service (the ADF Copy
 * connector Loom already ships). Other sources have no default-path ADF Copy
 * connector wired yet → an honest connector gate names the prerequisite.
 */
function sourceLinkedService(sourceType: MigrationSourceType): string | null {
  if (sourceType === 'snowflake') {
    const v = process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE || process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE;
    return v && v.trim() ? v.trim() : null;
  }
  return null;
}

/** Does this migration source have a default-path ADF Copy connector at all? */
function sourceHasCopyConnector(sourceType: MigrationSourceType): boolean {
  return sourceType === 'snowflake';
}

/**
 * The interim Azure **Blob Storage** linked service ADF stages a Snowflake
 * unload through before it lands in the ADLS Gen2 Bronze sink.
 *
 * WHY THIS IS A CONSTANT AND NOT AN ENV VAR. It is a Loom-OWNED resource in
 * Loom's OWN factory, provisioned by Loom's bicep alongside the staging storage
 * account (#4086). `auto-bind-by-default.md` is explicit that an infra
 * prerequisite the platform can create is DEPLOYED, not requested — "set
 * LOOM_X" as the terminal user-facing state is a violation of that rule — so
 * there is no operator choice here to carry in a variable.
 *
 * An env var would also have carried strictly LESS information than the probe
 * below already gets. Its only possible non-empty value is this same name, and
 * a name proves nothing on its own: the engine has to read the linked service
 * back from the factory regardless (see {@link planCopyTransfer} on why the
 * TYPE is authoritative and the name is not). Asking ADF answers "is it there,
 * and is it the right type?" in one call; a variable could only ever have
 * answered "did something set a string?", and could be stale or wrong on top.
 */
export const STAGING_BLOB_LINKED_SERVICE = 'loom_mirror_staging_blob';

/**
 * What the factory says about the staging linked service.
 *
 * `absent` and `unreadable` are kept apart deliberately, per
 * `deploy-integrity.md` R7: an error must not assert something it did not
 * establish. A swallowed exception that reports "not deployed" when the truth
 * was "the identity cannot read this factory" sends the operator to the wrong
 * fix — that exact conflation cost two investigations on 2026-08-05.
 */
export type StagingProbe =
  | { kind: 'present'; type: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string };

/** Staging prefix inside the interim Blob container, per migration. */
const STAGING_PATH_ROOT = 'loom-copyin-staging';

/** The ONE linked-service type Snowflake's COPY-unload can write to. */
const STAGING_REQUIRED_TYPE = 'AzureBlobStorage';

/** How a source table can actually be moved into Bronze on this deployment. */
export type CopyTransferPlan =
  | { kind: 'staged'; stagingLinkedService: string }
  | { kind: 'unsupported'; missing: string; message: string };

/**
 * Decide the transfer shape, at CONSTRUCTION time rather than at run time.
 *
 * WHY THIS EXISTS AT ALL. Both the V1 and the V2 Snowflake connectors mark
 * `exportSettings` REQUIRED, and its only value is `SnowflakeExportCopyCommand`
 * — which delegates the unload to Snowflake's own `COPY INTO <location>`. That
 * command can only write to an Azure **Blob** endpoint. Learn documents exactly
 * two shapes that satisfy it, and BOTH need a Blob-typed linked service: direct
 * copy (the SINK linked service is Azure Blob Storage with SAS auth) or staged
 * copy (an interim Azure Blob Storage linked service). This engine's sink is
 * `AzureBlobFS` (ADLS Gen2 / dfs), so the staged shape is the one that keeps
 * Bronze where the rest of the platform reads it.
 *   https://learn.microsoft.com/azure/data-factory/connector-snowflake
 *
 * WHY THE TYPE IS THE ANSWER AND THE NAME IS NOT: a linked service EXISTING
 * under the expected name proves only that something was created. If a factory
 * carries an `AzureBlobFS` linked service at that name — which is what the
 * Bronze sink is — authoring on it reproduces the exact failure this gate
 * exists to prevent. The probe is passed in rather than fetched here so this
 * stays pure and can be tested against every shape ADF can return.
 */
export function planCopyTransfer(probe: StagingProbe): CopyTransferPlan {
  if (probe.kind === 'absent') {
    return {
      kind: 'unsupported',
      missing: 'staging-linked-service-absent',
      message:
        "Snowflake's COPY INTO unload can only write to an Azure Blob endpoint, so Azure Data Factory rejects a " +
        'Snowflake source paired with an ADLS Gen2 (AzureBlobFS) Bronze sink: "Snowflake copy command not ' +
        'support Connector type as \'not Azure Blob Storage\'". The documented path is a staged copy through an ' +
        `interim Azure Blob Storage linked service. Loom provisions that itself — the "${STAGING_BLOB_LINKED_SERVICE}" ` +
        'linked service and the storage account behind it are deployed by platform bicep (issue #4086) — and it ' +
        'is NOT in this factory yet, so there is nothing for the copy to stage through. Until then the copy is ' +
        'gated rather than authoring a pipeline ADF would reject on every run — which is what made this defect ' +
        'destroy Bronze before the Delete was gated (#4083 / #4087).',
    };
  }

  // UNKNOWN is not "wrong type" and it is not "absent". Say precisely what
  // happened — the linked service could not be READ — and fail closed, because
  // authoring on an unverified pairing is what produced #4083.
  if (probe.kind === 'unreadable') {
    return {
      kind: 'unsupported',
      missing: 'staging-linked-service-unreadable',
      message:
        `Loom could not READ the "${STAGING_BLOB_LINKED_SERVICE}" staging linked service from the data factory ` +
        `(${probe.detail}), so its type is unknown — this is NOT a report that the type is wrong, and it is NOT a ` +
        'report that it is missing. The most likely cause is that the Console identity lacks Data Factory read ' +
        'access to this factory. Loom is gating rather than authoring a copy whose source/sink pairing it could ' +
        'not verify.',
    };
  }

  if (probe.type === STAGING_REQUIRED_TYPE) {
    return { kind: 'staged', stagingLinkedService: STAGING_BLOB_LINKED_SERVICE };
  }

  return {
    kind: 'unsupported',
    missing: 'staging-linked-service-wrong-type',
    message:
      `The "${STAGING_BLOB_LINKED_SERVICE}" staging linked service in this factory is a ${probe.type} linked ` +
      "service. Snowflake's COPY INTO unload can only write to an Azure Blob endpoint, so the staging linked " +
      `service must be ${STAGING_REQUIRED_TYPE} with shared access signature authentication. An AzureBlobFS ` +
      '(ADLS Gen2 / dfs endpoint) linked service — including the Bronze sink this copy writes to — is rejected ' +
      'by ADF with "Snowflake copy command not support Connector type as \'not Azure Blob Storage\'", which is ' +
      'the failure this gate exists to prevent.',
  };
}

/**
 * Ask the factory about the staging linked service.
 *
 * The 404 is classified from the `status` the adf-client attaches to the thrown
 * error rather than by regexing its message, so "absent" is only ever reported
 * when ADF actually said Not Found. Every other failure — 403, a network error,
 * a malformed body — is `unreadable`, which fails closed just the same but says
 * something TRUE about why.
 */
async function probeStagingLinkedService(): Promise<StagingProbe> {
  try {
    const ls = await getLinkedService(STAGING_BLOB_LINKED_SERVICE);
    const t = (ls as { properties?: { type?: unknown } })?.properties?.type;
    if (typeof t === 'string' && t) return { kind: 'present', type: t };
    return { kind: 'unreadable', detail: 'the factory returned it with no properties.type' };
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status;
    if (status === 404) return { kind: 'absent' };
    return {
      kind: 'unreadable',
      detail: typeof status === 'number'
        ? `the factory answered HTTP ${status}`
        : 'the factory could not be reached',
    };
  }
}

/**
 * Pre-flight gate for the copy. Returns an honest gate when a prerequisite is
 * missing (ADF factory, Bronze, or an unsupported source that has no
 * default-path ADF Copy connector), else null.
 *
 * The ADLS SINK linked service is deliberately NOT checked here any more: it is
 * created on demand from LOOM_BRONZE_URL at copy time
 * (`ensureMirrorAdlsLinkedService`), so demanding it was an
 * `auto-bind-by-default.md` §5 violation — a value the platform holds, asked of
 * the operator. `bronzeConfigured()` above already covers the only genuine
 * prerequisite behind it.
 */
export function copyGate(sourceType: MigrationSourceType): CopyGate | null {
  const adf = adfConfigGate();
  if (adf) {
    return {
      missing: adf.missing,
      message:
        'Copy-in runs on the env-pinned Azure Data Factory (no Microsoft Fabric): set LOOM_ADF_NAME (plus LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG) to the factory in the deployment VNet, then run the copy.',
    };
  }
  if (!bronzeConfigured()) {
    return {
      missing: 'LOOM_BRONZE_URL',
      message:
        'The Bronze landing zone is not configured. Set LOOM_BRONZE_URL to the deployment ADLS Gen2 Bronze container (platform/fiab/bicep/modules/landing-zone/storage*.bicep).',
    };
  }
  const supported = sourceHasCopyConnector(sourceType) && sourceLinkedService(sourceType);
  if (!supported) {
    return {
      missing: sourceType === 'snowflake' ? 'LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE' : `adf-linked-service:${sourceType}`,
      message: sourceType === 'snowflake'
        ? 'Set LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE to a Snowflake ADF linked service (credential in Key Vault) so ADF can read the source tables.'
        : `Copy-in from ${sourceType} needs an ADF Copy linked service for that source, which is not wired on the default path yet. Snowflake sources copy today; ${sourceType} table copy-in is a disclosed follow-up (its assessment + code translation already work). Reach no Fabric/OneLake host on the default path.`,
    };
  }
  return null;
}

/** abfss:// Bronze root for a migration's copy-in. */
function bronzeAbfssRoot(migrationId: string): string {
  const account = getAccountName();
  return `abfss://${BRONZE}@${account}.${dfsSuffix()}/migrations/${migrationId}/`;
}

/** The Copy activity name backing one object (monitor maps run output → row). */
function copyActivityName(o: CopyObjectPlan): string {
  return adfSafe(`Copy_${o.landingSegment}`);
}

/** The Delete that retires the PREVIOUS generation once the Copy succeeded. */
function deleteActivityName(o: CopyObjectPlan): string {
  return adfSafe(`DeletePrev_${o.landingSegment}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT: nothing is destroyed until its replacement is proven written.
 *
 * A copy-in pipeline both DESTROYS data (the Delete retires the previous
 * generation of one table's landing folder) and WRITES data (the Copy lands the
 * new generation). Exactly one property makes that safe, and it is PER TARGET:
 *
 *     no Delete may run unless the write that REPLACES WHAT IT DELETES has
 *     provably succeeded first.
 *
 * Everything below computes that property, and only that property, from the
 * pipeline's own data — the dataset each activity writes (`outputs`), the
 * dataset each Delete destroys (`typeProperties.dataset`), and the dependency
 * edges between them. It reads no activity NAME, no authoring order, and no
 * marker saying which function produced the list.
 *
 * WHY IT IS WRITTEN THIS WAY RATHER THAN AS A CHECKLIST. Round 1 of PR #4104
 * shipped a WEAKER question — "does this Delete have SOME dependency, on
 * SOMETHING typed Copy, whose condition list mentions Succeeded?" — and an
 * independent verifier defeated it. Re-measured here against that exact
 * implementation before this rewrite; all five were ACCEPTED with no throw:
 *
 *   1. CROSS-WIRED. Copy_A, Copy_B, and DeletePrev_B gated on Copy_A. Table B's
 *      landing folder is cleared the instant A's copy succeeds — whether or not
 *      Copy_B ever wrote a byte. That is delete-first for B, precisely.
 *   2. WIDENED CONDITION SET. `dependencyConditions: ['Succeeded','Failed']`.
 *      `includes('Succeeded')` is true, so round 1 read that as a success gate
 *      — but a list naming `Failed` is not one, and Learn does not document how
 *      a multi-condition list combines, so it establishes nothing either way.
 *   3. ORPHAN TARGET. A Delete whose dataset nothing in the pipeline writes,
 *      gated on an unrelated Copy: pure destruction behind a decoy gate.
 *   4. NO TARGET. A Delete with no `typeProperties.dataset` at all — what it
 *      destroys was unknowable and the old check never asked.
 *   5. NESTED. A root Delete inside a ForEach. The old check scanned only the
 *      top-level array, so that Delete was not in the population at all. ADF
 *      counts "inner activities for containers" toward the 120-activity ceiling
 *      too, so the budget check was blind to them as well.
 *
 * None of those five is enumerated in the code. Each is a CONSEQUENCE of asking
 * the per-target dominance question instead of the existential one — which is
 * the point, because the next evasion nobody has thought of is refused by the
 * same question.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, stated rather than implied: it reasons
 * about ADF `Delete` activities only. An edit that destroyed Bronze some other
 * way — a Script activity running a DROP, a Copy with a truncating pre-copy
 * script — is outside what this can see, and would need its own invariant.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One activity as it sits in the pipeline TREE, flattened with its scope. */
interface FlatActivity {
  idx: number;
  name: string;
  type: string;
  raw: Record<string, unknown>;
  /** Flat index of the enclosing container activity, or -1 at pipeline level. */
  parent: number;
  /** name → flat indices sharing this activity's scope (ADF resolves per scope). */
  scope: Map<string, number[]>;
}

/**
 * Does this value look like an ACTIVITY rather than, say, a dataset schema
 * column (which is also `{ name, type }`)? Used only to recognise a nested
 * activity ARRAY inside a container's typeProperties, so that a container type
 * nobody has added yet — Switch, Until, a future one — is still walked without
 * this file carrying a list of container spellings.
 */
function isActivityLike(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.type !== 'string') return false;
  return 'dependsOn' in o || 'typeProperties' in o || 'policy' in o
    || o.type === 'Copy' || o.type === 'Delete';
}

/** Every nested activity array reachable under one activity's typeProperties. */
function nestedActivityArrays(node: unknown, out: unknown[][], depth = 0): void {
  if (depth > 8 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(isActivityLike)) { out.push(node); return; }
    for (const v of node) nestedActivityArrays(v, out, depth + 1);
    return;
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    nestedActivityArrays(v, out, depth + 1);
  }
}

/**
 * The pipeline's activities INCLUDING the ones nested inside control-flow
 * containers. ADF's 120-activity ceiling "includes inner activities for
 * containers", and so does the destruction this file exists to refuse.
 *   https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-data-factory-limits
 */
function flattenActivities(activities: readonly unknown[]): FlatActivity[] {
  const flat: FlatActivity[] = [];
  const walk = (list: readonly unknown[], parent: number): void => {
    const scope = new Map<string, number[]>();
    const mine: number[] = [];
    for (const entry of list) {
      const raw = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const idx = flat.length;
      const name = typeof raw.name === 'string' ? raw.name : '';
      flat.push({ idx, name, type: typeof raw.type === 'string' ? raw.type : '', raw, parent, scope });
      scope.set(name, [...(scope.get(name) ?? []), idx]);
      mine.push(idx);
    }
    for (const idx of mine) {
      const nested: unknown[][] = [];
      nestedActivityArrays(flat[idx].raw.typeProperties, nested);
      for (const list2 of nested) walk(list2, idx);
    }
  };
  walk(activities, -1);
  return flat;
}

/**
 * Is this ONE dependency edge a pure success gate?
 *
 * `dependencyConditions` is a LIST. Learn documents what each condition means
 * individually — and that `Completed` alone means "succeeded OR failed", so a
 * condition is a status the upstream is ALLOWED to end in, not a requirement —
 * but it does not state how a list of several is combined.
 *   https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities#activity-dependency
 * So a list carrying anything besides `Succeeded` is not a gate this code can
 * claim to understand, and it is treated as no gate at all rather than assumed
 * benign. Fail-closed: being wrong in this direction costs a refusal to author;
 * being wrong in the other costs Bronze. Nothing here authors such a list.
 */
function isPureSuccessEdge(dep: unknown): boolean {
  const d = dep as { dependencyConditions?: unknown };
  const conds = Array.isArray(d?.dependencyConditions) ? d.dependencyConditions : [];
  return conds.length === 1 && conds[0] === 'Succeeded';
}

/**
 * Every activity that MUST have succeeded for `flat[idx]` to run at all —
 * transitively, and only across pure-success edges.
 *
 * Transitive because a chain Copy → Wait → Delete is genuinely safe and a check
 * that only looked one hop would reject it. Scope-aware because ADF resolves
 * `dependsOn` within an activity's own scope, and an activity nested in a
 * container additionally inherits whatever gates that CONTAINER runs behind.
 *
 * An unresolvable name and an ambiguous (duplicated) name each contribute
 * NOTHING rather than being assumed safe. A dependency CYCLE is cut and
 * reported through `viaCycle`, because a cut leaves the answer an
 * UNDER-approximation — the caller must not read "no violation" off a walk that
 * was truncated. (The cached value can only ever be a subset for the same
 * reason, so memoisation across queries stays on the fail-closed side.)
 */
function provenPredecessors(
  flat: readonly FlatActivity[],
  idx: number,
  memo: Map<number, { proven: Set<number>; viaCycle: boolean }>,
  stack: Set<number>,
): { proven: Set<number>; viaCycle: boolean } {
  const cached = memo.get(idx);
  if (cached) return cached;
  if (stack.has(idx)) return { proven: new Set(), viaCycle: true };
  stack.add(idx);

  const proven = new Set<number>();
  let viaCycle = false;
  const a = flat[idx];
  const deps = Array.isArray(a.raw.dependsOn) ? (a.raw.dependsOn as unknown[]) : [];
  for (const dep of deps) {
    if (!isPureSuccessEdge(dep)) continue;
    const target = String((dep as { activity?: unknown })?.activity ?? '');
    const candidates = a.scope.get(target) ?? [];
    if (candidates.length !== 1) continue;
    const j = candidates[0];
    if (j === idx) continue;
    proven.add(j);
    const up = provenPredecessors(flat, j, memo, stack);
    viaCycle = viaCycle || up.viaCycle;
    for (const k of up.proven) proven.add(k);
  }
  if (a.parent >= 0) {
    const up = provenPredecessors(flat, a.parent, memo, stack);
    viaCycle = viaCycle || up.viaCycle;
    for (const k of up.proven) proven.add(k);
  }

  stack.delete(idx);
  const result = { proven, viaCycle };
  memo.set(idx, result);
  return result;
}

/** Dataset reference names an activity WRITES. */
function writtenDatasets(raw: Record<string, unknown>): string[] {
  const outs = Array.isArray(raw.outputs) ? (raw.outputs as unknown[]) : [];
  return outs
    .map((o) => String((o as { referenceName?: unknown })?.referenceName ?? ''))
    .filter(Boolean);
}

/** Dataset reference name a Delete activity DESTROYS, or null if unknowable. */
function destroyedDataset(raw: Record<string, unknown>): string | null {
  const tp = raw.typeProperties as { dataset?: { referenceName?: unknown } } | undefined;
  const n = tp?.dataset?.referenceName;
  return typeof n === 'string' && n ? n : null;
}

/** A Delete this pipeline has not proven it can safely perform. */
export interface UnsafeDelete {
  /** Activity name as authored (may be '' — an unnamed activity is still unsafe). */
  name: string;
  /** `no-target` · `no-producer` · `producer-not-proven` · `cycle` */
  reason: 'no-target' | 'no-producer' | 'producer-not-proven' | 'cycle';
  detail: string;
}

/**
 * Every Delete in the pipeline — nested ones included — that could destroy data
 * the pipeline has not proven it will replace. Empty means the invariant holds.
 *
 * Exported so the property can be asserted directly on a hand-built shape, not
 * only on whatever {@link buildCopyActivities} happens to emit today. A test
 * that can only see the builder's current output cannot tell an invariant that
 * enforces the property from one that merely agrees with the builder.
 */
export function findUnsafeDeletes(activities: readonly unknown[]): UnsafeDelete[] {
  const flat = flattenActivities(activities);
  const memo = new Map<number, { proven: Set<number>; viaCycle: boolean }>();
  const bad: UnsafeDelete[] = [];

  for (const d of flat) {
    if (d.type !== 'Delete') continue;
    const label = d.name || '<unnamed>';

    const target = destroyedDataset(d.raw);
    if (!target) {
      bad.push({
        name: d.name,
        reason: 'no-target',
        detail: `${label} names no dataset to delete, so what it destroys cannot be established`,
      });
      continue;
    }

    const producers = flat.filter((a) => writtenDatasets(a.raw).includes(target));
    if (!producers.length) {
      bad.push({
        name: d.name,
        reason: 'no-producer',
        detail: `${label} deletes dataset "${target}", which NO activity in this pipeline writes`,
      });
      continue;
    }

    const { proven, viaCycle } = provenPredecessors(flat, d.idx, memo, new Set());
    if (viaCycle) {
      // The walk was truncated at a cycle, so "dominated" was never established.
      // ADF cannot run a cyclic pipeline either — refuse rather than author it.
      bad.push({
        name: d.name,
        reason: 'cycle',
        detail: `${label} sits behind a dependency CYCLE, so nothing about what runs before it is established`,
      });
      continue;
    }
    const unproven = producers.filter((p) => !proven.has(p.idx));
    if (unproven.length) {
      bad.push({
        name: d.name,
        reason: 'producer-not-proven',
        detail:
          `${label} deletes dataset "${target}", but [${unproven.map((p) => p.name || '<unnamed>').join(', ')}] ` +
          '— the activity(ies) that write it — are not proven to have SUCCEEDED before it runs',
      });
    }
  }
  return bad;
}

/**
 * Refuse to author a pipeline that could destroy Bronze, or that ADF would
 * reject outright.
 *
 * WHY THIS IS A RUNTIME CHECK AND NOT ONLY A TEST. Tests pin the shape
 * `buildCopyActivities` produces TODAY. This pins the shape that actually
 * reaches the factory, so a future edit that re-introduces a root Delete — the
 * exact regression #4083 shipped and #4087 found living on a second engine —
 * fails closed at the call site instead of clearing Bronze on the next run.
 * It throws rather than returning a gate because there is no operator action
 * that resolves it: it is a defect in Loom's own authoring.
 */
export function assertSafeCopyPipeline(activities: readonly unknown[]): void {
  const unsafe = findUnsafeDeletes(activities);
  if (unsafe.length) {
    throw new Error(
      `Refusing to author copy-in pipeline: ${unsafe.length} Delete activity(ies) would destroy data this ` +
      'pipeline has not proven it can replace — ' +
      unsafe.map((u) => `${u.detail} [${u.reason}]`).join('; ') +
      '. A Delete that is not dominated by the write that replaces what it deletes clears the Bronze landing ' +
      'folder before that data exists, so any copy failure destroys the previous snapshot ' +
      '(issue #4083, repeated here as #4087).',
    );
  }

  // ADF counts "inner activities for containers" toward the ceiling, so this
  // counts the FLATTENED tree — a nested activity is not free.
  const total = flattenActivities(activities).length;
  if (total > ADF_MAX_ACTIVITIES_PER_PIPELINE) {
    throw new Error(
      `Refusing to author copy-in pipeline: ${total} activities exceeds ADF's ceiling of ` +
      `${ADF_MAX_ACTIVITIES_PER_PIPELINE} per pipeline (default AND maximum — not raisable by support, and it ` +
      'counts inner activities for containers). ' +
      `At ${ACTIVITIES_PER_OBJECT} activities per object that is more than ${MAX_COPY_OBJECTS} objects.`,
    );
  }
}

/** Everything `buildCopyActivities` needs that is not the object list itself. */
export interface CopyActivityBuildOpts {
  pipelineName: string;
  /** Copy-activity source type, resolved from the linked service (V1 or V2). */
  sourceType: string;
  /** Interim Azure Blob Storage linked service the Snowflake unload stages through. */
  stagingLinkedService: string;
  /** Prefix inside the staging container. */
  stagingPath: string;
}

/** The source/sink dataset names for one object (stable, ADF-safe). */
export function datasetNamesFor(pipelineName: string, o: CopyObjectPlan): { srcDs: string; sinkDs: string } {
  return {
    srcDs: adfSafe(`${pipelineName}_s_${o.landingSegment}`),
    sinkDs: adfSafe(`${pipelineName}_k_${o.landingSegment}`),
  };
}

/**
 * Author the activity list for a plan — PURE, so the shape that reaches ADF is
 * the shape a test can inspect without mocking ARM.
 *
 * ── Copy FIRST; retire the PREVIOUS generation only once it SUCCEEDED ────────
 * The Delete used to run first with `dependsOn: []`, which made the full
 * refresh non-transactional: the Delete succeeded, the Copy failed, and Bronze
 * was left EMPTY. That is silent data loss on ANY copy failure, transient or
 * not. It is the same defect the mirror engine shipped and #4083 measured on a
 * live estate (pipeline `loom_copy_1ac5d678`, four consecutive runs, every
 * Delete Succeeded, every Copy Failed, `rowsCopied: null` throughout); #4087
 * found this second, independent copy of it here.
 *
 * Copy now has no dependency and the Delete is conditional on it having
 * SUCCEEDED, so a failed copy leaves the previous snapshot intact. The Delete
 * removes only files last modified BEFORE this run started
 * (`@pipeline().TriggerTime`) — the previous generation; the rows this run just
 * wrote are newer and are not matched. `wildcardFileName` is required whenever
 * a modifiedDatetime filter is used, a documented limitation of the Delete
 * activity.
 *   https://learn.microsoft.com/azure/data-factory/delete-activity
 *
 * WHAT THIS SHAPE COSTS — both windows, stated rather than implied.
 * Copy-then-delete is not transactional. There is no instant at which Bronze is
 * guaranteed to hold exactly one generation, so a concurrent reader (the
 * Synapse Serverless OPENROWSET this engine hands back in `readBack`) can
 * observe two wrong states:
 *   1. DURING every healthy run, between the Copy completing and the Delete
 *      completing, Bronze holds BOTH generations — a read in that window
 *      returns EVERY ROW TWICE. This is the dangerous one because it is
 *      SILENT: no error, no empty folder, just doubled counts.
 *   2. AFTER a run whose Copy SUCCEEDED and whose Delete FAILED, both
 *      generations persist until the next successful run repairs it.
 * Both are recoverable and neither destroys data, which is why this shape was
 * chosen over delete-first (which emptied Bronze on any copy failure). It was
 * also chosen over write-then-swap: that needs 4 activities per object against
 * ADF's hard 120-activity ceiling, which would cut this engine's capacity from
 * {@link MAX_COPY_OBJECTS} objects to 30. Do NOT describe this backend as
 * giving readers a consistent snapshot — it does not.
 */
export function buildCopyActivities(
  objects: readonly CopyObjectPlan[],
  opts: CopyActivityBuildOpts,
): unknown[] {
  const activities: unknown[] = [];
  for (const o of objects) {
    const { srcDs, sinkDs } = datasetNamesFor(opts.pipelineName, o);
    const copyName = copyActivityName(o);
    const delName = deleteActivityName(o);

    // Copy is the graph ROOT — nothing has been destroyed before it runs.
    activities.push({
      name: copyName, type: 'Copy',
      dependsOn: [],
      inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
      outputs: [{ referenceName: sinkDs, type: 'DatasetReference' }],
      typeProperties: {
        // `exportSettings` is REQUIRED on both the V1 and V2 Snowflake source;
        // omitting it (as this engine did) is not a lighter-weight copy, it is
        // an invalid one.
        source: { type: opts.sourceType, exportSettings: { type: 'SnowflakeExportCopyCommand' } },
        // MergeFiles is required on a staged Snowflake copy: without it only
        // the last partitioned file of the unload reaches the sink.
        //   https://learn.microsoft.com/azure/data-factory/connector-snowflake
        sink: {
          type: 'ParquetSink',
          storeSettings: { type: 'AzureBlobFSWriteSettings', copyBehavior: 'MergeFiles' },
        },
        enableStaging: true,
        stagingSettings: {
          linkedServiceName: { referenceName: opts.stagingLinkedService, type: 'LinkedServiceReference' },
          path: opts.stagingPath,
        },
      },
    });

    // Delete is now a LEAF, gated on that Copy having SUCCEEDED.
    activities.push({
      name: delName, type: 'Delete',
      dependsOn: [{ activity: copyName, dependencyConditions: ['Succeeded'] }],
      typeProperties: {
        dataset: { referenceName: sinkDs, type: 'DatasetReference' },
        recursive: true, enableLogging: false,
        storeSettings: {
          type: 'AzureBlobFSReadSettings',
          recursive: true,
          wildcardFileName: '*',
          modifiedDatetimeEnd: { value: '@pipeline().TriggerTime', type: 'Expression' },
        },
      },
    });
  }
  return activities;
}

/**
 * PHASE 1 — author + run the ADF Copy pipeline for the plan. One copy-then-retire
 * activity pair per object; Parquet sink into `migrations/<migrationId>/<seg>/`.
 * Returns the pipeline name, run id, and per-object seed results (status running)
 * OR an honest gate. Real ARM (upsertDataset/upsertPipeline) + real createRun.
 */
export async function startCopyIn(
  plan: CopyInPlan,
  migrationId: string,
): Promise<CopyStartResult> {
  const gate = copyGate(plan.sourceType);
  if (gate) return { ok: false, gate };
  if (!plan.objects.length) {
    return { ok: false, gate: { missing: 'objects', message: 'No copyable table objects in this plan. Assess a source estate with at least one table first.' } };
  }
  if (plan.objects.length > MAX_COPY_OBJECTS) {
    return {
      ok: false,
      gate: {
        missing: 'activity-budget',
        message:
          `This plan has ${plan.objects.length} copyable objects. One ADF pipeline can hold at most ` +
          `${ADF_MAX_ACTIVITIES_PER_PIPELINE} activities (default AND maximum — not raisable by support), and ` +
          `each object costs ${ACTIVITIES_PER_OBJECT} (a Copy plus the Delete that retires the previous ` +
          `generation), so at most ${MAX_COPY_OBJECTS} objects can copy in one run. Narrow the plan and run the ` +
          'remainder as a second migration.',
      },
    };
  }

  const sourceLs = sourceLinkedService(plan.sourceType)!;
  // Bound (and created if absent) here rather than gated on. A null can only
  // mean the Bronze binding vanished between `copyGate` and now, so it reports
  // that rather than asserting a missing env var it never checked (R7).
  const adlsLs = await adlsLinkedService();
  if (!adlsLs) {
    return {
      ok: false,
      gate: {
        missing: 'LOOM_BRONZE_URL',
        message:
          'The ADLS Bronze sink linked service could not be bound because the Bronze landing zone is not ' +
          'configured (LOOM_BRONZE_URL). It is produced by the landing-zone deploy — no linked service has to be ' +
          'hand-created.',
      },
    };
  }

  // Can this deployment actually MOVE a row? Decided before anything is
  // authored: the pre-#4087 engine authored an invalid pairing unconditionally,
  // ADF rejected every RUN, and the root Delete had already cleared Bronze.
  const transfer = planCopyTransfer(await probeStagingLinkedService());
  if (transfer.kind === 'unsupported') {
    return { ok: false, gate: { missing: transfer.missing, message: transfer.message } };
  }

  // A pinned linked service may be the LEGACY V1 connector, which Microsoft
  // lists at REMOVED. Read its type back rather than assuming: a V2 dataset on
  // a V1 linked service is rejected by ADF, and vice versa. This engine used to
  // hard-code the V1 pair (`SnowflakeTable` / `SnowflakeSource`) outright.
  //   https://learn.microsoft.com/azure/data-factory/connector-snowflake#snowflake-connector-lifecycle-and-upgrade
  const kind = await snowflakeDatasetKind(sourceLs);

  const pipelineName = copyPipelineName(migrationId);
  const basePathSeg = `migrations/${migrationId}`;

  for (const o of plan.objects) {
    const { srcDs, sinkDs } = datasetNamesFor(pipelineName, o);
    const folderPath = `${basePathSeg}/${o.landingSegment}`;

    // Source dataset — the assessed table, via the source's ADF Copy connector.
    await upsertDataset(srcDs, {
      name: srcDs,
      properties: {
        type: kind.dataset,
        linkedServiceName: { referenceName: sourceLs, type: 'LinkedServiceReference' },
        schema: [],
        typeProperties: { schema: o.source.schema || o.source.database || 'PUBLIC', table: o.source.name },
      },
    } as AdfDataset);
    // Sink dataset — Parquet in the Bronze migration folder.
    await upsertDataset(sinkDs, {
      name: sinkDs,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: adlsLs, type: 'LinkedServiceReference' },
        typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: BRONZE, folderPath } },
      },
    } as AdfDataset);
  }

  const activities = buildCopyActivities(plan.objects, {
    pipelineName,
    sourceType: kind.source,
    stagingLinkedService: transfer.stagingLinkedService,
    stagingPath: `${STAGING_PATH_ROOT}/${migrationId}`,
  });
  // Fail closed BEFORE the definition reaches the factory.
  assertSafeCopyPipeline(activities);

  const spec: AdfPipeline = {
    name: pipelineName,
    properties: {
      description: `Loom copy-in ${migrationId} (${plan.sourceType} → ADLS Bronze)`,
      activities,
      annotations: ['loom-migrate-copyin', migrationId],
      folder: { name: 'loom-migrations' },
    },
  };
  await upsertPipeline(pipelineName, spec);

  const run = await runPipeline(pipelineName);

  const objects: CopyObjectResult[] = plan.objects.map((o) => {
    const folderUrl = pathToHttpsUrl(BRONZE, `${basePathSeg}/${o.landingSegment}/`);
    const readBack = `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', FORMAT = 'PARQUET') AS rows`;
    return {
      source: o.landingSegment,
      targetTable: o.targetTable,
      targetKind: o.targetKind,
      status: 'running',
      rows: null,
      activityName: copyActivityName(o),
      landingPath: folderUrl,
      readBack,
      note: 'ADF Copy running: rows land as Parquet in Bronze; the count populates from the Copy activity output.',
    };
  });

  return { ok: true, pipelineName, adfRunId: run.runId, basePath: pathToHttpsUrl(BRONZE, `${basePathSeg}/`), objects };
}

/** Map an ADF Copy activity's output → rows copied (rowsCopied || rowsRead). */
function rowsFromActivityOutput(output: unknown): number | null {
  const o = (output || {}) as { rowsCopied?: unknown; rowsRead?: unknown };
  const n = Number(o.rowsCopied ?? o.rowsRead);
  return Number.isFinite(n) ? n : null;
}

/**
 * Refresh per-object copy status from the live ADF activity runs for a pipeline
 * run. Matches each object's Copy activity by name and folds in the real
 * rows-copied + Succeeded/Failed/InProgress state. Objects whose activity has
 * not yet reported stay as they were. Real ARM (listActivityRuns).
 */
export async function refreshCopyStatus(
  adfRunId: string,
  objects: CopyObjectResult[],
): Promise<CopyObjectResult[]> {
  let runs: Awaited<ReturnType<typeof listActivityRuns>> = [];
  try {
    runs = await listActivityRuns(adfRunId, 7);
  } catch {
    return objects; // transient — keep the last known state (no fake progress)
  }
  const byName = new Map(runs.filter((r) => r.activityType === 'Copy').map((r) => [r.activityName, r]));
  return objects.map((o) => {
    const run = byName.get(o.activityName);
    if (!run) return o;
    if (run.status === 'Succeeded') {
      return { ...o, status: 'succeeded', rows: rowsFromActivityOutput(run.output), note: 'Copied to Bronze (Parquet). Materialize as managed Delta to read it in the lakehouse editor.' };
    }
    if (run.status === 'Failed' || run.status === 'Cancelled') {
      return { ...o, status: 'failed', note: run.error?.message || `ADF Copy ${String(run.status).toLowerCase()}.` };
    }
    return { ...o, status: 'running' };
  });
}

/** Honest gate for the Phase-2 Delta materialize (Synapse Spark). */
export function materializeGate(): CopyGate | null {
  if (!bronzeConfigured()) {
    return { missing: 'LOOM_BRONZE_URL', message: 'The Bronze landing zone is not configured (LOOM_BRONZE_URL).' };
  }
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      missing: 'LOOM_SYNAPSE_WORKSPACE',
      message:
        'Materializing the copied Parquet into managed Delta needs a Synapse workspace + Spark pool. Set LOOM_SYNAPSE_WORKSPACE and deploy a Spark pool (platform/fiab/bicep/modules/landing-zone/synapse.bicep, deploySparkPool=true). Until then the rows are queryable in Bronze via the Serverless read shown in the receipt.',
    };
  }
  return null;
}

/**
 * PHASE 2 (opt-in) — materialize the copied Bronze Parquet for one object into a
 * managed Delta table in the target lakehouse (`bronze` container `Tables/<t>`),
 * reusing the SAME Livy path as the Lakehouse "Load to Table" wizard. Returns
 * the updated result carrying the Delta row count, or an honest gate/note.
 */
export async function materializeDelta(
  obj: CopyObjectResult,
): Promise<CopyObjectResult> {
  const gate = materializeGate();
  if (gate) return { ...obj, note: gate.message };

  let account: string;
  try { account = getAccountName(); } catch { return { ...obj, note: 'ADLS account not resolvable (LOOM_BRONZE_URL).' }; }

  let poolName = '';
  try {
    const pools = await listSparkPools();
    poolName = pools[0]?.name || '';
  } catch (e) {
    return { ...obj, note: `Could not list Spark pools: ${(e as Error)?.message || e}` };
  }
  if (!poolName) return { ...obj, note: 'No Synapse Spark pool deployed (synapse.bicep, deploySparkPool=true). Bronze Parquet is still queryable via the Serverless read.' };

  // The Bronze Parquet was landed at migrations/<...>/<seg>/ — read it, write a
  // managed Delta table under the container's Tables/ folder.
  const relPath = trimSlashes((obj.landingPath || '').split(`/${BRONZE}/`).pop() ?? '') || '';
  if (!relPath) return { ...obj, note: 'Bronze landing path unresolved; re-run the copy.' };

  let code: string;
  try {
    code = buildLoadToTablePySpark({
      container: BRONZE, account, path: relPath, tableName: obj.targetTable,
      writeMode: 'overwrite', format: 'parquet',
    });
  } catch (e) {
    return { ...obj, note: `Delta codegen failed: ${(e as Error)?.message || e}` };
  }

  let batch: Awaited<ReturnType<typeof submitLivyBatch>>;
  try {
    batch = await submitLivyBatch({ poolName, code, kind: 'pyspark', jobName: `loom-copyin-delta-${obj.targetTable}-${Date.now()}` });
  } catch (e) {
    return { ...obj, note: `Delta materialize submission failed: ${(e as Error)?.message || e}` };
  }

  const [sessIdStr, stmtIdStr] = batch.id.split('.');
  const sessionId = Number(sessIdStr), stmtId = Number(stmtIdStr);
  let rows: number | null = obj.rows;
  let note = 'Materialized as managed Delta in the lakehouse (Tables/).';
  if (Number.isFinite(sessionId) && Number.isFinite(stmtId)) {
    for (let i = 0; i < 40; i++) {
      let stmt: Awaited<ReturnType<typeof getLivyStatement>>;
      try { stmt = await getLivyStatement(poolName, sessionId, stmtId); } catch { await sleep(3000); continue; }
      if (stmt.state === 'available') {
        const out = (stmt.output || {}) as { status?: string; ename?: string; evalue?: string; data?: Record<string, string> };
        if (out.status === 'error') { note = `Delta materialize failed: ${out.ename || 'SparkError'}: ${out.evalue || ''}`.trim(); }
        else { const c = parseLoadRowCount(out.data?.['text/plain']); if (c != null) rows = c; }
        break;
      }
      if (stmt.state === 'error' || stmt.state === 'cancelled') { note = `Delta materialize statement ${stmt.state}.`; break; }
      await sleep(3000);
    }
  }
  const readBack = `SELECT COUNT(*) AS rows FROM OPENROWSET(BULK 'https://${account}.${dfsSuffix()}/${BRONZE}/Tables/${obj.targetTable}/', FORMAT = 'DELTA') AS d`;
  return { ...obj, status: 'succeeded', rows, readBack, note };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
