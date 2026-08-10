/**
 * A PARTITION-HONEST in-memory Cosmos container fake.
 *
 * Why this exists (fixtures-that-model-the-code, recorded incident class):
 * the pre-existing `decision.test.ts` fake was
 *
 *     item: (_id: string, _pk: string) => ({ read: async () => ({ resource: store.doc }) })
 *
 * — it IGNORED the partition key entirely and returned the single stored doc for
 * ANY (id, pk) pair. Combined with a fixture whose `tenantId` was set equal to
 * the APPROVER's oid, the suite could not observe the cross-user partition-key
 * defect even in principle. This fake models the two Cosmos behaviours that
 * defect actually depends on:
 *
 *   1. `container.item(id, pk).read()` resolves `{ resource: undefined }` when no
 *      document with that id lives in THAT partition (the Node SDK surfaces a
 *      point-read miss as an undefined resource, not a throw).
 *   2. `container.items.query()` evaluates the route's REAL SQL text against the
 *      REAL parameters, so a wrong partition-key parameter yields zero rows
 *      exactly as Cosmos would.
 *
 * FAIL-CLOSED: the tiny SQL evaluator THROWS on any construct it does not
 * understand. It must never return `[]` for a query it failed to parse — an
 * empty result is the very symptom under test, so a silently-unparsed query
 * would fabricate the defect (the "UNKNOWN reported as NEGATIVE" class). If a
 * new route query shape reaches this fake, the test fails loudly and the
 * evaluator gets extended.
 */

export interface FakeContainerOptions {
  /** Partition key path, e.g. '/tenantId'. */
  partitionKeyPath: string;
  /** Seed documents. */
  seed?: any[];
}

type Cond = (doc: any, params: Record<string, any>) => boolean;

const IDENT = String.raw`c\.([A-Za-z_][A-Za-z0-9_]*)`;

/** Parse ONE conjunct. Throws when the shape is unknown. */
function parseCondition(raw: string): Cond {
  const s = raw.trim();

  // c.field = @param
  let m = new RegExp(`^${IDENT}\\s*=\\s*@([A-Za-z_][A-Za-z0-9_]*)$`).exec(s);
  if (m) {
    const [, field, param] = m;
    return (doc, params) => {
      if (!(param in params)) {
        throw new Error(`[cosmos-fake] query references @${param} but no such parameter was supplied`);
      }
      return doc?.[field] === params[param];
    };
  }

  // c.field = "literal" | 'literal'
  m = new RegExp(`^${IDENT}\\s*=\\s*(?:"([^"]*)"|'([^']*)')$`).exec(s);
  if (m) {
    const field = m[1];
    const lit = m[2] !== undefined ? m[2] : m[3];
    return (doc) => doc?.[field] === lit;
  }

  // IS_DEFINED(c.field)
  m = new RegExp(`^IS_DEFINED\\(\\s*${IDENT}\\s*\\)$`).exec(s);
  if (m) {
    const field = m[1];
    return (doc) => doc?.[field] !== undefined && doc?.[field] !== null;
  }

  // (c.a = 'x' OR c.b = 'y') — a parenthesised OR of supported conjuncts.
  if (s.startsWith('(') && s.endsWith(')')) {
    const inner = s.slice(1, -1);
    if (/\sOR\s/i.test(inner)) {
      const parts = inner.split(/\s+OR\s+/i).map(parseCondition);
      return (doc, params) => parts.some((p) => p(doc, params));
    }
    return parseCondition(inner);
  }

  throw new Error(
    `[cosmos-fake] unsupported WHERE conjunct: ${JSON.stringify(s)}. ` +
      'Extend the evaluator — do NOT let this return an empty result set, ' +
      'because an empty result is the symptom under test.',
  );
}

interface ParsedQuery {
  top: number | null;
  projection: string[] | null; // null == SELECT *
  conds: Cond[];
  orderBy: { field: string; dir: 'ASC' | 'DESC' } | null;
}

function parseQuery(sql: string): ParsedQuery {
  const text = sql.replace(/\s+/g, ' ').trim();

  const head = /^SELECT\s+(TOP\s+(\d+)\s+)?(.+?)\s+FROM\s+c(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+))?$/i.exec(text);
  if (!head) throw new Error(`[cosmos-fake] unsupported query shape: ${JSON.stringify(sql)}`);

  const top = head[2] ? Number(head[2]) : null;
  const selectList = head[3].trim();
  const whereText = head[4]?.trim() || '';
  const orderText = head[5]?.trim() || '';

  let projection: string[] | null = null;
  if (selectList !== '*') {
    projection = selectList.split(',').map((p) => {
      const mm = new RegExp(`^${IDENT}$`).exec(p.trim());
      if (!mm) throw new Error(`[cosmos-fake] unsupported projection term: ${JSON.stringify(p)}`);
      return mm[1];
    });
  }

  const conds: Cond[] = [];
  if (whereText) {
    // Split on top-level AND only (no nesting beyond one paren group).
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    const tokens = whereText.split(/(\s+AND\s+)/i);
    for (const t of tokens) {
      if (/^\s+AND\s+$/i.test(t)) {
        if (depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += t;
        continue;
      }
      for (const ch of t) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      cur += t;
    }
    if (cur.trim()) parts.push(cur);
    for (const p of parts) conds.push(parseCondition(p));
  }

  let orderBy: ParsedQuery['orderBy'] = null;
  if (orderText) {
    const om = new RegExp(`^${IDENT}(?:\\s+(ASC|DESC))?$`, 'i').exec(orderText);
    if (!om) throw new Error(`[cosmos-fake] unsupported ORDER BY: ${JSON.stringify(orderText)}`);
    orderBy = { field: om[1], dir: (om[2] || 'ASC').toUpperCase() as 'ASC' | 'DESC' };
  }

  return { top, projection, conds, orderBy };
}

