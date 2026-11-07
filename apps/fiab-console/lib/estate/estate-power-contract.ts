/**
 * ESTATE POWER — the ONE typed contract for the service-principal route
 * `/api/estate/power` (PRP-02 step 3, #4876). Pure types + constants; no
 * imports, so a workflow-side TypeScript script may copy or import it verbatim.
 *
 * ── WHY THIS ROUTE EXISTS ──────────────────────────────────────────────────
 * The pause snapshot lives in Cosmos, which is private-endpoint-only, so a
 * GitHub-hosted runner cannot read or write it. The console can (and is exempt
 * from pause, so it is always up). The Actions/CLI lane therefore drives pause
 * and resume by CALLING THE CONSOLE with the deploy service principal. The
 * cookie routes under `/api/admin/estate/*` keep serving interactive admins and
 * share the same handler logic (`estate-power-handlers.ts`).
 *
 * ── AUTH ───────────────────────────────────────────────────────────────────
 * `Authorization: Bearer <Entra access token>` for the deploy SP, client
 * credentials flow, scope `api://<LOOM_MSAL_CLIENT_ID>/.default` (or the
 * explicit `LOOM_ESTATE_POWER_AUDIENCE`). Verified by the repo's canonical
 * `verifyEntraBearer`: RS256 signature against the active cloud's JWKS, issuer
 * pinned to the estate tenant on the active cloud's authority
 * (login.microsoftonline.com / .us), audience pinned, expiry. On top of that
 * this route requires `tid` == estate tenant and the app role
 * {@link ESTATE_POWER_ROLE} in `roles`. Anything unverifiable is refused:
 *   401 bad/absent/expired credential · 403 verified but role/tenant missing ·
 *   503 the console is not configured to verify (never reported as 401).
 *
 * ── REQUEST (POST) ─────────────────────────────────────────────────────────
 *   { action: 'preview' | 'pause' | 'resume' | 'state',
 *     confirm?: string,        // pause only: must equal the estate id
 *     confirmToken?: string }  // pause only: from a prior preview
 *   GET /api/estate/power  is `action: 'state'`.
 *
 * ── RESPONSE ───────────────────────────────────────────────────────────────
 * The repo envelope: success `{ ok: true, ...fields }`, failure
 * `{ ok: false, error, ...extra }`. Fields per action are the SAME as the
 * cookie routes return (`state`: GET /api/admin/estate/state, `preview`: POST
 * pause with dryRun, `pause`: 202 PAUSING, `resume`: 202 RESUMING), and every
 * `state` / `preview` response additionally carries {@link EstatePowerStatus}
 * under `power`.
 *
 * ── RULES FOR THE CALLER (the auto-pause lane) ─────────────────────────────
 *  1. Pause requires `confirm` (= estateId) AND `confirmToken` (from a preview
 *     taken moments earlier) EVEN FOR THE SERVICE PRINCIPAL, and the console
 *     must be armed (`LOOM_ESTATE_PAUSE_ENABLED`); otherwise 409/400.
 *  2. NEVER auto-pause on unknown idleness. Pause only when
 *     `power.autoPause.enabled === true`, `power.autoPause.source !== 'unreadable'`,
 *     `power.activity.lastActivityAt !== null` (null = no activity recorded, NOT
 *     "idle forever") and `power.activity.idleForSeconds >= idleHours * 3600`.
 *  3. A 202 is an accepted dispatch, never a result; poll `state` until
 *     PAUSED / RUNNING / RESUME_FAILED.
 */

/** Entra app role the deploy service principal must hold on the console API. */
export const ESTATE_POWER_ROLE = 'Estate.Power';

export const ESTATE_POWER_ACTIONS = ['preview', 'pause', 'resume', 'state'] as const;
export type EstatePowerAction = (typeof ESTATE_POWER_ACTIONS)[number];

export interface EstatePowerRequest {
  action: EstatePowerAction;
  /** pause: the typed estate id. */
  confirm?: string;
  /** pause: the drift token from a preview. */
  confirmToken?: string;
}

/** Auto-pause setting bounds (hours). */
export const AUTOPAUSE_DEFAULT_IDLE_HOURS = 2;
export const AUTOPAUSE_MIN_IDLE_HOURS = 1;
export const AUTOPAUSE_MAX_IDLE_HOURS = 168;

/**
 * Container Apps in the estate pause set (operator decision 2026-10-22): ON BY
 * DEFAULT for every app that is not on the never-pause list (`pause-guards.ts`).
 * `enabled:false` is the GLOBAL opt-out; `exempt` is the per-app opt-out (lower-case
 * Container App names). Persisted with the auto-pause setting, not in a second store.
 */
export interface EstateContainerAppsPolicy {
  enabled: boolean;
  exempt: string[];
}

export const CONTAINER_APPS_MAX_EXEMPT = 100;

export interface EstateAutoPauseSetting {
  enabled: boolean;
  idleHours: number;
  /** Container Apps pause policy: default `{ enabled: true, exempt: [] }`. */
  containerApps: EstateContainerAppsPolicy;
  /**
   * `stored`: read from Cosmos. `default`: nothing stored yet (armed by default,
   * 2h). `unreadable`: the read FAILED; the values are the defaults but must not
   * be acted on.
   */
  source: 'stored' | 'default' | 'unreadable';
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface EstateActivityStatus {
  /** ISO time of the last HUMAN interactive request, or null when none recorded / unreadable. */
  lastActivityAt: string | null;
  /** Seconds since lastActivityAt, or null when lastActivityAt is null. */
  idleForSeconds: number | null;
  /** True when the activity read failed (so null means "unknown", not "none"). */
  unreadable: boolean;
}

/**
 * Recent pipeline runs, read server-side for idle auto-pause (estate-pipeline-activity.ts).
 * Same shape `scripts/estate-power/read-activity.mjs` produces; `ok:false` = unknown.
 */
export interface EstatePipelineActivity {
  ok: boolean;
  reason?: string;
  runs?: Array<{ startedAt: string | null; status: string | null }>;
  /** Which sources were read ('adf' | 'synapse'); an unconfigured source is absent. */
  sources: string[];
}

/** Added under `power` on every `state` and `preview` response (cookie and SP). */
export interface EstatePowerStatus {
  activity: EstateActivityStatus;
  /** Present ONLY on the SP state route (the auto-pause caller), never the panel poll. */
  pipelineActivity?: EstatePipelineActivity;
  autoPause: EstateAutoPauseSetting;
  /** `pausedAt` of the last snapshot (ISO) or null. */
  lastPausedAt: string | null;
  /** `resumeConfirmedAt` of the last snapshot (ISO) or null. */
  lastResumedAt: string | null;
}
