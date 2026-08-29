/**
 * mirror-adf-shared — the small primitives BOTH mirror engines need.
 *
 * `mirror-engine.ts` dispatches to `mirror-adf-copy.ts`, so anything the copy
 * runtime imports back out of the engine would be a require cycle. These values
 * are the entire overlap, so they live here instead. Types stay in
 * `mirror-engine.ts` and are pulled with `import type`, which TypeScript erases,
 * so they create no runtime edge.
 *
 * Extracted when `mirror-engine.ts` crossed its 1700-LOC ceiling. The seam is
 * the one the file already documented with its own banner comment — the ADF
 * Copy runtime — not an arbitrary line-count cut.
 *
 * This module used to import nothing of ours. It now imports `adf-client`,
 * `adls-client` and `cloud-endpoints` so the ADLS sink can AUTO-BIND (below).
 * None of the three imports anything under `mirror-*`, so the no-cycle
 * invariant the extraction exists to protect is intact — what changed is that
 * this leaf is no longer import-free, not that it gained an edge back into an
 * engine.
 */
import {
  getPipelineRun,
  listActivityRuns,
  upsertLinkedService,
  type AdfActivityRun,
} from './adf-client';
import { getAccountName } from './adls-client';
import { dfsSuffix } from './cloud-endpoints';
import { classifySnowflakeFailure, describeSnowflakeFailure } from './snowflake-failure-class';

/** The ADLS container every mirror lands into. */
export const BRONZE = 'bronze';

/** Cap how many tables one Start replicates when none were explicitly chosen. */
export const MAX_TABLES = Number(process.env.LOOM_MIRROR_MAX_TABLES || 50);

/**
 * ADF object name: letters/digits/_ only, first char a letter. Byte-for-byte
 * the same transform the provisioner's `adfName()` applies, so the derived
 * pipeline name matches the one `provisionAdfCdc()` created (`<name>_to_bronze`).
 */
export function adfSafeName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}

/**
 * The auto-bound ADLS Gen2 sink linked service — one per factory, authenticated
 * with the FACTORY's own managed identity (no credential field, no account key).
 */
export const LOOM_MIRROR_SINK_LINKED_SERVICE = 'loom_mirror_sink_adls';

/**
 * An operator-PINNED ADLS sink linked service, or null.
 *
 * `LOOM_MIRROR_ADLS_LINKED_SERVICE` is an OVERRIDE, not a prerequisite — the
 * same contract `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` already has. A brownfield
 * estate may hold a hand-tuned `AzureBlobFS` linked service (a managed private
 * endpoint, a different account, a SHIR) that Loom must not clobber; setting the
 * variable keeps it. Everyone else gets the auto-bound one and never learns the
 * variable exists.
 */
export function mirrorAdlsLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/**
 * The DFS endpoint of the deployment's Bronze account, or null when the lake is
 * not wired.
 *
 * Sovereign-cloud correct by construction: the suffix comes from `dfsSuffix()`,
 * which resolves the Commercial/GCC host in one boundary and the US-Government
 * host in GCC-High / IL5 / DoD. No literal appears here — a hard-coded
 * Commercial host is the exact defect this repo ratchets against, and it is what
 * made every SQL mirror in a sovereign boundary bind to a hostname that does not
 * resolve there. `getAccountName()` throws when no `LOOM_{BRONZE,SILVER,GOLD,
 * LANDING}_URL` is configured, so it is guarded the same way
 * `mirror-engine.bronzeConfigured()` guards it.
 */
export function mirrorAdlsSinkUrl(): string | null {
  if (!process.env.LOOM_BRONZE_URL) return null;
  try {
    return `https://${getAccountName()}.${dfsSuffix()}`;
  } catch {
    return null;
  }
}

/** Why an ADLS sink linked service could not be bound. Never carries a secret. */
export interface MirrorSinkGate {
  missing: string;
  message: string;
}

