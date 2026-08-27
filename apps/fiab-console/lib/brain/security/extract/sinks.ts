/**
 * LOOM BRAIN — SECURITY EXTRACTION: privileged sinks and session-derived scope.
 *
 * Two questions, both required before any C1 or C3 verdict can be drawn:
 *
 *   1. Does this handler reach a PRIVILEGED SINK, and of which kind?
 *   2. Is the value the sink is keyed on DERIVED FROM THE SESSION, or chosen by
 *      the caller?
 *
 * Question 2 is the one that separates a real finding from noise, and getting it
 * wrong in the lenient direction would reproduce, exactly, a defect this repo has
 * already paid for four times.
 *
 * ── WHY A BARE `claims.oid` IS NOT ACCEPTED AS AUTHORIZATION ──────────────
 *
 * `detectors/c3-discarded-verdict.ts` records the measurement: a bare `claims.oid`
 * proves the token is PRESENT in the handler, not that it AUTHORIZES.
 * `items/dashboard/[id]` PUT passed a guard check on the overlay's `savedBy`
 * ATTRIBUTION field while overwriting any tenant's overlay by id. Removing bare
 * `claims.*` from that signal set moved the violation count from 0 to 205, and
 * commit `72fb01afd` is the same class at the reporting layer — "the route
 * inventory called a LOG FIELD an authorization check — 271 of 773 owner-scoped
 * rows" (#3625).
 *
 * So {@link sessionScopedIdentifiers} does NOT ask "does the session appear in
 * this handler". It asks whether a session-derived value appears INSIDE THE SINK
 * CALL'S OWN ARGUMENTS — i.e. whether the session narrows the thing being read or
 * written. `c.item(id, session.claims.oid)` scopes; `upsert({ ...body, savedBy:
 * session.claims.oid })` attributes. The first is an authorization edge and the
 * second is a log field, and this package must never confuse them, in either
 * direction:
 *
 *   - Counting attribution as scope makes C1 go QUIET on real cross-tenant reads.
 *   - Counting scope as attribution floods C1 with false positives on correct
 *     routes and gets the detector switched off.
 *
 * The narrow, defensible rule is "in the sink call's arguments", and the limit is
 * stated rather than hidden: a handler that resolves ownership several statements
 * earlier and then calls the sink with a bare local is NOT recognised as scoped
 * unless that local is itself session-derived. That direction of error is the
 * safe one — it over-reports, and an over-report is triaged by a human, whereas an
 * under-report is invisible.
 */

import type { PrivilegedSinkKind } from '../substrate';
import { balancedEnd, findCalls, lineAt, type CallSite } from './source-facts';

/** One privileged sink reached by a handler. */
export interface SinkHit {
  readonly kind: PrivilegedSinkKind;
  readonly line: number;
  /** The sink call's own arguments, blanked. The scope question is asked of THIS. */
  readonly argsText: string;
  /** The symbol that made this a sink, for evidence. */
  readonly via: string;
}

/**
 * Canonical `owns` resolvers.
 *
 * A handler that routes its decision through one of these has an authorization
 * edge that mentions the RESOURCE, which is exactly what C1 requires an ALLOW to
 * be implied by. This list is maintained EXPLICITLY and is not derived from a
 * spelling: `substrate.ts` is emphatic that a privileged sink is a `declared`
 * property, and the same applies to what counts as resolving ownership.
 */
export const OWNS_RESOLVERS: readonly string[] = [
  'loadOwnedItem',
  'authorizeItemWorkspace',
  'authorizeWorkspace',
  'requireWorkspace',
  'assertOwner',
  'withWorkspaceOwner',
] as const;

/**
 * The seven `NextResponse | null` verdict symbols, plus their wrapper forms.
 *
 * `detectors/c3-discarded-verdict.ts` names the seven. The `with*` wrappers are
 * added here because `lib/api/route-toolkit.ts` performs the caller's
 * `if (gate) return gate;` INSIDE the wrapper — so a route that adopts the
 * wrapper has the consumption edge even though the token `if (gate) return gate`
 * appears nowhere in the route file. An extractor blind to that would report
 * every wrapper-adopting route as a discarded verdict: ~72 false criticals.
 */
export const VERDICT_SYMBOLS: readonly string[] = [
  'enforceCapability',
  'requireTenantAdmin',
  'denyIfNoDlzAccess',
  'pdpCheck',
  'authorizeItemWorkspace',
  'authorizeWorkspace',
  'requireWorkspace',
] as const;

