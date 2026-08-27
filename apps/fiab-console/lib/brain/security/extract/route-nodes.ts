/**
 * LOOM BRAIN — SECURITY EXTRACTION: `authorizer` (C1) and `verdict-call` (C3)
 * nodes, from the console's route modules.
 *
 * ── THE GAP THIS CLOSES, MEASURED ─────────────────────────────────────────
 *
 * `scripts/ci/check-tid-boundary-chokepoint.mjs` is the repo's existing guard for
 * the admin-grant chokepoint. It matches the token `isTenantAdmin(` and reports a
 * repo-wide census of 15 candidate functions. Measured on this tree:
 *
 *     app/api/**\/route.ts files                 1686
 *     files consuming `withTenantAdmin`            72
 *
 * `withTenantAdmin` does not contain the token `isTenantAdmin(`, so those 72
 * files are STRUCTURALLY OUTSIDE that guard's population. It is not a tuning
 * problem: `lib/api/route-toolkit.ts:166-172` is
 *
 *     export function withTenantAdmin<P>(handler) {
 *       return withSession<P>((req, sctx) => {
 *         const gate = requireTenantAdmin(sctx.session);
 *         if (gate) return gate;
 *         return handler(req, sctx);
 *       });
 *     }
 *
 * — an admin-standing decision reached through a WRAPPER. Adopting the wrapper is
 * good practice and it removes the route from the guard's judged set. That is the
 * exact "adoption removes the file from the population" failure `population.ts`
 * documents, and it is why this extractor RESOLVES THE WRAPPER: a route wrapped in
 * `withTenantAdmin` is emitted as an authorizer whose condition predicate is
 * `isTenantAdmin`, because that is the claim actually read.
 *
 * `detectors/c1-unauthorized-inbound-edge.ts` is explicit that this is the
 * extractor's job — "The facet extractor names the predicate; this detector does
 * not re-derive it from a spelling."
 *
 * The live instance this surfaces, verified by reading the file:
 * `app/api/copilot/sessions/[id]/trace/route.ts:36-44` is `withTenantAdmin`-gated
 * and performs `c.item(id, id).read()` — a point-read whose partition key IS the
 * caller's URL segment, on a container with no tenant partition, with no `oid`
 * comparison anywhere in the handler. Admin standing in ANY tenant reaches it.
 *
 * ── WHY `requireTenantAdmin` ITSELF IS NOT A FINDING ─────────────────────
 *
 * C1's own negative control: `lib/auth/feature-gate.ts:157` is byte-identical in
 * shape and is CORRECT, because its contract is "is this caller a tenant admin at
 * all" — an org-wide gate over NO resource. This extractor reproduces that
 * distinction structurally rather than by naming the function: `resourceScoped`
 * is derived from whether the ROUTE names a resource in its path (a `[id]`
 * segment) or in an id-shaped query parameter. A route with no caller-named
 * resource is emitted with `resourceScoped: false` and C1 correctly skips it.
 */

import type {
  AllowPath,
  AuthorizerFacet,
  PrivilegedSinkKind,
  SecurityNode,
  VerdictCallFacet,
} from '../substrate';
import type { SkippedSubject, SourceFile } from './types';
import {
  blankNonCode,
  dynamicSegmentsOf,
  findCalls,
  findExportedHandlers,
  routePathOf,
  securityNodeId,
} from './source-facts';
import {
  argsAreSessionScoped,
  distinctSinkKinds,
  findPrivilegedSinks,
  findVerdictCalls,
  OWNS_RESOLVERS,
  sessionScopedIdentifiers,
  type SinkHit,
} from './sinks';
import { classifyConsumption, consumingWrappersIn } from './consumption';
import { assertEveryCandidateJudged } from './population-contract';

