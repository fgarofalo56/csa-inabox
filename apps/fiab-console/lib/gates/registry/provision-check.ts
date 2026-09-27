/**
 * `provision` fix-kind integrity — the checks that make the button honest.
 *
 * ── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────────────
 * `workflow_dispatch` ACCEPTS AN UNKNOWN INPUT NAME SILENTLY. GitHub does not
 * reject `service_bus_enabled` because the workflow declares no such input; it
 * simply drops it, the deploy runs with the bicep parameter at its DEFAULT, and
 * the run goes green. A `provision` button wired to a name that is not there
 * would report "deploying…", finish successfully, and provision NOTHING — a
 * worse outcome than the dead-end picker it replaces, because it looks like it
 * worked.
 *
 * So the declaration is checked against the real workflow file, not trusted:
 * every `provision` gate must name an input the boundary workflow actually
 * declares, and that input must reach a `--parameters <bicepParam>=` in the
 * same file.
 *
 * ── WHY THE COST NOTE IS MANDATORY ───────────────────────────────────────────
 * `auto-bind-by-default.md` allows a cost-material opt-in only when it is
 * "listed in the gate registry with that reason". A button that bills the
 * operator must say so BEFORE it is pressed, so an empty `costNote` is a
 * declaration error rather than a style nit.
 */
import type { GateFixit, GateProvision } from './types';

/** One problem found in a `provision` declaration. */
export interface ProvisionDefect {
  gateId: string;
  field: string;
  detail: string;
}

/**
 * Shape-check one gate's fixit. Returns [] when the gate is not a `provision`.
 *
 * Deliberately NOT a boolean: the caller reports WHICH field is wrong, because
 * "invalid provision gate" sends a maintainer to read five fields instead of
 * one.
 */
export function checkProvisionShape(gateId: string, fixit: GateFixit): ProvisionDefect[] {
  const out: ProvisionDefect[] = [];
  if (fixit.kind !== 'provision') {
    // A non-provision gate carrying a provision bag is a leftover from an
    // edit that changed the kind and not the payload. It would be dead data,
    // and dead data is how a later reader concludes the button exists.
    if (fixit.provision) {
      out.push({
        gateId,
        field: 'provision',
        detail: `kind is '${fixit.kind}' but a provision descriptor is present — remove one or the other`,
      });
    }
    return out;
  }
  const p = fixit.provision;
  if (!p) {
    out.push({ gateId, field: 'provision', detail: "kind is 'provision' but no descriptor is declared" });
    return out;
  }
  const required: Array<[keyof GateProvision, string]> = [
    ['service', 'the SERVICE_PARAM_MAP key'],
    ['workflowInput', 'the workflow_dispatch input name'],
    ['bicepParam', 'the bicep parameter it feeds'],
    ['module', 'the module that declares the resource'],
    ['costNote', 'the stated cost consequence (auto-bind-by-default)'],
  ];
  for (const [field, what] of required) {
    const v = p[field];
    if (typeof v !== 'string' || !v.trim()) {
      out.push({ gateId, field: String(field), detail: `missing or empty — ${what}` });
    }
  }
  return out;
}

/**
 * Is `workflowInput` actually declared by this workflow, and does it reach
 * `--parameters <bicepParam>=`?
 *
 * `workflowYaml` is passed in rather than read here so this stays pure and a
 * test can drive the "input absent" case without a fixture file on disk — the
 * case that matters, since that is the silent-drop failure.
 *
 * TWO CHECKS, NOT ONE. A declared input that is never threaded to
 * `--parameters` is the same silent no-op wearing a different hat: the dispatch
 * succeeds, the value is accepted, and nothing consumes it.
 */
export function checkProvisionWiring(
  gateId: string,
  p: GateProvision,
  workflowYaml: string,
): ProvisionDefect[] {
  const out: ProvisionDefect[] = [];
  // Anchored to the inputs block's key form (`  <name>:`) rather than a bare
  // substring: the name also appears in `${{ inputs.x }}` expressions, so a
  // substring test would pass for an input that is referenced but never
  // DECLARED — exactly the value GitHub drops.
  const declared = new RegExp(`^\\s{4,}${escapeRe(p.workflowInput)}:\\s*$`, 'm').test(workflowYaml);
  if (!declared) {
    out.push({
      gateId,
      field: 'workflowInput',
      detail:
        `'${p.workflowInput}' is not declared as a workflow_dispatch input — ` +
        'GitHub drops an unknown input silently, so the deploy would run with ' +
        `'${p.bicepParam}' at its default and report success having provisioned nothing`,
    });
  }
  if (!new RegExp(`${escapeRe(p.bicepParam)}=`).test(workflowYaml)) {
    out.push({
      gateId,
      field: 'bicepParam',
      detail: `'${p.bicepParam}=' never reaches a --parameters argument in this workflow`,
    });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
