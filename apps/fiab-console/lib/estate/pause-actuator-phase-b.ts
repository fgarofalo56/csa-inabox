/**
 * ESTATE PAUSE - the phase-B actuator verbs (#5099): PostgreSQL / MySQL flexible
 * servers, Application Gateway, Power BI Embedded.
 *
 * Split out of `./pause-actuator` (1100+ LOC) the same way that file was split out
 * of the orchestrator. `createArmActuator` hands this module its own ARM
 * transport and api-version lookup, so every verb here still addresses the
 * `resourceId` whose ownership was verified (`assertActuationTarget` runs in the
 * caller before any of these).
 *
 * Verbs and power fields, verified on Microsoft Learn (REST reference) 2026-10-23:
 *
 *   PostgreSQL flexible   POST {id}/stop | {id}/start    properties.state
 *   MySQL flexible        POST {id}/stop | {id}/start    properties.state
 *                         Ready | Stopped | Stopping | Starting | Updating | Disabled | Dropping
 *   Application Gateway   POST {id}/stop | {id}/start    properties.operationalState
 *                         Running | Stopped | Starting | Stopping
 *   Power BI Embedded     POST {id}/suspend | {id}/resume properties.state
 *                         Succeeded | Paused | Suspended | Pausing | Suspending | Resuming |
 *                         Preparing | Scaling | Provisioning | Updating | Failed | Deleting
 *
 * START IS GUARDED BY A READ. Learn (PostgreSQL "Start compute"): starting a server
 * that is not Stopped returns `ServerIsNotStopped`. That is exactly the shape of
 * the 7-day auto-restart, where the server came back on its own while the estate
 * was PAUSED, so a blind start would turn "already running" into a failed resume
 * and RESUME_FAILED. Every start here reads the state first: running -> a true
 * "already running, nothing sent"; a failed read -> an error, never a success.
 */
import type { EstatePowerState, PausedResourceSnapshot } from './pause-state';
import type { ActuatorResult, ServabilityProbe } from './pause-actuator';
import { judgeGateway, type GatewayBackendConfig } from './pause-appgateway-guard';

export const PG_TYPE = 'microsoft.dbforpostgresql/flexibleservers';
export const MYSQL_TYPE = 'microsoft.dbformysql/flexibleservers';
export const APPGW_TYPE = 'microsoft.network/applicationgateways';
export const PBI_TYPE = 'microsoft.powerbidedicated/capacities';

/** The types this module actuates. */
export const PHASE_B_TYPES: readonly string[] = [PG_TYPE, MYSQL_TYPE, APPGW_TYPE, PBI_TYPE];

export function isPhaseBType(resourceType: string): boolean {
  return PHASE_B_TYPES.includes(String(resourceType ?? '').toLowerCase());
}

/** Map one provider's own power vocabulary onto `EstatePowerState`. Unrecognised => Unknown. */
export function normalizePhaseBPowerState(resourceType: string, raw: unknown): EstatePowerState {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'Unknown';
  switch (resourceType.toLowerCase()) {
    case PG_TYPE:
    case MYSQL_TYPE:
      // Disabled (subscription disabled / being moved) and Dropping are deliberately
      // Unknown: a server in trouble is left alone, not "paused".
      if (s === 'ready') return 'Online';
      if (s === 'stopped') return 'Stopped';
      if (s === 'stopping') return 'Pausing';
      if (s === 'starting') return 'Starting';
      if (s === 'updating') return 'Scaling';
      return 'Unknown';
    case APPGW_TYPE:
      if (s === 'running') return 'Online';
      if (s === 'stopped') return 'Stopped';
      if (s === 'stopping') return 'Pausing';
      if (s === 'starting') return 'Starting';
      return 'Unknown';
    case PBI_TYPE:
      if (s === 'succeeded') return 'Online';
      if (s === 'paused' || s === 'suspended') return 'Paused';
      if (s === 'pausing' || s === 'suspending') return 'Pausing';
      if (s === 'resuming' || s === 'preparing' || s === 'provisioning') return 'Resuming';
      if (s === 'scaling' || s === 'updating') return 'Scaling';
      return 'Unknown';
    default:
      return 'Unknown';
  }
}

/** The ARM field that carries the power state for `resourceType`. */
export function phaseBPowerRaw(
  resourceType: string,
  props: { state?: string; operationalState?: string } | undefined,
): string | undefined {
  return resourceType.toLowerCase() === APPGW_TYPE ? props?.operationalState : props?.state;
}

export interface PhaseBDeps {
  armGet: <T = any>(path: string) => Promise<T>;
  armPost: <T = any>(path: string, body?: unknown) => Promise<T>;
  /** The 429-aware state-path GET. */
  stateGet: <T = any>(path: string) => Promise<T>;
  apiVersion: (resourceType: string) => string;
}

