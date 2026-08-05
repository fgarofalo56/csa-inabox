/**
 * Translate the Setup Wizard's per-service scan-and-choose picks into the two
 * deploy-time artifacts the rest of the pipeline consumes:
 *
 *   1. `bicepParams` — `loom<Svc>Enabled` flags, forwarded as `-p key=value`
 *      overrides on `az deployment sub create` (orchestrator body / GitHub
 *      dispatch / copy-paste command). These map 1:1 onto params declared in
 *      platform/fiab/bicep/main.bicep.
 *   1b. `adopt` — the ONE object param that carries every reuse decision. It
 *      replaced 36 `existing<Svc>*` scalars (ARM's 256-param cap); assigning
 *      one of those names now fails the build with BCP259.
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
  /**
   * The `adopt` bag main.bicep reads, keyed by the adoption-catalog service key.
   *
   * `main.bicep` NO LONGER DECLARES the 36 `existing<Svc>{Name,Rg,Sub}` scalars —
   * it declares ONE `adopt` object, because ARM caps a template at 256 parameters
   * and main.bicep was at 251/256. Emitting `-p existingPurviewAccount=…` against
   * the current template is a hard BCP259 and the deploy does not start.
   *
   * An ABSENT key means create-new (`adoptMode()` defaults to 'create'), so a
   * pure-greenfield set of choices leaves this EMPTY and no `-p adopt=` override
   * is emitted at all.
   */
  adopt: Record<string, { mode: 'adopt'; target: { name: string; rg: string; sub: string } }>;
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
      out.adopt[def.key] = { mode: 'adopt', target: { name, rg, sub } };
      out.existingEnv[def.envName] = name;
      out.existingEnv[def.envRg] = rg;
      out.existingEnv[def.envSub] = sub;
      // The enable flag stays TRUE on a reuse pick. Under the adopt-or-create
      // model `provision<Svc> = <enableFlag> && adoptMode(adopt,key)=='create'`,
      // so the adopt decision ALONE suppresses the new resource. Setting the
      // flag false as well would additionally blank the Console's binding env
      // (several flags are env MIRRORS, e.g. `deSynapse: loomSynapseEnabled`) —
      // i.e. the operator would adopt their Synapse and then find the editor
      // honest-gated because Loom had un-wired itself.
      if (def.enabledFlag) out.bicepParams[def.enabledFlag] = true;
      break;
    }
    case 'new': {
      if (def.enabledFlag) out.bicepParams[def.enabledFlag] = true;
      // Contribute NOTHING to the adopt bag — an absent key is 'create'.
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
  const out: ServiceChoiceParams = { bicepParams: {}, existingEnv: {}, adopt: {} };
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
