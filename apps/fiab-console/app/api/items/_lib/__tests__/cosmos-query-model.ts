/**
 * #3669 — a Cosmos `items` container mock that EVALUATES the SQL it is handed.
 *
 * WHY. The earlier warehouse-binding mocks filtered on the `@id` / `@t`
 * PARAMETERS and ignored the query text, so deleting `AND c.itemType = @t` from
 * the production query changed nothing the tests could see — the mock still
 * applied the type filter on the code's behalf. This model applies ONLY the
 * predicates that are written in the query, so a dropped predicate is a dropped
 * filter here too.
 *
 * WHAT IT ACCEPTS — and it THROWS on anything else, so an unsupported query can
 * never be silently evaluated as "match everything":
 *
 *   SELECT * FROM c [WHERE <conj>]
 *   SELECT VALUE COUNT(1) FROM c [WHERE <conj>]
 *
 *   <conj>  := <term> (AND <term>)*
 *   <term>  := <atom> | ( <atom> (OR <atom>)* )
 *   <atom>  := c.<dotted.path> (= | !=) @param
 *
 * A path that is undefined on a document makes the atom false for BOTH `=` and
 * `!=`, which is Cosmos' behaviour (a comparison with an undefined operand is
 * undefined, and WHERE keeps only true rows). A `@param` the spec does not bind
 * throws.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */

export interface QueryParam {
  name: string;
  value: unknown;
}
export interface QuerySpec {
  query: string;
  parameters?: QueryParam[];
}

type Atom = { path: string[]; op: '=' | '!='; param: string };
/** One AND-term: an OR of atoms (a bare atom is an OR of one). */
type Term = Atom[];

const ATOM_RE = /^c\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(=|!=)\s*(@[A-Za-z_][A-Za-z0-9_]*)$/;
const HEAD_RE = /^SELECT\s+(\*|VALUE\s+COUNT\(1\))\s+FROM\s+c(?:\s+WHERE\s+([\s\S]+))?$/i;

function parseAtom(raw: string): Atom {
  const m = ATOM_RE.exec(raw.trim());
  if (!m) throw new Error(`cosmos-query-model: unsupported predicate ${JSON.stringify(raw.trim())}`);
  return { path: m[1].split('.'), op: m[2] as '=' | '!=', param: m[3] };
}

