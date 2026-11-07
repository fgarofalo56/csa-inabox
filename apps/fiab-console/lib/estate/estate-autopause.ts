/**
 * ESTATE AUTO-PAUSE SETTING (PRP-02 step 3, #4876).
 *
 * `{ enabled, idleHours, containerApps }`, stored in the `maintenance-jobs`
 * container under the fixed doc id `estate-autopause:current` (PK `/tenantId`),
 * the same container and point-read pattern as the pause snapshot, so no new
 * Cosmos container and no bicep change. Operator decision: ARMED BY DEFAULT, 2
 * hours, and (2026-10-22) Container Apps INCLUDED by default - `containerApps`
 * carries the global opt-out (`enabled:false`) and the per-app opt-out (`exempt`).
 *
 * Arming the SETTING does not arm the PAUSE: the pause path is still behind
 * `LOOM_ESTATE_PAUSE_ENABLED`, the typed confirm and the drift token. This is
 * only the "how long idle" knob the auto-pause lane reads.
 *
 * A failed read is reported as `source: 'unreadable'` (never as a stored value),
 * so a consumer cannot mistake "Cosmos was down" for "the operator armed 2h".
 */
import {
  AUTOPAUSE_DEFAULT_IDLE_HOURS,
  AUTOPAUSE_MAX_IDLE_HOURS,
  AUTOPAUSE_MIN_IDLE_HOURS,
  CONTAINER_APPS_MAX_EXEMPT,
  type EstateAutoPauseSetting,
  type EstateContainerAppsPolicy,
} from './estate-power-contract';

export const ESTATE_AUTOPAUSE_DOC_ID = 'estate-autopause:current';
export const ESTATE_AUTOPAUSE_DOC_KIND = 'estate-autopause';

interface AutoPauseDoc {
  id: string;
  tenantId: string;
  kind: typeof ESTATE_AUTOPAUSE_DOC_KIND;
  enabled: boolean;
  idleHours: number;
  /** Absent on docs written before 2026-10-22: read as the default (on, nothing exempt). */
  containerApps?: EstateContainerAppsPolicy;
  updatedAt: string;
  updatedBy: string;
}

/** The default Container Apps policy: ON, nothing exempt (operator decision 2026-10-22). */
export function defaultContainerAppsPolicy(): EstateContainerAppsPolicy {
  return { enabled: true, exempt: [] };
}

export function defaultAutoPause(source: EstateAutoPauseSetting['source'] = 'default'): EstateAutoPauseSetting {
  return {
    enabled: true,
    idleHours: AUTOPAUSE_DEFAULT_IDLE_HOURS,
    containerApps: defaultContainerAppsPolicy(),
    source,
    updatedAt: null,
    updatedBy: null,
  };
}

/** Azure Container App names: 2-32 chars, lower-case letters, digits, hyphen. */
const CONTAINER_APP_NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/**
 * Validate an UNTRUSTED Container Apps policy. `exempt` is lower-cased and
 * de-duplicated; a name that is not a valid Container App name is refused (never
 * silently dropped), so a typo cannot masquerade as an opt-out that matches nothing.
 */
export function validateContainerAppsPolicy(
  raw: unknown,
): { ok: true; value: EstateContainerAppsPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '`containerApps` must be an object: { enabled: boolean, exempt: string[] }.' };
  }
  const { enabled, exempt } = raw as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return { ok: false, error: '`containerApps.enabled` must be true or false.' };
  if (!Array.isArray(exempt)) return { ok: false, error: '`containerApps.exempt` must be an array of Container App names.' };
  if (exempt.length > CONTAINER_APPS_MAX_EXEMPT) {
    return { ok: false, error: `\`containerApps.exempt\` holds at most ${CONTAINER_APPS_MAX_EXEMPT} names; got ${exempt.length}.` };
  }
  const names: string[] = [];
  for (const n of exempt) {
    const name = typeof n === 'string' ? n.trim().toLowerCase() : '';
    if (!CONTAINER_APP_NAME.test(name)) {
      return {
        ok: false,
        error: `\`containerApps.exempt\` entry ${JSON.stringify(n)} is not a Container App name (2-32 chars: a-z, 0-9, hyphen).`,
      };
    }
    if (!names.includes(name)) names.push(name);
  }
  return { ok: true, value: { enabled, exempt: names } };
}

