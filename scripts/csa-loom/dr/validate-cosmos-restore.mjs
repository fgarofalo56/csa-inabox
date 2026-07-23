#!/usr/bin/env node
// scripts/csa-loom/dr/validate-cosmos-restore.mjs — DR1 (loom-next-level WS-DR)
//
// Validates a completed Cosmos DB point-in-time restore (the deepened
// `cosmos-pitr-restore` scenario of .github/workflows/dr-drill.yml — formerly
// the `cosmos-failover` stub). Asserts REAL restored state on the scratch
// account(s) the drill created:
//
//   1. Admin-plane Loom store (`loom` database): every container restored,
//      per-container document counts >= configured floors, counts within a
//      tolerance band of a live-account snapshot (Azure Monitor DocumentCount
//      metric taken at drill start — the live account is PE-only so the metric
//      IS the reachable live signal from a hosted runner), and a sampled doc
//      per key container schema-probes clean.
//   2. Landing-zone vector account (`loom-vectors` / `docs-vec`) — the
//      graph/vector Cosmos pair was previously in NO drill's validation set
//      (SRE F15); its restored container is counted here.
//   3. Landing-zone Gremlin account — control-plane validation that the
//      restored account carries the `loom-graph` database + `default` graph
//      (data-plane gremlin traversal needs an in-VNet client; structure-level
//      restore proof is asserted here, noted in the runbook).
//
// Auth: az CLI login context. Data-plane uses an AAD token scoped to the
// restored account endpoint (the drill grants the SP Cosmos DB Built-in Data
// Contributor on the scratch accounts before invoking this).
//
// Env:
//   DRILL_ID, DRILL_CLOUD, DR_REPORT_DIR
//   ADMIN_ENDPOINT   (required) restored admin-store documentEndpoint
//   ADMIN_DB         (default `loom`)
//   SNAPSHOT_FILE    (optional) az monitor metrics JSON of live DocumentCount
//   FLOORS_JSON      (default {"loom-workspaces":1,"env-config":1})
//   TOLERANCE_PCT    (default 10)  TOLERANCE_ABS (default 25)
//   RESTORE_TS       (optional) restore timestamp used — recorded as RPO evidence
//   VECTOR_ENDPOINT  (optional) restored vector-account documentEndpoint
//   VECTOR_DB        (default `loom-vectors`)  VECTOR_CONTAINER (default `docs-vec`)
//   GREMLIN_ACCOUNT / GREMLIN_RG / GREMLIN_SUB (optional) restored gremlin account
//
// Exit 0 only when every check passes. Always writes the report JSON.

import {
  azJson, azToken, cosmosCount, cosmosGet, cosmosQuery, cosmosScope,
  drillEnv, makeReport,
} from './_drill-lib.mjs';
import { readFileSync } from 'node:fs';

const { drillId, cloud } = drillEnv();
const report = makeReport({ scenario: 'cosmos-pitr-restore', drillId, cloud });

const ADMIN_ENDPOINT = process.env.ADMIN_ENDPOINT;
const ADMIN_DB = process.env.ADMIN_DB || 'loom';
const FLOORS = JSON.parse(process.env.FLOORS_JSON || '{"loom-workspaces":1,"env-config":1}');
const TOL_PCT = Number(process.env.TOLERANCE_PCT || 10);
const TOL_ABS = Number(process.env.TOLERANCE_ABS || 25);

if (!ADMIN_ENDPOINT) {
  console.error('ADMIN_ENDPOINT is required (restored admin-store documentEndpoint)');
  process.exit(2);
}
if (process.env.RESTORE_TS) {
  report.rpo('restoreTimestamp', process.env.RESTORE_TS);
  report.rpo('restorePointAgeSecondsAtDrill',
    Math.round((Date.now() - Date.parse(process.env.RESTORE_TS.replace('+0000', 'Z'))) / 1000));
}

/** Parse the live-account DocumentCount metric snapshot → { collName: count }. */
function parseSnapshot(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const out = {};
  for (const metric of raw.value || []) {
    for (const series of metric.timeseries || []) {
      const dim = (series.metadatavalues || []).find(
        (m) => (m.name?.value || '').toLowerCase() === 'collectionname',
      );
      if (!dim) continue;
      const pts = (series.data || []).filter((d) => typeof d.total === 'number');
      if (pts.length) out[dim.value] = pts[pts.length - 1].total;
    }
  }
  return out;
}

