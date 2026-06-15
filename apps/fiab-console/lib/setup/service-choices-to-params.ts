/**
 * Translate the Setup Wizard's per-service scan-and-choose picks into the two
 * deploy-time artifacts the rest of the pipeline consumes:
 *
 *   1. `bicepParams` — `loom<Svc>Enabled` flags + `existing<Svc>*` reuse params,
 *      forwarded as `-p key=value` overrides on `az deployment sub create`
 *      (orchestrator body / GitHub dispatch / copy-paste command). These map
 *      1:1 onto params declared in platform/fiab/bicep/main.bicep.
 *   2. `existingEnv` — the canonical EXISTING_* triples for every use-existing
 *      pick, consumed post-deploy by scripts/csa-loom/{grant-navigator-rbac,
 *      patch-navigator-env}.sh to grant RBAC + patch the Console env on the
 *      loom-console Container App. This mirrors byo-wizard.sh's *.byo-exports.sh.
 *
 * This is a pure function (no I/O) so it is fully unit-testable and the wizard,
 * the deploy route, and tests all agree. It only ever emits params that
 * main.bicep declares (loom-no-freeform-config.md + no undeclared overrides).
 */
import {
  SETUP_SCAN_SERVICE_BY_KEY,
  type ScanServiceDef,
  type ServiceMode,
} from './scan-services';

/** One operator pick for a service (from the wizard's "Services" step). */
export interface ServiceChoice {
  mode: ServiceMode;
  /** use-existing: the chosen discovered resource. */
  name?: string;
  rg?: string;
  sub?: string;
}

export type ServiceChoices = Record<string, ServiceChoice>;

export interface ServiceChoiceParams {
  /** Bicep `-p key=value` overrides. Values are string | boolean. */
  bicepParams: Record<string, string | boolean>;
  /** Canonical EXISTING_* env triples for post-deploy wiring. */
  existingEnv: Record<string, string>;
}

/**
 * Translate a single service's choice. Exposed for tests.
 *
 *   use-existing → set existing<Svc>{Name,Rg,Sub} (when the service has bicep
 *                  reuse params) AND the EXISTING_* env triple. If the service
 *                  has an enable flag, set it false (reuse, don't provision new).
 *   new          → set <enabledFlag>=true (when present). DLZ services with no
 *                  flag provision with the platform → no param needed.
 *   disable      → set <enabledFlag>=false (only valid when a flag exists).
 */
export function translateChoice(
  def: ScanServiceDef,
  choice: ServiceChoice,
  out: ServiceChoiceParams,
): void {
  switch (choice.mode) {
    case 'use-existing': {
      const name = (choice.name || '').trim();
      const rg = (choice.rg || '').trim();
      const sub = (choice.sub || '').trim();
      if (!name) return; // nothing chosen — treat as no-op (the UI prevents this)
      if (def.existingNameParam) out.bicepParams[def.existingNameParam] = name;
      if (def.existingRgParam) out.bicepParams[def.existingRgParam] = rg;
      if (def.existingSubParam) out.bicepParams[def.existingSubParam] = sub;
      out.existingEnv[def.envName] = name;
      out.existingEnv[def.envRg] = rg;
      out.existingEnv[def.envSub] = sub;
      // Reuse an existing instance → do NOT also provision a new one.
      if (def.enabledFlag) out.bicepParams[def.enabledFlag] = false;
      break;
    }
    case 'new': {
      if (def.enabledFlag) out.bicepParams[def.enabledFlag] = true;
      // Leave existing* blank (the boundary defaults '' already).
      break;
    }
    case 'disable': {
      // Only services with a provisioning flag can be disabled.
      if (def.enabledFlag) out.bicepParams[def.enabledFlag] = false;
      break;
    }
  }
}

/**
 * Translate the full set of wizard service choices. Unknown keys are ignored
 * (forward-compatible with new services the UI might send).
 */
export function serviceChoicesToParams(choices: ServiceChoices | undefined): ServiceChoiceParams {
  const out: ServiceChoiceParams = { bicepParams: {}, existingEnv: {} };
  if (!choices) return out;
  for (const [key, choice] of Object.entries(choices)) {
    const def = SETUP_SCAN_SERVICE_BY_KEY[key];
    if (!def || !choice || !choice.mode) continue;
    translateChoice(def, choice, out);
  }
  return out;
}

/**
 * Render the bicepParams map as `key=value` tokens for an `az deployment sub
 * create -p ...` line. Booleans render bare (true/false); strings are
 * single-quoted. Returns [] when there is nothing to emit.
 */
export function bicepParamsToCliTokens(params: Record<string, string | boolean>): string[] {
  return Object.entries(params).map(([k, v]) =>
    typeof v === 'boolean' ? `${k}=${v}` : `${k}='${v}'`,
  );
}
