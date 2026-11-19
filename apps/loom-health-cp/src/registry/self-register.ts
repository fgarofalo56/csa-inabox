// Stamp self-registration (#5377). The control plane writes its own stamp into its own registry on start:
// create-if-absent, then `creating` -> `healthy` once the stamp deployment record reads back through ARM.
//
// Why this exists: nothing else calls POST /api/health/stamps, so the registry was empty and the Console
// provisioner stopped at `no-stamp` (it places a tenant only on a `healthy` stamp).
//
// What "healthy" is based on: `TenantArm.getStampManifest` finds the `lhds-stamp-<id>` deployment in the
// stamp resource group WITH its `stamp` outputs. That is the same read tenant.create makes first, so a
// stamp is marked healthy exactly when the next step can resolve it. It is evidence the stamp deployed and
// that this identity can read it. It is NOT a probe of the engines or the ingress; those are the SLO
// service's job. If the read cannot be made (403, 404, no outputs, ARM down) the stamp stays `creating`
// and the failure is logged and retried; nothing is asserted.

import { ConfigError, type Cloud } from '../config.js';
import { HttpError } from '../http/errors.js';
import { ArmError, stampResourceGroup, type TenantArm } from '../jobs/tenant-arm.js';
import { authoredMessage, logSafe, publicErrorMessage } from '../safe-error.js';
import type { Registry } from './registry.js';
import { SLUG, StampCreateSchema } from './types.js';

export interface StampSelfRegistration {
  id: string;
  cloud: Cloud;
  region: string;
  class: 'S' | 'M' | 'L';
  baseUrl: string;
}

const ACTOR = 'system:self-register';
const VARS = ['LOOM_HEALTH_CP_STAMP_ID', 'LOOM_HEALTH_CP_STAMP_REGION', 'LOOM_HEALTH_CP_STAMP_CLASS', 'LOOM_HEALTH_CP_STAMP_BASE_URL'] as const;

/** undefined = LOOM_HEALTH_CP_STAMP_ID unset (self-registration off). A partial set is a startup error naming the rest. */
export function loadStampSelfRegistration(cloud: Cloud, env: NodeJS.ProcessEnv = process.env): StampSelfRegistration | undefined {
  const v = (n: string): string => (env[n] ?? '').trim();
  if (!v(VARS[0])) {
    const stray = VARS.slice(1).filter((n) => v(n));
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} set without LOOM_HEALTH_CP_STAMP_ID`);
    return undefined;
  }
  const missing = VARS.filter((n) => !v(n));
  if (missing.length > 0) throw new ConfigError(`stamp self-registration needs ${missing.join(', ')}`);
  const cfg = {
    id: v(VARS[0]),
    cloud,
    region: v(VARS[1]),
    class: v(VARS[2]).toUpperCase(),
    baseUrl: v(VARS[3]),
  };
  const parsed = StampCreateSchema.safeParse({ ...cfg, displayName: cfg.id });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(`LOOM_HEALTH_CP_STAMP_* is invalid at ${first?.path.join('.') || 'body'}`);
  }
  if (!SLUG.test(cfg.id)) throw new ConfigError('LOOM_HEALTH_CP_STAMP_ID is malformed');
  return { id: cfg.id, cloud, region: cfg.region, class: parsed.data.class, baseUrl: cfg.baseUrl };
}

export type SelfRegisterOutcome = 'created_pending' | 'healthy' | 'already_healthy' | 'left_alone' | 'pending';
type Log = (event: string, fields: Record<string, string | number>) => void;

export interface SelfRegisterDeps {
  registry: Registry;
  arm: TenantArm;
  log: Log;
}

/** One pass. Idempotent; safe on concurrent replicas. Throws only for a failure the caller should log and retry. */
export async function ensureStampRegistered(d: SelfRegisterDeps, cfg: StampSelfRegistration): Promise<SelfRegisterOutcome> {
  let created = false;
  let stamp;
  try {
    stamp = await d.registry.getStamp(cfg.id);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e;
    try {
      stamp = await d.registry.createStamp({ id: cfg.id, displayName: cfg.id, cloud: cfg.cloud, region: cfg.region, class: cfg.class, baseUrl: cfg.baseUrl }, ACTOR);
      created = true;
    } catch (ce) {
      // A concurrent replica created it first: that is success.
      if (!(ce instanceof HttpError && ce.status === 409)) throw ce;
      stamp = await d.registry.getStamp(cfg.id);
    }
  }
  // An operator's paused / draining / evacuated stamp is never moved back; a healthy one needs nothing.
  if (stamp.status === 'healthy') return 'already_healthy';
  if (stamp.status !== 'creating') return 'left_alone';

  const rg = stampResourceGroup(cfg.id, cfg.region);
  const lookup = await d.arm.getStampManifest(rg, cfg.id);
  if (lookup.state !== 'found') {
    d.log('stamp.self_register_unconfirmed', { stamp: cfg.id, rg, state: lookup.state });
    return created ? 'created_pending' : 'pending';
  }
  try {
    await d.registry.updateStamp(cfg.id, { status: 'healthy' }, ACTOR);
  } catch (e) {
    // Another replica (or an operator) moved it first: only a stamp that is no longer `creating` is accepted as done.
    if (!(e instanceof HttpError && e.status === 409)) throw e;
    const now = await d.registry.getStamp(cfg.id);
    if (now.status === 'creating') throw e;
  }
  return 'healthy';
}

/** Run at startup and on a timer until the stamp is confirmed; failures are logged (ids and status codes) and retried, never thrown. */
export function scheduleStampSelfRegistration(
  d: SelfRegisterDeps,
  cfg: StampSelfRegistration,
  intervalMs = 30_000,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const run = async (): Promise<void> => {
    try {
      const outcome = await ensureStampRegistered(d, cfg);
      d.log('stamp.self_register', { stamp: cfg.id, outcome });
      if (outcome !== 'created_pending' && outcome !== 'pending') stop();
    } catch (e) {
      const fields: Record<string, string | number> = { stamp: cfg.id };
      if (e instanceof ArmError) {
        fields.status = e.status;
        fields.code = logSafe(e.code, 80);
        fields.op = logSafe(e.op, 80);
      } else if (e instanceof HttpError) {
        fields.status = e.status;
        fields.error = logSafe(authoredMessage(e));
      } else {
        fields.error = logSafe(publicErrorMessage(e, 'unexpected error'));
      }
      d.log('stamp.self_register_error', fields);
    }
  };
  void run();
  timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return stop;
}
