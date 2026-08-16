#!/usr/bin/env node
/**
 * GHSA-v2g8-gp3r-rg4r — MUTATION RECEIPTS for the advisory's route guards.
 *
 * WHY THIS IS COMMITTED RATHER THAN PASTED INTO A PR BODY. Independent review of
 * #3624 made the point and it is correct: a mutation table in prose is an
 * unreproducible assertion. The 21-row RED table was the ONLY evidence that the
 * suites added for this advisory are real controls rather than shape assertions,
 * and "the author says their control detected its own blind spot" is precisely
 * the claim that needs an artifact. So the harness lives here, runs on demand,
 * and prints verdicts anyone can reproduce.
 *
 * WHAT IT DOES. For each mutation: apply an EXACT string replacement to a real
 * source file, run the WHOLE named test file(s), record the real exit code, then
 * restore the file byte-for-byte from the pre-mutation buffer. A mutation that
 * turns its suite RED is a control that works; one that stays GREEN is a test
 * that proves nothing.
 *
 * THREE VERDICTS, NOT TWO — and the third is the one that matters.
 *
 *   RED      the suite failed. The control is real.
 *   GREEN    the suite passed WITH the mutation live. The test is decoration.
 *   SKIPPED  the `find` string was not present, so nothing was mutated.
 *
 * SKIPPED is reported as its own state and NEVER as a pass. That distinction is
 * not theoretical: on the first run of this harness **13 of 21 mutations came
 * back SKIPPED**, because this checkout is CRLF and the multi-line `find`
 * strings are LF. Had "did not apply" been scored as "the test survived it", the
 * receipt table would have been fiction — 13 rows of evidence for mutations that
 * never happened. The fix is the LF normalisation below; the disclosure is this
 * paragraph, and the guarantee is {@link CONTROL_MUTATION}.
 *
 * SELF-TESTING. Every mutation declares the verdict it EXPECTS. The harness
 * fails when any verdict differs — including {@link CONTROL_MUTATION}, a
 * deliberately unmatchable `find` that MUST come back SKIPPED. That control is
 * what proves the three-state distinction is live in this run rather than merely
 * described in this comment.
 *
 * NO `-t` FILTERS ANYWHERE. A regex metacharacter in a test name silently
 * matches nothing and exits 0 with the mutation live — the same class of
 * false-green this whole advisory is about. Whole files only.
 *
 * MUTATIONS DELETE A CONTROL, they never substitute an equal value. #3614's M1
 * was inert exactly that way: it swapped the scoped database for the requested
 * one on a path where the two were already equal, so it stayed green and looked
 * like proof.
 *
 * Usage (from anywhere in the repo):
 *   node scripts/ci/ghsa-v2g8-mutation-receipts.mjs           # all
 *   node scripts/ci/ghsa-v2g8-mutation-receipts.mjs S2 G1     # a subset
 *
 * Not wired into the default CI lane: it rewrites source files while running, so
 * it must never race another job in the same checkout. Run it on demand, and on
 * any PR that changes these routes or their guards.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

const SYN = 'app/api/items/warehouse/[id]/__tests__/ghsa-synapse-shared-pool.test.ts';
const DIS = 'app/api/items/[type]/[id]/__tests__/ghsa-shared-backend-dispatchers.test.ts';
const EH = 'app/api/items/eventhouse/[id]/__tests__/ghsa-eventhouse-get-scope.test.ts';
const UNIT = 'app/api/items/_lib/__tests__/synapse-item-scope.test.ts';

const GUARD_RETURN = 'if (guard.res) return guard.res;';

/**
 * The did-not-apply control. Its `find` cannot match any source in the repo, so
 * it MUST report SKIPPED. If it ever reports RED or GREEN the harness is
 * mutating something it did not intend to, and every other row is suspect.
 */
