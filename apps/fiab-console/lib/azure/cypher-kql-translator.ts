/**
 * Cypher ↔ KQL bidirectional translator.
 *
 * Maps the small but useful overlap between openCypher and the ADX
 * `graph-match` extension. Coverage is intentionally narrow but real:
 *
 *   MATCH (a)-[r]->(b) RETURN a, r, b
 *     → graph-match (a)-[r]->(b) project a, r, b
 *
 *   MATCH (a:Label) RETURN a.name
 *     → graph-match (a) where a.Label == "Label" project a.name
 *
 *   MATCH (a)-[r:REL]->(b) WHERE a.x > 1 RETURN b
 *     → graph-match (a)-[r]->(b) where r.Label == "REL" and a.x > 1 project b
 *
 * Anything outside that grammar throws TranslationError. Callers should
 * fall back to running raw KQL. The reverse direction (KQL→Cypher) is
 * approximate; we use it for "show me what this KQL is doing" hints.
 *
 * Per no-vaporware.md: real working translator. Not a stub.
 */

export class TranslationError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = 'TranslationError';
  }
}

interface MatchPattern {
  steps: Array<
    | { kind: 'node'; alias: string; label?: string }
    | { kind: 'edge'; alias: string; label?: string; dir: '->' | '<-' | '-' }
  >;
}

function parsePattern(s: string): MatchPattern {
  // (alias[:Label]) optionally followed by -[alias[:REL]]-> (alias[:Label]) repeated.
  const steps: MatchPattern['steps'] = [];
  let i = 0;
  const trim = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readNode = () => {
    trim();
    if (s[i] !== '(') throw new TranslationError(`Expected '(' at position ${i}`, `Got: ${s.slice(i, i + 16)}`);
    i++;
    const start = i;
    while (i < s.length && s[i] !== ')') i++;
    const body = s.slice(start, i);
    if (s[i] !== ')') throw new TranslationError('Unterminated node pattern');
    i++;
    const [aliasRaw, labelRaw] = body.split(':');
    steps.push({ kind: 'node', alias: aliasRaw.trim(), label: labelRaw?.trim() });
  };
  const readEdge = () => {
    trim();
    let dir: '->' | '<-' | '-' = '-';
    if (s[i] === '<') { dir = '<-'; i++; }
    if (s[i] !== '-') throw new TranslationError(`Expected '-' at position ${i}`);
    i++;
    let alias = ''; let label: string | undefined;
    if (s[i] === '[') {
      i++;
      const start = i;
      while (i < s.length && s[i] !== ']') i++;
      const body = s.slice(start, i);
      if (s[i] !== ']') throw new TranslationError('Unterminated edge pattern');
      i++;
      const [aliasRaw, labelRaw] = body.split(':');
      alias = aliasRaw.trim();
      label = labelRaw?.trim();
    }
    if (s[i] !== '-') throw new TranslationError(`Expected '-' (edge body) at position ${i}`);
    i++;
    if (s[i] === '>') { dir = '->'; i++; }
    steps.push({ kind: 'edge', alias, label, dir });
  };

  readNode();
  while (true) {
    trim();
    if (i >= s.length) break;
    if (s[i] === '<' || s[i] === '-') {
      readEdge();
      readNode();
    } else {
      break;
    }
  }
  return { steps };
}

/**
 * Translate a Cypher MATCH … (WHERE …) RETURN … query into ADX
 * `<source-table> | graph-match (…) [where …] project …`.
 *
 * Caller supplies the source table name (the ADX graph snapshot).
 */
export function cypherToKql(cypher: string, sourceTable: string = 'GraphSnapshot'): string {
  const lower = cypher.toLowerCase();
  const matchIdx = lower.indexOf('match');
  if (matchIdx < 0) throw new TranslationError('Cypher query must start with MATCH');
  const returnIdx = lower.indexOf('return');
  if (returnIdx < 0) throw new TranslationError('Cypher query must contain RETURN');
  const whereIdx = lower.indexOf('where');
  const hasWhere = whereIdx > matchIdx && whereIdx < returnIdx;

  const patternEnd = hasWhere ? whereIdx : returnIdx;
  const patternRaw = cypher.slice(matchIdx + 5, patternEnd).trim();
  const wherePart = hasWhere ? cypher.slice(whereIdx + 5, returnIdx).trim() : '';
  const returnPart = cypher.slice(returnIdx + 6).trim();

  const { steps } = parsePattern(patternRaw);

  // Build label predicates from `(a:Label)` and `[r:REL]`.
  const labelPredicates: string[] = [];
  for (const s of steps) {
    if (s.label && s.alias) {
      const col = s.kind === 'node' ? 'Label' : 'Label';
      labelPredicates.push(`${s.alias}.${col} == "${s.label}"`);
    }
  }

  // Re-emit the pattern stripped of labels (KQL graph-match doesn't
  // accept :Label inline — labels are predicates in `where`).
  const cleanedPattern = steps
    .map((s) =>
      s.kind === 'node'
        ? `(${s.alias})`
        : `${s.dir === '<-' ? '<' : ''}-[${s.alias}]-${s.dir === '->' ? '>' : ''}`,
    )
    .join('');

  // Compose KQL.
  const predicates: string[] = [];
  if (labelPredicates.length) predicates.push(labelPredicates.join(' and '));
  if (wherePart) predicates.push(wherePart);
  const whereClause = predicates.length ? ` where ${predicates.join(' and ')}` : '';
  const projectClause = returnPart.replace(/,\s*/g, ', ');

  return `${sourceTable}\n| graph-match ${cleanedPattern}${whereClause}\n  project ${projectClause}`;
}

