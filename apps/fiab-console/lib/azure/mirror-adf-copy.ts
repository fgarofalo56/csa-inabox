/**
 * mirror-adf-copy — the ADF **Copy** runtime for `mirrored-database`.
 *
 * The no-Fabric backend for sources that authenticate with their own runtime
 * and that ADF reads through its Copy connector (Snowflake today; BigQuery and
 * Oracle extend here). Split out of `mirror-engine.ts` when that file crossed
 * its 1700-LOC ceiling; the seam is the one the engine already marked with its
 * own banner comment, so this module is that section unchanged plus its imports.
 *
 * The engine dispatches INTO here, so nothing here may value-import the engine:
 * the four shared primitives live in `mirror-adf-shared.ts` and the types come
 * through `import type`, which TypeScript erases. That keeps the edge one-way.
 */
import {
  adfCdcConfigGate, upsertDataset, upsertPipeline, runPipeline, upsertTrigger, startTrigger,
  getLinkedService, getPipeline, getTrigger, stopTrigger, upsertLinkedService,
} from './adf-client';
import { pathToHttpsUrl, generateContainerWriteSasUri } from './adls-client';
import { BRONZE, MAX_TABLES, adfSafeName, mirrorAdlsLinkedService } from './mirror-adf-shared';
// The Snowflake backend: auto-binds its ADF linked service from the mirror's
// Loom Connection and enumerates the source through the same runtime that
// replicates it, so the table list can never disagree with what Copy can read.
import { resolveSnowflakeLinkedService, snowflakeDatasetKind, listSnowflakeTables } from './snowflake-adf';
import { statusToken } from './status-token';
import type { MirrorSource, MirrorTableSpec, MirrorTableResult, MirrorRunResult } from './mirror-engine';

// ============================================================
// ADF Copy runtime path (opt-in) — the no-Fabric backend for sources that
// authenticate with their own runtime and that ADF reads via its Copy connector
// (Snowflake today; BigQuery / Oracle extend later). Each selected table gets a
// **copy-then-swap** full-refresh pipeline (Copy lands fresh Parquet, then a
// Delete conditional on that Copy having SUCCEEDED removes the previous
// generation) and, unless syncMode='snapshot', a schedule trigger that re-runs
// the pipeline on a cadence. Real ARM (upsertDataset + upsertPipeline +
// runPipeline + upsertTrigger/startTrigger). No Microsoft Fabric.
//   https://learn.microsoft.com/azure/data-factory/connector-snowflake
//   https://learn.microsoft.com/azure/data-factory/connector-azure-data-lake-storage
//   https://learn.microsoft.com/azure/data-factory/delete-activity
// ============================================================

/** Container + prefix ADF stages a Snowflake unload through before Bronze. */
const STAGING_PATH_ROOT = 'loom-mirror-staging';

/**
 * Name of the staging linked service Loom binds for itself. Fixed by convention
 * so the console and the factory agree with no operator step — the same reason
 * `dataflow-run.ts` hard-names `loom-adls-mi`. An operator MAY still pin their
 * own with LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE (brownfield estates have
 * hand-tuned linked services); that name then wins.
 */
const STAGING_LS_CONVENTION_NAME = 'loom_mirror_staging_blob';

/**
 * SAS lifetime. Azure caps a user-delegation SAS at 7 days from the delegation
 * key's start and we take all of it, because this credential is not refreshed by
 * the pipeline that uses it.
 *
 * DISCLOSED LIMITATION (deploy-integrity.md R7). The staging SAS is minted at
 * mirror Start. A schedule trigger keeps firing after it expires, and those runs
 * FAIL to stage until the mirror is Started again — they do not silently copy
 * nothing, and they cannot destroy Bronze (the Delete is gated on a successful
 * Copy), but a mirror left running for more than a week will stop refreshing.
 * The durable fix is a Snowflake `storageIntegration`, which removes the SAS
 * from the loop entirely at the cost of a one-time object created in Snowflake
 * by the customer — tracked separately, NOT claimed here.
 *   https://learn.microsoft.com/azure/data-factory/connector-snowflake
 */
const STAGING_SAS_TTL_HOURS = 7 * 24;

/**
 * The dedicated Blob SCRATCH account the platform deployed for staged Snowflake
 * unloads (modules/landing-zone/mirror-staging.bicep), or null when this
 * deployment predates it.
 */
function mirrorStagingAccount(): string | null {
  const v = process.env.LOOM_MIRROR_STAGING_ACCOUNT;
  return v && v.trim() ? v.trim() : null;
}

/**
 * The interim Azure **Blob Storage** linked service ADF stages a Snowflake
 * unload through, or null when this deployment has none.
 *
 * This is a genuine infra prerequisite, not a tuning knob. Snowflake's
 * `COPY INTO <location>` unload — which `SnowflakeExportCopyCommand` delegates
 * to Snowflake to execute — can only write to an Azure **Blob** endpoint, so
 * ADF refuses the payload up front when the sink linked service is
 * `AzureBlobFS` (the ADLS Gen2 `dfs` endpoint):
 *
 *   ErrorCode=UnsupportPayloadForExternalCommand, ... Snowflake Export Copy
 *   Command validation failed: 'Snowflake copy command not support Connector
 *   type as 'not Azure Blob Storage'
 *
 * Learn documents exactly two supported shapes for a Snowflake source, and BOTH
 * require a Blob-typed linked service:
 *   - direct copy → the SINK linked service is Azure Blob Storage with shared
 *     access signature auth (it MAY point at a Gen2 account's blob endpoint);
 *   - staged copy → an interim Azure Blob Storage linked service, SAS auth
 *     absent a Snowflake `storageIntegration`.
 * Loom takes the staged shape because it preserves the ADLS Gen2 Bronze sink
 * the rest of the platform reads from (the paired Synapse Serverless endpoint
 * is provisioned over it).
 *   https://learn.microsoft.com/azure/data-factory/connector-snowflake
 */
function mirrorStagingBlobLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/**
 * The `properties.type` of a linked service as the FACTORY reports it, or null
 * when it could not be read.
 *
 * Null means UNKNOWN — the linked service is absent, or unreadable by this
 * identity — and callers must not collapse that into "wrong type" or into
 * "fine". The same read-back-rather-than-assume pattern the source linked
 * service uses (`snowflake-adf.snowflakeDatasetKind`).
 */