const CONTROL_MUTATION = {
  id: 'C0',
  desc: 'CONTROL — a find string that cannot match; MUST report SKIPPED, never a pass',
  file: 'app/api/items/_lib/synapse-item-scope.ts',
  find: '/* THIS STRING DOES NOT EXIST IN ANY SOURCE FILE — ghsa-v2g8 harness control */',
  replace: '/* unreachable */',
  suites: [UNIT],
  expect: 'SKIPPED',
};

/**
 * The INERT control. It applies cleanly and changes NOTHING a test could observe
 * (a comment), so it MUST report GREEN.
 *
 * Why a deliberately-surviving mutation is committed: without it, a run showing
 * only RED and SKIPPED rows does not demonstrate that this harness can DETECT a
 * survivor — the failure mode that matters most, because a surviving mutation
 * means the test is decoration. #3614's M1 was exactly that (an "equal value"
 * substitution that could not change behaviour on any admitted path) and it was
 * reported as a receipt until a reviewer reproduced it. C1 makes all three
 * verdicts exercised on every run, so the third column is never theoretical.
 */
const INERT_CONTROL = {
  id: 'C1',
  desc: 'CONTROL — an INERT mutation (comment only); MUST report GREEN, proving survivors are detected',
  file: 'app/api/items/_lib/synapse-item-scope.ts',
  find: "/** The single trusted construction point for {@link SynapseScopedDatabase}. */",
  replace: "/** (inert harness control: this comment was rewritten and nothing observable changed) */",
  suites: [UNIT],
  expect: 'GREEN',
};

