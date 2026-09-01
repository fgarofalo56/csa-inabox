/**
 * LOOM BRAIN ACTIONS — the guard chain (#4242).
 *
 * EVERY guard re-derives its input SERVER-SIDE, at execute time. The client
 * supplies three lookup keys (findingId, detector, subjectNodeId) and nothing
 * else is believed: the snapshot is rebuilt fresh, ownership is re-read from
 * fresh tags, populations and vacuity come from the rebuild, and current Azure
 * state comes from a fresh ARM GET. A perform request replayed a week after a
 * finding was minted meets the estate as it is NOW, or it refuses.
 *
 * ── THE #4015/#4016 RULE ───────────────────────────────────────────────────
 * A proposal derived from a PARTIAL estate pull must never be performable. A
 * partial graph manufactures unreachability (a missing page of rows is a
 * missing set of inbound edges), so `collection.complete === true` is a hard
 * gate, and on top of it the subject's CURRENT state must still match the
 * evidence the finding was built on — ARG is a replicated index (see
 * `lib/brain/run/azure/arm-probe.ts`), so the confirmation comes from ARM, the
 * authoritative plane.
 *
 * ── THE STATEFULNESS RULE (#4257) ──────────────────────────────────────────
 * `guardScalableToZero` refuses a subject the DEPLOY declares as a pinned
 * singleton. It is the guard whose absence made the Brain's highest-value
 * recommendation a one-click, unrecoverable destruction of `loom-risingwave`'s
 * materialized views — every other guard in this file passed on it.
 *
 * Guards return `GuardRefusal | null` (null = pass) so each one is
 * independently testable and independently deletable — and the tests in
 * `__tests__/guards.test.ts` are written so that deleting any one of them turns
 * a suite red.
 */

import type {
  BrainSnapshot,
  WireDetectorRun,
  WireFinding,
  WireNode,
} from '@/app/api/admin/brain/_lib/wire';
import type { ContainerAppInfo } from '@/lib/azure/container-apps-arm-client';
import { deriveArmResourceId, isContainerAppType } from './executors';
import { nonScalableExplanation, type ScalabilityDeclaration } from './scalability';
import type {
  GuardRefusal,
  PerformExecutorKind,
  PerformRequest,
  PerformSubject,
} from './types';

function refusal(guard: string, reason: string): GuardRefusal {
  return { guard, reason };
}

/**
 * G1 — the finding's snapshot must be COMPLETE. A verdict over a partial pull
 * is the #4015/#4016 failure: rows lost to pagination read as edges that do not
 * exist, i.e. as unreachability the estate never had.
 */
export function guardSnapshotComplete(snapshot: BrainSnapshot): GuardRefusal | null {
  if (snapshot.collection.complete === true) return null;
  return refusal(
    'snapshot-complete',
    `REFUSED: the fresh estate pull is INCOMPLETE (rowsFetched=` +
      `${snapshot.collection.rowsFetched}, ARG totalRecords=` +
      `${snapshot.collection.totalRecords ?? 'UNKNOWN'}). A reachability verdict over a ` +
      'partial graph can manufacture exactly the unreachability this finding reports, so ' +
      'nothing is performed from one. Nothing was changed in Azure.',
  );
}

/**
 * G2 — the FRESH rebuild must still produce this finding, and the named subject
 * must be one of ITS subjects. A finding the estate no longer produces is
 * stale; a subject the finding does not name is a request the server refuses
 * to reinterpret.
 */