export interface RouteExtraction {
  readonly nodes: readonly SecurityNode[];
  readonly skipped: readonly SkippedSubject[];
  /**
   * Route modules that ENTERED the population — and, because
   * {@link assertEveryCandidateJudged} runs before this is returned, every one of
   * them also received a verdict. It is a judged count, not merely a seen count.
   */
  readonly filesMatched: number;
}

/**
 * Wrapper / call spellings that read an admin claim, mapped to the predicate NAME
 * C1 keys on.
 *
 * The right-hand side must be a member of C1's `ADMIN_CLAIM_PREDICATES` set, or
 * the detector will not recognise it. That coupling is asserted BEHAVIOURALLY by
 * `__tests__/no-estate-identifiers.test.ts` ("every predicate name this extractor
 * emits is one C1 recognises", with a negative control), because a rename on
 * either side would otherwise silently empty the finding set without erroring.
 */
const ADMIN_CLAIM_SPELLINGS: readonly (readonly [string, string])[] = [
  ['withTenantAdmin', 'isTenantAdmin'],
  ['requireTenantAdmin', 'isTenantAdmin'],
  ['isTenantAdmin', 'isTenantAdmin'],
  ['hasTenantAdminRole', 'hasTenantAdminRole'],
] as const;

/** Query parameters that name a resource. Deliberately narrow — see `resourceScoped`. */
const ID_SHAPED_PARAM = /^(?:id|.*Id)$/;

