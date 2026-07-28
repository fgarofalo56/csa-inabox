/**
 * N7c — Reverse ETL / activation-sync model (PURE, no I/O).
 *
 * An `activation-sync` item pushes a modeled dataset (a lake Delta table, a
 * semantic model's output, or a materialized audience/segment) OUT to an
 * operational destination — Dataverse/Dynamics FIRST (the estate's S2S app is
 * already wired), plus webhook / Event Grid / Service Bus. It supports a FULL
 * sync (read the whole source) and an INCREMENTAL sync via the source Delta
 * table's Change Data Feed (only the rows that changed since the last run).
 *
 * This module is the shared contract + the server-side COERCION that enforces
 * loom_no_freeform_config: every enum is constrained to a fixed option set and
 * the field mapping is sanitized to `{source,target}` pairs — there is no
 * freeform JSON config surface anywhere in the item.
 *
 * No Fabric dependency: the source is read from the deployment's own ADLS Gen2
 * (Delta), and every destination is an Azure/OSS endpoint. SOVEREIGN MOAT —
 * IL5/air-gap: the webhook + Event Grid + Service Bus destinations target
 * in-boundary endpoints and run disconnected; SaaS destinations (a public
 * webhook, a Dynamics SaaS org) are honest-gated, never required to run.
 */

/** What the source represents. All three resolve to a lake Delta location. */
export type ActivationSourceKind = 'table' | 'model' | 'audience';
export const ACTIVATION_SOURCE_KINDS: readonly ActivationSourceKind[] = ['table', 'model', 'audience'];

/** Where activated rows are pushed. Dataverse is first-class. */
export type ActivationDestinationKind = 'dataverse' | 'webhook' | 'event-grid' | 'service-bus';
export const ACTIVATION_DESTINATION_KINDS: readonly ActivationDestinationKind[] =
  ['dataverse', 'webhook', 'event-grid', 'service-bus'];

/** Full = read the whole source; incremental = only Delta CDF changes since last run. */
export type ActivationMode = 'full' | 'incremental';
export const ACTIVATION_MODES: readonly ActivationMode[] = ['full', 'incremental'];

/** A lake Delta location — the uniform physical form every source resolves to. */
export interface ActivationSource {
  kind: ActivationSourceKind;
  /** Lake container (bronze/silver/gold/landing/…). */
  container: string;
  /** Delta table path within the container. */
  path: string;
  /** Display-only provenance for a model/audience source. */
  refItemId?: string;
  refItemType?: string;
  label?: string;
}

export interface ActivationDataverseDest {
  kind: 'dataverse';
  /** Power Platform environment GUID (BAP `name`). */
  environmentId: string;
  /** Dataverse entity set name, e.g. 'contacts'. */
  entitySetName: string;
  /**
   * Attribute (or alternate-key) logical name whose value keys the upsert —
   * a PATCH to `entityset(<keyAttribute>='<value>')` creates-or-updates.
   */
  keyAttribute: string;
  /** Org instance URL cached at config time (https://<org>.crm.dynamics.com). */
  instanceUrl?: string;
}

export interface ActivationWebhookDest {
  kind: 'webhook';
  /** https endpoint that receives the batch POST. */
  url: string;
}

export interface ActivationEventGridDest {
  kind: 'event-grid';
  /** https://<topic>.<region>.eventgrid.azure.net/api/events (custom topic). */
  topicEndpoint: string;
  /** eventType stamped on every CloudEvent (default 'Loom.Activation.Row'). */
  eventType?: string;
}

export interface ActivationServiceBusDest {
  kind: 'service-bus';
  /** Namespace host, `<ns>.servicebus.windows.net` (or bare `<ns>`). */
  namespace: string;
  /** Queue or topic name to send to. */
  entity: string;
}

export type ActivationDestination =
  | ActivationDataverseDest
  | ActivationWebhookDest
  | ActivationEventGridDest
  | ActivationServiceBusDest;

/** One source-column → destination-field mapping (dropdown-picked on both sides). */
export interface FieldMapping {
  source: string;
  target: string;
}

/** Terminal + in-flight run states. */
export type ActivationRunStatus = 'succeeded' | 'failed' | 'running';

/** One persisted run-history entry (bounded list, newest first). */
export interface ActivationRun {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mode: ActivationMode;
  status: ActivationRunStatus;
  /** Rows read from the source (change rows for incremental). */
  rowsRead: number;
  upserts: number;
  deletes: number;
  errors: number;
  /** Delta commit version range processed (incremental watermark advance). */
  fromVersion?: number;
  toVersion?: number;
  detail?: string;
}

/** The full persisted item state (lives in the Cosmos WorkspaceItem `state`). */
export interface ActivationSyncSpec {
  source?: ActivationSource;
  destination?: ActivationDestination;
  mapping: FieldMapping[];
  /** Source column whose value fills the destination key (alt-key / dedup key). */
  keyColumn?: string;
  mode: ActivationMode;
  runs?: ActivationRun[];
  /** Delta commit version processed by the last successful incremental run. */
  lastSyncedVersion?: number;
}