/** Split on a keyword at parenthesis depth 0 only. */
function splitTopLevel(s: string, keyword: 'AND' | 'OR'): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const re = new RegExp(`\\s${keyword}\\s`, 'iy');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) throw new Error('cosmos-query-model: unbalanced parentheses');
    } else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) {
        out.push(s.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  if (depth !== 0) throw new Error('cosmos-query-model: unbalanced parentheses');
  out.push(s.slice(start));
  return out.map((x) => x.trim());
}

export interface ParsedQuery {
  count: boolean;
  terms: Term[];
}

export function parseQuery(query: string): ParsedQuery {
  const m = HEAD_RE.exec(query.trim());
  if (!m) throw new Error(`cosmos-query-model: unsupported query ${JSON.stringify(query)}`);
  const count = m[1] !== '*';
  const where = (m[2] || '').trim();
  if (!where) return { count, terms: [] };
  const terms = splitTopLevel(where, 'AND').map((t): Term => {
    if (t.startsWith('(') && t.endsWith(')')) {
      return splitTopLevel(t.slice(1, -1), 'OR').map(parseAtom);
    }
    if (/\sOR\s/i.test(t)) throw new Error(`cosmos-query-model: OR must be parenthesised: ${t}`);
    return [parseAtom(t)];
  });
  return { count, terms };
}

function readPath(doc: unknown, path: string[]): unknown {
  let cur: unknown = doc;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function bind(spec: QuerySpec, name: string): unknown {
  const p = (spec.parameters || []).find((x) => x.name === name);
  if (!p) throw new Error(`cosmos-query-model: parameter ${name} is not bound`);
  return p.value;
}

function atomHolds(doc: unknown, a: Atom, spec: QuerySpec): boolean {
  const v = readPath(doc, a.path);
  if (v === undefined) return false;
  const want = bind(spec, a.param);
  return a.op === '=' ? v === want : v !== want;
}

/** Evaluate `spec` over `docs` the way Cosmos would for the accepted grammar. */
export function evaluateQuery(docs: ReadonlyArray<unknown>, spec: QuerySpec | string): unknown[] {
  const s: QuerySpec = typeof spec === 'string' ? { query: spec } : spec;
  const { count, terms } = parseQuery(s.query);
  // Bind every parameter up front, so an unbound one throws even on an empty container.
  for (const t of terms) for (const a of t) bind(s, a.param);
  const rows = docs.filter((d) => terms.every((t) => t.some((a) => atomHolds(d, a, s))));
  return count ? [rows.length] : rows.map((r) => structuredClone(r));
}

export interface ModelDoc {
  id: string;
  workspaceId?: string;
  _etag?: string;
  [k: string]: unknown;
}

export interface ItemsModel {
  /** Pass to the `itemsContainer` mock. */
  container: {
    items: { query: (spec: QuerySpec | string) => { fetchAll: () => Promise<{ resources: unknown[] }> } };
    item: (id: string, pk: string) => {
      read: () => Promise<{ resource: ModelDoc | undefined }>;
      replace: (body: ModelDoc, options?: { accessCondition?: { type: string; condition: string } }) => Promise<{ resource: ModelDoc }>;
    };
  };
  /** Every query spec seen, in order. */
  queries: QuerySpec[];
  /** Every successful replace, in order. */
  replaces: ModelDoc[];
  /** The live documents (mutated by `replace`). */
  docs: ModelDoc[];
}

export interface ItemsModelOptions {
  /** Throw this from `fetchAll` when it returns true for the spec. */
  failQuery?: (spec: QuerySpec) => boolean;
  /** Called after each `read`, before the caller can replace — simulate a concurrent writer here. */
  afterRead?: (doc: ModelDoc) => void;
}

let etagSeq = 0;
const nextEtag = () => `"etag-${++etagSeq}"`;

export function makeItemsModel(seed: ModelDoc[], opts: ItemsModelOptions = {}): ItemsModel {
  const docs: ModelDoc[] = seed.map((d) => ({ _etag: nextEtag(), ...structuredClone(d) }));
  const queries: QuerySpec[] = [];
  const replaces: ModelDoc[] = [];
  const find = (id: string, pk: string) => docs.find((d) => d.id === id && (d.workspaceId ?? '') === pk);
  const container: ItemsModel['container'] = {
    items: {
      query: (spec) => ({
        fetchAll: async () => {
          const s: QuerySpec = typeof spec === 'string' ? { query: spec } : spec;
          queries.push(s);
          if (opts.failQuery?.(s)) throw new Error('cosmos unavailable');
          return { resources: evaluateQuery(docs, s) };
        },
      }),
    },
    item: (id, pk) => ({
      read: async () => {
        const d = find(id, pk);
        if (!d) return { resource: undefined };
        const copy = structuredClone(d);
        opts.afterRead?.(d);
        return { resource: copy };
      },
      replace: async (body, options) => {
        const d = find(id, pk);
        if (!d) throw Object.assign(new Error('not found'), { code: 404 });
        const ac = options?.accessCondition;
        if (ac?.type === 'IfMatch' && ac.condition !== d._etag) {
          throw Object.assign(new Error('precondition failed'), { code: 412 });
        }
        const next = { ...structuredClone(body), _etag: nextEtag() };
        docs[docs.indexOf(d)] = next;
        replaces.push(structuredClone(next));
        return { resource: next };
      },
    }),
  };
  return { container, queries, replaces, docs };
}