const main = async () => {
  // ---- 1. Admin-plane Loom store ------------------------------------------
  const adminToken = azToken(cosmosScope(ADMIN_ENDPOINT));
  let colls = [];
  await report.check('admin: restored `loom` database lists containers', async () => {
    const body = await cosmosGet(ADMIN_ENDPOINT, adminToken, `dbs/${ADMIN_DB}/colls`);
    colls = (body.DocumentCollections || []).map((c) => c.id);
    if (colls.length === 0) throw new Error('restored database has ZERO containers');
    return `${colls.length} containers`;
  });

  const counts = {};
  for (const coll of colls) {
    // Count every restored container (real data-plane reads, cross-partition).
    await report.check(`admin: count ${coll}`, async () => {
      counts[coll] = await cosmosCount(ADMIN_ENDPOINT, adminToken, ADMIN_DB, coll);
      return `${counts[coll]} docs`;
    });
  }

  for (const [coll, floor] of Object.entries(FLOORS)) {
    await report.check(`admin: floor ${coll} >= ${floor}`, async () => {
      if (!(coll in counts)) throw new Error(`container ${coll} missing from restore`);
      if (counts[coll] < floor) throw new Error(`restored count ${counts[coll]} < floor ${floor}`);
      return `count ${counts[coll]}`;
    });
  }

  if (process.env.SNAPSHOT_FILE) {
    const snapshot = parseSnapshot(process.env.SNAPSHOT_FILE);
    const compared = Object.keys(snapshot).filter((c) => c in counts);
    await report.check('admin: restored counts within tolerance of live snapshot', async () => {
      if (compared.length === 0) return 'no per-collection metric datapoints — floors carry the assertion';
      const drifts = [];
      for (const coll of compared) {
        const live = snapshot[coll];
        const restored = counts[coll];
        const allowed = Math.max(TOL_ABS, (live * TOL_PCT) / 100);
        if (Math.abs(live - restored) > allowed) {
          drifts.push(`${coll}: live=${live} restored=${restored} (>±${Math.round(allowed)})`);
        }
      }
      if (drifts.length) throw new Error(`out of band: ${drifts.join('; ')}`);
      return `${compared.length} containers within ±max(${TOL_ABS}, ${TOL_PCT}%)`;
    });
  }

  // Schema probe: one sampled doc per key container must carry its identity
  // fields — proves restored documents deserialize, not just count.
  const schemaProbes = { 'loom-workspaces': ['id', 'tenantId'], 'env-config': ['id'] };
  for (const [coll, fields] of Object.entries(schemaProbes)) {
    if (!colls.includes(coll)) continue;
    await report.check(`admin: schema probe ${coll}`, async () => {
      const docs = await cosmosQuery(ADMIN_ENDPOINT, adminToken, ADMIN_DB, coll, 'SELECT TOP 1 * FROM c');
      if (docs.length === 0) throw new Error('no sampled doc (container empty)');
      const missing = fields.filter((f) => !(f in docs[0]));
      if (missing.length) throw new Error(`sampled doc missing fields: ${missing.join(',')}`);
      return `fields ${fields.join(',')} present (doc ${String(docs[0].id).slice(0, 24)})`;
    });
  }

  // ---- 2. Landing-zone vector account (SRE F15) ---------------------------
  if (process.env.VECTOR_ENDPOINT) {
    const vdb = process.env.VECTOR_DB || 'loom-vectors';
    const vcoll = process.env.VECTOR_CONTAINER || 'docs-vec';
    const vtoken = azToken(cosmosScope(process.env.VECTOR_ENDPOINT));
    await report.check(`vector: restored ${vdb}/${vcoll} readable`, async () => {
      const n = await cosmosCount(process.env.VECTOR_ENDPOINT, vtoken, vdb, vcoll);
      return `${n} docs`;
    });
  } else {
    console.log('  SKIP vector account (VECTOR_ENDPOINT unset — estate without cosmos-graph-vector)');
  }

  // ---- 3. Landing-zone Gremlin account (structure-level) ------------------
  if (process.env.GREMLIN_ACCOUNT) {
    const g = process.env.GREMLIN_ACCOUNT;
    const grg = process.env.GREMLIN_RG;
    const sub = process.env.GREMLIN_SUB;
    const subArgs = sub ? ['--subscription', sub] : [];
    await report.check('gremlin: restored loom-graph database present', async () => {
      const db = azJson(['cosmosdb', 'gremlin', 'database', 'show', '-a', g, '-g', grg, '-n', 'loom-graph', ...subArgs]);
      return `id=${db.id ? 'ok' : db.name}`;
    });
    await report.check('gremlin: restored default graph present', async () => {
      const graph = azJson(['cosmosdb', 'gremlin', 'graph', 'show', '-a', g, '-g', grg, '-d', 'loom-graph', '-n', 'default', ...subArgs]);
      return `partitionKey=${graph?.resource?.partitionKey?.paths?.join(',') || 'n/a'}`;
    });
  } else {
    console.log('  SKIP gremlin account (GREMLIN_ACCOUNT unset — estate without cosmos-graph-vector)');
  }
};

main()
  .catch((err) => {
    console.error(err);
    return report.check('validator crashed', async () => { throw err; });
  })
  .finally(() => {
    report.write();
    process.exit(report.ok ? 0 : 1);
  });
