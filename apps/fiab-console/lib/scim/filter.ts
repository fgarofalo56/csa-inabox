/**
 * BR-SCIM — a small, dependency-free SCIM filter parser (RFC 7644 §3.4.2.2).
 *
 * Entra's user/group provisioning issues a narrow, well-known set of filters —
 * overwhelmingly `attr eq "value"` (e.g. `userName eq "alice@contoso.com"`,
 * `externalId eq "…"`, `displayName eq "Data Engineers"`). We support the
 * common comparison operators (eq/ne/co/sw/ew/pr/gt/ge/lt/le) against a single
 * attribute, plus `and`/`or` composition, which covers real IdP traffic without
 * pulling a parser dependency. Anything we cannot parse returns `null` so the
 * caller can fall back to "return all" rather than 500.
 *
 * Pure + fully unit-tested — no I/O.
 */

export type ScimComparator = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'pr' | 'gt' | 'ge' | 'lt' | 'le';

export interface ScimComparison {
  kind: 'compare';
  attribute: string;
  op: ScimComparator;
  value?: string;
}

export interface ScimLogical {
  kind: 'logical';
  op: 'and' | 'or';
  left: ScimFilter;
  right: ScimFilter;
}

export type ScimFilter = ScimComparison | ScimLogical;

const COMPARATORS = new Set<ScimComparator>(['eq', 'ne', 'co', 'sw', 'ew', 'pr', 'gt', 'ge', 'lt', 'le']);

/**
 * Parse a SCIM filter string into an evaluable tree, or null if unsupported /
 * empty. Handles `and`/`or` (left-associative, `and` binds tighter than `or`)
 * and a single level of parentheses is tolerated by stripping matched wrapping
 * parens.
 */
export function parseScimFilter(input: string | null | undefined): ScimFilter | null {
  if (!input || !input.trim()) return null;
  try {
    return parseOr(tokenize(input));
  } catch {
    return null;
  }
}

interface TokenStream {
  tokens: string[];
  pos: number;
}

function tokenize(input: string): TokenStream {
  const tokens: string[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push(ch); i++; continue; }
    if (ch === '"') {
      // quoted string — allow escaped quotes
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { val += s[j + 1]; j += 2; continue; }
        val += s[j]; j++;
      }
      if (j >= s.length) throw new Error('unterminated string');
      tokens.push('"' + val); // sentinel-prefixed literal
      i = j + 1;
      continue;
    }
    // bare word (attribute, operator, or logical keyword)
    let j = i;
    while (j < s.length && !' \t()'.includes(s[j])) j++;
    tokens.push(s.slice(i, j));
    i = j;
  }
  return { tokens, pos: 0 };
}

function peek(ts: TokenStream): string | undefined {
  return ts.tokens[ts.pos];
}
function next(ts: TokenStream): string | undefined {
  return ts.tokens[ts.pos++];
}

function parseOr(ts: TokenStream): ScimFilter {
  let left = parseAnd(ts);
  while (peek(ts)?.toLowerCase() === 'or') {
    next(ts);
    const right = parseAnd(ts);
    left = { kind: 'logical', op: 'or', left, right };
  }
  return left;
}

function parseAnd(ts: TokenStream): ScimFilter {
  let left = parsePrimary(ts);
  while (peek(ts)?.toLowerCase() === 'and') {
    next(ts);
    const right = parsePrimary(ts);
    left = { kind: 'logical', op: 'and', left, right };
  }
  return left;
}

function parsePrimary(ts: TokenStream): ScimFilter {
  const t = peek(ts);
  if (t === '(') {
    next(ts);
    const inner = parseOr(ts);
    if (next(ts) !== ')') throw new Error('missing )');
    return inner;
  }
  return parseComparison(ts);
}

function parseComparison(ts: TokenStream): ScimComparison {
  const attribute = next(ts);
  if (!attribute || attribute.startsWith('"')) throw new Error('expected attribute');
  const opTok = next(ts)?.toLowerCase() as ScimComparator | undefined;
  if (!opTok || !COMPARATORS.has(opTok)) throw new Error('expected comparator');
  if (opTok === 'pr') {
    return { kind: 'compare', attribute, op: 'pr' };
  }
  const valTok = next(ts);
  if (valTok === undefined) throw new Error('expected value');
  const value = valTok.startsWith('"') ? valTok.slice(1) : valTok;
  return { kind: 'compare', attribute, op: opTok, value };
}

/**
 * Read an attribute off a resource for filter evaluation. SCIM attribute names
 * are case-insensitive; we support the handful IdPs actually filter on.
 */
function readAttr(resource: Record<string, unknown>, attribute: string): string | undefined {
  const a = attribute.toLowerCase();
  const direct = resource[attribute] ?? resource[a];
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'boolean' || typeof direct === 'number') return String(direct);
  return undefined;
}

/** Evaluate a parsed filter against a plain resource object. */
export function evaluateScimFilter(filter: ScimFilter, resource: Record<string, unknown>): boolean {
  if (filter.kind === 'logical') {
    const l = evaluateScimFilter(filter.left, resource);
    const r = evaluateScimFilter(filter.right, resource);
    return filter.op === 'and' ? l && r : l || r;
  }
  const actual = readAttr(resource, filter.attribute);
  if (filter.op === 'pr') return actual !== undefined && actual !== '';
  if (actual === undefined) return false;
  const a = actual.toLowerCase();
  const b = (filter.value ?? '').toLowerCase();
  switch (filter.op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'co': return a.includes(b);
    case 'sw': return a.startsWith(b);
    case 'ew': return a.endsWith(b);
    case 'gt': return a > b;
    case 'ge': return a >= b;
    case 'lt': return a < b;
    case 'le': return a <= b;
    default: return false;
  }
}
