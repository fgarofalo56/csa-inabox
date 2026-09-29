/**
 * outcomes.ts — the #3541 walk's outcome vocabulary and its pure decisions,
 * defined ONCE so the live walk and the offline proof cannot disagree (the same
 * reason `locators.ts` exists beside this file).
 *
 * `health-check-logic-app-picker.spec.ts` imports these to classify a run;
 * `locator-proof.spec.ts` imports them — and lifts every `outcome: '…'` the walk
 * can return straight out of the walk's SOURCE at runtime — to prove every
 * branch is registered. No estate, no network.
 */

/**
 * Every outcome the walk can legitimately reach. The walk's final assertion
 * reds on anything else, so a new branch that forgets to register its outcome
 * fails instead of silently passing.
 */
export const KNOWN_OUTCOMES: ReadonlySet<string> = new Set([
  // discovery half — the ROBOT receipt
  'discovery-failed',
  'no-workflows',
  // wiring half — an OPERATOR receipt under the caller-token design
  'wired',
  'save-gated',
  'no-callable-workflow',
  'label-mismatch',
  'no-caller-arm-token',
]);

export function isKnownOutcome(outcome: string | null | undefined): boolean {
  return typeof outcome === 'string' && KNOWN_OUTCOMES.has(outcome);
}

/**
 * The outcomes that mean DISCOVERY did not prove itself: the picker could not
 * list, or listed zero, real Logic Apps. The strict `-receipt` project reds on
 * exactly these — it is strict on discovery only. Every wiring outcome is out of
 * the robot's reach by design (see {@link NO_CALLER_ARM_TOKEN_NOTE}).
 */
export const DISCOVERY_FAILURE_OUTCOMES: ReadonlySet<string> = new Set(['discovery-failed', 'no-workflows']);

export function strictDiscoveryFailed(outcome: string | null | undefined): boolean {
  return outcome == null || DISCOVERY_FAILURE_OUTCOMES.has(outcome);
}

/** The registry code the BFF returns when the caller has no delegated ARM token. */
export const NO_USER_ARM_TOKEN_CODE = 'NO_USER_ARM_TOKEN';

/** The `NO MEASUREMENT` note for the `no-caller-arm-token` outcome. */
export const NO_CALLER_ARM_TOKEN_NOTE =
  'NO MEASUREMENT: no-caller-arm-token — the unattended session has no delegated Azure token by design ' +
  '(binding a receiver resolves its secret under the signed-in user\'s own Azure permissions, never the ' +
  'platform identity); the WIRING half is an operator receipt, not a robot one';

/** One trigger-inspector response, as the walk observed it. */
export interface InspectionResponse {
  id: string;
  status: number;
  body: any;
}

export type InspectionVerdict =
  | { kind: 'callable'; id: string; triggerName: string }
  | { kind: 'no-caller-arm-token' }
  | { kind: 'none' };

/**
 * Decide, from the trigger-inspector responses, whether the walk has a callable
 * workflow, has NO caller ARM token, or has neither. A "no delegated token" gate
 * is its OWN verdict and is never folded into "none": the two point triage at
 * different things (the session vs. the estate).
 */
export function classifyInspection(responses: InspectionResponse[]): InspectionVerdict {
  for (const r of responses) {
    if (r.body?.ok && r.body?.triggerName && !r.body?.problem) {
      return { kind: 'callable', id: r.id, triggerName: String(r.body.triggerName) };
    }
  }
  if (responses.some((r) => r.status === 401 && r.body?.code === NO_USER_ARM_TOKEN_CODE)) {
    return { kind: 'no-caller-arm-token' };
  }
  return { kind: 'none' };
}

/**
 * Anchored, regex-escaped EXACT option pattern for a workflow. The picker
 * renders an option as `${name}[ (kind)] · ${resourceGroup} · ${location}`
 * (`azure-resource-picker.tsx`), so matching name AND resource group means
 * `WeathForeCast` never matches `WeathForeCast2`, nor a same-named workflow in
 * another group. Case-insensitive: Resource Graph lower-cases `resourceGroup`,
 * and ARM names are case-insensitively unique anyway.
 */
export function exactOptionPattern(name: string, resourceGroup: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${esc(name)}(?: \\([^)]*\\))? · ${esc(resourceGroup)} · `, 'i');
}

/** `{ name, resourceGroup }` from a Microsoft.Logic/workflows ARM id. */
export function nameAndGroupOf(id: string): { name: string; resourceGroup: string } {
  const m = /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Logic\/workflows\/([^/]+)$/i.exec(id || '');
  return { resourceGroup: m?.[1] ?? '', name: m?.[2] ?? '' };
}
