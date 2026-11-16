#!/usr/bin/env node
/**
 * seed-automation-feature-grant.mjs -- post-deploy bootstrap step (operator decision
 * 2026-11-16): idempotently SEED one feature-permission grant so the minted automation
 * identity used by loom-ui-verify holds `health.tenant-admin` Contributor.
 *
 * WHY A SEED, AND WHY tenantId = THE OID (not a tid)
 *   Grants live in the Cosmos `feature-permissions` container, partition key /tenantId, and
 *   are looked up by tenantScopeId(session) = claims.tid || claims.oid
 *   (apps/fiab-console/lib/auth/session.ts). The minted session carries NO tid
 *   (apps/fiab-console/lib/auth/uat.ts), so its scope is its own oid. A grant written from a
 *   real admin session (real tid) lands in the tid partition and is invisible to it
 *   (run 43800748474: 403 "No explicit grant of health.tenant-admin").
 *
 * DOC SHAPE is the one POST /api/admin/permissions/grants writes (FeatureGrant in
 * lib/auth/feature-gate.ts): id = `${capabilityId}::${principalType}::${principalId}` so a
 * later UI edit addresses the same doc. The route's SIEM emitAuditEvent runs inside the
 * console process and is not reachable from CI; this script instead records `grantedBy`
 * and prints one log line per run.
 *
 * AUTOMATION OID is read through scripts/ci/resolve-automation-oid.mjs (the same resolver
 * loom-ui-verify uses): LOOM_AUTOMATION_OID_OVERRIDE, else the console's LOOM_TENANT_ADMIN_OID.
 *
 * COSMOS ACCESS: AAD data-plane (az access token, no account keys) over the REST API, so no
 * npm install is needed and the host comes from LOOM_COSMOS_ENDPOINT (documents.azure.com or
 * documents.azure.us) -- identical code in every boundary. The deploy identity needs Cosmos
 * DB Built-in Data Contributor (same requirement as seed-governance.sh).
 *
 * Env: LOOM_COSMOS_ENDPOINT (required), LOOM_COSMOS_DATABASE (default loom),
 *      LOOM_AUTOMATION_OID_OVERRIDE, CONSOLE_RG, CONSOLE_APP, CONSOLE_SUBSCRIPTION.
 * Exit: 0 seeded|unchanged; 2 missing/unusable input; 1 any other failure.
 */
import { execFileSync } from 'node:child_process';
import { decide, readBinding, discoverResourceGroup } from '../ci/resolve-automation-oid.mjs';

export const CAPABILITY_ID = 'health.tenant-admin';
export const ROLE = 'Contributor';
export const PRINCIPAL_TYPE = 'user';
export const CONTAINER = 'feature-permissions';
export const GRANTED_BY = 'bootstrap:seed-automation-feature-grant';
const RANK = { Reader: 1, Contributor: 2, Admin: 3 };

export class SeedError extends Error {
  constructor(exit, message) { super(message); this.exit = exit; }
}

/** The grant doc, same fields and id scheme as app/api/admin/permissions/grants/route.ts. */
export function buildGrantDoc(oid, now = new Date()) {
  const id = `${CAPABILITY_ID}::${PRINCIPAL_TYPE}::${oid}`;
  return {
    id,
    tenantId: oid, // the minted session has no tid => tenantScopeId() === its own oid
    capabilityId: CAPABILITY_ID,
    principalId: oid,
    principalType: PRINCIPAL_TYPE,
    principalDisplayName: 'loom-ui-verify automation (seeded)',
    role: ROLE,
    grantedBy: GRANTED_BY,
    grantedAt: now.toISOString(),
  };
}

/** True when `existing` already gives the principal >= the wanted role in the right partition. */
export function isConverged(existing, want) {
  return !!existing
    && existing.tenantId === want.tenantId
    && existing.capabilityId === want.capabilityId
    && existing.principalId === want.principalId
    && existing.principalType === want.principalType
    && (RANK[existing.role] ?? 0) >= RANK[want.role];
}

