#!/usr/bin/env node
/**
 * LHDS edge probe (W1-6 / #5149): the live proof that the APIM `lhds-tenant-routing`
 * fragment (a) refuses tenant A's path with tenant B's token (403) and (b) enforces the
 * per-tenant quota with 429 + Retry-After. Until this has been run against a deployed
 * gateway, both behaviours are MODELLED only (apps/loom-health-cp/test/routing-edge.test.ts).
 *
 * Operator-run, read-only against the gateway (GET only). Tokens come from the
 * environment and are never printed or written.
 *
 *   LHDS_EDGE_BASE_URL   https://<gateway> (http only for loopback)
 *   LHDS_TENANT_A / LHDS_TENANT_B     tenant slugs (distinct)
 *   LHDS_TOKEN_A / LHDS_TOKEN_B       access tokens whose `tenant` claim is A / B
 *   LHDS_QUOTA_RPM       the effective requests-per-minute of tenant A (registry quota or the fragment default)
 *   LHDS_PATH_SUFFIX     default /fhir/metadata
 *
 * Exit codes (R6/R7: a result that was not established is not a pass):
 *   0 every check PASSED
 *   1 a check FAILED: the gateway answered and the answer is wrong (a defect)
 *   2 UNMEASURED: bad config, no response, or the positive control failed, so the
 *     403/429 observations cannot be interpreted. This is NOT a claim the edge is broken.
 */
const out = (o) => console.log(JSON.stringify(o));

export function readConfig(e = process.env) {
  const g = (k, d) => (e[k] ?? d ?? '').trim();
  const cfg = {
    base: g('LHDS_EDGE_BASE_URL').replace(/\/+$/, ''),
    a: g('LHDS_TENANT_A'), b: g('LHDS_TENANT_B'),
    tokA: g('LHDS_TOKEN_A'), tokB: g('LHDS_TOKEN_B'),
    quota: Number.parseInt(g('LHDS_QUOTA_RPM'), 10),
    suffix: g('LHDS_PATH_SUFFIX', '/fhir/metadata'),
  };
  const problems = [];
  if (!/^https:\/\//.test(cfg.base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.base)) problems.push('LHDS_EDGE_BASE_URL must be https (http only for loopback)');
  if (!cfg.a || !cfg.b || cfg.a === cfg.b) problems.push('LHDS_TENANT_A and LHDS_TENANT_B must be set and distinct');
  if (!cfg.tokA || !cfg.tokB) problems.push('LHDS_TOKEN_A and LHDS_TOKEN_B must be set');
  if (!Number.isInteger(cfg.quota) || cfg.quota < 1) problems.push('LHDS_QUOTA_RPM must be a positive integer');
  return { cfg, problems };
}

async function get(cfg, tenant, token) {
  const res = await fetch(`${cfg.base}/${tenant}${cfg.suffix}`, { headers: { Authorization: `Bearer ${token}` } });
  await res.arrayBuffer();
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

/** Run all checks; returns { exit, results[] }. `fetch` errors become UNMEASURED, never a pass. */
export async function runProbe(cfg) {
  const results = [];
  const rec = (name, verdict, detail) => { results.push({ name, verdict, detail }); };
  try {
    const pos = await get(cfg, cfg.a, cfg.tokA);
    if (pos.status < 200 || pos.status >= 400) {
      rec('positive-control', 'UNMEASURED', `tenant A token on tenant A path answered ${pos.status}, not 2xx/3xx: token or route unusable, so the 403/429 checks below were not run`);
      return { exit: 2, results };
    }
    rec('positive-control', 'PASS', `tenant A token on tenant A path answered ${pos.status}`);

    const mm = await get(cfg, cfg.a, cfg.tokB);
    rec('cross-tenant-403', mm.status === 403 ? 'PASS' : 'FAIL', `tenant A path with tenant B token answered ${mm.status}, expected 403`);

    const total = cfg.quota + Math.max(5, Math.ceil(cfg.quota * 0.05));
    const seen = [];
    let sent = 0;
    const worker = async () => {
      while (sent < total) { sent += 1; seen.push(await get(cfg, cfg.a, cfg.tokA)); }
    };
    await Promise.all(Array.from({ length: Math.min(16, total) }, worker));
    const limited = seen.filter((r) => r.status === 429);
    if (limited.length === 0) {
      rec('quota-429', 'FAIL', `${seen.length} requests against a quota of ${cfg.quota}/min produced no 429 (statuses: ${[...new Set(seen.map((r) => r.status))].join(',')})`);
    } else {
      const bad = limited.filter((r) => !/^[1-9]\d*$/.test(r.retryAfter ?? ''));
      rec('quota-429', 'PASS', `${limited.length} of ${seen.length} requests were 429 against a quota of ${cfg.quota}/min`);
      rec('retry-after', bad.length === 0 ? 'PASS' : 'FAIL', bad.length === 0 ? `every 429 carried a positive integer Retry-After (e.g. ${limited[0].retryAfter})` : `${bad.length} of ${limited.length} 429 responses had a missing or non-positive Retry-After (e.g. ${JSON.stringify(bad[0].retryAfter)})`);
      const other = await get(cfg, cfg.b, cfg.tokB);
      if (other.status === 429) rec('quota-isolation', 'FAIL', `tenant B own token was 429 while only tenant A exceeded its quota: the counter is shared across tenants`);
      else if (other.status < 200 || other.status >= 400) rec('quota-isolation', 'UNMEASURED', `tenant B own token on its own path answered ${other.status}: cannot tell whether B shares A's counter`);
      else rec('quota-isolation', 'PASS', `tenant B answered ${other.status} while tenant A was being limited`);
    }
  } catch (e) {
    rec('transport', 'UNMEASURED', `no usable response from the gateway (${e?.cause?.code ?? e?.name ?? 'error'}): this does not establish the edge is broken`);
    return { exit: 2, results };
  }
  const exit = results.some((r) => r.verdict === 'FAIL') ? 1 : results.some((r) => r.verdict === 'UNMEASURED') ? 2 : 0;
  return { exit, results };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const { cfg, problems } = readConfig();
  if (problems.length) { out({ verdict: 'UNMEASURED', problems }); process.exit(2); }
  const { exit, results } = await runProbe(cfg);
  for (const r of results) out(r);
  out({ verdict: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : 'UNMEASURED' });
  process.exit(exit);
}