export interface FakeContainer {
  item(id: string, pk?: string): {
    read<T = any>(): Promise<{ resource: T | undefined }>;
    replace<T = any>(doc: T): Promise<{ resource: T }>;
    delete(): Promise<{ resource: any }>;
  };
  items: {
    create<T = any>(doc: T): Promise<{ resource: T }>;
    upsert<T = any>(doc: T): Promise<{ resource: T }>;
    query<T = any>(
      spec: { query: string; parameters?: { name: string; value: any }[] } | string,
      options?: { partitionKey?: string },
    ): { fetchAll(): Promise<{ resources: T[] }> };
  };
  /** Test-only: every stored doc, in insertion order. */
  __all(): any[];
  /** Test-only: docs in one partition. */
  __partition(pk: string): any[];
}

export function makePartitionedContainer(opts: FakeContainerOptions): FakeContainer {
  const pkField = opts.partitionKeyPath.replace(/^\//, '');
  const docs: any[] = [...(opts.seed || [])];

  const pkOf = (doc: any) => doc?.[pkField];

  return {
    item(id: string, pk?: string) {
      return {
        async read<T = any>(): Promise<{ resource: T | undefined }> {
          const found = docs.find((d) => d.id === id && (pk === undefined || pkOf(d) === pk));
          return { resource: found as T | undefined };
        },
        async replace<T = any>(next: T): Promise<{ resource: T }> {
          const i = docs.findIndex((d) => d.id === id && (pk === undefined || pkOf(d) === pk));
          if (i < 0) {
            const err: any = new Error('NotFound');
            err.code = 404;
            throw err;
          }
          docs[i] = next;
          return { resource: next };
        },
        async delete() {
          const i = docs.findIndex((d) => d.id === id && (pk === undefined || pkOf(d) === pk));
          if (i < 0) {
            const err: any = new Error('NotFound');
            err.code = 404;
            throw err;
          }
          const [gone] = docs.splice(i, 1);
          return { resource: gone };
        },
      };
    },
    items: {
      async create<T = any>(doc: T): Promise<{ resource: T }> {
        docs.push(doc);
        return { resource: doc };
      },
      async upsert<T = any>(doc: T): Promise<{ resource: T }> {
        const i = docs.findIndex((d) => d.id === (doc as any).id && pkOf(d) === pkOf(doc));
        if (i >= 0) docs[i] = doc;
        else docs.push(doc);
        return { resource: doc };
      },
      query<T = any>(
        spec: { query: string; parameters?: { name: string; value: any }[] } | string,
        options?: { partitionKey?: string },
      ) {
        const sql = typeof spec === 'string' ? spec : spec.query;
        const params: Record<string, any> = {};
        for (const p of (typeof spec === 'string' ? [] : spec.parameters) || []) {
          params[p.name.replace(/^@/, '')] = p.value;
        }
        // Parse EAGERLY so an unsupported shape throws at call time, never as an
        // empty result set.
        const q = parseQuery(sql);
        return {
          async fetchAll(): Promise<{ resources: T[] }> {
            let rows = docs;
            // Honour an explicit partition-key option the way Cosmos does:
            // the read is confined to that logical partition.
            if (options && Object.prototype.hasOwnProperty.call(options, 'partitionKey')) {
              rows = rows.filter((d) => pkOf(d) === options.partitionKey);
            }
            rows = rows.filter((d) => q.conds.every((c) => c(d, params)));
            if (q.orderBy) {
              const { field, dir } = q.orderBy;
              rows = [...rows].sort((a, b) => {
                const av = a?.[field];
                const bv = b?.[field];
                if (av === bv) return 0;
                const cmp = av > bv ? 1 : -1;
                return dir === 'DESC' ? -cmp : cmp;
              });
            }
            if (q.top !== null) rows = rows.slice(0, q.top);
            if (q.projection) {
              rows = rows.map((d) => {
                const out: any = {};
                for (const f of q.projection!) out[f] = d?.[f];
                return out;
              });
            }
            return { resources: rows as T[] };
          },
        };
      },
    },
    __all: () => [...docs],
    __partition: (pk: string) => docs.filter((d) => pkOf(d) === pk),
  };
}

/** A container that swallows writes — for audit/notification sinks under test. */
export function makeSinkContainer(): FakeContainer & { __writes: any[] } {
  const writes: any[] = [];
  const c = makePartitionedContainer({ partitionKeyPath: '/id' });
  const orig = c.items.create.bind(c.items);
  c.items.create = async (doc: any) => {
    writes.push(doc);
    return orig(doc);
  };
  return Object.assign(c, { __writes: writes });
}