/** `ALLOWLIST_PREFIXES` entries parsed out of `scripts/ci/check-route-guards.mjs`. */
export function parseAllowlistPrefixes(guardSource: string): string[] {
  const start = guardSource.indexOf('const ALLOWLIST_PREFIXES');
  if (start < 0) return [];
  const open = guardSource.indexOf('[', start);
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (; end < guardSource.length; end += 1) {
    if (guardSource[end] === '[') depth += 1;
    else if (guardSource[end] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const block = guardSource.slice(open, end);
  const out: string[] = [];
  const re = /\[\s*'([^']+)'\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/**
 * Id-shaped query parameters, read from RAW text.
 *
 * String contents are blanked for code analysis, so the parameter NAME has to be
 * recovered from the original source. That is safe here: the only thing taken
 * from raw text is a quoted literal inside a `searchParams.get(...)` call, which
 * cannot be confused with prose.
 */
function queryNamedResourcesRaw(rawBody: string): string[] {
  const out = new Set<string>();
  const re = /searchParams\s*\.\s*get\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawBody)) !== null) {
    if (ID_SHAPED_PARAM.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** The owns-resolver named in a body, if any. */
function ownsResolverIn(blanked: string): string | null {
  for (const r of OWNS_RESOLVERS) {
    if (new RegExp(`\\b${r}\\b`).test(blanked)) return r;
  }
  return null;
}

/**
 * Is the ALLOW boolean-implied by a verdict from the canonical `owns` resolver?
 *
 * Two independent ways to be implied, and BOTH are required to be about the
 * RESOURCE rather than about the caller's presence (see `sinks.ts` for the
 * measurement behind that distinction):
 *
 *   1. A canonical owns resolver runs and its verdict is consumed as a refusal.
 *      `withWorkspaceOwner` counts: `route-toolkit.ts:145` returns `apiNotFound()`
 *      when `loadOwnedItem` yields nothing, so the ALLOW genuinely cannot be
 *      reached without ownership.
 *   2. EVERY privileged sink in the handler is keyed on a session-derived value.
 *      "Every", not "any": one unscoped sink means the admin claim alone reaches
 *      that sink, which is precisely the finding.
 */
function impliedByOwns(
  blanked: string,
  wrappers: readonly string[],
  sinks: readonly SinkHit[],
): { implied: boolean; resolver: string | null } {
  if (wrappers.includes('withWorkspaceOwner')) {
    return { implied: true, resolver: 'withWorkspaceOwner' };
  }

  const resolver = ownsResolverIn(blanked);
  if (resolver) {
    const calls = findCalls(blanked, resolver);
    for (const call of calls) {
      const consumption = classifyConsumption(blanked, call.index);
      // `loadOwnedItem` returns the ITEM (null when unreachable), so the refusal
      // shape is `if (!item) return apiNotFound()`. `classifyConsumption` reports
      // that as 'returned' because the `if` tests the binding and returns.
      if (consumption.consumption === 'returned') return { implied: true, resolver };
    }
  }

  const derived = sessionScopedIdentifiers(blanked);
  if (sinks.length > 0 && sinks.every((s) => argsAreSessionScoped(s.argsText, derived))) {
    return { implied: true, resolver: 'session-scoped sink arguments' };
  }

  return { implied: false, resolver: resolver ?? null };
}

/** Extract every `authorizer` and `verdict-call` node from the console's routes. */
export function extractRouteNodes(
  files: readonly SourceFile[],
  allowlistPrefixes: readonly string[],
): RouteExtraction {
  const nodes: SecurityNode[] = [];
  const skipped: SkippedSubject[] = [];

  // THE POPULATION, AND THE VERDICT LEDGER. See `population-contract.ts`:
  // `candidates` is appended the moment a file is IN scope, `judged` only once a
  // verdict has actually been produced for it. A `continue` injected anywhere
  // between the two — the loop-level narrowing that removed 44% of this graph
  // with every gate green on 2026-08-24 — leaves the file in `candidates` and
  // out of `judged`, and the assertion below throws.
  const candidates: string[] = [];
  const judged: string[] = [];

  for (const file of files) {
    const routePath = routePathOf(file.path);
    // NOT a skip: a module that is not an `app/**/route.ts` was never in this
    // extractor's population at all. That boundary is cross-checked against an
    // independent census in `build.ts`, because a narrowing applied HERE would
    // shrink `candidates` and `judged` together and balance.
    if (routePath === null) continue;
    candidates.push(file.path);

    const blanked = blankNonCode(file.text);
    const handlers = findExportedHandlers(blanked);

    if (handlers.length === 0) {
      skipped.push({
        subject: file.path,
        reason:
          'no exported HTTP handler was recognised in the blanked source — either the export ' +
          'shape is not one this extractor reads (`export const GET = …` / `export async ' +
          'function GET(…)`), or the module\'s comment/string structure is unterminated and the ' +
          'lexer blanked the handler along with it. Which of the two is NOT established here, ' +
          'so neither is asserted. No authorizer or verdict-call node is emitted for it — ' +
          'recorded rather than dropped so the gap is countable.',
      });
      // A recorded skip IS a verdict: the file is accounted for in `meta.skipped`
      // where a reader can count it.
      judged.push(file.path);
      continue;
    }

    const allowlisted = allowlistPrefixes.some((p) => file.path.startsWith(p));

    for (const handler of handlers) {
      const sinks = findPrivilegedSinks(handler.body);
      const wrappers = consumingWrappersIn(handler.body);
      const dynamicSegments = dynamicSegmentsOf(routePath);
      const queryIds = queryNamedResourcesRaw(file.text);
      const callerNamed = [...dynamicSegments, ...queryIds];
      const sinkKinds = distinctSinkKinds(sinks);

      emitAuthorizer({
        nodes,
        file,
        routePath,
        handler,
        sinks,
        sinkKinds,
        wrappers,
        callerNamed,
        dynamicSegments,
      });

      emitVerdictCalls({ nodes, file, routePath, handler, sinks, sinkKinds, allowlisted });
    }

    judged.push(file.path);
  }

  assertEveryCandidateJudged('extractRouteNodes', candidates, judged);

  return { nodes, skipped, filesMatched: candidates.length };
}

interface AuthorizerArgs {
  nodes: SecurityNode[];
  file: SourceFile;
  routePath: string;
  handler: { method: string; body: string; line: number };
  sinks: readonly SinkHit[];
  sinkKinds: readonly PrivilegedSinkKind[];
  wrappers: readonly string[];
  callerNamed: readonly string[];
  dynamicSegments: readonly string[];
}

function emitAuthorizer(a: AuthorizerArgs): void {
  const predicates: string[] = [];
  for (const [spelling, predicate] of ADMIN_CLAIM_SPELLINGS) {
    if (new RegExp(`\\b${spelling}\\b`).test(a.handler.body) && !predicates.includes(predicate)) {
      predicates.push(predicate);
    }
  }
  if (predicates.length === 0) return;

  const { implied, resolver } = impliedByOwns(a.handler.body, a.wrappers, a.sinks);

  const allowPath: AllowPath = {
    id: `${a.handler.method.toLowerCase()}:admin-claim`,
    conditionPredicates: predicates,
    // Reserved for a literal narrowing on the path condition (the 2026-08-21
    // `opts.itemType === 'lakehouse'` shape). This extractor does not yet decide
    // path conditions inside a handler body, so it emits none rather than
    // guessing — an empty list never exempts and never reduces severity in C1.
    scopeLiterals: [],
    mentionsVerdict: resolver !== null && !implied,
    impliedByOwnsVerdict: implied,
    ownsResolver: implied ? resolver : null,
  };

  const facet: AuthorizerFacet = {
    kind: 'authorizer',
    fnName: `${a.handler.method} ${a.routePath}`,
    params: [...a.dynamicSegments],
    resourceScoped: a.callerNamed.length > 0,
    callerNamedResourceInputs: [...a.callerNamed],
    allowPaths: [allowPath],
    reachesPrivilegedSink: a.sinks.length > 0,
    privilegedSinkKinds: [...a.sinkKinds],
  };

  a.nodes.push({
    id: securityNodeId('authorizer', a.file.path, a.handler.method),
    kind: 'authorizer',
    provenance: 'declared',
    label: `${a.handler.method} ${a.routePath}`,
    facet,
  });
}

interface VerdictArgs {
  nodes: SecurityNode[];
  file: SourceFile;
  routePath: string;
  handler: { method: string; body: string; line: number };
  sinks: readonly SinkHit[];
  sinkKinds: readonly PrivilegedSinkKind[];
  allowlisted: boolean;
}

function emitVerdictCalls(v: VerdictArgs): void {
  for (const call of findVerdictCalls(v.handler.body)) {
    const consumption = classifyConsumption(v.handler.body, call.index);

    // See `consumption.ts`: when the refusal is conditional the extractor records
    // exactly ONE escaping path, because one is what it PROVED.
    let consumingPaths: number;
    if (consumption.consumption !== 'returned') consumingPaths = 0;
    else if (consumption.refusalIsTotal) consumingPaths = v.sinks.length;
    else consumingPaths = Math.max(0, v.sinks.length - 1);

    const facet: VerdictCallFacet = {
      kind: 'verdict-call',
      callSite: `${v.handler.method} ${v.routePath}:${call.line}`,
      symbol: call.name,
      returnsVerdictUnion: true,
      pathsToPrivilegedSink: v.sinks.length,
      pathsConsumingAsRefusal: consumingPaths,
      consumption: consumption.consumption,
      allowlisted: v.allowlisted,
      // #3607, OPEN: `ALLOWLIST_PREFIXES` premises are load-bearing for 12 routes
      // and have never been premise-tested. This is the issue's measured state,
      // cited rather than assumed — the extractor does not itself run a premise
      // probe, and says so instead of asserting a `true` it never established.
      allowlistPremiseTested: false,
      sinkPrivileged: v.sinks.length > 0,
      sinkKind: v.sinkKinds[0] ?? 'none',
    };

    v.nodes.push({
      id: securityNodeId(
        'verdict-call',
        v.file.path,
        `${v.handler.method}:${call.name}:${call.line}`,
      ),
      kind: 'verdict-call',
      provenance: 'declared',
      label: `${v.handler.method} ${v.routePath} -> ${call.name}`,
      facet,
    });
  }
}
