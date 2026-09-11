'use client';
/**
 * #3688 — the Power Platform family's ONE error surface, and the Dataverse
 * ADMISSION → GATE decision it makes.
 *
 * WHY THIS IS ITS OWN MODULE. It was inline in `powerplatform-editors.tsx`, and
 * the comment weight this decision genuinely needs pushed that file from 2390 to
 * 2476 LOC — past its 2400 frozen `check-file-size.mjs` ceiling. The ratchet's
 * documented answer is "reduce below the ceiling, or justify + bump", and the
 * ratchet only tightens, so this is the reduction rather than a bump. It is also
 * the honest decomposition: this cluster is the whole subject of
 * `__tests__/powerplatform-editors-first-open.test.tsx`, which already imported
 * it in isolation precisely because rendering a whole editor would measure that
 * editor's fetch plumbing instead of the decision under test.
 *
 * `powerplatform-editors.tsx` re-exports both symbols, so every existing
 * `<ErrorBar>` call site is unchanged.
 */
import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { HonestGate } from '@/lib/components/shared/honest-gate';
// #3688 — the ONE classifier for a Power Platform / Dataverse admission refusal.
// Imported from the Copilot Studio family rather than re-implemented: BAP and
// Dataverse return no Loom error CODE for these, only prose, so the decision is
// a phrase list and a second copy of a phrase list is a guarantee of drift. It
// would sit better in a shared `lib/azure/power-platform-auth.ts`; that file is
// outside this change's ownership and the move is noted, not silently skipped.
import { isPowerPlatformAdmissionError } from './copilot-studio-editors';

/**
 * The gate id every Dataverse admission refusal on THIS family routes to.
 *
 * `svc-dataverse`, not `svc-powerplatform`: the two registry entries name two
 * different one-time actions, and pointing at the wrong one is the
 * false-remediation class R7 forbids. `svc-powerplatform` is the BAP MANAGEMENT
 * APP registration (New-PowerAppManagementApp); `svc-dataverse` is the
 * per-environment DATAVERSE APPLICATION USER grant, which is the thing
 * "not a member of the organization" / "principal not found" actually reports
 * missing and the thing `scripts/csa-loom/dataverse-add-appuser.sh` performs.
 *
 * `export` is LOAD-BEARING, not stylistic. `lib/gates/__tests__/gate-id-resolution.test.ts`
 * resolves `gateId={CONST}` indirection through a scanner whose declaration
 * pattern is `export const ([A-Z][A-Z0-9_]*)\s*=\s*'…'`. Declared without
 * `export`, this const is unresolvable to that scanner, and the G2 guard reports
 * the mount as an id the registry does not know — a FALSE positive that is
 * nonetheless a real red, because the guard cannot distinguish "unexported
 * const" from "typo'd gate id". Removing `export` re-breaks that spec.
 *
 * THE SIBLING DISAGREES WITH THIS, AND THAT IS NAMED RATHER THAN LEFT TO ROT.
 * `copilot-studio-editors.tsx:221` sets
 * `COPILOT_STUDIO_ADMISSION_GATE_ID = 'svc-powerplatform'` and routes the SAME
 * classifier's refusal — `isPowerPlatformAdmissionError`, imported from that
 * very file — to the OTHER gate. Both cannot be right: one classifier, one
 * failure, two remediations, and the argument above says routing it to
 * `svc-powerplatform` is the false-remediation class R7 forbids. Measured:
 * `grep -n "ADMISSION_GATE_ID *=" lib/editors/copilot-studio-editors.tsx`
 * -> `221:export const COPILOT_STUDIO_ADMISSION_GATE_ID = 'svc-powerplatform';`.
 * `copilot-studio-editors.tsx` is outside this change's ownership, so the
 * contradiction is recorded, not silently resolved — and it should be resolved
 * in ONE direction for both families rather than each file picking a gate.
 */
export const DATAVERSE_ADMISSION_GATE_ID = 'svc-dataverse';

/**
 * #3688 — an admission refusal is a GATE, not a red bar.
 *
 * WHAT THIS WAS. A bare `<MessageBar intent="error">` reading "Power Platform
 * error — <prose>". Every one of the Power Platform surfaces plus the
 * Dataverse-backed Copilot Studio surfaces funnels through it, and the single
 * most common message it ever showed is the Dataverse Application User refusal:
 * a one-time grant the platform can perform (`dataverse-add-appuser.sh`, run by
 * the post-deploy bootstrap). Rendering that as an error with no Fix-it left the
 * operator with prose and no route out — `ux-baseline.md` G2, and this family had
 * zero HonestGate mounts. The Copilot Studio family already made exactly this
 * move (#3544); this is the same decision applied to its sibling.
 *
 * DELIBERATELY NARROW. Only the admission phrases route to the gate. A 404 on a
 * table, a 400 on a bad column payload and a 429 are NOT admission refusals, and
 * a grant Fix-it over one of those would send the operator at a grant that was
 * never the problem.
 *
 * `firstOpen` is the ux-baseline "new-item first-open is clean" rule: a freshly
 * created, untouched item must not greet the user with a red banner. The failure
 * is still SHOWN — suppressing it outright would be a different defect — but as
 * a guided warning, and it reverts to the error styling the moment the user acts.
 *
 * SCOPE, stated honestly: this component makes the admission→gate decision for
 * every call site that renders it, but `firstOpen` is only PASSED by the
 * dataverse-table editor today. The other Power Platform editors still render
 * their mount-time failures through the error branch. Widening that is a
 * separate change with its own receipt.
 */
export function ErrorBar({
  msg, hint, surface = 'Power Platform', firstOpen = false,
}: { msg: string; hint?: string; surface?: string; firstOpen?: boolean }) {
  if (!msg) return null;
  if (isPowerPlatformAdmissionError(msg)) {
    return <HonestGate gateId={DATAVERSE_ADMISSION_GATE_ID} surface={surface} detail={msg} />;
  }
  if (firstOpen) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Not connected yet</MessageBarTitle>
          {msg}{hint ? ` — ${hint}` : ''}
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>Power Platform error</MessageBarTitle>
        {msg}{hint ? ` — ${hint}` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}