export function resolveOid(env, readers = { discoverResourceGroup, readBinding }) {
  const app = (env.CONSOLE_APP || 'loom-console').trim();
  const sub = (env.CONSOLE_SUBSCRIPTION || '').trim();
  const subArgs = sub ? ['--subscription', sub] : [];
  let rg = (env.CONSOLE_RG || '').trim();
  let derived = { status: 'no-target' };
  if (!rg) {
    const f = readers.discoverResourceGroup(app, subArgs);
    if (f.status === 'resolved') rg = f.value; else derived = f;
  }
  if (rg) derived = readers.readBinding(app, rg, subArgs);
  const v = decide({ explicit: env.LOOM_AUTOMATION_OID_OVERRIDE, derived });
  if (!v.ok) throw new SeedError(2, `cannot resolve the automation oid (LOOM_AUTOMATION_OID_OVERRIDE unset or unusable and the console binding unreadable): ${v.error}`);
  return v.oid;
}

/** Cosmos AAD data-plane over REST. */
export function realCosmos(endpoint, db) {
  const host = new URL(endpoint);
  const token = () => execFileSync(process.env.AZ_BIN || 'az',
    ['account', 'get-access-token', '--resource', `${host.protocol}//${host.host}`, '--query', 'accessToken', '-o', 'tsv'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const call = async (method, path, pk, body, upsert) => {
    const res = await fetch(`${host.protocol}//${host.host}${path}`, {
      method,
      headers: {
        authorization: encodeURIComponent(`type=aad&ver=1.0&sig=${token()}`),
        'x-ms-date': new Date().toUTCString(),
        'x-ms-version': '2018-12-31',
        'x-ms-documentdb-partitionkey': JSON.stringify([pk]),
        ...(upsert ? { 'x-ms-documentdb-is-upsert': 'True' } : {}),
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, text: text.slice(0, 300) };
  };
  const base = `/dbs/${encodeURIComponent(db)}/colls/${CONTAINER}/docs`;
  return {
    async read(id, pk) {
      const r = await call('GET', `${base}/${encodeURIComponent(id)}`, pk);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new SeedError(1, `Cosmos read of ${id} returned HTTP ${r.status}: ${r.text}. 401/403 means the deploy identity lacks Cosmos DB Built-in Data Contributor on the account.`);
      return r.json;
    },
    async upsert(doc) {
      const r = await call('POST', base, doc.tenantId, doc, true);
      if (r.status !== 200 && r.status !== 201) throw new SeedError(1, `Cosmos upsert of ${doc.id} returned HTTP ${r.status}: ${r.text}`);
    },
  };
}

/** Pure orchestration; `cosmos` = {read(id,pk), upsert(doc)}. Returns {outcome, id}. */
export async function seed({ oid, cosmos, now = new Date(), log = console.log }) {
  const want = buildGrantDoc(oid, now);
  const existing = await cosmos.read(want.id, want.tenantId);
  if (isConverged(existing, want)) {
    log(`unchanged ${want.id} (role=${existing.role})`);
    return { outcome: 'unchanged', id: want.id };
  }
  await cosmos.upsert(want);
  const back = await cosmos.read(want.id, want.tenantId);
  if (!isConverged(back, want)) throw new SeedError(1, `upsert of ${want.id} did not read back as ${ROLE} in partition tenantId=${want.tenantId}; refusing to report seeded.`);
  log(`seeded ${want.id} (role=${back.role}, grantedBy=${GRANTED_BY})`);
  return { outcome: 'seeded', id: want.id };
}

export async function main(env = process.env, io = {}) {
  try {
    const endpoint = (env.LOOM_COSMOS_ENDPOINT || '').trim();
    if (!endpoint) throw new SeedError(2, 'LOOM_COSMOS_ENDPOINT is not set: no Cosmos account was resolved, so the grant cannot be written. Nothing was changed.');
    const oid = (io.resolveOid ?? resolveOid)(env);
    console.log(`::add-mask::${oid}`);
    const cosmos = io.cosmos ?? realCosmos(endpoint, env.LOOM_COSMOS_DATABASE || 'loom');
    await seed({ oid, cosmos });
    return 0;
  } catch (e) {
    console.error(`::error::seed-automation-feature-grant FAILED: ${e.message}`);
    return e instanceof SeedError ? e.exit : 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed-automation-feature-grant.mjs')) {
  process.exit(await main());
}