async function readLinkedServiceType(name: string): Promise<string | null> {
  try {
    const ls = await getLinkedService(name);
    const t = ls?.properties?.type;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/**
 * How a Snowflake table can be moved into Bronze on this deployment.
 *
 * Split out as a pure function so the pairing is validated at CONSTRUCTION
 * time. Before #4083 the engine authored a `SnowflakeExportCopyCommand` source
 * against an `AzureBlobFS` sink unconditionally; ADF accepted the pipeline and
 * rejected every RUN, after the unconditional Delete had already cleared
 * Bronze. Deciding here means an unsupported pairing is never authored at all.
 */
export type SnowflakeCopyTransferPlan =
  | { kind: 'staged'; stagingLinkedService: string }
  | { kind: 'unsupported'; missing: string; message: string };

/** The ONE linked-service type Snowflake's COPY-unload can write to. */
const STAGING_REQUIRED_TYPE = 'AzureBlobStorage';

/**
 * Decide the transfer shape.
 *
 * `observedType` is the `properties.type` READ BACK from the factory for
 * `stagingLinkedService` — `null` when the linked service could not be read at
 * all. It is passed in rather than fetched here so this stays a pure function
 * that can be tested against every type ADF can return.
 *
 * WHY THE TYPE IS CHECKED AND NOT JUST THE NAME: a non-empty string proves only
 * that somebody set the variable. The first thing an operator does when a gate
 * says "point LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE at a Blob linked service"
 * is point it at the linked service they already have — which on every Loom
 * deployment is `loom_mirror_sink_adls`, an `AzureBlobFS` (ADLS Gen2) linked
 * service. That passed the name-only check, authored the pipeline, and
 * reproduced the exact #4083 failure the gate exists to prevent. Reading the
 * type is what makes the gate mean what it says.
 */
export function planSnowflakeCopyTransfer(
  stagingLinkedService: string | null,
  observedType: string | null,
): SnowflakeCopyTransferPlan {
  if (!stagingLinkedService) {
    return {
      kind: 'unsupported',
      missing: 'LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE',
      message:
        "Snowflake's COPY INTO unload can only write to an Azure Blob endpoint, so Azure Data Factory rejects a " +
        'Snowflake source paired with an ADLS Gen2 (AzureBlobFS) sink: "Snowflake copy command not support ' +
        'Connector type as \'not Azure Blob Storage\'". The documented path is a staged copy through an interim ' +
        'Azure Blob Storage linked service using shared access signature authentication. ' +
        'Loom BINDS that linked service for you once the deploy has provisioned the staging account it needs ' +
        '(platform/fiab/bicep/modules/landing-zone/mirror-staging.bicep, surfaced as LOOM_MIRROR_STAGING_ACCOUNT). ' +
        'Neither value is set here, so this deployment predates that module — re-run the infra deploy. Until then ' +
        'this mirror is gated rather than authoring a pipeline ADF would reject on every run (issue #4086).',
    };
  }

  if (observedType === STAGING_REQUIRED_TYPE) {
    return { kind: 'staged', stagingLinkedService };
  }

  // Read it back and it was something else — name the type actually found, so
  // the operator is not left guessing which of their linked services is wrong.
  if (observedType) {
    return {
      kind: 'unsupported',
      missing: 'LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE',
      message:
        `LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE points at "${stagingLinkedService}", which is a ` +
        `${observedType} linked service. Snowflake's COPY INTO unload can only write to an Azure Blob ` +
        `endpoint, so the staging linked service must be ${STAGING_REQUIRED_TYPE} with shared access ` +
        'signature authentication. An AzureBlobFS (ADLS Gen2 / dfs endpoint) linked service — including the ' +
        'Bronze sink this mirror writes to — is rejected by ADF with "Snowflake copy command not support ' +
        'Connector type as \'not Azure Blob Storage\'", which is the failure this gate exists to prevent. ' +
        'Unset LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE to let Loom bind a correctly typed one against the ' +
        'staging account the deploy provisioned, or point it at a real AzureBlobStorage linked service — but ' +
        'not at the Bronze sink.',
    };
  }

  // UNKNOWN is not "wrong type" and it is not "fine" (memory:
  // csa_loom_unknown_as_negative_class). Say precisely what happened — the
  // linked service could not be READ — and fail closed, because authoring on an
  // unverified pairing is what produced #4083.
  return {
    kind: 'unsupported',
    missing: 'staging-linked-service-unreadable',
    message:
      `LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE names "${stagingLinkedService}", but Loom could not READ that ` +
      'linked service from the data factory, so its type is unknown — this is NOT a report that the type is ' +
      'wrong. Either the linked service does not exist in this factory, or the Console identity lacks Data ' +
      'Factory read access to it. Loom is gating rather than authoring a pipeline whose source/sink pairing it ' +
      `could not verify. Confirm "${stagingLinkedService}" exists in the factory and that the Console UAMI holds ` +
      'Data Factory Contributor on it.',
  };
}

/**
 * Bind the interim Blob staging linked service — CREATING it when the platform
 * has deployed a staging account for it.
 *
 * This is the `auto-bind-by-default.md` §5 half of #4083. The gate that
 * preceded it told the operator to go set
 * LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE at "a Blob linked service", which is
 * a plumbing job Loom holds every value for and can therefore do itself.
 *
 * WHY THE LINKED SERVICE IS NOT IN BICEP. It must carry a SAS — Snowflake's COPY
 * unload runs in Snowflake's cloud and cannot use a managed identity, and Learn
 * requires SAS auth on the staging linked service for exactly that reason. The
 * only SAS bicep can mint is `listAccountSas`/`listServiceSas`, both of which
 * need `allowSharedKeyAccess: true`, which this estate's Azure Policy denies. So
 * bicep deploys the ACCOUNT (hardened, keyless) and the console mints an Entra
 * USER-DELEGATION SAS against it here — no account key exists to leak.
 *
 * Re-bound on every Start, so a linked service deleted or edited out-of-band
 * self-heals and the SAS is refreshed (auto-bind-by-default.md §3).
 */
type StagingBinding =
  | { ok: true; name: string; stagingPath: string; autoBound: boolean; expiresAt: string | null }
  | { ok: false; missing: string; message: string };

async function bindStagingLinkedService(mirrorId: string): Promise<StagingBinding> {
  const pinned = mirrorStagingBlobLinkedService();
  const account = mirrorStagingAccount();

  // No staging account deployed → nothing to auto-bind. A pinned name is still
  // honoured (brownfield); otherwise planSnowflakeCopyTransfer gates below.
  if (!account) {
    return pinned
      ? { ok: true, name: pinned, stagingPath: `${STAGING_PATH_ROOT}/${mirrorId}`, autoBound: false, expiresAt: null }
      : { ok: false, missing: 'LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE', message: '' };
  }

  const name = pinned || STAGING_LS_CONVENTION_NAME;
  try {
    const sas = await generateContainerWriteSasUri(STAGING_PATH_ROOT, STAGING_SAS_TTL_HOURS, account);
    await upsertLinkedService(name, {
      name,
      properties: {
        type: 'AzureBlobStorage',
        description:
          'Loom Snowflake mirror staging (scratch). Container-scoped Entra user-delegation SAS, ' +
          'refreshed on every mirror Start. Not a data store — purged daily by lifecycle policy.',
        typeProperties: {
          // ADF stores this encrypted and never reads it back out.
          sasUri: { type: 'SecureString', value: sas.containerSasUri },
        },
      },
    } as any);
    // The SAS URI is CONTAINER-scoped, so the staging path is relative to that
    // container — prefixing it with the container name again would resolve to
    // `loom-mirror-staging/loom-mirror-staging/<id>`.
    return { ok: true, name, stagingPath: mirrorId, autoBound: true, expiresAt: sas.expiresAt };
  } catch (e: any) {
    return {
      ok: false,
      missing: 'staging-linked-service-bind-failed',
      message:
        `Loom could not bind the Snowflake staging linked service "${name}" against staging account ` +
        `"${account}": ${e?.message || String(e)}. The account is deployed by ` +
        'platform/fiab/bicep/modules/landing-zone/mirror-staging.bicep, which also grants the Console UAMI ' +
        'Storage Blob Delegator (to mint the SAS) and Storage Blob Data Contributor on it. If this deployment ' +
        'predates that module, or those grants have not propagated yet, re-run Start.',
    };
  }
}

/**
 * Snowflake source linked service to bind.
 *
 * An operator MAY pin their own with `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE`
 * (brownfield estates have hand-tuned linked services with private endpoints we
 * must not clobber). When they have not, the platform builds one from the
 * mirror's Loom connection — see `snowflake-adf.resolveSnowflakeLinkedService`.
 * The env var is an OVERRIDE, never a prerequisite: requiring it was an
 * `auto-bind-by-default.md` §5 violation, since Loom holds every value the
 * linked service needs.
 */
function mirrorSnowflakeLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE || process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/**
 * Is the ADF Copy path usable? The factory + the ADLS sink are genuine infra
 * prerequisites (deployed by bicep). The SOURCE linked service is no longer one
 * — it is auto-bound from the connection at Start.
 */
export function adfCopyConfigured(): boolean {
  return !!process.env.LOOM_ADF_NAME
    && !adfCdcConfigGate()
    && !!mirrorAdlsLinkedService();
}


/** ADF Copy pipeline name — stable + safe ([A-Za-z0-9_], first char a letter). */
function adfCopyName(mirrorId: string): string {
  const safe = (mirrorId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'mirror';
  return `loom_copy_${safe}`;
}

/** The schedule/tumbling trigger that re-runs a mirror's Copy pipeline. */
function adfCopyTriggerName(pipelineName: string): string {
  return adfSafeName(`${pipelineName}_trg`);
}

/**
 * Is this Delete activity gated behind a Copy that SUCCEEDED?
 *
 * That single property is what separates the safe copy-then-swap shape from the
 * delete-first shape that empties Bronze whenever the Copy fails. A Delete with
 * `dependsOn: []` is a ROOT activity: ADF runs it unconditionally, before
 * anything has been written.
 *
 * Keyed to the SHAPE (does a successful Copy dominate this Delete?), never to a
 * name or an authoring version — a mutation that renames the activities, adds a
 * decoy dependency on a non-Copy activity, or depends on a Copy with a
 * `Completed`/`Failed`/`Skipped` condition is still delete-first and is still
 * caught here.
 */
function deleteIsGatedOnCopySuccess(act: any, byName: Map<string, any>): boolean {
  const deps = Array.isArray(act?.dependsOn) ? act.dependsOn : [];
  return deps.some((d: any) => {
    const conds = Array.isArray(d?.dependencyConditions) ? d.dependencyConditions : [];
    if (!conds.includes('Succeeded')) return false;
    return byName.get(String(d?.activity ?? ''))?.type === 'Copy';
  });
}

/**
 * What `disarmExistingCopyPipeline` ACTUALLY did. Every field is an observation,
 * not an intention — `summary` is built from these and must never assert
 * something the calls did not establish (deploy-integrity.md R7).
 */
export interface CopyDisarmOutcome {
  trigger: 'stopped' | 'already-stopped' | 'absent' | 'stop-failed' | 'unreadable' | 'not-checked';
  pipeline: 'absent' | 'already-safe' | 'rewritten' | 'rewrite-failed' | 'unreadable' | 'not-checked';
  /** Delete-first activities actually removed from the STORED definition. */
  deletesRemoved: number;
  summary: string;
}

/**
 * Repair a mirror's ALREADY-PROVISIONED ADF artifacts when this deployment
 * cannot run the copy correctly.
 *
 * WHY THIS EXISTS. Gating only stops Loom from authoring a NEW bad pipeline. It
 * does nothing about one that is already in the factory: the gate returns long
 * before `upsertPipeline`, so a delete-first definition provisioned by an older
 * build survives untouched, and its ScheduleTrigger keeps firing on cadence.
 * Measured on `loom_copy_1ac5d678` (2026-08-26): trigger `runtimeState: Started`,
 * hourly, 14 triggered runs that day; every one of the three Delete activities
 * `Succeeded` and every Copy `Failed`. Those Deletes removed nothing only
 * because the Copy had never once succeeded, so the Bronze prefix they sweep had
 * never been populated (`foldersDeleted: 0`, no `filesDeleted`, on every run
 * sampled). That is luck, not safety: the first time a Copy succeeds the prefix
 * IS populated, and the next run's Delete — which runs first and unconditionally
 * — empties it whenever that run's Copy fails.
 *
 * Which makes shipping a Copy fix while leaving the old pipeline armed strictly
 * MORE dangerous than the broken state it replaces. Hence: repair, don't just
 * gate (auto-bind-by-default.md §3 — a stale binding is a bug to fix
 * automatically, not a message to show the user).
 *
 * ── ORDER: STOP THE TRIGGER FIRST, THEN REWRITE THE DEFINITION ──────────────
 * This order is chosen for what it leaves behind when it dies HALFWAY, which is
 * the only interesting case:
 *
 *   stop → rewrite  (chosen). If the rewrite fails or the process dies after the
 *     stop, the definition is still delete-first but it can no longer FIRE on a
 *     schedule. The hazard is inert.
 *   rewrite → stop  (rejected). If the REWRITE fails — the likelier failure, as
 *     it is a full PUT of a document that must first be read, versus a
 *     parameterless POST — we abort with a delete-first pipeline still on a live
 *     trigger. That is exactly the state this function exists to eliminate, and
 *     we would have spent our one attempt getting nowhere.
 *
 * The rule generalises: perform the action that REMOVES REACHABILITY before the
 * action that removes the hazard itself, so every prefix of the sequence is safe.
 *
 * What this canNOT do: a run already in flight when the trigger stops keeps
 * going, and a stopped trigger does not prevent a manual run of a pipeline that
 * is still delete-first. That is why the rewrite is still attempted after the
 * stop, and why a failed rewrite is REPORTED rather than swallowed.
 */
export async function disarmExistingCopyPipeline(mirrorId: string): Promise<CopyDisarmOutcome> {
  const pipelineName = adfCopyName(mirrorId);
  const triggerName = adfCopyTriggerName(pipelineName);

  // No factory configured means there is nothing to reach and nothing we can
  // claim about. Say "not checked" rather than "nothing to disarm" — those are
  // different facts (memory: csa_loom_unknown_as_negative_class).
  if (adfCdcConfigGate()) {
    return {
      trigger: 'not-checked', pipeline: 'not-checked', deletesRemoved: 0,
      summary:
        `Loom did NOT check whether a previously provisioned pipeline (${pipelineName}) is still armed, because no ` +
        'data factory is configured in this deployment. If this mirror was provisioned by an earlier deployment, ' +
        'its trigger may still be running.',
    };
  }

  // ── 1. Remove reachability: stop the schedule ─────────────────────────────
  let trigger: CopyDisarmOutcome['trigger'] = 'absent';
  let triggerDetail = '';
  try {
    const trg = await getTrigger(triggerName);
    const state = trg?.properties?.runtimeState;
    if (state === 'Started' || !state) {
      // Started, or present-but-state-unreadable. Stopping an already-stopped
      // trigger is a no-op in ADF, so when the state is UNKNOWN the safe move is
      // to stop it rather than to assume it is idle.
      try {
        await stopTrigger(triggerName);
        trigger = 'stopped';
      } catch (e: any) {
        trigger = 'stop-failed';
        triggerDetail = e?.message || String(e);
      }
    } else {
      trigger = 'already-stopped';
    }
  } catch (e: any) {
    if (e?.status === 404) {
      trigger = 'absent';
    } else {
      // Could not READ the trigger. That is not evidence it is idle, so attempt
      // the stop regardless rather than leave a possibly-armed schedule running.
      try {
        await stopTrigger(triggerName);
        trigger = 'stopped';
      } catch {
        trigger = 'unreadable';
        triggerDetail = e?.message || String(e);
      }
    }
  }

  // ── 2. Remove the hazard: strip the delete-first activities ───────────────
  // Only Deletes that are NOT gated on a successful Copy are removed. A Delete
  // from the corrected shape is load-bearing — it retires the previous
  // generation — and stripping it would trade data loss for unbounded duplicate
  // accumulation, a different defect.
  let pipeline: CopyDisarmOutcome['pipeline'] = 'absent';
  let deletesRemoved = 0;
  let pipelineDetail = '';
  let existing: any = null;
  try {
    existing = await getPipeline(pipelineName);
  } catch (e: any) {
    existing = null;
    pipeline = e?.status === 404 ? 'absent' : 'unreadable';
    if (pipeline === 'unreadable') pipelineDetail = e?.message || String(e);
  }
  if (existing) {
    const acts: any[] = Array.isArray(existing?.properties?.activities) ? existing.properties.activities : [];
    const byName = new Map<string, any>(acts.map((a) => [String(a?.name ?? ''), a]));
    const armed = acts.filter((a) => a?.type === 'Delete' && !deleteIsGatedOnCopySuccess(a, byName));
    if (!armed.length) {
      pipeline = 'already-safe';
    } else {
      const armedNames = new Set(armed.map((a) => String(a?.name ?? '')));
      const kept = acts
        .filter((a) => !armedNames.has(String(a?.name ?? '')))
        .map((a) => {
          const deps = Array.isArray(a?.dependsOn) ? a.dependsOn : [];
          const pruned = deps.filter((d: any) => !armedNames.has(String(d?.activity ?? '')));
          return pruned.length === deps.length ? a : { ...a, dependsOn: pruned };
        });
      try {
        await upsertPipeline(pipelineName, {
          name: pipelineName,
          properties: { ...existing.properties, activities: kept },
        } as any);
        deletesRemoved = armed.length;
        pipeline = 'rewritten';
      } catch (e: any) {
        pipeline = 'rewrite-failed';
        pipelineDetail = e?.message || String(e);
      }
    }
  }

  // ── 3. Report exactly what happened ───────────────────────────────────────
  const triggerPhrase = {
    'stopped': `its schedule trigger ${triggerName} was STOPPED`,
    'already-stopped': `its schedule trigger ${triggerName} was already stopped`,
    'absent': 'it has no schedule trigger',
    'stop-failed': `its schedule trigger ${triggerName} could NOT be stopped (${triggerDetail}) and may still be firing`,
    'unreadable': `its schedule trigger ${triggerName} could NOT be read or stopped (${triggerDetail}), so whether it is still firing is UNKNOWN`,
    'not-checked': 'its schedule trigger was not checked',
  }[trigger];
  const pipelinePhrase = {
    'absent': 'no previously provisioned pipeline exists in the factory',
    'already-safe': 'the stored pipeline has no delete-first activity',
    'rewritten': `${deletesRemoved} delete-first activit${deletesRemoved === 1 ? 'y was' : 'ies were'} REMOVED from the stored pipeline`,
    'rewrite-failed': `the stored pipeline still holds delete-first activities and could NOT be rewritten (${pipelineDetail})`,
    'unreadable': `the stored pipeline could NOT be read (${pipelineDetail}), so whether it holds a delete-first activity is UNKNOWN`,
    'not-checked': 'the stored pipeline was not checked',
  }[pipeline];

  return {
    trigger, pipeline, deletesRemoved,
    summary: `Existing ADF artifacts for this mirror (${pipelineName}): ${pipelinePhrase}, and ${triggerPhrase}.`,
  };
}

/** Refresh cadence → ADF schedule-trigger recurrence. 'on-demand' = no trigger. */
function copyRecurrence(cadence: string): { frequency: string; interval: number } | null {
  switch (cadence) {
    case '15min': return { frequency: 'Minute', interval: 15 };
    case '1h': return { frequency: 'Hour', interval: 1 };
    case '4h': return { frequency: 'Hour', interval: 4 };
    case 'daily': return { frequency: 'Day', interval: 1 };
    default: return null; // 'on-demand'
  }
}

/**
 * What each sync mode ACTUALLY produces on the ADF Copy runtime.
 *
 * The three modes have to be observably different or the selector is decoration.
 * On this backend they are three different sets of ADF artifacts:
 *
 *   snapshot    → the pipeline runs ONCE. No trigger is registered at all.
 *   incremental → a ScheduleTrigger at the deployment cadence
 *                 (LOOM_MIRROR_COPY_CADENCE, default 1h).
 *   continuous  → a TumblingWindowTrigger at the 15-minute floor with
 *                 maxConcurrency 1, so windows queue rather than overlap.
 *
 * HONESTY NOTE (deploy-integrity.md R7): on this backend `incremental` means
 * "re-copied on a schedule", not row-level change capture — the ADF Snowflake
 * connector has no CDC source, so each run is a full refresh: a fresh copy
 * followed by a delete of the previous generation.
 * Snowflake CHANGES/stream-based row-level deltas are a disclosed follow-up, and
 * the wizard's per-source note says exactly this rather than implying more.
 */
export type CopyTriggerPlan =
  | { kind: 'none'; reason: string }
  | { kind: 'schedule'; cadence: string; recurrence: { frequency: string; interval: number } }
  | { kind: 'tumbling'; cadence: string; recurrence: { frequency: string; interval: number } };

export function planCopyTrigger(
  syncMode: MirrorSource['syncMode'],
  cadence: string,
): CopyTriggerPlan {
  if (syncMode === 'snapshot') {
    return { kind: 'none', reason: 'One-time full load (sync mode: snapshot); no ongoing trigger was registered.' };
  }
  if (syncMode === 'continuous') {
    return { kind: 'tumbling', cadence: '15min', recurrence: { frequency: 'Minute', interval: 15 } };
  }
  const recurrence = copyRecurrence(cadence);
  if (!recurrence) {
    return { kind: 'none', reason: `One-time full load (LOOM_MIRROR_COPY_CADENCE=${cadence} means on-demand); no ongoing trigger was registered.` };
  }
  return { kind: 'schedule', cadence, recurrence };
}


/**
 * Return a Gated result — and first REPAIR whatever this mirror already has in
 * the factory.
 *
 * Every gate in `runMirrorAdfCopy` returns before `upsertPipeline`, so without
 * this a gate is purely advisory for an already-provisioned mirror: it stops the
 * next bad pipeline being written and leaves the existing one running. Routing
 * all of them through here makes "Loom cannot run this correctly" and "so Loom
 * has made sure it is not running" the same event.
 *
 * The disarm's own account of what it did is appended to the gate message, so
 * the operator is told the true post-state — including when the repair itself
 * failed or could not be verified — rather than being left to assume the gate
 * made things safe (deploy-integrity.md R7).
 */
async function gatedRun(
  mirrorId: string, missing: string, message: string, note: string,
): Promise<MirrorRunResult> {
  const disarm = await disarmExistingCopyPipeline(mirrorId);
  return {
    ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-copy', tables: [],
    gate: { missing, message: `${message} ${disarm.summary}` },
    note,
  };
}

/**
 * POSITIVE evidence that ADF REFUSED the trigger call, or `null` when nothing
 * establishes it.
 *
 * The sibling of the Snowflake R7 defect, in the same file's blast radius: the
 * trigger-start `catch` used to append "re-run Start or grant the Console UAMI
 * Data Factory Contributor" to EVERY failure, whatever ADF said. A missing
 * pipeline reference, a 409 on a concurrent update, a 429, an ARM outage — all
 * of them told the operator to go check an RBAC grant that was, in every one of
 * those cases, already correct.
 *
 * So the grant is named only on evidence of a refusal:
 *   - a STRUCTURED status: `adf-client`'s `jsonOrThrow` rides `status` along on
 *     the thrown error precisely "so a BFF route can classify … without regexing
 *     the message". Reading the field beats parsing prose, so it is read first.
 *   - failing that, ARM's own denial CODES in the message. `startTrigger` throws
 *     a bare Error with the status interpolated into the string, so the prose
 *     path is not dead code — it is the only path for that call.
 *
 * The `40[13]` alternation is ANCHORED (`status-token.ts`). Unanchored, it
 * matches inside a factory or trigger name — `loom_copy_403abc_trg` — which is
 * exactly how `_az-failure-class.mjs` once classified `rg-loom-503` as transient.
 */
export function adfDenialEvidence(e: unknown): string | null {
  const err = (e ?? null) as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const raw = err?.status ?? err?.statusCode;
  const status = Number(raw ?? 0);
  if (status === 401 || status === 403) return `ARM answered ${status}`;
  const msg = typeof err?.message === 'string' ? err.message : String(e ?? '');
  const DENIED = new RegExp(
    [
      'AuthorizationFailed',
      'LinkedAuthorizationFailed',
      'does not have authorization',
      'Forbidden',
      'Unauthorized',
      statusToken('40[13]'),
    ].join('|'),
    'i',
  );
  const m = DENIED.exec(msg);
  return m ? `ARM refused the call (${m[0]})` : null;
}

/**
 * The run note for a trigger that would not start. The initial load DID run —
 * that part is established and is stated first — and the cause of the trigger
 * failure is named only when `adfDenialEvidence` found it.
 *
 * Exported so it is directly testable: inline, it could be reverted to the
 * unconditional string with the whole suite still green.
 */
export function describeTriggerStartFailure(
  kind: CopyTriggerPlan['kind'],
  e: unknown,
): string {
  const label = kind === 'tumbling' ? 'tumbling-window' : 'schedule';
  const detail = (e as { message?: string } | null)?.message || String(e ?? '');
  const denial = adfDenialEvidence(e);
  if (denial) {
    return (
      ` Initial load ran; the ongoing ${label} trigger could NOT be started — ${denial}: ${detail}. ` +
      'This one IS a permission problem and ARM named it: grant the Console UAMI "Data Factory Contributor" ' +
      'on the factory, then re-run Start.'
    );
  }
  return (
    ` Initial load ran; the ongoing ${label} trigger could NOT be started: ${detail}. ` +
    'Loom did NOT establish why — this was not shown to be a permission problem, so do not start by changing ' +
    'role assignments. Re-run Start to try again; if it fails the same way, the ADF message above is the whole ' +
    'of what is known.'
  );
}


/**
 * Provision + run an ADF Copy pipeline that lands each selected table as Parquet
 * in ADLS Bronze (copy-then-swap full refresh), and — unless syncMode is
 * 'snapshot' — register a schedule trigger that re-runs the copy on a cadence
 * (LOOM_MIRROR_COPY_CADENCE, default '1h'). Returns a MirrorRunResult carrying the
 * pipeline name (the ADF run-id receipt) + per-table Parquet landing paths. The
 * Snowflake source + AzureBlobFS sink are pre-existing ADF linked services bound
 * by env var. Real ARM calls; failures surface verbatim (no fake success).
 */
export async function runMirrorAdfCopy(
  mirrorId: string, workspaceId: string, src: MirrorSource, tableSpecs: MirrorTableSpec[], note: string,
): Promise<MirrorRunResult> {
  const adlsLs = mirrorAdlsLinkedService();
  const adfGate = adfCdcConfigGate();
  if (adfGate || !adlsLs) {
    return gatedRun(
      mirrorId,
      adfGate?.missing || 'LOOM_MIRROR_ADLS_LINKED_SERVICE',
      'Snowflake mirroring runs on an ADF Copy runtime (no Microsoft Fabric). This deployment is missing the ' +
        'factory or the ADLS sink linked service, both of which platform/fiab/bicep deploys: ' +
        `${adfGate?.missing || 'LOOM_MIRROR_ADLS_LINKED_SERVICE'}. The Snowflake source linked service is NOT a ` +
        "prerequisite — Loom builds it from the mirror's connection.",
      note,
    );
  }

  // ── Validate the source/sink pairing BEFORE authoring anything ────────────
  // Cheapest gate first: if this deployment cannot move a Snowflake row into
  // Bronze at all, say so now rather than binding a linked service, enumerating
  // the source, and authoring a pipeline whose every run ADF will reject.
  //
  // The staging linked service's TYPE is read back from the factory, not
  // inferred from the variable being set — see planSnowflakeCopyTransfer for
  // why a name-only check is not a gate. This mirrors what the SOURCE linked
  // service already does via snowflakeDatasetKind().
  const stagingLs = mirrorStagingBlobLinkedService();
  const staging = await bindStagingLinkedService(mirrorId);
  if (!staging.ok && staging.missing === 'staging-linked-service-bind-failed') {
    return gatedRun(mirrorId, staging.missing, staging.message, note);
  }
  const stagingName = staging.ok ? staging.name : stagingLs;
  const transfer = planSnowflakeCopyTransfer(
    stagingName,
    stagingName ? await readLinkedServiceType(stagingName) : null,
  );
  if (transfer.kind === 'unsupported') {
    return gatedRun(mirrorId, transfer.missing, transfer.message, note);
  }

  // ── Auto-bind the Snowflake linked service (auto-bind-by-default.md §5) ────
  // Built from the mirror's Loom Connection, named after it, and re-upserted on
  // every Start so a linked service deleted or edited out-of-band self-heals.
  const bound = await resolveSnowflakeLinkedService(src.tenantId || '', src.connectionId);
  if ('gate' in bound) {
    return gatedRun(mirrorId, bound.gate.missing, bound.gate.message, note);
  }
  const sourceLs = bound.binding.linkedServiceName;
  // A pinned linked service may be the LEGACY V1 connector; read its type rather
  // than assuming, because a V2 dataset on a V1 linked service is rejected.
  const kind = await snowflakeDatasetKind(sourceLs);

  // ── Resolve WHICH tables replicate, and honour the Iceberg toggle ──────────
  // No explicit subset means "mirror everything", which on this backend requires
  // a real enumeration — a Copy pipeline needs a dataset per table. This is also
  // where `includeIcebergTables` becomes load-bearing: Snowflake-managed Iceberg
  // tables are excluded unless the mirror asked for them.
  let specs = tableSpecs;
  let tableNote = '';
  // Null when no enumeration ran (an explicit subset was pinned) or the probe
  // could not be read — never conflated with "the role sees zero schemas".
  let visibleSchemas: number | null = null;
  if (!specs.length) {
    const listed = await listSnowflakeTables(src.tenantId || '', src.connectionId, src.database);
    if ('gate' in listed) {
      return gatedRun(mirrorId, listed.gate.missing, listed.gate.message, note);
    }
    const all = listed.tables;
    visibleSchemas = listed.visibleSchemas;
    const kept = src.includeIcebergTables ? all : all.filter((t) => !t.isIceberg);
    const dropped = all.length - kept.length;
    specs = kept.slice(0, MAX_TABLES).map((t) => ({ schema: t.schema, table: t.table }));
    if (!listed.icebergKnown) {
      tableNote = ` Enumerated ${all.length} tables (this Snowflake edition does not expose IS_ICEBERG, so no table could be classified as Iceberg).`;
    } else if (src.includeIcebergTables) {
      const ice = all.filter((t) => t.isIceberg).length;
      tableNote = ` Enumerated ${all.length} tables, including ${ice} Snowflake-managed Iceberg table${ice === 1 ? '' : 's'}.`;
    } else {
      tableNote = ` Enumerated ${all.length} tables${dropped ? `; excluded ${dropped} Snowflake-managed Iceberg table${dropped === 1 ? '' : 's'} (turn on "Include Iceberg tables" to mirror them)` : ''}.`;
    }
  }
  if (!specs.length) {
    // Zero tables has TWO causes and they send the operator to different
    // places. The visibility probe (see snowflake-adf) distinguishes them, so
    // this names the one that actually happened instead of guessing.
    const noVisibility = visibleSchemas === 0;
    const base = noVisibility
      ? `The connection's role cannot see ANY schema in Snowflake database ${src.database}, so no table list could be built. ` +
        'This is a grants problem, not an empty database: grant the role USAGE on the database and its schemas, and SELECT on the tables to mirror.'
      : `No tables were found in Snowflake database ${src.database}` +
        (visibleSchemas === null
          ? ' (Loom could not determine whether the role can see its schemas, so a missing grant is still possible).'
          : ` across the ${visibleSchemas} schema(s) the role can see.`);
    return gatedRun(
      mirrorId,
      noVisibility ? 'snowflake-grants' : 'tables',
      src.includeIcebergTables || noVisibility
        ? base
        : `${base} If its tables are Snowflake-managed Iceberg tables, turn on "Include Iceberg tables" on the mirror.`,
      note,
    );
  }
  const tableSpecsResolved = specs;


  const pipelineName = adfCopyName(mirrorId);
  const basePath = `mirrors/${workspaceId}/${mirrorId}`;
  const cadence = (process.env.LOOM_MIRROR_COPY_CADENCE || '1h').trim();
  const triggerPlan = planCopyTrigger(src.syncMode, cadence);

  // One source dataset + one Parquet sink dataset + a copy-then-swap activity
  // pair per selected table. Datasets named off the pipeline + table (safe).
  const activities: unknown[] = [];
  try {
    for (const t of tableSpecsResolved) {
      const srcDs = adfSafeName(`${pipelineName}_s_${t.schema}_${t.table}`);
      const sinkDs = adfSafeName(`${pipelineName}_k_${t.schema}_${t.table}`);
      const folderPath = `${basePath}/${t.schema}.${t.table}`;
      await upsertDataset(srcDs, {
        name: srcDs,
        properties: {
          type: kind.dataset,
          linkedServiceName: { referenceName: sourceLs, type: 'LinkedServiceReference' },
          schema: [],
          typeProperties: { schema: t.schema, table: t.table },
        },
      } as any);

      await upsertDataset(sinkDs, {
        name: sinkDs,
        properties: {
          type: 'Parquet',
          linkedServiceName: { referenceName: adlsLs, type: 'LinkedServiceReference' },
          typeProperties: {
            location: { type: 'AzureBlobFSLocation', fileSystem: BRONZE, folderPath },
          },
        },
      } as any);
      const delName = adfSafeName(`DeletePrev_${t.schema}_${t.table}`);
      const copyName = adfSafeName(`Copy_${t.schema}_${t.table}`);
      // ── Copy FIRST; delete the PREVIOUS generation only once it succeeded ──
      // The Delete used to run first with `dependsOn: []`, which made the full
      // refresh non-transactional: the Delete succeeded, the Copy failed, and
      // Bronze was left EMPTY. That is silent data loss on any copy failure,
      // transient or not. Measured on pipeline `loom_copy_1ac5d678` — four
      // consecutive runs, every Delete Succeeded, every Copy Failed,
      // `rowsCopied: null` throughout (issue #4083).
      //
      // Copy now has no dependency and the Delete is conditional on it having
      // SUCCEEDED, so a failed copy leaves the previous snapshot intact. The
      // Delete removes only files last modified BEFORE this run started
      // (`@pipeline().TriggerTime`), which is the previous generation — the
      // rows this run just wrote are newer and are not matched. Chaining a
      // Delete behind a Copy this way is the shape Learn documents for moving
      // data; `wildcardFileName` is required whenever a modifiedDatetime filter
      // is used, a documented limitation of the Delete activity.
      //   https://learn.microsoft.com/azure/data-factory/delete-activity
      //
      // WHAT THIS SHAPE COSTS — both windows, stated (deploy-integrity.md R7).
      // Copy-then-delete is not transactional. There is no instant at which
      // Bronze is guaranteed to hold exactly one generation, so a concurrent
      // reader (Synapse Serverless OPENROWSET over this folder, which is how
      // the rest of the platform reads Bronze) can observe two wrong states:
      //
      //   1. DURING every healthy run, between the Copy completing and the
      //      Delete completing, Bronze holds BOTH the previous generation and
      //      the fresh one, so a read in that window returns EVERY ROW TWICE.
      //      This is the dangerous one because it is SILENT: no error, no empty
      //      folder, nothing anomalous in the data — just doubled counts and
      //      doubled sums, for as long as the Delete takes.
      //   2. AFTER a run whose Copy SUCCEEDED and whose Delete FAILED, Bronze
      //      holds both generations persistently — duplicate rows until the
      //      next successful run repairs it.
      //
      // Both are recoverable and neither destroys data, which is why this shape
      // was chosen over the pre-#4083 delete-first shape (that one emptied
      // Bronze on ANY copy failure) and over write-then-swap (4 activities per
      // table would breach ADF's 120-activity pipeline ceiling at MAX_TABLES=50
      // and force a regression from 50 tables to 30). This is a real
      // correctness limit of the ADF Copy backend, not something reordering
      // fixes: closing window 1 needs an atomic publish (swapping a pointer the
      // reader follows), which is tracked separately. Do NOT describe this
      // backend as giving readers a consistent snapshot — it does not.
      activities.push({
        name: copyName,
        type: 'Copy',
        dependsOn: [],
        inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
        outputs: [{ referenceName: sinkDs, type: 'DatasetReference' }],
        typeProperties: {
          source: { type: kind.source, exportSettings: { type: 'SnowflakeExportCopyCommand' } },
          // MergeFiles is required on a staged Snowflake copy: without it only
          // the last partitioned file of the unload is copied to the sink.
          //   https://learn.microsoft.com/azure/data-factory/connector-snowflake
          sink: {
            type: 'ParquetSink',
            storeSettings: { type: 'AzureBlobFSWriteSettings', copyBehavior: 'MergeFiles' },
          },
          enableStaging: true,
          stagingSettings: {
            linkedServiceName: { referenceName: transfer.stagingLinkedService, type: 'LinkedServiceReference' },
            path: staging.ok ? staging.stagingPath : `${STAGING_PATH_ROOT}/${mirrorId}`,
          },
        },
      });
      activities.push({
        name: delName,
        type: 'Delete',
        dependsOn: [{ activity: copyName, dependencyConditions: ['Succeeded'] }],
        typeProperties: {
          dataset: { referenceName: sinkDs, type: 'DatasetReference' },
          recursive: true,
          enableLogging: false,
          storeSettings: {
            type: 'AzureBlobFSReadSettings',
            recursive: true,
            wildcardFileName: '*',
            modifiedDatetimeEnd: { value: '@pipeline().TriggerTime', type: 'Expression' },
          },
        },
      });
    }

    await upsertPipeline(pipelineName, {
      name: pipelineName,
      properties: { activities, annotations: ['loom-mirror', mirrorId], folder: { name: 'loom-mirrors' } },
    } as any);
  } catch (e: any) {
    return {
      ok: false, status: 'Error', backend: 'azure-native-cdc', engine: 'adf-copy', cdcName: pipelineName, tables: [],
      basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note,
      error: `ADF Copy pipeline authoring failed: ${e?.message || String(e)}`,
    };
  }

  // Fire the initial full load. Auth-to-source/sink failures are surfaced verbatim.
  try {
    await runPipeline(pipelineName);
  } catch (e: any) {
    return {
      ok: false, status: 'Error', backend: 'azure-native-cdc', engine: 'adf-copy', cdcName: pipelineName, tables: [],
      basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note,
      error: `ADF Copy initial run failed: ${e?.message || String(e)}`,
    };
  }

  // Register + start the ongoing trigger. Which trigger — and whether there is
  // one at all — is what makes the three sync modes observably different in the
  // factory (see planCopyTrigger). Best-effort: a trigger failure does not fail
  // the initial load, and the reason is stated rather than swallowed.
  let triggerNote = '';
  const triggerName = adfCopyTriggerName(pipelineName);
  if (triggerPlan.kind === 'none') {
    // A mode with NO ongoing trigger must also retire one a previous Start left
    // behind. Switching a mirror from incremental to snapshot otherwise leaves
    // the old ScheduleTrigger firing the pipeline on the old cadence forever,
    // which makes the sync-mode selector a lie — the same stale-binding class as
    // the delete-first pipeline (auto-bind-by-default.md §3).
    let stopped = '';
    try {
      const trg = await getTrigger(triggerName);
      if (trg?.properties?.runtimeState === 'Started') {
        await stopTrigger(triggerName);
        stopped = ` A trigger left by a previous sync mode (${triggerName}) was stopped.`;
      }
    } catch (e: any) {
      // 404 = there was never a trigger, which is the expected case. Anything
      // else means Loom does NOT know whether one is still firing, and says so
      // rather than implying the one-time load is the only thing that will run.
      if (e?.status !== 404) {
        stopped =
          ` Loom could NOT confirm whether a trigger from a previous sync mode (${triggerName}) is still running ` +
          `(${e?.message || String(e)}).`;
      }
    }
    triggerNote = ` ${triggerPlan.reason}${stopped}`;
  } else {
    const startTime = new Date().toISOString();
    try {
      if (triggerPlan.kind === 'tumbling') {
        // Continuous → a tumbling window at the 15-minute floor. maxConcurrency 1
        // makes windows queue instead of overlapping, so a slow full refresh can
        // never stack copies on top of each other.
        await upsertTrigger(triggerName, {
          name: triggerName,
          properties: {
            type: 'TumblingWindowTrigger',
            pipeline: { pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' } },
            typeProperties: {
              frequency: triggerPlan.recurrence.frequency,
              interval: triggerPlan.recurrence.interval,
              startTime,
              maxConcurrency: 1,
              retryPolicy: { count: 2, intervalInSeconds: 60 },
            },
          },
        } as any);
      } else {
        await upsertTrigger(triggerName, {
          name: triggerName,
          properties: {
            type: 'ScheduleTrigger',
            pipelines: [{ pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' } }],
            typeProperties: { recurrence: { ...triggerPlan.recurrence, startTime, timeZone: 'UTC' } },
          },
        } as any);
      }
      await startTrigger(triggerName);
      triggerNote = triggerPlan.kind === 'tumbling'
        ? ` Continuous sync: tumbling-window trigger ${triggerName} every ${triggerPlan.cadence} (max 1 concurrent window).`
        : ` Incremental sync: schedule trigger ${triggerName} re-copies every ${triggerPlan.cadence}.`;
    } catch (e: any) {
      triggerNote = describeTriggerStartFailure(triggerPlan.kind, e);
    }
  }

  const credNote = bound.binding.credential === 'key-vault-reference'
    ? ' Credential read by the factory from Key Vault by reference (never copied into the linked service).'
    : bound.binding.credential === 'inline-secure-string'
      ? ' Credential stored in the linked service as an encrypted SecureString (no Key Vault linked service is bound in this deployment).'
      : '';
  // Say when the staging credential runs out. A trigger keeps firing past that
  // point and those runs fail to stage — stating the date is the difference
  // between a known limit and a mystery outage (deploy-integrity.md R7).
  const stagingNote = staging.ok && staging.autoBound && staging.expiresAt
    ? ` Staging linked service ${staging.name} was bound automatically with a container-scoped Entra ` +
      `user-delegation SAS valid until ${staging.expiresAt}; Start the mirror again before then to refresh it.`
    : '';
  const adfNote =
    'Azure-native mirror via ADF Copy runtime (no Microsoft Fabric): each selected Snowflake table is ' +
    `copied as Parquet into ADLS Bronze, staged through ${transfer.stagingLinkedService}, and the previous ` +
    `generation deleted only after that copy succeeded. Pipeline: ${pipelineName}. ` +
    `Snowflake linked service: ${sourceLs}.${credNote}${stagingNote}${tableNote}${triggerNote}`;
  const lastSync = new Date().toISOString();
  const tables: MirrorTableResult[] = tableSpecsResolved.map((t) => {

    const folderUrl = pathToHttpsUrl(BRONZE, `${basePath}/${t.schema}.${t.table}/`);
    const openrowset = `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', FORMAT = 'PARQUET') AS rows`;
    return {
      schema: t.schema, table: t.table, status: 'replicated', mode: 'snapshot',
      rows: 0, bytes: 0, truncated: false, lastSync, path: folderUrl, openrowset,
      note: 'ADF Copy: full load running. Row/byte metrics populate in the ADF monitor.',
    };
  });

  return {
    ok: true, status: 'Running', backend: 'azure-native-cdc', engine: 'adf-copy', cdcName: pipelineName, tables,
    basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note: adfNote,
  };
}