/**
 * Resolve the ADLS Gen2 sink linked service a mirror should write through,
 * CREATING it when it is absent.
 *
 * ## Why this exists (auto-bind-by-default.md §5)
 *
 * The install-time SQL mirror path has always auto-created its own sink —
 * `lib/install/provisioners/mirrored-database.ts` upserts
 * `<MirrorName>_sink_adls` as `AzureBlobFS` with factory-MI auth and gets on
 * with it. The Start-time ADF Copy and ADF CDC paths did not: they DEMANDED a
 * pre-existing shared linked service named by `LOOM_MIRROR_ADLS_LINKED_SERVICE`,
 * and gated when it was unset — which it is on every shipped deployment, because
 * the bicep param that feeds it has no value to compose.
 *
 * That asymmetry was the defect. Loom holds every value the linked service needs
 * (the Bronze account is `LOOM_BRONZE_URL`, the auth is the factory's own MI), so
 * asking the operator for it is precisely the shape §5 forbids. The fix is not to
 * deploy the linked service from bicep — ADF linked services are data-plane
 * objects an ARM template does not own here — it is to make the runtime create
 * the thing it needs, exactly like its sibling already did.
 *
 * ## Self-healing (§3)
 *
 * The upsert is unconditional, so a linked service deleted or edited out-of-band
 * is simply rebuilt on the next Start rather than surfacing an error.
 *
 * ## Idempotency
 *
 * `upsertLinkedService` is a name-addressed ARM PUT. Re-running it with the same
 * name and body is a no-op on the service, so a re-Start (or a redeploy that
 * re-runs a mirror) can never create a second sink.
 */
export async function ensureMirrorAdlsLinkedService(): Promise<
  { linkedServiceName: string; pinned: boolean } | { gate: MirrorSinkGate }
> {
  const pinned = mirrorAdlsLinkedService();
  if (pinned) return { linkedServiceName: pinned, pinned: true };

  const url = mirrorAdlsSinkUrl();
  if (!url) {
    return {
      gate: {
        missing: 'LOOM_BRONZE_URL',
        message:
          'The ADLS Bronze landing zone is not configured for this deployment, so the mirror has nowhere to write. ' +
          'LOOM_BRONZE_URL is produced by the landing-zone deploy (platform/fiab/bicep) — no linked service or ' +
          'portal step is required once the lake is bound.',
      },
    };
  }

  await upsertLinkedService(LOOM_MIRROR_SINK_LINKED_SERVICE, {
    name: LOOM_MIRROR_SINK_LINKED_SERVICE,
    properties: {
      type: 'AzureBlobFS',
      description:
        'Loom mirroring Bronze sink (factory managed-identity auth). Auto-bound by CSA Loom — do not hand-edit.',
      typeProperties: { url },
    },
  } as never);
  return { linkedServiceName: LOOM_MIRROR_SINK_LINKED_SERVICE, pinned: false };
}

// ============================================================
// #4025 — the SUBMITTED-IS-NOT-SUCCEEDED repair
// ============================================================
//
// `runMirrorAdfCopy` fired `runPipeline(pipelineName)`, DISCARDED the
// `PipelineRunResponse` (which carries the runId), and returned
// `ok: true, status: 'Running'` with every table synthesised as
// `status: 'replicated', rows: 0, bytes: 0`. The pipeline was SUBMITTED, and
// Loom reported that as success.
//
// Every run-time failure on the Snowflake mirroring path therefore surfaced as
// success — the factory MI lacking Key Vault Secrets User, the Snowflake role
// lacking CREATE STAGE (the Copy activity creates an external stage with a SAS
// URI), a suspended warehouse that cannot auto-resume, a source unreachable from
// the factory's network. In all four the badge read "Running", the grid read
// `replicated / 0 rows`, and nothing landed in Bronze. An independent review of
// #4024 called this the single thing most likely to make a demo look fine while
// no data moves.
//
// The polling primitive already existed and was proven: `snowflake-adf.ts`
// `listSnowflakeTables` runs a bounded `getPipelineRun` loop and reports the real
// terminal status. This is that shape, extracted so both mirror engines use ONE
// implementation rather than two that can drift.

