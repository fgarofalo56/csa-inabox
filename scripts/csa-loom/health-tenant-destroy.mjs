#!/usr/bin/env node
/**
 * health-tenant-destroy (#5405) - submit `tenant.destroy` to the LHDS health control
 * plane for a tenant whose console `health-tenant` item no longer exists, poll the job
 * with a bound, and print its receipts.
 *
 * The console item-DELETE path (destroyHealthTenantForItem, health-tenant.ts) is the only
 * other caller, and it needs the item. A tenant whose destroy failed before the item was
 * removed leaks with no way back to it. This is that way back. The control plane is
 * reachable only in-VNet, so this runs from .github/workflows/lhds-tenant-destroy.yml on
 * the `loom-aca` runner.
 *
 * Input (args override env):
 *   --cp-url          / LHDS_CP_URL           https:// base of loom-health-cp
 *   --tenant          / LHDS_TENANT           tenant id; must match ^g1-[0-9]{12}$ (a G1 synthetic
 *                                             tenant) unless --allow-non-synthetic true
 *   --stamp           / LHDS_STAMP            the stamp the tenant MUST be on (refused otherwise)
 *   --idempotency-key / LHDS_IDEMPOTENCY_KEY  required; the same key re-reads the same job
 *   --allow-non-synthetic true|false (false)  --allow-missing-storage true|false (false)
 *   --timeout-s (1800)  --interval-s (15)
 *   bearer token: env LHDS_CP_TOKEN ONLY (never an argument, never printed).
 *
 * Exit 0 = the destroy job SUCCEEDED (the control plane read every deleted resource back as
 *          gone and every key back as deleted before it said so).
 * Exit 1 = refused, failed, cancelled, timed out, or could not be read: nothing here is green
 *          over an unknown outcome (deploy-integrity R6/R7).
 * Exit 2 = bad input; the control plane was not contacted.
 *
 * Output is public (Actions log + step summary): every GUID (subscription, principal) is
 * replaced with <guid>, control characters are flattened, and each line has a fixed prefix
 * so no control-plane text can become a workflow command.
 */

const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f]+/g;
export const SYNTHETIC_RE = /^g1-[0-9]{12}$/;
// The binding cap is 20 (tenant.bicep @maxLength, #5383); the CP subject regex is wider.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,19}$/;
const STAMP_RE = /^[a-z0-9]{1,20}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_READ_FAILURES = 5;

/** Public-safe text: GUIDs masked, control characters flattened, length capped. */
export function redact(v, cap = 400) {
  const s = String(v ?? '').replace(GUID_RE, '<guid>').replace(CTRL_RE, ' ');
  return s.length > cap ? `${s.slice(0, cap)}...` : s;
}

export function readConfig(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const pick = (k, e, d = '') => String(a[k] ?? env[e] ?? d).replace(/\r/g, '').trim();
  const int = (k, e, d) => { const s = pick(k, e, String(d)); return /^\d{1,5}$/.test(s) ? Number(s) : NaN; };
  return {
    cpUrl: pick('cp-url', 'LHDS_CP_URL'),
    tenant: pick('tenant', 'LHDS_TENANT'),
    stamp: pick('stamp', 'LHDS_STAMP'),
    idempotencyKey: pick('idempotency-key', 'LHDS_IDEMPOTENCY_KEY'),
    allowNonSynthetic: pick('allow-non-synthetic', 'LHDS_ALLOW_NON_SYNTHETIC', 'false') === 'true',
    allowMissingStorage: pick('allow-missing-storage', 'LHDS_ALLOW_MISSING_STORAGE', 'false') === 'true',
    timeoutS: int('timeout-s', 'LHDS_TIMEOUT_S', 1800),
    intervalS: int('interval-s', 'LHDS_INTERVAL_S', 15),
    token: String(env.LHDS_CP_TOKEN ?? '').replace(/[\r\n]/g, ''),
  };
}

/** null when usable, else the reason (the control plane is not contacted). */
export function validate(c) {
  if (!c.token) return 'no bearer token (set env LHDS_CP_TOKEN)';
  let u;
  try { u = new URL(c.cpUrl); } catch { return 'cp-url is not a URL'; }
  if (u.protocol !== 'https:') return 'cp-url must be https';
  if (u.username || u.password || u.search || u.hash) return 'cp-url must be a bare https origin';
  if (!SLUG_RE.test(c.tenant)) return 'tenant must match ^[a-z0-9][a-z0-9-]{1,19}$';
  if (!c.allowNonSynthetic && !SYNTHETIC_RE.test(c.tenant)) {
    return `tenant ${c.tenant} is not a G1 synthetic tenant (^g1-[0-9]{12}$); pass --allow-non-synthetic true to destroy it`;
  }
  if (!STAMP_RE.test(c.stamp)) return 'stamp must match ^[a-z0-9]{1,20}$';
  if (!KEY_RE.test(c.idempotencyKey)) return 'idempotency-key must be 1-80 chars of A-Za-z0-9._:-';
  if (!Number.isInteger(c.timeoutS) || c.timeoutS < 1 || c.timeoutS > 7200) return 'timeout-s must be 1-7200';
  if (!Number.isInteger(c.intervalS) || c.intervalS > 600) return 'interval-s must be 0-600';
  return null;
}

/** One CP call. Never throws: a network failure is a value, not an exception. */
async function call(c, deps, method, path, body) {
  const base = c.cpUrl.replace(/\/+$/, '');
  try {
    const res = await deps.fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json };
  } catch (e) {
    const cc = e?.cause?.code;
    return { status: 'network-error', json: null, cls: typeof cc === 'string' && /^[A-Z0-9_]{1,40}$/.test(cc) ? cc : 'unknown' };
  }
}

