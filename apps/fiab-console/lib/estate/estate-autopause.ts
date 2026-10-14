/**
 * ESTATE AUTO-PAUSE SETTING (PRP-02 step 3, #4876).
 *
 * `{ enabled, idleHours }`, stored in the `maintenance-jobs` container under the
 * fixed doc id `estate-autopause:current` (PK `/tenantId`), the same container
 * and point-read pattern as the pause snapshot, so no new Cosmos container and
 * no bicep change. Operator decision: ARMED BY DEFAULT, 2 hours.
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
  type EstateAutoPauseSetting,
} from './estate-power-contract';

export const ESTATE_AUTOPAUSE_DOC_ID = 'estate-autopause:current';
export const ESTATE_AUTOPAUSE_DOC_KIND = 'estate-autopause';

interface AutoPauseDoc {
  id: string;
  tenantId: string;
  kind: typeof ESTATE_AUTOPAUSE_DOC_KIND;
  enabled: boolean;
  idleHours: number;
  updatedAt: string;
  updatedBy: string;
}

export function defaultAutoPause(source: EstateAutoPauseSetting['source'] = 'default'): EstateAutoPauseSetting {
  return {
    enabled: true,
    idleHours: AUTOPAUSE_DEFAULT_IDLE_HOURS,
    source,
    updatedAt: null,
    updatedBy: null,
  };
}

export type AutoPauseValidation =
  | { ok: true; value: { enabled: boolean; idleHours: number } }
  | { ok: false; error: string };

/**
 * Validate an UNTRUSTED body. `idleHours` must be a finite JSON number in
 * [1, 168]; a string "2", NaN, Infinity, null or a missing field is refused,
 * never coerced.
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
  return { ok: true, value: { enabled, idleHours } };
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
      ...v.value,
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
  value: { enabled: boolean; idleHours: number },
  updatedBy: string,
): Promise<EstateAutoPauseSetting> {
  const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await maintenanceJobsContainer();
  const updatedAt = new Date().toISOString();
  const doc: AutoPauseDoc = {
    id: ESTATE_AUTOPAUSE_DOC_ID,
    tenantId,
    kind: ESTATE_AUTOPAUSE_DOC_KIND,
    enabled: value.enabled,
    idleHours: value.idleHours,
    updatedAt,
    updatedBy,
  };
  await c.items.upsert(doc);
  return { ...value, source: 'stored', updatedAt, updatedBy };
}