export function guardFindingPresent(
  snapshot: BrainSnapshot,
  req: PerformRequest,
): { refusal: GuardRefusal } | { finding: WireFinding; node: WireNode } {
  const finding = snapshot.findings.find((f) => f.id === req.findingId);
  if (!finding) {
    return {
      refusal: refusal(
        'finding-present',
        `REFUSED: a fresh estate rebuild no longer produces finding '${req.findingId}'. ` +
          'Either the condition was already fixed or the estate changed underneath the ' +
          'recommendation — in both cases performing it now would act on evidence that no ' +
          'longer holds. Reload the Brain and re-review. Nothing was changed in Azure.',
      ),
    };
  }
  if (finding.detector !== req.detector) {
    return {
      refusal: refusal(
        'finding-present',
        `REFUSED: finding '${req.findingId}' belongs to detector '${finding.detector}', ` +
          `not '${req.detector}'. The request does not match the server's own derivation, ` +
          'so nothing is performed. Nothing was changed in Azure.',
      ),
    };
  }
  if (!finding.subjects.includes(req.subjectNodeId)) {
    return {
      refusal: refusal(
        'finding-present',
        `REFUSED: node '${req.subjectNodeId}' is not a subject of finding ` +
          `'${req.findingId}'. The server resolves subjects from its own snapshot and does ` +
          'not act on substituted targets. Nothing was changed in Azure.',
      ),
    };
  }
  const node = snapshot.nodes.find((n) => n.id === req.subjectNodeId);
  if (!node) {
    return {
      refusal: refusal(
        'finding-present',
        `REFUSED: subject node '${req.subjectNodeId}' is not present in the fresh ` +
          'snapshot, so its current state cannot be established. Nothing was changed in Azure.',
      ),
    };
  }
  return { finding, node };
}

/**
 * G3 — ownership, RE-CHECKED from the fresh rebuild (whose `owns` edges come
 * from a fresh tag read). PRP §1 decision 1's measured reason applies with full
 * force at the moment of execution: most Container App environments visible
 * across these subscriptions are NOT Loom's.
 */
export function guardOwnership(finding: WireFinding): GuardRefusal | null {
  if (finding.ownershipConfirmed === true) return null;
  return refusal(
    'ownership-confirmed',
    'REFUSED: ownership of the subject is NOT established on a fresh tag read — no ' +
      "resolved 'owns' edge covers it in the rebuilt snapshot. A mutation scoped by a " +
      'guessed owner can reach an estate that is not Loom’s, which is the blast radius ' +
      'the recommend-only decision exists to prevent. Stamp the ownership tag in the ' +
      'deploy and re-run. Nothing was changed in Azure.',
  );
}

/**
 * G4 — the detector must not be VACUOUS and the finding's population must not
 * be BLIND. A verdict whose provenance was never collected, or whose examined
 * set was empty, established nothing — performing on it would be acting on a
 * confident blank (P3, and the `byProvenance` note on `Population`).
 */
export function guardDetectorNotVacuous(
  snapshot: BrainSnapshot,
  finding: WireFinding,
): GuardRefusal | null {
  const run: WireDetectorRun | undefined = snapshot.detectors.find(
    (d) => d.detector === finding.detector,
  );
  if (!run) {
    return refusal(
      'detector-not-vacuous',
      `REFUSED: the fresh snapshot carries no run record for detector ` +
        `'${finding.detector}', so whether it examined anything cannot be established. ` +
        'Nothing was changed in Azure.',
    );
  }
  if (run.vacuous) {
    return refusal(
      'detector-not-vacuous',
      `REFUSED: detector '${finding.detector}' is VACUOUS in the fresh snapshot — ` +
        `${run.vacuousReason ?? 'the provenance it queries was not collected'}. A finding ` +
        'over uncollected data is not evidence. Nothing was changed in Azure.',
    );
  }
  if (finding.population.blind) {
    return refusal(
      'population-not-blind',
      `REFUSED: the finding's population is BLIND (examined=` +
        `${finding.population.examined}). A verdict over an empty set establishes ` +
        'nothing. Nothing was changed in Azure.',
    );
  }
  // ── #4258 item 2: COUNT ONLY RESOLVED, NON-DANGLING EDGES ────────────────
  //
  // This read used to be `finding.population.byProvenance.configured`, and that
  // count INCLUDES DANGLING edges — `graph.ts`'s `countByProvenance` ranges over
  // every edge the extractor emitted, and a dangling edge is emitted on purpose
  // so its evidence survives (`to: null`, which is what keeps it out of
  // reachability). So the exact state this guard exists to catch — every app
  // looks unreachable because the only `configured` edges in the graph are
  // broken ones — SATISFIED it. A graph of nothing but empty wires read as a
  // graph with three configured edges and sailed through.
  //
  // The count is therefore re-derived from the snapshot's own edge list, over
  // the same resolved/dangling discriminator the reachability verdict uses. It
  // is not read from a summary that answers a different question.
  const resolvedConfigured = snapshot.edges.filter(
    (e) => e.provenance === 'configured' && e.resolution === 'resolved',
  ).length;
  if (resolvedConfigured === 0) {
    const dangling = snapshot.edges.filter(
      (e) => e.provenance === 'configured' && e.resolution !== 'resolved',
    ).length;
    return refusal(
      'population-not-blind',
      "REFUSED: the fresh graph holds ZERO RESOLVED 'configured' edges" +
        (dangling > 0
          ? ` (${dangling} 'configured' edge(s) exist and are DANGLING — they carry no target, so ` +
            'they confer no reachability on anything)'
          : '') +
        ', so "no inbound configured edge" is vacuously true of every node — the vacuous-truth ' +
        'case `Population.byProvenance` exists to expose. Nothing was changed in Azure.',
    );
  }
  return null;
}