/** How long a Start waits for the initial load before reporting UNKNOWN. */
export const ADF_RUN_TIMEOUT_MS = Number(process.env.LOOM_MIRROR_RUN_TIMEOUT_MS || 120_000);
/** Gap between `getPipelineRun` polls. */
export const ADF_RUN_POLL_MS = Number(process.env.LOOM_MIRROR_RUN_POLL_MS || 3_000);

/** ARM pipeline-run states that will not change again. */
const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled']);

/** What a bounded poll of one pipeline run established. */
export interface AdfRunOutcome {
  readonly runId: string;
  /** The last status ARM reported. `'Unknown'` when the run could not be read. */
  readonly status: string;
  /** True only when ARM reported a state that will not change again. */
  readonly terminal: boolean;
  /** True only for a terminal `Succeeded`. NEVER inferred from anything else. */
  readonly succeeded: boolean;
  /** ARM's own message, verbatim, or '' when there was none. */
  readonly message: string;
  /** Per-activity detail, read once the run reached a terminal state. */
  readonly activities: readonly AdfActivityRun[];
  /** True when the deadline expired before a terminal state was reached. */
  readonly timedOut: boolean;
}

/**
 * Poll ONE pipeline run to a terminal state, or to the deadline.
 *
 * NEVER REPORTS SUCCESS ON AN UNVERIFIED OUTCOME (`deploy-integrity.md` R6).
 * `succeeded` is true for exactly one input — a terminal `Succeeded` — and every
 * other path (Failed, Cancelled, still running at the deadline, ARM unreadable)
 * leaves it false with `timedOut` / `status` saying which.
 *
 * A failure to READ the run is not a failure of the run, and the two are kept
 * apart: an unreadable run comes back `status: 'Unknown'`, `terminal: false`,
 * with the read error as the message. Reporting "the pipeline failed" when the
 * truth is "I could not look" is the R7 shape this repo has already paid for
 * once (the `2>/dev/null` roll that reported a permission denial as a missing
 * tag).
 */
