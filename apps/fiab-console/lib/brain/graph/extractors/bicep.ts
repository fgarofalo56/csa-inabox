/**
 * LOOM BRAIN — extractor: bicep → `declared` edges.
 *
 * PURE. Takes bicep SOURCE TEXT a caller has already read and produces edges.
 * No filesystem access, no Azure client.
 *
 * ── THE ONE BRANCH THAT MATTERS ────────────────────────────────────────────
 * A bicep `env:` entry whose value is the empty string is a DANGLING edge, NOT
 * an absent one. This is the whole founding finding:
 *
 *   platform/fiab/bicep/modules/admin-plane/main.bicep:4730
 *     { name: 'LOOM_BROKER_URL', value: '' }
 *
 * `loom-capacity-broker` is deployed at `minReplicas: 2` with 0.5 vCPU + 1 GiB
 * per replica and an internal ingress FQDN, and this is the ONLY name any bicep
 * emits for its URL. So the service bills continuously while the one wire that
 * would reach it carries an empty string.
 *
 * Three states, and the difference between them is the whole design:
 *
 *   RESOLVED  a wire with a value that names a node       → target is reachable
 *   DANGLING  a wire that EXISTS and carries ''           → target NOT reachable,
 *                                                            evidence preserved
 *   ABSENT    no `env:` entry at all                      → no edge, nothing to say
 *
 * If this extractor SKIPPED empty values instead of emitting them, the broker
 * would still come back unreachable — but the receipt would be empty. An
 * operator would be told "loom-capacity-broker has no inbound configured edge"
 * with no file, no line, and no idea that main.bicep:4730 is the thing to fix.
 * `__tests__/graph/mutation.test.ts` performs exactly that mutation and shows
 * the tests going red.
 *
 * ── AN EMPTY VALUE DESTROYS THE EVIDENCE OF ITS OWN INTENT ─────────────────
 * `value: 'https://${loomDirectLake!.outputs.fqdn}'` names its target. `value: ''`
 * names nothing — the erasure is total, and no amount of parsing recovers it.
 * That is why {@link BicepFileInput.envVarBindings} exists: the mapping from env
 * var name to intended target is supplied as DATA by the caller, inspectable and
 * reviewable, rather than guessed from the variable's name. A guess here would
 * attach a real finding to a possibly-wrong resource (R7).
 *
 * ── LINE ENDINGS ───────────────────────────────────────────────────────────
 * This repo is mixed: console `.ts` files are CRLF in the working tree while the
 * bicep sources are LF, and CI reads whatever git hands it. A parser that
 * assumes either one silently matches nothing on the other — which reads exactly
 * like "there are no env entries", i.e. a clean, confident, wrong answer. Input
 * is normalized on entry and `__tests__/graph/bicep-extractor.test.ts` runs the
 * same fixture through both.
 */

import type {
  DeployArtifactNode,
  ExtractionResult,
  NodeId,
  PendingEdge,
  SkippedSubject,
} from '../../types';
import { deployArtifactNodeId } from '../node-id';
import { makePopulation } from '../graph';

/** One bicep source file to scan. */
export interface BicepFileInput {
  /** Repo-relative path, e.g. 'platform/fiab/bicep/modules/admin-plane/main.bicep'. */
  readonly path: string;
  /** The file's text. CRLF or LF; both are handled. */
  readonly text: string;
  /**
   * The node that CONSUMES this env block — the app the variables are set on.
   * Edges run consumer → target, so this is the `from` of every emitted edge.
   */
  readonly consumer: NodeId;
  /**
   * Env var name → the node it is MEANT to reach. Supplied as data because an
   * empty value cannot name its own target (see the module header).
   *
   * Keys are matched case-sensitively: bicep env var names are exact strings and
   * `LOOM_BROKER_URL` vs `Loom_Broker_Url` would be two different variables.
   */
  readonly envVarBindings?: Readonly<Record<string, NodeId>>;
  /**
   * Bicep module symbol (e.g. `loomDirectLake`) → a target ref the resolver can
   * match: an ARM id, an FQDN, or a resource name.
   *
   * Without an entry, a value like `'https://${loomDirectLake!.outputs.fqdn}'`
   * becomes a DANGLING edge with reason `unresolved-target` — which is honest:
   * this extractor genuinely cannot map a module symbol to a deployed resource
   * without knowing that module's naming logic. It reports the gap rather than
   * inventing a link.
   */
  readonly moduleTargets?: Readonly<Record<string, string>>;
  /**
   * Route individual env entries to different consumers, for a file that
   * declares env for more than one app. Returning `null` falls back to
   * {@link consumer}.
   */
  readonly resolveConsumer?: (envVarName: string, line: number) => NodeId | null;
}