/** @type {{id:string,desc:string,file:string,find:string,replace:string,suites:string[],expect:string}[]} */
const MUTATIONS = [
  CONTROL_MUTATION,
  INERT_CONTROL,

  // ── Synapse shared pool ──────────────────────────────────────────────────
  {
    id: 'S1', desc: 'warehouse/clone — DELETE the guard return (denial discarded)',
    file: 'app/api/items/warehouse/[id]/clone/route.ts',
    find: `${GUARD_RETURN}\n  const { session } = guard.ctx;`,
    replace: '  const { session } = guard.ctx!;',
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S2', desc: 'warehouse/query — DELETE the scope call, use body.database raw',
    file: 'app/api/items/warehouse/[id]/query/route.ts',
    find: `    const scopedDb = await scopeSynapseDatabase(item, body?.database);
    if (!scopedDb.ok) {
      return NextResponse.json({ ok: false, error: scopedDb.error }, { status: scopedDb.status });
    }`,
    replace: '    const scopedDb = { ok: true as const, database: String(body?.database || process.env.LOOM_SYNAPSE_DEDICATED_POOL || "") as any };',
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S3', desc: 'warehouse/query — downgrade the WRITE guard to allowReadRoles',
    file: 'app/api/items/warehouse/[id]/query/route.ts',
    find: `    notFound: WAREHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { session, item } = guard.ctx;`,
    replace: `    notFound: WAREHOUSE_NOT_FOUND,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { session, item } = guard.ctx;`,
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S4', desc: 'warehouse/schema — DELETE the picker narrowing (cluster-wide list returns)',
    file: 'app/api/items/warehouse/[id]/schema/route.ts',
    find: '      databases = dbs.rows.map((r) => String(r[0])).filter((n) => scope.has(n));',
    replace: '      void scope; databases = dbs.rows.map((r) => String(r[0]));',
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S5', desc: 'dedicated-pool/query — DELETE the scope call (sibling URL as the way round)',
    file: 'app/api/items/synapse-dedicated-sql-pool/[id]/query/route.ts',
    find: `    const scopedDb = await scopeSynapseDatabase(item, body?.database);
    if (!scopedDb.ok) {
      return NextResponse.json({ ok: false, error: scopedDb.error }, { status: scopedDb.status });
    }`,
    replace: '    const scopedDb = { ok: true as const, database: String(body?.database || process.env.LOOM_SYNAPSE_DEDICATED_POOL || "") as any }; void item;',
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S6', desc: 'copy-into POST — call the guard and DISCARD its answer entirely',
    file: 'app/api/items/warehouse/[id]/copy-into/route.ts',
    find: `    notFound: WAREHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;`,
    replace: `    notFound: WAREHOUSE_NOT_FOUND,
  });
  const session = { claims: { upn: 'x' } } as any; void guard;`,
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S7', desc: 'warehouse/script-out — DELETE the guard return',
    file: 'app/api/items/warehouse/[id]/script-out/route.ts',
    find: `    allowReadRoles: true,
  });
  if (guard.res) return guard.res;`,
    replace: `    allowReadRoles: true,
  });
  void guard;`,
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'S8', desc: 'dedicated-pool/clone — DELETE the guard return',
    file: 'app/api/items/synapse-dedicated-sql-pool/[id]/clone/route.ts',
    find: `${GUARD_RETURN}\n  const { session } = guard.ctx;`,
    replace: '  const { session } = guard.ctx!;',
    suites: [SYN], expect: 'RED',
  },

  // ── The outer error envelopes (BLOCKER 1 from review of #3624) ───────────
  {
    id: 'W1', desc: 'warehouse/query — REMOVE the outer envelope (dedicatedTarget throw escapes as HTML 500)',
    file: 'app/api/items/warehouse/[id]/query/route.ts',
    find: `  } catch (e) {
    return apiServerError(e);
  }
}`,
    replace: `  } catch (e) {
    throw e;
  }
}`,
    suites: [SYN], expect: 'RED',
  },
  {
    id: 'W2', desc: 'dedicated-pool/query — REMOVE the outer envelope',
    file: 'app/api/items/synapse-dedicated-sql-pool/[id]/query/route.ts',
    find: `  } catch (e) {
    return apiServerError(e);
  }
}`,
    replace: `  } catch (e) {
    throw e;
  }
}`,
    suites: [SYN], expect: 'RED',
  },

  // ── Shared-backend dispatchers ───────────────────────────────────────────
  {
    id: 'D1', desc: 'ctas — DELETE the guard return',
    file: 'app/api/items/databricks-sql-warehouse/[id]/ctas/route.ts',
    find: `${GUARD_RETURN}\n  const { session } = guard.ctx;`,
    replace: '  const { session } = guard.ctx!;',
    suites: [DIS], expect: 'RED',
  },
  {
    id: 'D2', desc: 'ctas — run the CONFIG GATE before the guard (denial disclosed as a 503 naming LOOM_*)',
    file: 'app/api/items/databricks-sql-warehouse/[id]/ctas/route.ts',
    find: `  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'databricks-sql-warehouse',
    notFound: WAREHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: \`Databricks not configured: \${gate.missing}\`, code: 'not_configured' },
      { status: 503 },
    );
  }`,
    replace: `  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: \`Databricks not configured: \${gate.missing}\`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'databricks-sql-warehouse',
    notFound: WAREHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;`,
    suites: [DIS], expect: 'RED',
  },
  {
    id: 'D3', desc: 'optimize — DELETE the guard return',
    file: 'app/api/items/[type]/[id]/optimize/route.ts',
    find: `${GUARD_RETURN}\n  const { session } = guard.ctx;`,
    replace: '  const { session } = guard.ctx!;',
    suites: [DIS], expect: 'RED',
  },
  {
    id: 'D4', desc: 'statistics POST — downgrade the WRITE guard to allowReadRoles',
    file: 'app/api/items/[type]/[id]/statistics/route.ts',
    find: `    itemType: type,
    notFound: 'item not found',
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;`,
    replace: `    itemType: type,
    notFound: 'item not found',
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;`,
    suites: [DIS], expect: 'RED',
  },
  {
    id: 'D5', desc: 'refresh-policy PUT — DELETE the guard return (TMSL Alter reachable)',
    file: 'app/api/items/semantic-model/[id]/refresh-policy/route.ts',
    find: `    notFound: MODEL_NOT_FOUND,
  });
  if (guard.res) return guard.res;

  const gate = backendGate();`,
    replace: `    notFound: MODEL_NOT_FOUND,
  });
  void guard;

  const gate = backendGate();`,
    suites: [DIS], expect: 'RED',
  },
  {
    id: 'D6', desc: 'refresh-policy GET — drop allowReadRoles (a Viewer is refused)',
    file: 'app/api/items/semantic-model/[id]/refresh-policy/route.ts',
    find: `    notFound: MODEL_NOT_FOUND,
    allowReadRoles: true,
  });`,
    replace: `    notFound: MODEL_NOT_FOUND,
  });`,
    suites: [DIS], expect: 'RED',
  },

  // ── The guard module itself ──────────────────────────────────────────────
  {
    id: 'G1', desc: 'guard — return a ctx for a MISSING item (fail open)',
    file: 'app/api/items/_lib/synapse-item-scope.ts',
    find: '      return { res: NextResponse.json({ ok: false, error: opts.notFound }, { status: 404 }) };',
    replace: '      return { ctx: { session, item: {} as WorkspaceItem, database: resolveItemSynapseDatabase(null) } };',
    suites: [UNIT, SYN, DIS], expect: 'RED',
  },
  {
    id: 'G2', desc: 'guard — REMOVE the fail-safe try/catch (Cosmos throw escapes as HTML 500)',
    file: 'app/api/items/_lib/synapse-item-scope.ts',
    find: `  } catch (e) {
    return { res: apiServerError(e) };
  }
}`,
    replace: `  } catch (e) {
    throw e;
  }
}`,
    suites: [UNIT], expect: 'RED',
  },
  {
    id: 'G3', desc: 'workspaceSynapseScope — WIDEN on a Cosmos failure instead of narrowing',
    file: 'app/api/items/_lib/synapse-item-scope.ts',
    find: `  } catch {
    /* fail closed — the item's own database only */
  }
  return scope;`,
    replace: `  } catch {
    scope.add('tenantB_dw');
  }
  return scope;`,
    suites: [UNIT, SYN], expect: 'RED',
  },
  {
    id: 'G4', desc: 'guard — resolve the database from the default, not from the item',
    file: 'app/api/items/_lib/synapse-item-scope.ts',
    find: '    return { ctx: { session, item, database: resolveItemSynapseDatabase(item) } };',
    replace: '    return { ctx: { session, item, database: resolveItemSynapseDatabase(null) } };',
    suites: [UNIT], expect: 'RED',
  },
  {
    id: 'N1', desc: 'resolveItemSynapseDatabase — resolve a NON-Synapse item to the Synapse pool instead of null',
    file: 'app/api/items/_lib/synapse-item-scope.ts',
    find: `  if (typeof itemType === 'string' && !SYNAPSE_BACKED_ITEM_TYPES.includes(itemType as SynapseBackedItemType)) {
    return null;
  }`,
    replace: '  void itemType;',
    suites: [UNIT], expect: 'RED',
  },

  // ── eventhouse GET ───────────────────────────────────────────────────────
  {
    id: 'E1', desc: 'eventhouse GET — DELETE the guard return',
    file: 'app/api/items/eventhouse/[id]/route.ts',
    find: `${GUARD_RETURN}\n  const { item } = guard.ctx;`,
    replace: '  const { item } = guard.ctx!;',
    suites: [EH], expect: 'RED',
  },
  {
    id: 'E2', desc: 'eventhouse GET — DELETE the workspace filter (cluster-wide list returns)',
    file: 'app/api/items/eventhouse/[id]/route.ts',
    find: '      databases: dbResult.v.filter((d) => scope.has(d.name)),',
    replace: '      databases: (void scope, dbResult.v),',
    suites: [EH], expect: 'RED',
  },
  {
    id: 'E3', desc: 'eventhouse GET — drop allowReadRoles (a Viewer cannot open the editor)',
    file: 'app/api/items/eventhouse/[id]/route.ts',
    find: `    // Read-only: this handler issues no ADX write, so any workspace role opens it.
    allowReadRoles: true,`,
    replace: '',
    suites: [EH], expect: 'RED',
  },

  // ── The RESIDUAL assertions must FAIL when the residual CLOSES ───────────
  {
    id: 'V1',
    desc: 'RESIDUAL control — narrow warehouse/schema to the item, proving the residual test is not decoration',
    file: 'app/api/items/warehouse/[id]/schema/route.ts',
    find: '      const [, tableName, schemaName, rowCount] = row as [string, string, string, number];',
    replace: `      const [, tableName, schemaName, rowCount] = row as [string, string, string, number];
      if (String(schemaName).startsWith('tenantB')) continue;`,
    suites: [SYN], expect: 'RED',
  },
];