export async function awaitAdfRun(
  runId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<AdfRunOutcome> {
  const timeoutMs = opts.timeoutMs ?? ADF_RUN_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? ADF_RUN_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  let status = 'Queued';
  let message = '';
  let readError = '';
  // READ FIRST, THEN SLEEP. The sibling loop in `snowflake-adf.ts` sleeps first,
  // which costs a full poll interval on every run whose pipeline was already
  // terminal — a small copy of two tables finishes in well under 3s, and the
  // sleep-first shape charged it 3s of latency for nothing. Measured while
  // wiring this in: sleep-first added 78s to the mirror vitest suite alone.
  let first = true;
  while (first || Date.now() < deadline) {
    if (!first) await new Promise((r) => setTimeout(r, pollMs));
    first = false;
    try {
      const run = await getPipelineRun(runId);
      if (run) {
        status = run.status || status;
        message = run.message || '';
        readError = '';
      } else {
        // 404 on a run ARM just handed us is not "no failure" — it is a state
        // Loom cannot explain, and it is recorded as such rather than treated
        // as still-queued.
        readError = `ARM returned no run for ${runId}`;
      }
    } catch (e: any) {
      readError = e?.message || String(e);
    }
    if (TERMINAL.has(status)) break;
  }

  const terminal = TERMINAL.has(status);
  let activities: AdfActivityRun[] = [];
  if (terminal) {
    // Best-effort: the run's verdict does not depend on this, so a failure to
    // read per-activity detail degrades the row/byte counters rather than the
    // status. It is not swallowed silently — the caller sees an empty list and
    // reports rows/bytes as unknown rather than as zero.
    try { activities = await listActivityRuns(runId); } catch { activities = []; }
  }

  return {
    runId,
    status: readError && !terminal ? 'Unknown' : status,
    terminal,
    succeeded: status === 'Succeeded',
    message: message || readError,
    activities,
    timedOut: !terminal,
  };
}

/** Row/byte counters harvested from one Copy activity's ARM output. */
export interface AdfCopyCounters {
  readonly rows: number | null;
  readonly bytes: number | null;
  readonly status: string | null;
  readonly error: string | null;
}

/**
 * The Copy activity's own counters, by activity name.
 *
 * `null` rather than `0` when a counter is absent, and the distinction is the
 * point: `rows: 0` is a CLAIM that nothing was copied, and the defect this
 * repairs is exactly a synthesised `rows: 0` presented as measured. An absent
 * counter means Loom did not read one.
 */
export function adfCopyCounters(
  activities: readonly AdfActivityRun[],
  activityName: string,
): AdfCopyCounters {
  const act = activities.find((a) => a.activityName === activityName);
  if (!act) return { rows: null, bytes: null, status: null, error: null };
  const out = (act.output ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    rows: num(out.rowsCopied) ?? num(out.rowsRead),
    bytes: num(out.dataWritten) ?? num(out.dataRead),
    status: act.status ?? null,
    error: act.error?.message ?? null,
  };
}

/**
 * The operator-facing explanation for a FAILED ADF Copy run.
 *
 * The four causes #4025 enumerates are classified into concrete remediations
 * (`deploy-integrity.md` R6), and anything else falls through to the Snowflake
 * classifier — which itself returns NO remediation for an unrecognised failure
 * rather than a friendly-sounding guess (#4033 / #4048).
 *
 * ORDER. The two ADF-SIDE causes are asked first, because they are decidable
 * from tokens Snowflake never emits (`Key Vault`, `CREATE STAGE` on a staging
 * path) and because misrouting an ADF fault into Snowflake advice is this
 * module's own defect inverted — naming a cause on the wrong system entirely,
 * which `snowflake-adf.ts` already calls out at its ARM catch.
 */
export function describeAdfCopyRunFailure(detail: string, database?: string): string {
  const d = String(detail ?? '');

  if (/key ?vault/i.test(d) && /(forbidden|denied|unauthorized|not authorized|403|SecretNotFound|AKV)/i.test(d)) {
    return (
      `The ADF Copy run FAILED and the factory could not dereference the credential from Key Vault (${d}). ` +
      'Grant the data factory\'s managed identity the "Key Vault Secrets User" role on the vault that backs ' +
      'this connection\'s linked service, then Start the mirror again. Nothing about the Snowflake role, its ' +
      'grants or the warehouse was tested — the run never reached Snowflake.'
    );
  }

  if (/CREATE STAGE|create stage|external stage/i.test(d)) {
    return (
      `The ADF Copy run FAILED creating the external stage it unloads through (${d}). The ADF Copy activity ` +
      'creates a Snowflake external stage with a SAS URI, so the connection\'s role needs CREATE STAGE on the ' +
      'schema it reads — SELECT alone is not enough. In Snowflake: GRANT CREATE STAGE ON SCHEMA ' +
      `${database ? `${database}.<schema>` : '<database>.<schema>'} TO ROLE <role>; then Start the mirror again.`
    );
  }

  // Everything else is Snowflake's own words, classified by the module that
  // already refuses to assert an unestablished cause.
  return describeSnowflakeFailure('The ADF Copy run FAILED', d, database);
}

/** The machine-readable gate key for a failed ADF Copy run. */
export function adfCopyRunGate(detail: string): string {
  const d = String(detail ?? '');
  if (/key ?vault/i.test(d)) return 'mirror-adf-keyvault';
  if (/CREATE STAGE|create stage|external stage/i.test(d)) return 'snowflake-create-stage';
  return `snowflake-${classifySnowflakeFailure(d)}`;
}
