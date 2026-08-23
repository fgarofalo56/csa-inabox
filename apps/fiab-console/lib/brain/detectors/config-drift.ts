/**
 * LOOM BRAIN — detector: CONFIG DRIFT.
 *
 * The same wire, declared one way in the template and configured another way in
 * the running deployment. PRP §0: "edge whose **declared** endpoint != **live**
 * endpoint".
 *
 * The join is (source node, env var symbol): a `declared` edge from bicep and a
 * `configured` edge from the live app that carry the SAME symbol on the SAME
 * consumer are two statements about one wire, and they can disagree.
 *
 * ── THIS DETECTOR'S FAILURE MODE IS FALSE POSITIVES, NOT MISSES ────────────
 * A bicep value is usually an EXPRESSION —
 * `'https://${loomDirectLake!.outputs.fqdn}'` — and the live value is a resolved
 * FQDN. Those two strings will never be equal, and a naive `declared !== live`
 * comparison would flag essentially every wire on the estate as drifted. A
 * detector that fires on everything is worse than one that fires on nothing:
 * nothing is a visible gap, everything is noise that gets the whole surface
 * ignored.
 *
 * So a comparison is only made where it can be ESTABLISHED, and every pair that
 * cannot be compared is SKIPPED with the reason:
 *
 *   BOTH RESOLVED    -> compare the resolved node ids. An ARM expression and an
 *                       FQDN that resolve to the same node are the same wire, so
 *                       this comparison is immune to the expression problem.
 *   BOTH LITERAL     -> neither value contains a `${` interpolation, so the raw
 *                       strings are directly comparable after normalization.
 *   MIXED / EITHER
 *   INTERPOLATED     -> NOT COMPARABLE. Skipped with the reason. This is the
 *                       common case and it is honest, not a gap being hidden.
 *
 * ── FOUR KINDS OF DRIFT, BECAUSE THEY HAVE FOUR DIFFERENT FIXES ───────────
 *   'target-mismatch'  both sides resolve, to DIFFERENT nodes. The strongest
 *                      finding available: two concrete endpoints that disagree.
 *   'literal-mismatch' both sides are literals and the strings differ.
 *   'live-empty'       the template declares a real target and the running app
 *                      carries ''. A wire the deployment LOST.
 *   'declared-empty'   the template declares '' and the running app carries a
 *                      real value — someone patched the live app by hand. This is
 *                      MEASURED on this estate: the live console carries a
 *                      hand-added `LOOM_CAPACITY_BROKER_URL` alongside the
 *                      bicep-emitted `LOOM_BROKER_URL`, which is what working
 *                      around a broken binding looks like. Only a `configured`
 *                      edge can ever see it; no amount of reading bicep will.
 */

import {
  isDanglingEdge,
  type BrainEdge,
  type BrainGraphView,
  type Detector,
  type DetectorResult,
  type Finding,
  type FindingSeverity,
  type NodeId,
  type SkippedSubject,
} from '../graph';
import {
  edgeDetectorPopulation,
  evidence,
  finalizeResult,
  findingId,
  makeLedger,
  ownership,
  scopedProposal,
  skip,
} from './detector-kit';

export const CONFIG_DRIFT = 'config-drift';

export type DriftKind = 'target-mismatch' | 'literal-mismatch' | 'live-empty' | 'declared-empty';

const QUERY =
  "join declared edges to configured edges on (from, evidence.symbol); compare resolved target or literal value";

/** True when a bicep value expression interpolates something the string cannot express. */
function isInterpolated(raw: string | undefined): boolean {
  return raw !== undefined && raw.includes('${');
}

