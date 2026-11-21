#!/usr/bin/env node
/**
 * Orchestrator for .github/workflows/lhds-edge-probe.yml (#5410, W1b-2 L2). Runs in-VNet on
 * the `loom-aca` fleet as the deploy SP (HealthCP.Admin + caller allowlist). Three phases:
 *
 *   create   POST the synthetic tenants, submit tenant.create, wait (bounded) for the job.
 *            Fails fast on a failed/cancelled job. Prints receipts' states only.
 *   probe    mint one token per tenant (mint-tenant-token.mjs), verify the claims, then in
 *            `--mode probe` run edge-probe.mjs IN THIS PROCESS. Tokens exist only here: never
 *            printed, written, or exported. The minted clients are disabled in a finally.
 *   cleanup  (run under `if: always()`) disable every `ep-` client of the two tenants, then
 *            destroy each tenant through health-tenant-destroy.mjs. A tenant that was never
 *            created is reported as such, not as a failure.
 *
 * Args: --phase --cp-url --stamp --tenant-a --tenant-b [--mode mint-only|probe]
 *       [--edge-base-url] [--quota-rpm] [--timeout-s] [--issuer-path]
 * Bearer: env LHDS_CP_TOKEN only. Exit 0 pass, 1 defect/refused/failed, 2 unmeasured.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { cpCall, disableClient, mintTenantToken, MintError, verdictLines, redact, SLUG_RE } from './mint-tenant-token.mjs';
import { readConfig as readProbeConfig, runProbe } from './edge-probe.mjs';
import { runDestroy } from '../../csa-loom/health-tenant-destroy.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_ID_RE = /^job-[0-9a-f]{32}$/;
const say = (s) => console.log(`lhds-edge-probe: ${s}`);

export function parseArgs(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  const pick = (k, d = '') => String(a[k] ?? d).replace(/\r/g, '').trim();
  return {
    phase: pick('phase'), cpUrl: pick('cp-url'), stamp: pick('stamp'), a: pick('tenant-a'), b: pick('tenant-b'),
    mode: pick('mode', 'mint-only'), edge: pick('edge-base-url'), quota: Number.parseInt(pick('quota-rpm', '30'), 10),
    timeoutS: Number.parseInt(pick('timeout-s', '1500'), 10), issuerPath: pick('issuer-path', '/auth'), ownedFile: pick('owned-file'),
    cpToken: String(env.LHDS_CP_TOKEN ?? '').replace(/[\r\n]/g, ''),
  };
}

export function validate(c) {
  if (!['create', 'probe', 'cleanup'].includes(c.phase)) return 'phase must be create, probe or cleanup';
  if (!c.cpToken) return 'no control-plane bearer token (set env LHDS_CP_TOKEN)';
  if (!SLUG_RE.test(c.a) || !SLUG_RE.test(c.b) || c.a === c.b) return 'tenant-a and tenant-b must be distinct slugs matching ^[a-z0-9][a-z0-9-]{1,19}$';
  if (!/^[a-z0-9]{1,20}$/.test(c.stamp)) return 'stamp must match ^[a-z0-9]{1,20}$';
  if (!Number.isInteger(c.quota) || c.quota < 1 || c.quota > 600) return 'quota-rpm must be 1-600';
  if (!Number.isInteger(c.timeoutS) || c.timeoutS < 1 || c.timeoutS > 2400) return 'timeout-s must be 1-2400';
  if (c.phase !== 'probe' && !c.ownedFile) return 'owned-file is required for create and cleanup (the slugs this run created; cleanup destroys only those)';
  if (!['mint-only', 'probe'].includes(c.mode)) return 'mode must be mint-only or probe';
  if (c.phase === 'probe' && c.mode === 'probe' && !/^https:\/\//.test(c.edge)) return 'edge-base-url (https) is required for mode probe';
  return null;
}

const api = (c, deps, method, path, body) => cpCall(deps, method, `${new URL(c.cpUrl).origin}${path}`, { body, bearer: c.cpToken });
const errText = (r) => r.status === 'network-error' ? `network-error ${r.code}` : `HTTP ${r.status} ${redact(r.json?.error?.code ?? '-', 60)}: ${redact(r.json?.error?.message ?? '(no body)', 200)}`;

export async function phaseCreate(c, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const jobs = [];
  for (const t of [c.a, c.b]) {
    const r = await api(c, deps, 'POST', '/api/health/tenants', { id: t, displayName: `edge probe ${t}`, stampId: c.stamp, quotas: { maxRequestsPerMinute: c.quota, maxStorageGiB: 1 } });
    if (r.status === 409) { say(`COLLISION: tenant ${t} already exists (HTTP 409). This run did not create it and will NOT destroy it; nothing was marked as owned for it.`); return 1; }
    if (r.status !== 201) { say(`REFUSED creating tenant ${t}: ${errText(r)}`); return 1; }
    // Ownership: only a 201 means THIS run created the slug. Recorded (slugs only, non-secret) before anything else can fail.
    if (c.ownedFile) appendFileSync(c.ownedFile, `${t}\n`);
    const j = await api(c, deps, 'POST', '/api/health/jobs', { kind: 'tenant.create', subjectType: 'tenant', subjectId: t, idempotencyKey: `ep-create-${t}` });
    if ((j.status !== 202 && j.status !== 200) || !JOB_ID_RE.test(String(j.json?.data?.id ?? ''))) { say(`REFUSED submitting tenant.create for ${t}: ${errText(j)}`); return 1; }
    jobs.push({ t, id: j.json.data.id, state: j.json.data.state });
    say(`tenant=${t} job=${j.json.data.id} state=${redact(j.json.data.state, 20)}`);
  }
  const deadline = now() + c.timeoutS * 1000;
  let failures = 0;
  while (jobs.some((j) => !TERMINAL.has(j.state))) {
    if (now() >= deadline) { say(`TIMEOUT after ${c.timeoutS}s: ${jobs.filter((j) => !TERMINAL.has(j.state)).map((j) => `${j.t}=${j.state}`).join(' ')}. Outcome NOT verified.`); return 1; }
    await sleep(15_000);
    for (const j of jobs.filter((x) => !TERMINAL.has(x.state))) {
      const g = await api(c, deps, 'GET', `/api/health/jobs/${encodeURIComponent(j.id)}`);
      if (g.status !== 200 || !g.json?.data) {
        failures += 1;
        say(`read of job ${j.id} failed (${failures}/5): ${errText(g)}`);
        if (failures >= 5) { say('COULD NOT READ the job after 5 consecutive failures. Outcome NOT verified.'); return 1; }
        continue;
      }
      failures = 0;
      j.state = g.json.data.state;
      if (j.state === 'failed' || j.state === 'cancelled') {
        say(`tenant.create for ${j.t} ${j.state}: ${redact(g.json.data.error?.code ?? '-', 60)}: ${redact(g.json.data.error?.message ?? '(none)', 300)}`);
        return 1;
      }
    }
  }
  say('both tenant.create jobs succeeded');
  return 0;
}

export async function phaseProbe(c, deps = {}) {
  const minted = [];
  let code = 0;
  const tokens = {};
  try {
    for (const t of [c.a, c.b]) {
      const m = await mintTenantToken({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken, tenant: t, issuerPath: c.issuerPath });
      minted.push(m.clientId);
      tokens[t] = m.accessToken;
      const v = verdictLines(t, m);
      for (const l of v.lines) say(l);
      if (!v.ok) code = 1;
    }
    if (code === 0 && c.mode === 'probe') {
      // Tokens go straight into an env-like object for readConfig; nothing is printed from it.
      const { cfg, problems } = readProbeConfig({
        LHDS_EDGE_BASE_URL: c.edge, LHDS_TENANT_A: c.a, LHDS_TENANT_B: c.b,
        LHDS_TOKEN_A: tokens[c.a], LHDS_TOKEN_B: tokens[c.b], LHDS_QUOTA_RPM: String(c.quota),
      });
      if (problems.length) { say(`UNMEASURED: ${problems.map((p) => redact(p, 120)).join('; ')}`); code = 2; }
      else {
        const r = await runProbe(cfg);
        for (const x of r.results) say(`probe ${x.name} ${x.verdict}: ${redact(x.detail, 300)}`);
        code = r.exit;
      }
    }
  } catch (e) {
    if (e instanceof MintError) { say(`mint failed class=${e.cls}: ${redact(e.message, 500)}`); code = e.exit; }
    else { say(`unexpected ${redact(e?.name ?? 'error', 40)}: ${redact(e?.message ?? '', 200)}`); code = 1; }
  } finally {
    for (const id of minted) {
      const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, id).catch(() => false);
      say(`cleanup client ${id} disabled=${ok}`);
      if (!ok && code === 0) code = 2;
    }
  }
  say(`VERDICT ${code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'UNMEASURED'} mode=${c.mode}`);
  return code;
}

/** Slugs this run created (one per line). A missing/unreadable file means nothing is owned. */
export function readOwned(file) {
  if (!file) return new Set();
  try { return new Set(readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)); } catch { return new Set(); }
}