const LABEL: Readonly<Record<string, string>> = {
  [PG_TYPE]: 'PostgreSQL flexible server',
  [MYSQL_TYPE]: 'MySQL flexible server',
  [APPGW_TYPE]: 'Application Gateway',
  [PBI_TYPE]: 'Power BI Embedded capacity',
};

/** The pause verb path segment per type. */
const PAUSE_VERB: Readonly<Record<string, string>> = {
  [PG_TYPE]: 'stop',
  [MYSQL_TYPE]: 'stop',
  [APPGW_TYPE]: 'stop',
  [PBI_TYPE]: 'suspend',
};
const RESUME_VERB: Readonly<Record<string, string>> = {
  [PG_TYPE]: 'start',
  [MYSQL_TYPE]: 'start',
  [APPGW_TYPE]: 'start',
  [PBI_TYPE]: 'resume',
};

export function createPhaseBVerbs(deps: PhaseBDeps) {
  const readState = async (resourceId: string, type: string, get: PhaseBDeps['armGet']) => {
    const body = await get<{ properties?: { state?: string; operationalState?: string } }>(
      `${resourceId}?api-version=${deps.apiVersion(type)}`,
    );
    const raw = phaseBPowerRaw(type, body?.properties);
    return { raw: String(raw ?? ''), state: normalizePhaseBPowerState(type, raw) };
  };

  /** Pause. For the gateway, re-judges its backend pools AT ACT TIME and holds it out if it cannot establish safety. */
  const pause = async (resource: { resourceId: string; resourceType: string; name: string }): Promise<ActuatorResult> => {
    const type = resource.resourceType.toLowerCase();
    if (type === APPGW_TYPE) {
      const v = await judgeGateway(
        resource,
        (id) => deps.armGet<GatewayBackendConfig>(`${id}?api-version=${deps.apiVersion(type)}`),
      );
      if (!v.eligible) return { ok: false, held: true, detail: v.reason };
    }
    await deps.armPost(`${resource.resourceId}/${PAUSE_VERB[type]}?api-version=${deps.apiVersion(type)}`);
    return { ok: true, detail: `ARM accepted the ${PAUSE_VERB[type]} of ${LABEL[type]} ${resource.name}.` };
  };

  /** Resume: read first; only a Stopped/Paused resource gets a start. */
  const resume = async (entry: PausedResourceSnapshot): Promise<ActuatorResult> => {
    const type = entry.resourceType.toLowerCase();
    const label = LABEL[type];
    let before: { raw: string; state: EstatePowerState };
    try {
      before = await readState(entry.resourceId, type, deps.armGet);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        detail: `The state of ${label} ${entry.name} could not be read before starting it, so whether it is stopped was NOT established; no start was sent.`,
        error,
      };
    }
    if (before.state === 'Online') {
      return {
        ok: true,
        detail:
          `${label} ${entry.name} already reports '${before.raw}'; no start was sent. `
          + 'A stopped server can restart on its own, so this is not necessarily a Loom start.',
      };
    }
    if (before.state === 'Starting' || before.state === 'Resuming') {
      return { ok: true, detail: `${label} ${entry.name} is already starting ('${before.raw}'); no second start was sent.` };
    }
    if (before.state !== 'Stopped' && before.state !== 'Paused') {
      return {
        ok: false,
        detail:
          `${label} ${entry.name} reports '${before.raw || 'no state'}', which is neither stopped nor running, `
          + 'so a start was NOT sent (ARM refuses a start on a resource that is not stopped). Retry once it settles.',
        error: `phase-b-not-stopped:${before.raw || 'unreported'}`,
      };
    }
    await deps.armPost(`${entry.resourceId}/${RESUME_VERB[type]}?api-version=${deps.apiVersion(type)}`);
    return { ok: true, detail: `ARM accepted the ${RESUME_VERB[type]} of ${label} ${entry.name}.` };
  };

  /** Control-plane servability. No data-plane round trip: that needs a credential Loom does not hold per server. */
  const probe = async (entry: PausedResourceSnapshot): Promise<ServabilityProbe> => {
    const type = entry.resourceType.toLowerCase();
    const label = LABEL[type];
    const { raw, state } = await readState(entry.resourceId, type, deps.stateGet);
    const ok = state === 'Online';
    return {
      servable: ok,
      probed: true,
      detail: ok
        ? `${label} ${entry.name} reports '${raw}' (control-plane evidence; no database connection or HTTP request was made).`
        : `${label} ${entry.name} reports '${raw || 'no state'}', not running.`,
    };
  };

  return { pause, resume, probe };
}