/**
 * G4b — THE STATEFULNESS REFUSAL (#4257). The blocking guard.
 *
 * `scale-to-zero` must never reach a service the DEPLOY declares as a pinned
 * singleton. `loom-risingwave` is the measured case: its bicep says a
 * scaled-to-zero replica "loses every MV definition and its progress", and until
 * this guard existed the whole chain passed — the operator's highest-value
 * recommendation was a one-click, unrecoverable destruction of the streaming
 * tier's materialized views, presented as a cost saving.
 *
 * The declaration is INJECTED rather than read here, so this stays pure and each
 * arm is testable; `./scalability` derives it from the compiled deploy template
 * and explains why that source cannot drift from the bicep.
 *
 * `delete-resource` is deliberately NOT gated by this guard: deleting a pinned
 * singleton is destructive for its own reasons, which the orphan detector's
 * evidence and the staged confirm already speak to. This guard makes exactly one
 * claim — that a declared singleton must not have its replica floor removed.
 */
export function guardScalableToZero(
  subject: PerformSubject,
  executor: PerformExecutorKind,
  declaration: ScalabilityDeclaration | null,
): GuardRefusal | null {
  if (executor !== 'scale-to-zero') return null;
  if (declaration === null || declaration.scalableToZero) return null;
  return refusal(
    'scalable-to-zero',
    `REFUSED: ${nonScalableExplanation(declaration)} Nothing was changed in Azure.`,
  );
}

/**
 * G5 — resolve the subject the executor may act on. Refuses anything that is
 * not a Container App with full ARM coordinates: phase 1's executors act on
 * `Microsoft.App/containerApps` and nothing else, and the ARM id is DERIVED
 * from these server-held fields — never accepted from the client.
 */
export function resolvePerformSubject(
  node: WireNode,
): { refusal: GuardRefusal } | { subject: PerformSubject } {
  if (!isContainerAppType(node.resourceType)) {
    return {
      refusal: refusal(
        'subject-resolvable',
        `REFUSED: subject '${node.displayName}' has ARM type ` +
          `'${node.resourceType ?? '(none)'}' and the phase-1 executors act only on ` +
          'Microsoft.App/containerApps. Nothing was changed in Azure.',
      ),
    };
  }
  if (!node.subscriptionId || !node.resourceGroup || !node.displayName) {
    return {
      refusal: refusal(
        'subject-resolvable',
        `REFUSED: the snapshot does not carry full ARM coordinates for ` +
          `'${node.id}' (subscription, resource group, name), so its resource id cannot ` +
          'be derived server-side. A client-supplied id is not accepted in its place. ' +
          'Nothing was changed in Azure.',
      ),
    };
  }
  const subject: PerformSubject = {
    nodeId: node.id,
    displayName: node.displayName,
    resourceType: node.resourceType as string,
    subscriptionId: node.subscriptionId,
    resourceGroup: node.resourceGroup,
    armResourceId: deriveArmResourceId({
      subscriptionId: node.subscriptionId,
      resourceGroup: node.resourceGroup,
      displayName: node.displayName,
    }),
    ...(node.scaleMeasured && node.scale ? { minReplicasClaimed: node.scale.minReplicas } : {}),
  };
  return { subject };
}