export async function phaseCleanup(c, deps = {}) {
  let rc = 0;
  const owned = readOwned(c.ownedFile);
  const list = await api(c, deps, 'GET', '/api/health/auth/clients');
  if (list.status === 200 && Array.isArray(list.json?.data?.clients)) {
    for (const cl of list.json.data.clients.filter((x) => owned.has(x.tenant) && String(x.clientId).startsWith('ep-') && x.status !== 'disabled')) {
      const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, cl.clientId).catch(() => false);
      say(`cleanup client ${cl.clientId} disabled=${ok}`);
      if (!ok) rc = 1;
    }
  } else { say(`COULD NOT LIST clients to disable leftovers: ${errText(list)}`); rc = 1; }
  for (const t of [c.a, c.b]) {
    if (!owned.has(t)) { say(`tenant ${t} was not created by this run (no ownership record): NOT destroying it`); continue; }
    const g = await api(c, deps, 'GET', `/api/health/tenants/${encodeURIComponent(t)}`);
    if (g.status === 404) { say(`tenant ${t} was never registered (HTTP 404): nothing to destroy`); continue; }
    const r = await runDestroy({
      cpUrl: c.cpUrl, tenant: t, stamp: c.stamp, idempotencyKey: `ep-destroy-${t}`, allowNonSynthetic: true,
      allowMissingStorage: false, timeoutS: c.timeoutS, intervalS: 15, token: c.cpToken,
    }, deps.destroyDeps ?? {});
    if (r.code !== 0) rc = 1;
  }
  say(`cleanup ${rc === 0 ? 'complete' : 'INCOMPLETE: see lines above (a leaked tenant keeps billing)'}`);
  return rc;
}

export async function main(argv, env, deps = {}) {
  const c = parseArgs(argv, env);
  const bad = validate(c);
  if (bad) { say(`REFUSED (input): ${redact(bad, 200)}. Nothing was contacted.`); return 2; }
  return c.phase === 'create' ? phaseCreate(c, deps) : c.phase === 'probe' ? phaseProbe(c, deps) : phaseCleanup(c, deps);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main(process.argv.slice(2), process.env).then((code) => process.exit(code));
