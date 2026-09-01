/**
 * LOOM BRAIN ACTIONS — the two phase-1 executors (#4242).
 *
 * Both are REAL backend calls with real before/after receipts
 * (`no-vaporware.md`), both are destructive, and both are reachable ONLY
 * through the perform route's guard chain: tenant admin, fresh snapshot rebuild
 * with `collection.complete === true`, ownership re-confirmed from a fresh tag
 * read, detector not vacuous, population not blind, a fresh ARM GET matching
 * the finding's evidence, and the staged two-step confirm.
 *
 *   scale-to-zero    `updateContainerAppScale(name, { minReplicas: 0 })` — the
 *                    existing, proven PATCH in
 *                    `lib/azure/container-apps-arm-client.ts`. maxReplicas is
 *                    NOT touched: the app stays deployed and scales back up on
 *                    demand; only the always-on floor (the billed waste the
 *                    finding measured) is removed.
 *   delete-resource  ARM DELETE via `./arm`.
 *
 * The subject's ARM id is DERIVED from the server-resolved node fields — a
 * client-supplied resource id is never accepted (see the route).
 */

import {
  getContainerApp,
  updateContainerAppScale,
  type ContainerAppInfo,
} from '@/lib/azure/container-apps-arm-client';
import { armDeleteResource, BRAIN_ACTIONS_ACA_API } from './arm';
import type { PerformReceipt, PerformSubject } from './types';

const CONTAINER_APPS_TYPE = 'microsoft.app/containerapps';

/**
 * Rebuild the subject's ARM resource id from the SERVER's own node fields.
 * ARM ids are case-insensitive, so the normalized (lowercased) segments the
 * snapshot carries identify the same resource the original id did.
 */
export function deriveArmResourceId(subject: {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly displayName: string;
}): string {
  return (
    `/subscriptions/${subject.subscriptionId}/resourceGroups/${subject.resourceGroup}` +
    `/providers/Microsoft.App/containerApps/${subject.displayName}`
  );
}

/** True when the node's ARM type is a Container App (compared per ARM rules —
 * case-insensitively). Phase 1's executors act on nothing else. */
export function isContainerAppType(resourceType: string | undefined): boolean {
  return (resourceType || '').toLowerCase() === CONTAINER_APPS_TYPE;
}

/**
 * The fresh ARM read the #4015/#4016 guard compares against. Uses the existing
 * client's GET (scoped to the deployment's configured subscription + RG — the
 * write-scope guard has already confirmed the subject lives there).
 *
 * Throws verbatim on failure: a state that could not be read is a perform that
 * must refuse, and the message must say "could not read", never "does not
 * match" (deploy-integrity.md R7).
 */
export async function freshContainerAppRead(subject: PerformSubject): Promise<ContainerAppInfo> {
  return getContainerApp(subject.displayName);
}

/**
 * Scale the subject's always-on floor to zero. Returns the real before/after.
 *
 * `before` is the fresh ARM reading the guard chain just validated — passed in
 * rather than re-read so the receipt shows exactly the state the guards
 * approved, with no window for a second drift between guard and receipt.
 */
export async function executeScaleToZero(
  subject: PerformSubject,
  before: ContainerAppInfo,
  finding: { readonly findingId: string; readonly detector: string },
): Promise<PerformReceipt> {
  const after = await updateContainerAppScale(subject.displayName, { minReplicas: 0 });
  return {
    executor: 'scale-to-zero',
    detector: finding.detector,
    findingId: finding.findingId,
    resourceId: subject.armResourceId,
    before: {
      minReplicas: before.minReplicas ?? null,
      maxReplicas: before.maxReplicas ?? null,
      provisioningState: before.provisioningState ?? null,
    },
    after: {
      minReplicas: after.minReplicas ?? 0,
      maxReplicas: after.maxReplicas ?? before.maxReplicas ?? null,
      provisioningState: after.provisioningState ?? null,
    },
    performedAt: new Date().toISOString(),
    mutatedAzure: true,
  };
}

/**
 * Delete the subject. The strongest destructive class; reachable only behind
 * the staged confirm the route enforces.
 */
export async function executeDeleteResource(
  subject: PerformSubject,
  before: ContainerAppInfo,
  finding: { readonly findingId: string; readonly detector: string },
): Promise<PerformReceipt> {
  const res = await armDeleteResource(subject.armResourceId, BRAIN_ACTIONS_ACA_API);
  return {
    executor: 'delete-resource',
    detector: finding.detector,
    findingId: finding.findingId,
    resourceId: subject.armResourceId,
    before: {
      minReplicas: before.minReplicas ?? null,
      maxReplicas: before.maxReplicas ?? null,
      provisioningState: before.provisioningState ?? null,
      existed: true,
    },
    after: {
      deleted: true,
      armStatus: res.status,
      // 202 means ARM ACCEPTED the delete and completes it asynchronously —
      // stated as accepted, not as already-gone (R7).
      completion: res.status === 202 ? 'accepted (asynchronous)' : 'completed',
    },
    performedAt: new Date().toISOString(),
    mutatedAzure: true,
  };
}