const errText = (r) => {
  if (r.status === 'network-error') return `network-error class=${r.cls}`;
  const e = r.json?.error;
  return `HTTP ${r.status} ${redact(e?.code ?? '-', 80)}: ${redact(e?.message ?? '(no error body)', 300)}`;
};

export async function runDestroy(c, deps = {}) {
  const d = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    out: deps.out ?? ((s) => console.log(s)),
    now: deps.now ?? (() => Date.now()),
  };
  const say = (s) => d.out(`lhds-tenant-destroy: ${s}`);

  const bad = validate(c);
  if (bad) { say(`REFUSED (input): ${redact(bad)}. The control plane was not contacted.`); return { code: 2 }; }

  // 1. The tenant must be registered and on the stamp the caller named.
  const t = await call(c, d, 'GET', `/api/health/tenants/${encodeURIComponent(c.tenant)}`);
  if (t.status === 404) {
    say(`REFUSED: tenant ${c.tenant} is not in the control-plane registry (HTTP 404). tenant.destroy needs a registered tenant; nothing was submitted.`);
    return { code: 1 };
  }
  if (t.status !== 200 || t.json?.ok !== true) {
    const hint = t.status === 401 || t.status === 403
      ? ' The caller needs the HealthCP.Admin app role AND a place on the control plane caller allowlist (post-deploy bootstrap).'
      : '';
    say(`COULD NOT READ tenant ${c.tenant}: ${errText(t)}.${hint} Nothing was submitted.`);
    return { code: 1 };
  }
  const tenant = t.json.data ?? {};
  say(`tenant=${c.tenant} stamp=${redact(tenant.stampId, 40)} status=${redact(tenant.status, 40)}`);
  if (tenant.stampId !== c.stamp) {
    say(`REFUSED: tenant ${c.tenant} is on stamp '${redact(tenant.stampId, 40)}', not '${c.stamp}'. Nothing was submitted.`);
    return { code: 1 };
  }

  // 2. Submit. The same idempotency key returns the existing job (200) instead of a second one.
  const input = { confirmTenantId: c.tenant, ...(c.allowMissingStorage ? { allowMissingStorage: true } : {}) };
  const s = await call(c, d, 'POST', '/api/health/jobs', {
    kind: 'tenant.destroy', subjectType: 'tenant', subjectId: c.tenant, idempotencyKey: c.idempotencyKey, input,
  });
  if (s.status === 'network-error') {
    say(`SUBMIT OUTCOME UNKNOWN (${errText(s)}): the job may or may not exist. Re-run with idempotency key ${c.idempotencyKey} to read it back without submitting a second one.`);
    return { code: 1 };
  }
  if ((s.status !== 202 && s.status !== 200) || s.json?.ok !== true || !JOB_ID_RE.test(String(s.json?.data?.id ?? ''))) {
    say(`REFUSED by the control plane: ${errText(s)}. No job was started.`);
    return { code: 1 };
  }
  let job = s.json.data;
  say(`job=${redact(job.id, 200)} kind=tenant.destroy created=${s.status === 202} state=${redact(job.state, 20)} key=${c.idempotencyKey}`);

  // 3. Poll with a bound, printing each receipt once.
  const deadline = d.now() + c.timeoutS * 1000;
  let printed = 0;
  let failures = 0;
  const printNew = () => {
    const rs = Array.isArray(job.receipts) ? job.receipts : [];
    for (; printed < rs.length; printed++) {
      const r = rs[printed] ?? {};
      say(`receipt ${redact(r.at, 40)} ${redact(r.step, 60)} ${redact(r.detail)}`);
    }
  };
  printNew();
  while (!TERMINAL.has(job.state)) {
    if (d.now() >= deadline) {
      say(`TIMEOUT: job ${redact(job.id, 200)} is still '${redact(job.state, 20)}' after ${c.timeoutS}s. It keeps running in the control plane; re-run with idempotency key ${c.idempotencyKey} to read it back. Outcome NOT verified.`);
      return { code: 1, job };
    }
    if (c.intervalS > 0) await d.sleep(c.intervalS * 1000);
    const g = await call(c, d, 'GET', `/api/health/jobs/${encodeURIComponent(job.id)}`);
    if (g.status !== 200 || g.json?.ok !== true || !g.json?.data) {
      failures++;
      say(`read ${failures}/${MAX_READ_FAILURES} of job ${redact(job.id, 200)} failed: ${errText(g)}`);
      if (failures >= MAX_READ_FAILURES) {
        say(`COULD NOT READ the job after ${MAX_READ_FAILURES} consecutive failures. Outcome NOT verified.`);
        return { code: 1, job };
      }
      continue;
    }
    failures = 0;
    job = g.json.data;
    printNew();
  }

  // 4. Verdict, then the tenant's registry state (informational).
  const verdict = job.state === 'succeeded'
    ? `RESULT job=${redact(job.id, 200)} state=succeeded receipts=${printed}`
    : `RESULT job=${redact(job.id, 200)} state=${redact(job.state, 20)} error=${redact(job.error?.code ?? '-', 80)}: ${redact(job.error?.message ?? '(none)')}`;
  say(verdict);
  const after = await call(c, d, 'GET', `/api/health/tenants/${encodeURIComponent(c.tenant)}`);
  say(after.status === 404
    ? `tenant ${c.tenant} after: not in the registry (HTTP 404)`
    : after.status === 200 && after.json?.ok === true
      ? `tenant ${c.tenant} after: status=${redact(after.json.data?.status, 40)}`
      : `tenant ${c.tenant} after: could not read (${errText(after)})`);
  return { code: job.state === 'succeeded' ? 0 : 1, job };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  runDestroy(readConfig(process.argv.slice(2), process.env)).then((r) => process.exit(r.code));
}
