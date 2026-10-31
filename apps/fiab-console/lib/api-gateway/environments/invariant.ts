/**
 * ADR-008 decision 4: an edit that would leave an APPLIED publication blocked
 * is refused, and the refusal lists the publications. Drafts are ignored here
 * (they fail at plan time). Only publications that become blocked BY this edit
 * count, so a pairing that was already blocked out-of-band cannot wedge every
 * unrelated administrator edit.
 */
import { permits, type PermitsSettings } from './permits';
import type { AppliedPublication, ClassifiableResource } from './types';

export interface BlockedPublication { publication: AppliedPublication; reason: string }

export const resourceRef = (kind: string, id: string): string => `${kind}:${id}`;

export function classificationMap(resources: readonly ClassifiableResource[]): Map<string, string | null> {
  return new Map(resources.map((r) => [resourceRef(r.kind, r.id), r.environmentKey]));
}

export function blockedPublications(
  publications: readonly AppliedPublication[],
  classOf: ReadonlyMap<string, string | null>,
  settings: PermitsSettings,
): BlockedPublication[] {
  const out: BlockedPublication[] = [];
  for (const pub of publications) {
    const gatewayEnv = classOf.get(resourceRef('gateway', pub.gatewayId)) ?? null;
    for (const res of pub.resources) {
      const verdict = permits(gatewayEnv, classOf.get(resourceRef(res.kind, res.id)) ?? null, settings);
      if (verdict.level === 'blocked') {
        out.push({ publication: pub, reason: verdict.message });
        break;
      }
    }
  }
  return out;
}

export function newlyBlocked(before: readonly BlockedPublication[], after: readonly BlockedPublication[]): BlockedPublication[] {
  const was = new Set(before.map((b) => b.publication.id));
  return after.filter((b) => !was.has(b.publication.id));
}
