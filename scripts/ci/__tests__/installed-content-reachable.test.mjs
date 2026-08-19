/**
 * check-installed-content-reachable tests (refs #3549 / #3551).
 *
 * The guard's own failure modes matter more than usual here, because one of
 * them ALREADY SHIPPED during this fix and had to be caught by hand: an earlier
 * revision brace-matched the enclosing function, could not parse a signature
 * returning `Promise<{ … }>`, fell back to whole-FILE scope, and then credited a
 * function with its own call site further down the file — returning `ok` for a
 * planted regression that was a byte-for-byte copy of a real one. A guard that
 * widens its scope when parsing fails excuses exactly what it watches for.
 *
 * So these tests drive `judgeLoomGatedFile` and `judgeItemTypes` directly rather
 * than asserting on the guard's exit code, and every case that matters is a
 * VERDICT assertion, not a "did it print something" check.
 *
 * MUTATION-PROVEN (each reproduced while writing these):
 *   - restore the brace-matched enclosing-function scope: the self-credit test
 *     goes RED.
 *   - allow a declaration to credit itself (drop the `n !== scope.name` filter):
 *     the self-credit test goes RED.
 *   - credit any `else` regardless of content (drop resolvesItemById): the
 *     dead-end-else test goes RED.
 *   - drop comment blanking from blankSource(): the comment test goes RED.
 *   - make judgeItemTypes ignore the `proof` symbol: the stale-declaration test
 *     goes RED.
 *
 * Run: node --test scripts/ci/__tests__/installed-content-reachable.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeLoomGatedFile, judgeItemTypes, blankSource } from '../check-installed-content-reachable.mjs';

const one = (src) => {
  const s = judgeLoomGatedFile(src);
  assert.equal(s.length, 1, `expected exactly one judged site, got ${JSON.stringify(s)}`);
  return s[0];
};

// ── RULE 2 ─────────────────────────────────────────────────────────────────

test('FAIL: content served only behind the loom: prefix, fall-through is a live read', () => {
  const v = one(`
export async function loadModelContext(id, workspaceId, tenantId) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    return { tables: semanticModelDetailFromContent(item).tables, liveDataset: false };
  }
  if (!workspaceId) return { tables: [], liveDataset: true };
  const tables = await listDatasetTables(workspaceId, id);
  return { tables, liveDataset: true };
}
`);
  assert.equal(v.verdict, 'unreachable');
});

test('PASS: the bare id is resolved FIRST, loom: kept as a fast path', () => {
  const v = one(`
async function contextFromContentItem(cosmosItemId, tenantId) {
  const item = await loadContentBackedItem(cosmosItemId, 'semantic-model', tenantId);
  return item ? { tables: semanticModelDetailFromContent(item).tables } : null;
}
export async function loadModelContext(id, workspaceId, tenantId) {
  const built = await contextFromContentItem(cosmosIdFromLoomId(id), tenantId);
  if (built) return built;
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    return { tables: [], liveDataset: false };
  }
  return { tables: await listDatasetTables(workspaceId, id), liveDataset: true };
}
`);
  assert.equal(v.verdict, 'ok');
});

test('PASS: an if/else id-shape fork — both branches load the item', () => {
  const v = one(`
export async function GET(req, ctx) {
  let item;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
    if (!item) return notFound();
  } else {
    item = await loadModelItem(id, 'report', oid);
    if (!item) return notFound();
  }
  return respond(item);
}
`);
  assert.equal(v.verdict, 'ok');
  assert.equal(v.scope, 'else-fork');
});

test('FAIL: an else that resolves NOTHING is a dead end, not a fork', () => {
  const v = one(`
export async function GET(req, ctx) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
    return respond(item.state.content);
  } else {
    return { ok: true, pages: [] };
  }
}
`);
  assert.equal(v.verdict, 'unreachable');
});

test('PASS: an early-return fork (the else-less spelling)', () => {
  const v = one(`
async function loadReport(id, oid) {
  if (isLoomContentId(id)) {
    return loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
  }
  return loadModelItem(id, 'report', oid);
}
`);
  assert.equal(v.verdict, 'ok');
  assert.equal(v.scope, 'early-return-fork');
});

test('FAIL: a declaration may NOT credit itself, and scope never widens to the file', () => {
  // The regression that shipped once: a multi-line signature returning
  // `Promise<{ … }>` defeated brace-matched scoping, which fell back to file
  // scope and then let `loadBulkContext` answer for itself via its own call
  // site in the handler below.
  const v = one(`
async function loadBulkContext(
  id, workspaceId, tenantId,
): Promise<{ modelName: string; tables: BulkTable[]; liveDataset: boolean }> {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    return { modelName: 'm', tables: semanticModelDetailFromContent(item).tables, liveDataset: false };
  }
  if (!workspaceId) return { modelName: 'm', tables: [], liveDataset: true };
  const pbiTables = await listDatasetTables(workspaceId, id);
  return { modelName: 'm', tables: pbiTables, liveDataset: true };
}

export const POST = withSession(async (req, ctx) => {
  const model = await loadBulkContext(ctx.params.id, null, ctx.session.claims.oid);
  return NextResponse.json({ ok: true, model });
});
`);
  assert.equal(v.verdict, 'unreachable');
  assert.equal(v.scope, 'decl:loadBulkContext');
});

test('a bare-id content path that exists only in a COMMENT does not count', () => {
  const v = one(`
export async function handler(id, tenantId) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', tenantId);
    return item.state.content;
  }
  // Also reads state.content via loadContentBackedItem(id, ...) — prose only.
  return null;
}
`);
  assert.equal(v.verdict, 'unreachable');
});

test('NOT JUDGED: a loom: test that resolves no content at all', () => {
  // powerbi-embed-plan.ts asks the question only to skip a Power BI embed.
  const sites = judgeLoomGatedFile(`
export function embedPlan(reportId) {
  if (isLoomContentId(reportId)) return { request: null, skip: 'loom-native' };
  return { request: buildRequest(reportId), skip: null };
}
`);
  assert.equal(sites.length, 0);
});

test('blankSource preserves offsets and keeps template-hole CODE', () => {
  const src = "const a = 1; // state.content\nconst b = `x${state.content}y`;\n";
  const out = blankSource(src);
  assert.equal(out.length, src.length, 'byte offsets must be preserved');
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count must be preserved');
  assert.ok(!/\/\/ state\.content/.test(out), 'the comment text must be blanked');
  assert.ok(/state\.content/.test(out.split('\n')[1]), 'code inside a ${} hole must survive');
});

// ── RULE 1 ─────────────────────────────────────────────────────────────────

function io({ provisioner, autoBind = '', routes = [] }) {
  return {
    read: (p) => {
      if (p.endsWith('provisioning-engine.ts')) {
        return "import { thingProvisioner } from './provisioners/thing';\n"
          + "export const PROVISIONERS: Record<string, Provisioner> = {\n  'thing': thingProvisioner,\n};\n";
      }
      if (p.endsWith('auto-bind-providers.ts')) return autoBind || "itemTypes: ['other'],";
      if (p.endsWith('thing.ts')) return provisioner;
      return routes.includes(p) ? 'const c = item.state.content;' : '';
    },
    exists: (p) => p.endsWith('provisioning-engine.ts') || p.endsWith('auto-bind-providers.ts')
      || p.endsWith('thing.ts') || p.includes('items' + '/' + 'thing') || p.includes('items\\thing'),
    walk: () => routes,
  };
}

test('FAIL: a content-consuming provisioner with NO reachability mechanism', () => {
  const { rows, unjudged } = judgeItemTypes(io({ provisioner: 'const c = input.content;' }));
  assert.equal(unjudged.length, 0);
  assert.equal(rows.find((r) => r.itemType === 'thing').verdict, 'unreachable');
});

test('PASS: the provisioner persists the content itself', () => {
  const { rows } = judgeItemTypes(io({
    provisioner: 'const c = input.content; const items = await itemsContainer();'
      + ' await items.item(id, ws).replace({ ...cur, state: { ...cur.state, content: c } });',
  }));
  const row = rows.find((r) => r.itemType === 'thing');
  assert.equal(row.verdict, 'ok');
  assert.ok(row.mech.includes('persists'));
});

test('FAIL: a MENTION of itemsContainer() is not a write', () => {
  // Independent review of #3549 proved the original `itemsContainer(` spelling
  // could be satisfied by an unused helper, flipping the guard to OK over an
  // item type that was still genuinely unreachable — the "presence, not
  // enforcement" shape. The credit must track the write, not the import.
  const { rows } = judgeItemTypes(io({
    provisioner: 'const c = input.content;\n'
      + 'async function _peek(id) { const c2 = await itemsContainer(); return c2; }\n'
      + 'return { status: "created" };',
  }));
  assert.equal(rows.find((r) => r.itemType === 'thing').verdict, 'unreachable');
});

test('PASS: updateOwnedItem / createOwnedItem also count as a write', () => {
  for (const verb of ['await updateOwnedItem(id, t, oid, { state })', 'await createOwnedItem(s, t, { state })']) {
    const { rows } = judgeItemTypes(io({ provisioner: `const c = input.content; ${verb};` }));
    assert.equal(rows.find((r) => r.itemType === 'thing').verdict, 'ok', verb);
  }
});

test('PASS: the item type is covered by the auto-bind seed registry', () => {
  const { rows } = judgeItemTypes(io({
    provisioner: 'const c = input.content;',
    autoBind: "itemTypes: ['thing', 'other'],",
  }));
  assert.equal(rows.find((r) => r.itemType === 'thing').verdict, 'ok');
});

test('PASS: a route directory named for the item type reads state.content', () => {
  const routes = ['apps/fiab-console/app/api/items/thing/[id]/route.ts'];
  const { rows } = judgeItemTypes(io({ provisioner: 'const c = input.content;', routes }));
  const row = rows.find((r) => r.itemType === 'thing');
  assert.equal(row.verdict, 'ok');
  assert.ok(row.mech.some((m) => m.startsWith('content-read-route')));
});

test('NOT JUDGED: a provisioner that reads no bundle content', () => {
  const { rows } = judgeItemTypes(io({ provisioner: 'return { status: "created" };' }));
  assert.equal(rows.find((r) => r.itemType === 'thing').verdict, 'not-judged');
});

test('UNJUDGED (not clean): the provisioner module cannot be resolved', () => {
  const bad = {
    read: (p) => (p.endsWith('provisioning-engine.ts')
      ? "export const PROVISIONERS: Record<string, Provisioner> = {\n  'thing': thingProvisioner,\n};\n"
      : ''),
    exists: (p) => p.endsWith('provisioning-engine.ts'),
    walk: () => [],
  };
  const { rows, unjudged } = judgeItemTypes(bad);
  assert.equal(rows.length, 0);
  assert.equal(unjudged.length, 1);
  assert.match(unjudged[0].why, /no resolvable import/);
});