/** How far below a `name:` line this scanner will look for its `value:`. */
const VALUE_LOOKAHEAD_LINES = 6;

const NAME_RE = /\bname:\s*'([^']+)'/;
const VALUE_ON_SAME_LINE_RE = /\bvalue:\s*(.+)$/;
const VALUE_ON_OWN_LINE_RE = /^\s*value:\s*(.+)$/;

/** All single-quoted string literals in a bicep expression, in order. */
function stringLiterals(expr: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) out.push(m[1]!);
  return out;
}

/** The first bicep module/symbol referenced in a `${...}` interpolation. */
function firstInterpolatedSymbol(expr: string): string | null {
  const m = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(expr);
  return m?.[1] ?? null;
}

/**
 * Trim a value expression to just the expression: drop a trailing `}` that
 * closes the object on a single-line entry, and any trailing comment.
 */
function cleanValueExpr(raw: string): string {
  let v = raw.trim();
  // Strip a trailing line comment, but only outside a string literal. Counting
  // quotes is enough here because bicep has no escaped quote outside `''`.
  const commentAt = v.indexOf('//');
  if (commentAt >= 0) {
    const before = v.slice(0, commentAt);
    const quotes = (before.match(/'/g) ?? []).length;
    if (quotes % 2 === 0) v = before.trim();
  }
  // Drop the object's closing brace on a single-line entry.
  while (v.endsWith('}')) {
    const quotes = (v.slice(0, -1).match(/'/g) ?? []).length;
    if (quotes % 2 !== 0) break; // the `}` is inside a string — keep it
    v = v.slice(0, -1).trim();
  }
  return v;
}

interface ParsedValue {
  /** True iff the expression declares an EMPTY wire. */
  readonly emptyValue: boolean;
  /** The target as authored, resolvable by the graph. */
  readonly targetRef: string;
}

/**
 * Interpret a bicep value expression.
 *
 * The ternary case is real and common in this codebase:
 *   `directLakeSvcActive ? 'https://${loomDirectLake!.outputs.fqdn}' : ''`
 * It declares a CONDITIONAL wire. The template does declare a target, so the
 * first NON-EMPTY literal is taken as the declared target and the full
 * expression is preserved verbatim in the evidence — a reader can then see the
 * condition rather than being handed a link that looks unconditional.
 *
 * An expression whose only literals are empty (`''`, or `x ? '' : ''`) is an
 * EMPTY WIRE. That is the founding case.
 */
function parseValueExpression(
  expr: string,
  moduleTargets: Readonly<Record<string, string>>,
): ParsedValue {
  const literals = stringLiterals(expr);
  const nonEmpty = literals.filter((l) => l.trim() !== '');

  if (literals.length > 0 && nonEmpty.length === 0) {
    // Every literal in the expression is empty. THE FOUNDING CASE.
    return { emptyValue: true, targetRef: '' };
  }

  if (nonEmpty.length > 0) {
    const first = nonEmpty[0]!;
    const symbol = firstInterpolatedSymbol(first);
    if (symbol && moduleTargets[symbol]) {
      return { emptyValue: false, targetRef: moduleTargets[symbol]! };
    }
    // An interpolation with no supplied mapping stays unresolved rather than
    // being flattened into a literal string that resolves to nothing useful.
    return { emptyValue: false, targetRef: symbol ?? first };
  }

  // No string literals at all — a bare identifier or a function call.
  const symbol = firstInterpolatedSymbol(expr) ?? expr.trim();
  if (moduleTargets[symbol]) return { emptyValue: false, targetRef: moduleTargets[symbol]! };
  return { emptyValue: false, targetRef: symbol };
}

/**
 * Scan bicep files for `env:` entries and emit `declared` edges.
 *
 * Reports its population honestly: how many `name:` entries were seen, how many
 * produced an edge, and every entry it could not interpret with the reason. An
 * extractor that returns nothing over a file it failed to parse is
 * indistinguishable from one that returned nothing over a file with no wires —
 * `skipped` is what tells those apart.
 */
export function extractFromBicep(files: readonly BicepFileInput[]): ExtractionResult {
  const nodes: DeployArtifactNode[] = [];
  const edges: PendingEdge[] = [];
  const skipped: SkippedSubject[] = [];
  let nameEntriesSeen = 0;
  let nameEntriesRejected = 0;

  for (const file of files) {
    nodes.push({
      id: deployArtifactNodeId(file.path),
      kind: 'deploy-artifact',
      displayName: file.path.split('/').pop() ?? file.path,
      source: 'bicep',
      path: file.path,
      artifactKind: file.path.endsWith('.bicepparam') ? 'bicep-param' : 'bicep-module',
    });

    // CRLF and lone-CR both normalized. See the module header: a parser that
    // assumes one line ending silently matches nothing on the other.
    const lines = file.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const bindings = file.envVarBindings ?? {};
    const moduleTargets = file.moduleTargets ?? {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const nameMatch = NAME_RE.exec(line);
      if (!nameMatch) continue;
      const envName = nameMatch[1]!;

      // Only env-var-shaped names. A bicep `name:` property is used for dozens
      // of things (resource names, module names, probe names); treating them all
      // as env wires would flood the graph with edges that mean nothing.
      //
      // The filter's COST is counted and reported in the scope string. It was
      // not: `nameEntriesSeen` was incremented AFTER this `continue`, so the
      // scope reported only the survivors while the comment here claimed the
      // cost was visible. Measured on the real 187-file bicep tree, that hid
      // more than it showed — 1,833 `name:` entries matched, 892 kept, 941
      // (51.3%) rejected and reported nowhere.
      //
      // KNOWN LIMIT, deliberately not a `skipped` entry: a legitimately-named
      // env var outside SCREAMING_SNAKE (`Loom_Broker_Url`, `loomBrokerUrl`) is
      // rejected here and appears only in this aggregate count, not as a named
      // subject. Every rejection observed on the real tree is a resource or
      // module name, so per-subject records would be ~941 rows of noise — but
      // the aggregate makes the trade visible instead of silent.
      if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
        nameEntriesRejected += 1;
        continue;
      }
      nameEntriesSeen += 1;

      const lineNumber = i + 1;
      let rawValue: string | null = null;

      const sameLine = VALUE_ON_SAME_LINE_RE.exec(line.slice(nameMatch.index + nameMatch[0].length));
      if (sameLine) {
        rawValue = sameLine[1]!;
      } else {
        for (let j = i + 1; j < Math.min(i + 1 + VALUE_LOOKAHEAD_LINES, lines.length); j++) {
          const candidate = lines[j]!;
          if (NAME_RE.test(candidate)) break; // next entry started; this one has no value
          const own = VALUE_ON_OWN_LINE_RE.exec(candidate);
          if (own) {
            rawValue = own[1]!;
            break;
          }
        }
      }

      if (rawValue === null) {
        skipped.push({
          subject: `${file.path}:${lineNumber} ${envName}`,
          reason:
            `no \`value:\` found on the same line or within ${VALUE_LOOKAHEAD_LINES} lines. ` +
            'The entry exists but this scanner could not read its value — NOT evidence that it is unset.',
        });
        continue;
      }

      const expr = cleanValueExpr(rawValue);
      const parsed = parseValueExpression(expr, moduleTargets);
      const from = file.resolveConsumer?.(envName, lineNumber) ?? file.consumer;
      const intendedTo = bindings[envName] ?? null;

      edges.push({
        provenance: 'declared',
        from,
        targetRef: parsed.targetRef,
        emptyValue: parsed.emptyValue,
        intendedTo,
        evidence: {
          artifact: file.path,
          line: lineNumber,
          symbol: envName,
          // The expression VERBATIM. For the founding case this renders as `''`,
          // which is the receipt: the wire is there and it is empty.
          rawValue: expr,
          extractor: 'bicep',
        },
      });

      if (parsed.emptyValue && intendedTo === null) {
        skipped.push({
          subject: `${file.path}:${lineNumber} ${envName}`,
          reason:
            'declares an EMPTY wire, and no envVarBindings entry names its intended target, so the ' +
            'dangling edge cannot be attached to a node. The edge IS emitted (it appears in ' +
            'danglingEdges()), but it will not surface via danglingEdgesIntendedFor().',
        });
      }
    }
  }

  return {
    source: 'bicep',
    nodes,
    edges,
    population: makePopulation({
      subject: 'edges',
      nodes,
      edges,
      scope:
        `${files.length} bicep file(s); ${nameEntriesSeen} env-var-shaped \`name:\` entries examined ` +
        `(${nameEntriesRejected} \`name:\` entr(ies) REJECTED as not env-var-shaped); ` +
        `${edges.length} declared edge(s) emitted (${edges.filter((e) => e.emptyValue).length} EMPTY); ` +
        `${skipped.length} skipped`,
    }),
    skipped,
  };
}