/**
 * Sink patterns, most specific first.
 *
 * ── ON `cosmos-cross-partition-read`, STATED PRECISELY ────────────────────
 *
 * It is used here for a read that is NOT CONFINED TO THE CALLER'S OWN PARTITION
 * — either an explicit cross-partition query, or a point-read whose partition key
 * is caller-supplied. Those are different things to Cosmos and the SAME thing to
 * a tenant boundary: both let a caller reach a partition they do not own. The
 * substrate does not define the term, so it is defined here rather than left to
 * a reader to infer, per deploy-integrity R7 — a classification must not assert
 * more than was established.
 */
interface SinkPattern {
  readonly symbol: string;
  readonly kind: PrivilegedSinkKind;
}

const SINK_PATTERNS: readonly SinkPattern[] = [
  { symbol: 'setAccessControlRecursive', kind: 'adls-posix-acl' },
  { symbol: 'updateAccessControlRecursive', kind: 'adls-posix-acl' },
  { symbol: 'setAccessControl', kind: 'adls-posix-acl' },
  { symbol: 'setPermissions', kind: 'adls-posix-acl' },
  { symbol: 'beginCreateOrUpdateAtSubscriptionScope', kind: 'arm-deploy' },
  { symbol: 'beginCreateOrUpdateAndWait', kind: 'arm-deploy' },
  { symbol: 'beginCreateOrUpdate', kind: 'arm-deploy' },
  { symbol: 'getSecret', kind: 'secret-read' },
  { symbol: 'setSecret', kind: 'secret-read' },
] as const;

/** `roleAssignments` reached in any form is a role-assignment sink. */
const ROLE_ASSIGNMENT_RE = /\broleAssignments\b/;

/**
 * Cosmos data-plane operations, detected on the `.<op>(` member form.
 *
 * Matched as members rather than as bare identifiers because `create`, `delete`
 * and `replace` are far too common as free functions to key on safely.
 */
const COSMOS_OPS: readonly { readonly op: string; readonly kind: PrivilegedSinkKind }[] = [
  { op: 'upsert', kind: 'cosmos-write' },
  { op: 'replace', kind: 'cosmos-write' },
  { op: 'patch', kind: 'cosmos-write' },
  { op: 'delete', kind: 'delete-cascade' },
] as const;

/**
 * Identifiers in `body` that hold a session-derived principal or tenant value.
 *
 * Three binding shapes are recognised, all of which occur in this repo:
 *   `const oid = session.claims.oid;`
 *   `const { oid, tid } = session.claims;`
 *   `const { claims } = session;`  (then `claims.oid` is matched directly)
 *
 * The literal member paths `claims.oid` / `claims.tid` are always included.
 */
export function sessionScopedIdentifiers(body: string): Set<string> {
  const ids = new Set<string>();

  const assignRe = /\bconst\s+([A-Za-z0-9_$]+)\s*=\s*([^;\n]*\bclaims\s*\.\s*(?:oid|tid)\b[^;\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(body)) !== null) ids.add(m[1]);

  const destructureRe = /\bconst\s*\{([^}]*)\}\s*=\s*[A-Za-z0-9_$.]*\bclaims\b/g;
  while ((m = destructureRe.exec(body)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop()?.trim();
      if (name && /^[A-Za-z0-9_$]+$/.test(name) && (name === 'oid' || name === 'tid')) ids.add(name);
    }
  }

  return ids;
}

/**
 * Does this sink call's ARGUMENT LIST narrow on a session-derived value?
 *
 * See the module docblock: this is asked of the sink's own arguments and
 * nowhere else, precisely so an attribution field written into a body object
 * cannot be mistaken for an authorization edge.
 */
export function argsAreSessionScoped(argsText: string, derived: ReadonlySet<string>): boolean {
  if (/\bclaims\s*\.\s*(?:oid|tid)\b/.test(argsText)) return true;
  for (const id of derived) {
    if (new RegExp(`\\b${id}\\b`).test(argsText)) return true;
  }
  return false;
}

/**
 * Every `.<op>(` member call, tolerating a GENERIC argument list.
 *
 * The generic handling is not a nicety — it was a measured miss. The first
 * implementation matched `/\.\s*read\s*\(/` and therefore did NOT match
 * `app/api/copilot/sessions/[id]/trace/route.ts:44`:
 *
 *     const { resource } = await c.item(id, id).read<{ steps?: unknown[] }>();
 *
 * so the live cross-tenant point-read this extractor exists to surface was
 * emitted with `reachesPrivilegedSink: false` and C1 correctly declined to fire
 * on it. A typed data-plane call is the NORM in this codebase, not the exception,
 * so a matcher blind to type arguments is blind to most of the sinks that matter.
 */