/** Compare two endpoint literals the way a reader would: trimmed, unquoted, case-folded, no trailing slash. */
export function normalizeLiteral(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const SEVERITY: Readonly<Record<DriftKind, FindingSeverity>> = {
  // The deployment lost a wire the template declares — a service is unwired right now.
  'live-empty': 'high',
  // Two concrete, different endpoints. Something is talking to the wrong thing.
  'target-mismatch': 'high',
  // A hand-patch on a live app: real, but the running state is the working one.
  'declared-empty': 'medium',
  'literal-mismatch': 'medium',
};

interface Pair {
  readonly from: NodeId;
  readonly symbol: string;
  readonly declared: BrainEdge<'declared'>;
  readonly configured: BrainEdge<'configured'>;
}

export const configDrift: Detector = (graph: BrainGraphView): DetectorResult => {
  const skipped: SkippedSubject[] = [];

  const declared = graph.edges.filter((e): e is BrainEdge<'declared'> => e.provenance === 'declared');
  const configured = graph.edges.filter((e): e is BrainEdge<'configured'> => e.provenance === 'configured');

  // Index the live side by (from, symbol). An edge with no symbol cannot be
  // joined — it is recorded, not dropped.
  const liveBySymbol = new Map<string, BrainEdge<'configured'>>();
  for (const e of configured) {
    if (!e.evidence.symbol) {
      skipped.push(skip(e.id, "configured edge carries no `evidence.symbol`, so it cannot be joined to a declared wire."));
      continue;
    }
    liveBySymbol.set(`${e.from}|${e.evidence.symbol}`, e);
  }

  const pairs: Pair[] = [];
  for (const d of declared) {
    if (!d.evidence.symbol) {
      skipped.push(skip(d.id, 'declared edge carries no `evidence.symbol`, so it cannot be joined to a live wire.'));
      continue;
    }
    const key = `${d.from}|${d.evidence.symbol}`;
    const live = liveBySymbol.get(key);
    if (!live) {
      // Not drift. A declared wire with no live counterpart is `declared-but-dead`
      // territory, and reporting it here as well would double-count one defect
      // under two names.
      continue;
    }
    pairs.push({ from: d.from, symbol: d.evidence.symbol, declared: d, configured: live });
  }

  // The subject is the set of comparable PAIRS, expressed as the edges involved.
  const pairEdges: BrainEdge[] = pairs.flatMap((p) => [p.declared, p.configured]);
  // The ledger's universe is the PAIRS — the things the predicate ranges over —
  // while the population counts the EDGES under comparison. Keyed on the
  // DECLARED edge id, which is unique per pair; keying on (from, symbol) would
  // collide if a template ever declared the same symbol twice on one consumer.
  const pairKey = (p: Pair): string => p.declared.id;
  const ledger = makeLedger(CONFIG_DRIFT, pairs.map(pairKey));
  const population = edgeDetectorPopulation(
    graph,
    pairEdges,
    `${declared.length} declared and ${configured.length} configured edge(s) in graph; ` +
      `${pairs.length} pair(s) joined on (from, symbol) — ${pairEdges.length} edges under comparison. ` +
      'A declared wire with no live counterpart is NOT drift and is left to `declared-but-dead`.',
  );

  const findings: Finding[] = [];

  for (const pair of pairs) {
    const d = pair.declared;
    const c = pair.configured;
    const dRaw = d.evidence.rawValue;
    const cRaw = c.evidence.rawValue;
    const dEmpty = isDanglingEdge(d) && d.danglingReason === 'empty-value';
    const cEmpty = isDanglingEdge(c) && c.danglingReason === 'empty-value';

    let kind: DriftKind | null = null;
    let detail = '';

    if (dEmpty && cEmpty) {
      // Both empty. They AGREE, and both are wrong — that is `dangling-wire`'s
      // finding, not drift. Reporting it here would triple-count it.
      ledger.cleared(pairKey(pair), 'both sides are empty — they AGREE; the defect is `dangling-wire`\'s');
      continue;
    } else if (dEmpty && !cEmpty) {
      kind = 'declared-empty';
      detail =
        `the template declares ${JSON.stringify(dRaw ?? '')} (an empty wire) while the running app carries ` +
        `${JSON.stringify(cRaw ?? '')}. The live value did not come from this template.`;
    } else if (!dEmpty && cEmpty) {
      kind = 'live-empty';
      detail =
        `the template declares ${JSON.stringify(dRaw ?? '')} while the running app carries an empty string. ` +
        'The deployment does not have the wire the template describes.';
    } else if (d.resolution === 'resolved' && c.resolution === 'resolved') {
      // THE PREDICATE, strongest form. Both sides name a real node; compare them.
      if (d.to !== c.to) {
        kind = 'target-mismatch';
        const dName = graph.node(d.to)?.displayName ?? d.to;
        const cName = graph.node(c.to)?.displayName ?? c.to;
        detail = `the template resolves to '${dName}' and the running app resolves to '${cName}'.`;
      }
    } else if (!isInterpolated(dRaw) && !isInterpolated(cRaw) && dRaw !== undefined && cRaw !== undefined) {
      if (normalizeLiteral(dRaw) !== normalizeLiteral(cRaw)) {
        kind = 'literal-mismatch';
        detail = `the template declares ${JSON.stringify(dRaw)} and the running app carries ${JSON.stringify(cRaw)}.`;
      }
    } else {
      // NOT COMPARABLE, and this is the common case. Say so rather than guessing.
      ledger.skipped(pairKey(pair));
      skipped.push(
        skip(
          `${pair.from} ${pair.symbol}`,
          'declared and live values are NOT COMPARABLE: at least one side is an unresolved bicep ' +
            `expression (declared=${JSON.stringify(dRaw ?? '')}, live=${JSON.stringify(cRaw ?? '')}). ` +
            'Comparing an ARM expression to a resolved endpoint as strings would flag nearly every wire ' +
            'on the estate. Supply `moduleTargets` to the bicep extractor so both sides resolve, and this ' +
            'pair becomes comparable.',
        ),
      );
      continue;
    }

    if (kind === null) {
      // Compared, and they AGREE. No finding.
      ledger.cleared(pairKey(pair), 'both sides were compared on established values and they AGREE');
      continue;
    }
    ledger.finding(pairKey(pair));

    const own = ownership(graph, pair.from);
    const fromName = graph.node(pair.from)?.displayName ?? pair.from;
    const subjects: NodeId[] = [pair.from];
    if (d.resolution === 'resolved') subjects.push(d.to);
    if (c.resolution === 'resolved') subjects.push(c.to);
    if (isDanglingEdge(d) && d.intendedTo) subjects.push(d.intendedTo);
    if (isDanglingEdge(c) && c.intendedTo) subjects.push(c.intendedTo);

    findings.push({
      id: findingId(CONFIG_DRIFT, pair.from, pair.symbol),
      detector: CONFIG_DRIFT,
      severity: SEVERITY[kind],
      title: `${fromName}: ${pair.symbol} differs between the template and the deployment (${kind})`,
      summary: `On '${fromName}', ${pair.symbol} ${detail}`,
      subjects: [...new Set(subjects)],
      evidence: evidence({
        nodes: [...new Set(subjects)],
        edges: [d, c],
        query: `${QUERY} — pair (from='${pair.from}', symbol='${pair.symbol}'), driftKind='${kind}'`,
        notes: [
          `driftKind: ${kind}`,
          `declared  [${d.resolution}] ${d.evidence.artifact}` +
            (d.evidence.line !== undefined ? `:${d.evidence.line}` : '') +
            ` = ${JSON.stringify(dRaw ?? '')} (extractor: ${d.evidence.extractor})`,
          `configured[${c.resolution}] ${c.evidence.artifact} = ${JSON.stringify(cRaw ?? '')} ` +
            `(extractor: ${c.evidence.extractor})`,
          kind === 'declared-empty'
            ? 'A live value with no template origin is a hand-patch. It works today and it will be ' +
              'silently reverted by the next deploy that re-renders this app.'
            : kind === 'live-empty'
              ? 'The running deployment is missing a wire the template declares — merged is not deployed ' +
                '(deploy-integrity R2).'
              : 'Both sides were compared on established values, not on raw expression text.',
        ],
      }),
      population,
      // Both values are read directly off their artifacts and the comparison only
      // runs where it is well-defined, so the verdict itself is not inferred.
      confidence: 'high',
      remediation: scopedProposal(
        `Reconcile ${pair.symbol} on '${fromName}'`,
        kind === 'declared-empty'
          ? `The running app carries ${JSON.stringify(cRaw ?? '')} for ${pair.symbol} and the template emits ` +
            `an empty string. Move the working value INTO the template so the next deploy does not revert ` +
            `it, then re-roll.`
          : kind === 'live-empty'
            ? `The template declares ${JSON.stringify(dRaw ?? '')} for ${pair.symbol} and the running app ` +
              `has an empty string. Roll the app so the declared value reaches it; if the roll already ran, ` +
              `the template's expression is evaluating to '' and that expression is the defect.`
            : `Decide which endpoint is correct for ${pair.symbol}, set it in the template, and roll. ` +
              `Template: ${JSON.stringify(dRaw ?? '')}. Live: ${JSON.stringify(cRaw ?? '')}.`,
        own,
      ),
    });
  }

  return finalizeResult({
    detector: CONFIG_DRIFT,
    graph,
    findings,
    population,
    skipped,
    ledger,
  });
};