/** Cap on retained run-history entries (bounded to keep the item doc small). */
export const MAX_RUN_HISTORY = 50;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Coerce an arbitrary source payload into a valid, dropdown-constrained source. */
export function coerceSource(raw: unknown): ActivationSource | undefined {
  const s = (raw ?? {}) as Partial<ActivationSource>;
  const container = str(s.container);
  const path = str(s.path);
  if (!container || !path) return undefined;
  const kind: ActivationSourceKind = ACTIVATION_SOURCE_KINDS.includes(s.kind as ActivationSourceKind)
    ? (s.kind as ActivationSourceKind)
    : 'table';
  return {
    kind,
    container,
    path,
    ...(str(s.refItemId) ? { refItemId: str(s.refItemId) } : {}),
    ...(str(s.refItemType) ? { refItemType: str(s.refItemType) } : {}),
    ...(str(s.label) ? { label: str(s.label) } : {}),
  };
}

/** Coerce an arbitrary destination payload into a valid, typed destination. */
export function coerceDestination(raw: unknown): ActivationDestination | undefined {
  const d = (raw ?? {}) as { kind?: unknown } & Record<string, unknown>;
  const kind = d.kind;
  if (kind === 'dataverse') {
    const environmentId = str(d.environmentId);
    const entitySetName = str(d.entitySetName);
    const keyAttribute = str(d.keyAttribute);
    if (!environmentId || !entitySetName || !keyAttribute) return undefined;
    return {
      kind: 'dataverse', environmentId, entitySetName, keyAttribute,
      ...(str(d.instanceUrl) ? { instanceUrl: str(d.instanceUrl) } : {}),
    };
  }
  if (kind === 'webhook') {
    const url = str(d.url);
    if (!/^https:\/\//i.test(url)) return undefined;
    return { kind: 'webhook', url };
  }
  if (kind === 'event-grid') {
    const topicEndpoint = str(d.topicEndpoint);
    if (!/^https:\/\//i.test(topicEndpoint)) return undefined;
    return { kind: 'event-grid', topicEndpoint, ...(str(d.eventType) ? { eventType: str(d.eventType) } : {}) };
  }
  if (kind === 'service-bus') {
    const namespace = str(d.namespace);
    const entity = str(d.entity);
    if (!namespace || !entity) return undefined;
    return { kind: 'service-bus', namespace, entity };
  }
  return undefined;
}

/** Sanitize the field-mapping list — trimmed `{source,target}` pairs only. */
export function coerceMapping(raw: unknown): FieldMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldMapping[] = [];
  for (const m of raw) {
    const source = str((m as FieldMapping)?.source);
    const target = str((m as FieldMapping)?.target);
    if (source && target) out.push({ source, target });
  }
  return out;
}

/**
 * Coerce a whole persisted spec into a valid shape. Enums fall back to their
 * safe default; unknown fields are dropped. This is the server-side guarantee
 * that no freeform config leaks into the item state.
 */
export function coerceSpec(raw: unknown): ActivationSyncSpec {
  const s = (raw ?? {}) as Partial<ActivationSyncSpec>;
  const mode: ActivationMode = ACTIVATION_MODES.includes(s.mode as ActivationMode)
    ? (s.mode as ActivationMode)
    : 'full';
  const runs = Array.isArray(s.runs) ? (s.runs as ActivationRun[]).slice(0, MAX_RUN_HISTORY) : [];
  return {
    ...(coerceSource(s.source) ? { source: coerceSource(s.source) } : {}),
    ...(coerceDestination(s.destination) ? { destination: coerceDestination(s.destination) } : {}),
    mapping: coerceMapping(s.mapping),
    ...(str(s.keyColumn) ? { keyColumn: str(s.keyColumn) } : {}),
    mode,
    runs,
    ...(typeof s.lastSyncedVersion === 'number' && Number.isFinite(s.lastSyncedVersion)
      ? { lastSyncedVersion: s.lastSyncedVersion }
      : {}),
  };
}

/** A validation failure the run route surfaces as a precise 400. */
export interface SpecValidationError { field: string; message: string; }

/**
 * Validate a spec is runnable for the requested mode. Returns [] when ready,
 * else a list of precise, human-readable problems (never a generic "invalid").
 */
export function validateForRun(spec: ActivationSyncSpec, mode: ActivationMode): SpecValidationError[] {
  const errs: SpecValidationError[] = [];
  if (!spec.source?.container || !spec.source?.path) {
    errs.push({ field: 'source', message: 'Pick a source table before running.' });
  }
  const d = spec.destination;
  if (!d) {
    errs.push({ field: 'destination', message: 'Pick a destination before running.' });
  } else if (d.kind === 'dataverse') {
    if (!d.environmentId || !d.entitySetName || !d.keyAttribute) {
      errs.push({ field: 'destination', message: 'Dataverse destination needs an environment, table, and key attribute.' });
    }
    if (!spec.keyColumn) {
      errs.push({ field: 'keyColumn', message: 'Pick the source column that supplies the Dataverse key value.' });
    }
    if (spec.mapping.length === 0) {
      errs.push({ field: 'mapping', message: 'Map at least one source column to a Dataverse field.' });
    }
  }
  if (mode === 'incremental' && spec.mapping.length === 0 && d?.kind !== 'dataverse' && !spec.keyColumn) {
    // Non-Dataverse destinations pass source columns through, but incremental
    // still needs a stable dedup key.
    errs.push({ field: 'keyColumn', message: 'Incremental runs need a key column for downstream idempotency.' });
  }
  return errs;
}
