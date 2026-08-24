/**
 * C8 — INJECTION INTO A HUMAN-EXECUTED COMMAND (a sink that is not a machine).
 *
 * Taxonomy §9 — a class the commissioned list did not contain. #3610 (OPEN):
 * `app/api/setup/identity/route.ts` builds a `bootstrapScript` string RETURNED IN
 * THE RESPONSE BODY, wrapping caller-supplied values in single quotes with NO
 * ESCAPING of an embedded quote. Neither field is validated — one is only
 * `.trim()`ed and the other is never checked to be a GUID.
 *
 * ── WHAT MAKES IT A DISTINCT CLASS ───────────────────────────────────────
 *
 * THE ROUTE DOES NOT EXECUTE THE STRING. That is exactly the point: the sink is
 * THE OPERATOR'S TERMINAL, and the emitted command already carries key-vault and
 * resource-group names and runs a privileged bootstrap script. Standard taint
 * analysis terminates at "no `exec` on this path" and reports clean. The
 * privileged execution happens OFF-GRAPH, performed by a human who has every
 * reason to trust the product's own output.
 *
 * A reachability query over executable sinks cannot express this. The sink has to
 * be DECLARED as privileged on the grounds of its CONTENT SHAPE — a shell
 * command, a connection string, a copy-paste remediation — which is why
 * `contentShape` is a facet field rather than something inferred from whether the
 * value flows into `exec`.
 *
 * ── C8 AND C1 COMPOUND HERE ──────────────────────────────────────────────
 *
 * #3610 also notes the route authorizes on a bare `getSession()` with no
 * capability gate. Its clean `check-route-guards` verdict rests on the
 * `app/api/setup/` ALLOWLIST CLASS, which #3607 (OPEN) records is NEVER
 * PREMISE-TESTED. So the same route is a C8 instance and a C3 allowlist-premise
 * instance simultaneously, and neither detector sees the other's half. The
 * fixture corpus models it that way on purpose.
 *
 * ── THE NARROW BYPASS ────────────────────────────────────────────────────
 *
 * ESCAPE THE VALUE IN THE FIELD THE DETECTOR KNOWS ABOUT AND ADD A SECOND
 * EMITTER. That is #3602's history exactly: `remediation.commands` in
 * `wire-existing` was allowlisted and `bootstrapScript` in a SIBLING ROUTE was
 * not. So `siblingEmitters` / `siblingEmittersCovered` are facet fields, and the
 * gap between them is its own finding — emitted even when every interpolation in
 * THIS node is clean, because that is exactly the state in which a per-field
 * audit reports success.
 *
 * NOT RE-VERIFIED BY THIS LANE: the file:line citations are #3610's measurement;
 * the taxonomy read the issue and not the route, and neither did this lane. The
 * fixtures are synthetic.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
} from '../population';
import type {
  EmittedCommandFacet,
  Finding,
  SecurityGraph,
  SecurityNode,
} from '../substrate';

export const C8_DETECTOR_ID = 'security.c8.human-executed-command';

/** Content shapes whose sink is a privileged execution the graph cannot see. */
const COMMAND_SHAPED = new Set(['shell-command', 'connection-string', 'remediation']);

/** Judge ONE emitted field. See `c1` for why every exit is a `return`. */
function judgeEmittedCommand(node: SecurityNode): Finding[] {
  const facet = node.facet as EmittedCommandFacet;
  const findings: Finding[] = [];

  // NEGATIVE CONTROL — a field that is not command-shaped is not a privileged
  // sink, however much caller data it carries. That is C2's question, not C8's.
  if (!COMMAND_SHAPED.has(facet.contentShape)) return findings;

  for (const interp of facet.interpolations) {
    if (interp.source !== 'caller-supplied') continue;
    if (interp.escaped || interp.allowlisted) continue;

    findings.push(
      buildFinding({
        id: `${C8_DETECTOR_ID}:${node.id}:${interp.name}`,
        detectorId: C8_DETECTOR_ID,
        findingClass: 'C8-human-executed-command',
        severity: 'high',
        confidence: 'high',
        title:
          `${facet.route} interpolates caller-supplied '${interp.name}' into ` +
          `${facet.field} (${facet.contentShape}) unescaped`,
        nodeIds: [node.id],
        query:
          'emitted-command where contentShape is command-shaped AND some interpolation is ' +
          'caller-supplied AND NOT escaped AND NOT allowlisted',
        facts: [
          `'${interp.name}' is validated as: ${interp.validatedAs ?? 'NOTHING'}`,
          'The route does not execute this string, which is what makes the class invisible to ' +
            'taint analysis: the analysis terminates at "no exec on this path" and reports ' +
            'clean while the privileged execution happens in the operator\'s terminal.',
          'The operator has every reason to trust the product\'s own output, so the social ' +
            'barrier that protects a copy-paste sink elsewhere does not exist here.',
        ],
        remediationSummary:
          `Allowlist or escape '${interp.name}' before it reaches ${facet.field}, and validate ` +
          'it against its actual domain (a GUID, a hostname) rather than trimming it. ' +
          'DRAFT ONLY.',
        proposedPatchDescription:
          `Validate '${interp.name}' at the route boundary and pass it through the same ` +
          'allowlist the sibling remediation emitter uses.',
      }),
    );
  }

  // The narrow bypass, reported independently of this node's own cleanliness.
  if (facet.siblingEmitters > facet.siblingEmittersCovered) {
    findings.push(
      buildFinding({
        id: `${C8_DETECTOR_ID}:${node.id}:emitter-coverage`,
        detectorId: C8_DETECTOR_ID,
        findingClass: 'POP-population-integrity',
        severity: 'medium',
        confidence: 'high',
        title:
          `${facet.route}'s module family has ${facet.siblingEmitters} command-shaped emitters ` +
          `and ${facet.siblingEmittersCovered} are covered`,
        nodeIds: [node.id],
        query: 'emitted-command where siblingEmitters > siblingEmittersCovered',
        facts: [
          'The measured evasion is to escape the field the detector knows about and add a ' +
            'second emitter: #3602 allowlisted `remediation.commands` in one route while ' +
            '`bootstrapScript` in a sibling was not covered.',
          'This finding is emitted independently of whether this node\'s interpolations are ' +
            'clean, because a fully-escaped node is exactly the state in which a per-field ' +
            'audit reports success.',
        ],
        remediationSummary:
          'Enumerate every command-shaped emitter in the family and route them all through one ' +
          'allowlist, then assert the emitter COUNT so a new one cannot land uncovered. ' +
          'DRAFT ONLY.',
      }),
    );
  }

  return findings;
}

export function detectHumanExecutedCommand(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'emitted-command');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    findings.push(...judgeEmittedCommand(node));
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C8_DETECTOR_ID,
    declaredKinds: ['emitted-command'],
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population, graph);
}

export const c8Spec: SecurityDetectorSpec = {
  id: C8_DETECTOR_ID,
  taxonomyClass: 'C8',
  title: 'Injection into a human-executed command (the sink is off-graph)',
  run: detectHumanExecutedCommand,
};