export function findMemberCalls(
  blanked: string,
  op: string,
): { index: number; line: number; argsText: string; end: number }[] {
  const out: { index: number; line: number; argsText: string; end: number }[] = [];
  const re = new RegExp(`\\.\\s*${op}\\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    let j = m.index + m[0].length;

    if (blanked[j] === '<') {
      let depth = 0;
      let k = j;
      for (; k < blanked.length; k += 1) {
        if (blanked[k] === '<') depth += 1;
        else if (blanked[k] === '>') {
          depth -= 1;
          if (depth === 0) {
            k += 1;
            break;
          }
        } else if (blanked[k] === ';') break;
      }
      let p = k;
      while (p < blanked.length && /\s/.test(blanked[p])) p += 1;
      if (blanked[p] === '(') j = p;
    }

    if (blanked[j] !== '(') continue;
    const end = balancedEnd(blanked, j);
    out.push({
      index: m.index,
      line: lineAt(blanked, m.index),
      argsText: blanked.slice(j + 1, Math.max(j + 1, end - 1)),
      end,
    });
  }
  return out;
}

/** Every privileged sink reached in `blanked`. */
export function findPrivilegedSinks(blanked: string): SinkHit[] {
  const hits: SinkHit[] = [];

  for (const pattern of SINK_PATTERNS) {
    for (const call of findCalls(blanked, pattern.symbol)) {
      hits.push({
        kind: pattern.kind,
        line: call.line,
        argsText: call.argsText,
        via: `${pattern.symbol}()`,
      });
    }
  }

  const roleMatch = ROLE_ASSIGNMENT_RE.exec(blanked);
  if (roleMatch) {
    hits.push({
      kind: 'role-assignment',
      line: lineAt(blanked, roleMatch.index),
      argsText: '',
      via: 'roleAssignments',
    });
  }

  for (const { op, kind } of COSMOS_OPS) {
    for (const call of findMemberCalls(blanked, op)) {
      hits.push({
        kind,
        line: call.line,
        argsText: call.argsText,
        via: `.${op}()`,
      });
    }
  }

  hits.push(...findCosmosReads(blanked));
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Cosmos READS, with the partition key that keys them.
 *
 * `.item(id, pk).read()` is the shape that matters and the reason this is not
 * folded into {@link COSMOS_OPS}: the security question is not "did a read
 * happen" but "what partition did it reach", and that lives in `.item(...)`'s
 * SECOND argument. `app/api/copilot/sessions/[id]/trace/route.ts:44` is the live
 * instance — `c.item(id, id).read()`, where both arguments are the caller's URL
 * segment and the container carries no tenant partition at all.
 *
 * A `.query(` with no partition-key option is also a cross-partition read; it is
 * recorded at the same kind, since both cross the boundary the tenant cares about.
 */
function findCosmosReads(blanked: string): SinkHit[] {
  const hits: SinkHit[] = [];

  for (const call of findMemberCalls(blanked, 'item')) {
    // Only count it as a READ when `.read(` actually follows the item handle.
    // The window is generous because the read is routinely generic:
    // `.read<{ steps?: unknown[]; prompt?: string }>()`.
    const tail = blanked.slice(call.end, call.end + 200);
    if (!/^\s*\.\s*read\s*(?:<|\()/.test(tail)) continue;
    hits.push({
      kind: 'cosmos-cross-partition-read',
      line: call.line,
      argsText: call.argsText,
      via: '.item(id, pk).read()',
    });
  }

  for (const call of findMemberCalls(blanked, 'query')) {
    hits.push({
      kind: 'cosmos-cross-partition-read',
      line: call.line,
      argsText: call.argsText,
      via: '.query()',
    });
  }

  return hits;
}

/** Distinct sink kinds, order-stable, for a facet's `privilegedSinkKinds`. */
export function distinctSinkKinds(hits: readonly SinkHit[]): PrivilegedSinkKind[] {
  const seen = new Set<PrivilegedSinkKind>();
  const out: PrivilegedSinkKind[] = [];
  for (const h of hits) {
    if (seen.has(h.kind)) continue;
    seen.add(h.kind);
    out.push(h.kind);
  }
  return out;
}

/** Verdict-symbol call sites present in a handler body. */
export function findVerdictCalls(blanked: string): CallSite[] {
  const out: CallSite[] = [];
  for (const symbol of VERDICT_SYMBOLS) out.push(...findCalls(blanked, symbol));
  return out.sort((a, b) => a.index - b.index);
}