const only = process.argv.slice(2);
const results = [];

for (const m of MUTATIONS) {
  if (only.length && !only.includes(m.id)) continue;
  const abs = path.join(CONSOLE_ROOT, m.file);
  const original = readFileSync(abs, 'utf8');
  // The checkout is CRLF on Windows; match and mutate against an LF-normalised
  // copy, and ALWAYS restore the byte-exact original afterwards. Without this
  // every multi-line `find` misses — which is the 13-of-21 SKIPPED run recorded
  // in this file's header.
  const lf = original.replace(/\r\n/g, '\n');

  if (!lf.includes(m.find)) {
    const ok = m.expect === 'SKIPPED';
    results.push({ id: m.id, verdict: 'SKIPPED', ok, line: '', desc: m.desc });
    console.log(`[${m.id}] SKIPPED — find string absent${ok ? ' (EXPECTED: this is the control)' : ' *** NOT EXPECTED ***'}  — ${m.desc}`);
    continue;
  }

  writeFileSync(abs, lf.replace(m.find, m.replace), 'utf8');
  let out = '';
  let code = -1;
  try {
    const r = spawnSync(
      process.platform === 'win32' ? 'node_modules\\.bin\\vitest.cmd' : 'node_modules/.bin/vitest',
      ['run', ...m.suites, '--reporter=dot'],
      { cwd: CONSOLE_ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    code = r.status;
    out = `${r.stdout || ''}${r.stderr || ''}`;
  } finally {
    writeFileSync(abs, original, 'utf8');
  }

  const line = (out.match(/Tests\s+.*$/m) || [''])[0].replace(/\[[0-9;]*m/g, '').trim();
  const verdict = code === 0 ? 'GREEN' : 'RED';
  const ok = verdict === m.expect;
  results.push({ id: m.id, verdict, ok, code, line, desc: m.desc });
  const note = ok
    ? (m.expect === 'GREEN' ? '  (EXPECTED: this is the inert control)' : '')
    : (verdict === 'GREEN'
      ? '  *** EXPECTED RED — MUTATION SURVIVED, the test is decoration ***'
      : `  *** EXPECTED ${m.expect} ***`);
  console.log(`[${m.id}] ${verdict} (exit ${code}) ${line}${note}  — ${m.desc}`);
}

const red = results.filter((r) => r.verdict === 'RED').length;
const green = results.filter((r) => r.verdict === 'GREEN').length;
const skipped = results.filter((r) => r.verdict === 'SKIPPED').length;
const bad = results.filter((r) => !r.ok);

console.log('\n=== SUMMARY ===');
console.log(`mutations: ${results.length}   RED: ${red}   GREEN(survived): ${green}   SKIPPED(not applied): ${skipped}`);
for (const r of results) console.log(`  ${r.id}\t${r.verdict}\t${r.ok ? 'as expected' : 'UNEXPECTED'}\t${r.line || ''}`);

if (bad.length) {
  console.error(`\n[ghsa-v2g8-mutations] FAIL — ${bad.length} mutation(s) did not match their expected verdict:`);
  for (const r of bad) console.error(`  ${r.id}: got ${r.verdict}, expected ${MUTATIONS.find((m) => m.id === r.id).expect}`);
  console.error('A GREEN row means the test cannot detect that defect. A SKIPPED row means nothing was measured.');
  process.exit(1);
}
console.log('\n[ghsa-v2g8-mutations] OK — every mutation produced its expected verdict, including the did-not-apply control.');