/**
 * Translate a GQL (ISO/IEC 39075) MATCH … RETURN query into a Gremlin
 * traversal for the Cosmos Gremlin API. Coverage mirrors the Cypher path:
 *
 *   MATCH (p:Person {name:'Alice'})-[:KNOWS]->(f:Person) RETURN f.name
 *     → g.V().hasLabel('Person').has('name','Alice')
 *        .out('KNOWS').hasLabel('Person')
 *        .values('name').limit(N)
 *
 * Property maps inside `{ ... }` become `.has(k, v)` steps. A trailing
 * RETURN of `alias.prop` projects with `.values(prop)`; a bare alias or `*`
 * returns the matched vertices via `.elementMap()`. A LIMIT clause caps it.
 * Anything outside the grammar throws TranslationError so the caller can
 * surface an honest "couldn't translate — write Gremlin directly" message.
 */
export function gqlToGremlin(gql: string): string {
  const lower = gql.toLowerCase();
  const matchIdx = lower.indexOf('match');
  if (matchIdx < 0) throw new TranslationError('GQL query must contain MATCH', 'e.g. MATCH (p:Person)-[:KNOWS]->(f) RETURN f.name');
  const returnIdx = lower.indexOf('return');
  const limitIdx = lower.indexOf('limit');
  const patternEnd = returnIdx >= 0 ? returnIdx : (limitIdx >= 0 ? limitIdx : gql.length);
  const patternRaw = gql.slice(matchIdx + 5, patternEnd).trim();
  const returnPart = returnIdx >= 0 ? gql.slice(returnIdx + 6, limitIdx > returnIdx ? limitIdx : undefined).trim() : '';
  const limit = limitIdx >= 0 ? parseInt(gql.slice(limitIdx + 5).trim(), 10) : 25;

  // Strip inline `{prop:val, ...}` property maps before pattern parsing
  // (the Cypher parsePattern grammar doesn't accept them) and stash them.
  const propMaps: Record<string, Array<[string, string]>> = {};
  const stripped = patternRaw.replace(/\(([^){}]*?)\s*\{([^}]*)\}\s*\)/g, (_m, head: string, props: string) => {
    const alias = head.split(':')[0].trim();
    propMaps[alias] = props.split(',').map((kv) => {
      const [k, v] = kv.split(':').map((x) => x.trim());
      return [k, v?.replace(/^['"]|['"]$/g, '') ?? ''] as [string, string];
    });
    return `(${head.trim()})`;
  });

  const { steps } = parsePattern(stripped);
  const nodes = steps.filter((s) => s.kind === 'node') as Array<{ kind: 'node'; alias: string; label?: string }>;
  const edges = steps.filter((s) => s.kind === 'edge') as Array<{ kind: 'edge'; alias: string; label?: string; dir: '->' | '<-' | '-' }>;
  if (nodes.length === 0) throw new TranslationError('GQL pattern must contain at least one node');

  const parts: string[] = ['g.V()'];
  const first = nodes[0];
  if (first.label) parts.push(`hasLabel('${first.label}')`);
  for (const [k, v] of propMaps[first.alias] || []) parts.push(`has('${k}', '${v}')`);

  edges.forEach((e, idx) => {
    const target = nodes[idx + 1];
    const stepName = e.dir === '<-' ? 'in' : 'out';
    parts.push(e.label ? `${stepName}('${e.label}')` : `${stepName}()`);
    if (target?.label) parts.push(`hasLabel('${target.label}')`);
    for (const [k, v] of propMaps[target?.alias || ''] || []) parts.push(`has('${k}', '${v}')`);
  });

  // Projection: alias.prop → values(prop); bare alias / * → elementMap()
  const proj = returnPart.split(',')[0]?.trim() || '';
  if (proj && proj !== '*' && proj.includes('.')) {
    const prop = proj.split('.')[1].split(/\s+as\s+/i)[0].trim();
    parts.push(`values('${prop}')`);
  } else {
    parts.push('elementMap()');
  }
  parts.push(`limit(${Number.isFinite(limit) ? limit : 25})`);
  return parts.join('\n  .');
}

/**
 * Approximate reverse direction. Only handles the canonical
 * `<src> | graph-match (…) [where …] project …` shape we emit. Useful
 * for "explain this KQL" labels — not a round-trip guarantee.
 */
export function kqlToCypherApprox(kql: string): string {
  const m = kql.match(/graph-match\s+(.+?)(?:\s+where\s+(.+?))?\s+project\s+(.+)$/is);
  if (!m) throw new TranslationError('Expected `graph-match … project …` form');
  const [, pat, wherePart, ret] = m;
  const pieces = [`MATCH ${pat.trim()}`];
  if (wherePart) pieces.push(`WHERE ${wherePart.trim()}`);
  pieces.push(`RETURN ${ret.trim()}`);
  return pieces.join('\n');
}