export type AutoPauseValidation =
  | { ok: true; value: { enabled: boolean; idleHours: number; containerApps?: EstateContainerAppsPolicy } }
  | { ok: false; error: string };

/**
 * Validate an UNTRUSTED body. `idleHours` must be a finite JSON number in
 * [1, 168]; a string "2", NaN, Infinity, null or a missing field is refused,
 * never coerced. `containerApps` is optional: omitted = leave the stored policy
 * alone; present but malformed = refused.
 */
export function validateAutoPause(body: unknown): AutoPauseValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object: { enabled: boolean, idleHours: number }.' };
  }
  const { enabled, idleHours } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: '`enabled` must be true or false.' };
  }
  if (typeof idleHours !== 'number' || !Number.isFinite(idleHours)) {
    return { ok: false, error: '`idleHours` must be a finite number.' };
  }
  if (idleHours < AUTOPAUSE_MIN_IDLE_HOURS || idleHours > AUTOPAUSE_MAX_IDLE_HOURS) {
    return {
      ok: false,
      error: `\`idleHours\` must be between ${AUTOPAUSE_MIN_IDLE_HOURS} and ${AUTOPAUSE_MAX_IDLE_HOURS} (one week); got ${idleHours}.`,
    };
  }
  const rawPolicy = (body as Record<string, unknown>).containerApps;
  if (rawPolicy === undefined) return { ok: true, value: { enabled, idleHours } };
  const policy = validateContainerAppsPolicy(rawPolicy);
  if (!policy.ok) return policy;
  return { ok: true, value: { enabled, idleHours, containerApps: policy.value } };
}

/** Read the setting. Never throws: a failed read is `source: 'unreadable'`. */
export async function loadAutoPause(tenantId: string): Promise<EstateAutoPauseSetting> {
  if (!tenantId) return defaultAutoPause('unreadable');
  try {
    const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await maintenanceJobsContainer();
    const { resource } = await c.item(ESTATE_AUTOPAUSE_DOC_ID, tenantId).read<AutoPauseDoc>();
    if (!resource || resource.kind !== ESTATE_AUTOPAUSE_DOC_KIND) return defaultAutoPause('default');
    // Re-validate on the way in: a hand-edited or corrupt doc is not a setting.
    const v = validateAutoPause(resource);
    if (!v.ok) return defaultAutoPause('unreadable');
    return {
      enabled: v.value.enabled,
      idleHours: v.value.idleHours,
      containerApps: v.value.containerApps ?? defaultContainerAppsPolicy(),
      source: 'stored',
      updatedAt: resource.updatedAt ?? null,
      updatedBy: resource.updatedBy ?? null,
    };
  } catch {
    return defaultAutoPause('unreadable');
  }
}

/** Persist the setting (upsert). Throws on Cosmos failure: a PUT must not claim success. */
export async function saveAutoPause(
  tenantId: string,
  value: { enabled: boolean; idleHours: number; containerApps?: EstateContainerAppsPolicy },
  updatedBy: string,
): Promise<EstateAutoPauseSetting> {
  const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await maintenanceJobsContainer();
  const updatedAt = new Date().toISOString();
  const containerApps = value.containerApps ?? defaultContainerAppsPolicy();
  const doc: AutoPauseDoc = {
    id: ESTATE_AUTOPAUSE_DOC_ID,
    tenantId,
    kind: ESTATE_AUTOPAUSE_DOC_KIND,
    enabled: value.enabled,
    idleHours: value.idleHours,
    containerApps,
    updatedAt,
    updatedBy,
  };
  await c.items.upsert(doc);
  return { enabled: value.enabled, idleHours: value.idleHours, containerApps, source: 'stored', updatedAt, updatedBy };
}
