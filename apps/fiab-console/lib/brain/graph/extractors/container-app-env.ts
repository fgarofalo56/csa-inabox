/**
 * LOOM BRAIN — extractor: live container-app env → `configured` edges.
 *
 * PURE. Takes env lists a caller has ALREADY read (ARM GET or Resource Graph
 * projection) and turns them into edges. No client, no request, no write.
 *
 * ── WHY `configured` IS A DIFFERENT PROVENANCE FROM `declared` ─────────────
 * `declared` is what the TEMPLATE says. `configured` is what the DEPLOYMENT
 * actually has. They disagree routinely, and each direction of disagreement is a
 * distinct finding:
 *
 *   declared, not configured  the bicep wires it, the running app does not have
 *                             it — a deploy that never rolled, or a value the
 *                             template computes to ''.
 *   configured, not declared  someone set it by hand on the live app. MEASURED
 *                             on this estate: `lib/azure/capacity-broker-client.ts`
 *                             records that the live Commercial console carries
 *                             BOTH `LOOM_BROKER_URL` (bicep-emitted) and a
 *                             hand-added `LOOM_CAPACITY_BROKER_URL`, which is
 *                             what patching around a broken binding by hand
 *                             looks like. Only a `configured` edge can see it;
 *                             no amount of reading bicep ever will.
 *
 * ── `secretRef` IS INDETERMINATE, NOT EMPTY (R7) ───────────────────────────
 * A Container Apps env entry is either `{ name, value }` or `{ name, secretRef }`.
 * A `secretRef` entry HAS a value; this process simply cannot see it. Reporting
 * that as an empty wire would manufacture a dangling edge for a variable that is
 * correctly configured — a false claim, and one that would put a healthy service
 * on a cleanup list. So `secretRef` produces NO edge and a recorded skip, and
 * the skip says which variable and why.
 */

import type {
  ExtractionResult,
  NodeId,
  PendingEdge,
  SkippedSubject,
} from '../../types';
import { azureResourceNodeId } from '../node-id';
import { makePopulation } from '../graph';

/** One env entry as ARM returns it. Exactly one of `value` / `secretRef` is set. */
export interface ContainerAppEnvEntry {
  readonly name: string;
  /** The literal value. `''` is a REAL state — an empty wire — not a missing field. */
  readonly value?: string;
  /** Present when the value comes from a secret. The value is not readable here. */
  readonly secretRef?: string;
}

/** The live env of one container app. */
export interface ContainerAppEnvInput {
  /** ARM resource id of the app whose env this is. Becomes the edge's `from`. */
  readonly appResourceId: string;
  readonly env: readonly ContainerAppEnvEntry[];
  /**
   * Env var name → the node it is MEANT to reach, for entries whose value is
   * empty. Same rationale as the bicep extractor: an empty value cannot name its
   * own target, so the mapping is supplied as reviewable data rather than
   * inferred from the variable's name.
   */
  readonly envVarBindings?: Readonly<Record<string, NodeId>>;
  /**
   * Only emit edges for these env var names. Omit to consider every entry.
   *
   * Worth using: a Loom container app carries well over a hundred env vars, most
   * of which are feature flags and tuning knobs rather than wires to another
   * node. Every one of those would otherwise become an `unresolved-target`
   * dangling edge, burying the real ones. The filter is reported in the
   * population so its effect on the counts is visible.
   */
  readonly onlyNames?: readonly string[];
}

/**
 * Values that name a target rather than being one. A wire whose value is a
 * boolean or a numeric knob is not pointing at a node, and turning it into a
 * dangling edge would be noise that looks like a finding.
 */
function looksLikeATarget(value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (/^(true|false|yes|no|on|off|enabled|disabled)$/i.test(v)) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return false;
  return (
    v.startsWith('/subscriptions/') ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ||
    /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(v) ||
    /^[a-z0-9][a-z0-9-]{2,}$/i.test(v)
  );
}

export function extractFromContainerAppEnv(
  apps: readonly ContainerAppEnvInput[],
): ExtractionResult {
  const edges: PendingEdge[] = [];
  const skipped: SkippedSubject[] = [];
  let entriesExamined = 0;
  let emptyWires = 0;

  for (const app of apps) {
    const from = azureResourceNodeId(app.appResourceId);
    const bindings = app.envVarBindings ?? {};
    const only = app.onlyNames ? new Set(app.onlyNames) : null;

    for (const entry of app.env) {
      if (only && !only.has(entry.name)) continue;
      entriesExamined += 1;

      if (entry.secretRef !== undefined) {
        skipped.push({
          subject: `${app.appResourceId} ${entry.name}`,
          reason:
            `value comes from secretRef '${entry.secretRef}' and is NOT readable here. ` +
            'INDETERMINATE — this is not an empty wire, and no edge is emitted either way.',
        });
        continue;
      }

      if (entry.value === undefined) {
        skipped.push({
          subject: `${app.appResourceId} ${entry.name}`,
          reason:
            'entry has neither `value` nor `secretRef`. The env list was read but this entry ' +
            'carries no value field — indeterminate, not empty.',
        });
        continue;
      }

      const value = entry.value;
      const isEmpty = value.trim() === '';

      if (isEmpty) {
        // THE FOUNDING CASE, live side. The wire EXISTS on the running app and
        // carries ''. Emitted as a dangling edge so the evidence survives; its
        // `to` is null so it does not make the target reachable.
        emptyWires += 1;
        const intendedTo = bindings[entry.name] ?? null;
        edges.push({
          provenance: 'configured',
          from,
          targetRef: '',
          emptyValue: true,
          intendedTo,
          evidence: {
            artifact: app.appResourceId,
            symbol: entry.name,
            rawValue: value,
            extractor: 'container-app-env',
          },
        });
        if (intendedTo === null) {
          skipped.push({
            subject: `${app.appResourceId} ${entry.name}`,
            reason:
              'live value is EMPTY and no envVarBindings entry names its intended target, so the ' +
              'dangling edge cannot be attached to a node. It is still emitted and visible via ' +
              'danglingEdges().',
          });
        }
        continue;
      }

      if (!looksLikeATarget(value)) {
        skipped.push({
          subject: `${app.appResourceId} ${entry.name}`,
          reason:
            'value is set but does not name a target (a flag, a number, or free text). ' +
            'Not a wire; no edge emitted.',
        });
        continue;
      }

      edges.push({
        provenance: 'configured',
        from,
        targetRef: value,
        emptyValue: false,
        intendedTo: bindings[entry.name] ?? null,
        evidence: {
          artifact: app.appResourceId,
          symbol: entry.name,
          rawValue: value,
          extractor: 'container-app-env',
        },
      });
    }
  }

  return {
    source: 'container-app-env',
    // No nodes: the apps themselves come from Resource Graph, which reads their
    // scale, ingress and tags. Minting a second, thinner node for the same ARM
    // id here would be de-duplicated by buildGraph anyway, but emitting it would
    // imply this extractor established facts it did not.
    nodes: [],
    edges,
    population: makePopulation({
      subject: 'edges',
      nodes: [],
      edges,
      scope:
        `${apps.length} container app(s); ${entriesExamined} env entr(ies) examined` +
        `${apps.some((a) => a.onlyNames) ? ' (name-filtered)' : ''}; ` +
        `${edges.length} configured edge(s) emitted (${emptyWires} EMPTY); ${skipped.length} skipped`,
    }),
    skipped,
  };
}