/**
 * G6 — the deployment's write credential is scoped to ONE subscription + RG
 * (`readAcaConfig()`). A subject outside that scope is refused with the scopes
 * named — attempting the call and translating ARM's 403/404 would violate R7,
 * and silently targeting a same-named app in the configured RG would be the
 * worst bug this route could have.
 */
export function guardWriteScope(
  subject: PerformSubject,
  cfg: { subscriptionId: string; resourceGroup: string },
): GuardRefusal | null {
  const subOk = subject.subscriptionId.toLowerCase() === cfg.subscriptionId.toLowerCase();
  const rgOk = subject.resourceGroup.toLowerCase() === cfg.resourceGroup.toLowerCase();
  if (subOk && rgOk) return null;
  return refusal(
    'write-scope',
    `REFUSED: '${subject.displayName}' lives in subscription ` +
      `'${subject.subscriptionId}', resource group '${subject.resourceGroup}', but this ` +
      `deployment's write credential is scoped to subscription '${cfg.subscriptionId}', ` +
      `resource group '${cfg.resourceGroup}'. Performing across that boundary is not ` +
      'attempted. Nothing was changed in Azure.',
  );
}

/**
 * G7 — the #4015/#4016 freshness gate: the subject's CURRENT state, read from
 * ARM (the authoritative plane, not the ARG index), must still match the
 * evidence the finding stands on.
 *
 * For BOTH executors, a measured snapshot claim that disagrees with the fresh
 * ARM reading is a stale proposal and refuses with both numbers shown. For
 * `scale-to-zero` specifically the always-on floor is additionally
 * re-confirmed: minReplicas must be MEASURED and > 0 — an unmeasured scale is
 * not zero, and an already-zero app has nothing left to perform. For
 * `delete-resource` existence was established by the successful GET itself.
 */
export function guardEvidenceFresh(
  subject: PerformSubject,
  arm: Pick<ContainerAppInfo, 'minReplicas' | 'provisioningState'>,
  executor: PerformExecutorKind,
): GuardRefusal | null {
  if (
    typeof subject.minReplicasClaimed === 'number' &&
    typeof arm.minReplicas === 'number' &&
    arm.minReplicas !== subject.minReplicasClaimed
  ) {
    return refusal(
      'evidence-fresh',
      `REFUSED: the snapshot's evidence says '${subject.displayName}' runs ` +
        `minReplicas=${subject.minReplicasClaimed}, but a fresh ARM GET reads ` +
        `minReplicas=${arm.minReplicas}. The estate changed between analysis and ` +
        'execution, so the proposal is STALE. Reload the Brain and re-review the ' +
        'finding against current state. Nothing was changed in Azure.',
    );
  }
  if (executor === 'scale-to-zero') {
    if (typeof arm.minReplicas !== 'number') {
      return refusal(
        'evidence-fresh',
        `REFUSED: a fresh ARM GET of '${subject.displayName}' returned no minReplicas ` +
          'reading, so the always-on evidence could not be re-confirmed. NOT MEASURED is ' +
          'not zero, and nothing is performed on an unconfirmed state. Nothing was changed ' +
          'in Azure.',
      );
    }
    if (arm.minReplicas === 0) {
      return refusal(
        'evidence-fresh',
        `REFUSED: '${subject.displayName}' already has minReplicas 0 on a fresh ARM GET. ` +
          'The condition this finding reports no longer holds — it was fixed out-of-band or ' +
          'by an earlier perform. There is nothing to do, and re-running the write anyway ' +
          'would be a receipt for a change that did not happen. Nothing was changed in Azure.',
      );
    }
  }
  return null;
}
