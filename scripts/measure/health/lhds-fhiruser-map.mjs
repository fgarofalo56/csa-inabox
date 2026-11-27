#!/usr/bin/env node
/**
 * Orchestrator for .github/workflows/lhds-fhiruser-map.yml (Inferno one-off, operator-approved 2026-11-27; the durable
 * console surface is #5472). Makes a real Entra user's SMART sign-in carry a `fhirUser` claim on an EXISTING LHDS tenant:
 *
 *   map      1. GET the tenant (must exist, be `active`, and live on --stamp).
 *            2. GET the fhir-users mapping for the oid. A mapping to anything but a Practitioner is REFUSED (this tool
 *               never overwrites a mapping it did not make). A mapping to Practitioner/<id> is verified in-cluster.
 *            3. Register a TEMPORARY backend client (prefix `fu`, scope system/Practitioner.cr, role fhir-data-writer)
 *               and mint its token (mint-tenant-token.mjs: ES384 key in memory, private_key_jwt, issuer discovered).
 *            4. ONE `az aks command invoke` runs a generated sh+curl script in the aks-command pod against the tenant's
 *               engine ClusterIP Service at the BARE base (http://fhir-<slug>.loom-health.svc.cluster.local:80/fhir,
 *               the DEFAULT partition since #5496). Already mapped + GET 200 with the same id = stop, nothing created.
 *               Not mapped, or mapped to a Practitioner that answers 404/410 = POST one SYNTHETIC Practitioner
 *               (meta.tag v3-ActReason HTEST, a synthetic identifier system, name.text = --display-name), read it back.
 *            5. PUT /api/health/auth/tenants/{t}/fhir-users/{oid} {resource:"Practitioner/<id>"} and read it back.
 *            The minted client is DISABLED in a finally on every path.
 *   cleanup  (workflow `if: always()`) disable every still-active `fu-<tenant>-` client of the tenant, so a killed
 *            map phase cannot leave a writer client behind.
 *
 * The oid comes ONLY from env LHDS_FHIRUSER_OID (a repo secret: the repo is public, inputs are visible). It is never
 * printed: every output line is scrubbed of it in every letter case, and the summary carries only the tenant, the
 * Practitioner reference and mapping=ok. Tokens and keys are never printed or written outside a 0600 temp dir that is
 * deleted in a finally.
 *
 * Exit 0 mapped (created or already mapped), 1 defect / refused, 2 unmeasured (deploy-integrity R7: an outcome that
 * was not established is never reported as a defect or as a pass).
 *
 * Args: --phase map|cleanup --cp-url --tenant --stamp [--display-name] [--run-ref] [--issuer-path]
 *       [--aks-rg --aks-name --aks-subscription] [--summary-file]
 * Env:  LHDS_CP_TOKEN (control-plane bearer), LHDS_FHIRUSER_OID (map only).
 */
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpCall, disableClient, mintTenantToken, MintError, redact, SLUG_RE } from './mint-tenant-token.mjs';
import { COMMAND_ID_RE, defaultExec, engineBase, RESULT_MAX_POLLS, RESULT_POLL_MS, TERMINAL_RUN_STATES } from './lhds-fhir-crud-probe-run.mjs';

export const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Mirrors apps/loom-health-cp/src/auth/fhir-user.ts FHIR_ID (a test lifts the source pattern and compares). */
export const FHIR_ID = /^(?!\.+$)[A-Za-z0-9.-]{1,64}$/;
export const DISPLAY_NAME_RE = /^[A-Za-z0-9 ().,_-]{1,100}$/;
export const DEFAULT_DISPLAY_NAME = 'LHDS Inferno Practitioner (synthetic)';
/** The narrowest grant that can create AND read back a Practitioner: the AS accepts a typed v2 scope, the PDP matches the type. */
export const GRANT = Object.freeze({ scope: 'system/Practitioner.cr', allowedScopes: ['system/Practitioner.cr'], roleIds: ['fhir-data-writer'], clientPrefix: 'fu' });
export const SYNTHETIC_TAG = Object.freeze({ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' });
export const SYNTHETIC_IDENTIFIER_SYSTEM = 'urn:loom:lhds:synthetic-practitioner';
export const clientPrefixFor = (tenant) => `${GRANT.clientPrefix}-${tenant}-`;

/** Remove every occurrence of each secret, in its given, lower and upper case, before text can be printed. */
export function scrub(text, secrets) {
  let s = String(text ?? '');
  for (const x of secrets) {
    if (!x) continue;
    for (const v of new Set([x, x.toLowerCase(), x.toUpperCase()])) s = s.split(v).join('<redacted>');
  }
  return s;
}

export function parseArgs(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  const pick = (k, d = '') => String(a[k] ?? d).replace(/\r/g, '').trim();
  return {
    phase: pick('phase'), cpUrl: pick('cp-url'), tenant: pick('tenant'), stamp: pick('stamp'),
    displayName: pick('display-name', DEFAULT_DISPLAY_NAME), runRef: pick('run-ref', String(Date.now())),
    issuerPath: pick('issuer-path', '/auth'), aksRg: pick('aks-rg'), aksName: pick('aks-name'), aksSub: pick('aks-subscription'),
    summaryFile: pick('summary-file'),
    cpToken: String(env.LHDS_CP_TOKEN ?? '').replace(/[\r\n]/g, ''),
    oid: String(env.LHDS_FHIRUSER_OID ?? '').replace(/[\r\n]/g, '').trim(),
  };
}

/** Returns a refusal reason, or null. Never includes the oid in the reason. */
export function validate(c) {
  if (!['map', 'cleanup'].includes(c.phase)) return 'phase must be map or cleanup';
  if (!c.cpToken) return 'no control-plane bearer token (set env LHDS_CP_TOKEN)';
  if (!SLUG_RE.test(c.tenant)) return 'tenant must be a slug matching ^[a-z0-9][a-z0-9-]{1,19}$';
  if (!/^[a-z0-9]{1,20}$/.test(c.stamp)) return 'stamp must match ^[a-z0-9]{1,20}$';
  if (c.phase === 'cleanup') return null;
  if (!c.oid) return 'LHDS_FHIRUSER_OID is empty: set the repo secret to the Entra object id of the user to map';
  if (!GUID_RE.test(c.oid)) return 'LHDS_FHIRUSER_OID is not a GUID (8-4-4-4-12 hex); its value is withheld';
  if (!DISPLAY_NAME_RE.test(c.displayName)) return 'display-name must be 1-100 chars of letters, digits, space and ().,_-';
  if (!/^[A-Za-z0-9-]{1,40}$/.test(c.runRef)) return 'run-ref must be 1-40 chars of letters, digits and hyphen';
  if (!/^[A-Za-z0-9._()-]{1,90}$/.test(c.aksRg)) return 'aks-rg is required (the stamp resource group)';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(c.aksName)) return 'aks-name is required (the stamp AKS cluster)';
  if (c.aksSub && !GUID_RE.test(c.aksSub)) return 'aks-subscription must be a GUID when given';
  return null;
}

/** The synthetic Practitioner. No PHI: a fixed family name, the operator's display text, a synthetic tag and identifier. */
export function practitionerBody({ displayName, runRef }) {
  if (!DISPLAY_NAME_RE.test(displayName)) throw new Error('practitionerBody: display name has characters outside the allowed set');
  return {
    resourceType: 'Practitioner',
    meta: { tag: [{ ...SYNTHETIC_TAG }] },
    identifier: [{ system: SYNTHETIC_IDENTIFIER_SYSTEM, value: `fhiruser-map-${runRef}` }],
    active: true,
    name: [{ use: 'official', text: displayName, family: 'Synthetic', given: ['Inferno'] }],
  };
}

/**
 * The script run in the aks-command pod (sh builtins + curl only, as the CRUD probe measured). The token is NOT in this
 * text: it arrives as the header file `hdr`, read with `curl -H @hdr`. The body arrives as practitioner.json. Prints
 * only `MAP ...` lines. With an existing id it GETs that Practitioner first and creates one only on a 404/410 answer.
 */
export function renderMapScript({ tenant, existingId = '' }) {
  if (!SLUG_RE.test(tenant)) throw new Error('renderMapScript: tenant is not a slug');
  if (existingId && !FHIR_ID.test(existingId)) throw new Error('renderMapScript: existing id is not a FHIR id');
  return `#!/bin/sh
# Generated by scripts/measure/health/lhds-fhiruser-map.mjs. Holds no secret: the token is the header file hdr.
# Prints MAP lines only. curl stderr is discarded; no header, token or response body is ever printed.
set -u
BASE='${engineBase(tenant)}'
EXISTING='${existingId}'
TMP="\${TMPDIR:-/tmp}/lhds-fumap.$$"
HF="$TMP.h"
BF="$TMP.b"
trap 'rm -f "$HF" "$BF" hdr practitioner.json 2>/dev/null' EXIT
CR=$(printf '\\r')
CODE=000

# req <METHOD> <url> [bodyfile] -> sets CODE; headers in $HF, body in $BF
req() {
  : > "$HF" 2>/dev/null; : > "$BF" 2>/dev/null
  if [ "$#" -ge 3 ]; then
    CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$1" -H "@hdr" -H 'content-type: application/fhir+json' --data-binary "@$3" "$2" 2>/dev/null) || CODE=000
  else
    CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$1" -H "@hdr" -H 'accept: application/fhir+json' "$2" 2>/dev/null) || CODE=000
  fi
  case "$CODE" in [0-9][0-9][0-9]) ;; *) CODE=000 ;; esac
}

location() {
  loc=''
  while IFS= read -r line; do
    line=\${line%"$CR"}
    case "$line" in [Ll]ocation:*) loc=\${line#*:} ;; esac
  done < "$HF"
  printf '%s' "$loc"
}

created_id() {
  loc=$(location)
  case "$loc" in *'/Practitioner/'*) rest=\${loc#*/Practitioner/}; id=\${rest%%/*} ;; *) id='' ;; esac
  case "$id" in ''|*[!A-Za-z0-9.-]*) id='' ;; esac
  printf '%s' "$id"
}

location_bare() {
  case "$(location)" in *'/fhir/Practitioner/'*) printf 'yes' ;; *) printf 'no' ;; esac
}

body_is() { # $1 = id ; 0 when the response body is a Practitioner whose id is $1
  b=''
  while IFS= read -r line || [ -n "$line" ]; do b="$b$line"; done < "$BF"
  case "$b" in *'"resourceType":"Practitioner"'*|*'"resourceType": "Practitioner"'*) ;; *) return 1 ;; esac
  case "$b" in *'"id":"'"$1"'"'*|*'"id": "'"$1"'"'*) return 0 ;; esac
  return 1
}

if [ -n "$EXISTING" ]; then
  req GET "$BASE/Practitioner/$EXISTING"
  if [ "$CODE" = "200" ] && body_is "$EXISTING"; then echo "MAP step=verify status=$CODE id_match=yes"; exit 0; fi
  echo "MAP step=verify status=$CODE id_match=no"
  case "$CODE" in 404|410) ;; *) exit 0 ;; esac
fi

req POST "$BASE/Practitioner" practitioner.json
NID=''; BARE=no
if [ "$CODE" = "201" ]; then NID=$(created_id); BARE=$(location_bare); fi
if [ -n "$NID" ]; then echo "MAP step=create status=$CODE id=$NID bare=$BARE"; else echo "MAP step=create status=$CODE bare=$BARE"; fi
if [ -n "$NID" ]; then
  req GET "$BASE/Practitioner/$NID"
  if [ "$CODE" = "200" ] && body_is "$NID"; then echo "MAP step=read status=$CODE id_match=yes"; else echo "MAP step=read status=$CODE id_match=no"; fi
fi
exit 0
`;
}

const MAP_LINE = /^MAP step=(verify|create|read) status=(\d{3})(?: id=([A-Za-z0-9.-]{1,64}))?(?: id_match=(yes|no))?(?: bare=(yes|no))?$/;

/** Only exact MAP lines are read; anything else in the pod log is ignored and never echoed. The last line per step wins. */
export function parseMapLogs(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = MAP_LINE.exec(raw.trim());
    if (!m) continue;
    out[m[1]] = { status: Number(m[2]), ...(m[3] ? { id: m[3] } : {}), ...(m[4] ? { idMatch: m[4] === 'yes' } : {}), ...(m[5] ? { bare: m[5] === 'yes' } : {}) };
  }
  return out;
}

const NO_ANSWER = (s) => s === 0 || s === 503;

/**
 * What the pod established. Returns { code, kind, id, note }: kind `existing` (the mapped Practitioner resolves: nothing
 * to do), `created` (a new Practitioner exists and reads back: map it), or undefined with code 1 (the engine answered
 * wrongly) / 2 (no usable answer). Each branch names the value that lands in it.
 */
export function judgeMap(p, existingId = '') {
  if (existingId) {
    const v = p.verify;
    if (!v) return { code: 2, note: 'no verify line for the mapped Practitioner' };
    if (v.status === 200 && v.idMatch === true) return { code: 0, kind: 'existing', id: existingId, note: 'the mapped Practitioner resolves (GET 200, same id)' };
    if (v.status === 200) return { code: 1, note: 'the mapped Practitioner answered 200 with a body that is not that Practitioner' };
    if (NO_ANSWER(v.status)) return { code: 2, note: v.status === 0 ? 'curl got no HTTP answer from the engine' : 'the engine answered 503 for the mapped Practitioner' };
    if (v.status !== 404 && v.status !== 410) return { code: 1, note: `the mapped Practitioner answered ${v.status}; expected 200 (or 404/410 to replace it). Nothing was created` };
  }
  const c = p.create;
  if (!c) return { code: 2, note: 'no create line from the pod' };
  if (NO_ANSWER(c.status)) return { code: 2, note: c.status === 0 ? 'curl got no HTTP answer from the engine' : 'the engine answered 503 to the create' };
  if (c.status === 403) return { code: 1, note: 'the engine refused the create (403). A PDP deny and a tenant not homed in the published bundle read the same from here; the rule that fired is in the engine audit log, not established by this run' };
  if (c.status !== 201) return { code: 1, note: `the create answered ${c.status}; expected 201` };
  if (!c.id) return { code: 1, note: 'created, but the Location header carried no Practitioner id' };
  if (c.bare !== true) return { code: 1, note: 'created, but the Location carries a partition segment: the bare-base reference would not resolve' };
  const r = p.read;
  if (!r) return { code: 2, note: 'no read-back line' };
  if (NO_ANSWER(r.status)) return { code: 2, note: 'no usable answer to the read-back' };
  if (r.status !== 200 || r.idMatch !== true) return { code: 1, note: `the read-back answered ${r.status} id_match=${r.idMatch === true}; expected 200 and the created id` };
  return { code: 0, kind: 'created', id: c.id, note: existingId ? 'the mapped Practitioner was gone (404/410); a new synthetic one was created and read back' : 'a synthetic Practitioner was created and read back' };
}

const mkSay = (deps, secrets) => {
  const out = deps.out ?? ((s) => console.log(s));
  return (s) => out(scrub(`lhds-fhiruser-map: ${s}`, secrets));
};
const errText = (r) => r.status === 'network-error' ? `network-error ${r.code}` : `HTTP ${r.status} ${redact(r.json?.error?.code ?? '-', 60)}: ${redact(r.json?.error?.message ?? '(no body)', 200)}`;

/** One in-cluster run; polls `az aks command result` while ARM reports a non-terminal state (as the CRUD probe does). */
async function invokeInCluster(c, deps, say, dir, secrets) {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  const target = ['-g', c.aksRg, '-n', c.aksName, ...(c.aksSub ? ['--subscription', c.aksSub] : [])];
  let r = await exec('az', ['aks', 'command', 'invoke', ...target, '--command', 'sh map.sh', '--file', 'map.sh', '--file', 'hdr', '--file', 'practitioner.json', '-o', 'json'], { cwd: dir });
  let logs = ''; let state = ''; let sub = 'invoke';
  const read = (o) => { try { const j = JSON.parse(o.stdout); logs = String(j.logs ?? ''); state = String(j.provisioningState ?? ''); return j; } catch { logs = ''; state = 'unparseable'; return undefined; } };
  const first = read(r);
  const id = String(first?.id ?? '');
  if (r.code === 0 && first && !TERMINAL_RUN_STATES.has(state) && COMMAND_ID_RE.test(id)) {
    for (let i = 1; i <= RESULT_MAX_POLLS && !TERMINAL_RUN_STATES.has(state); i++) {
      say(`command is ${redact(state || 'unreported', 20)}; polling its result (${i}/${RESULT_MAX_POLLS})`);
      await sleep(RESULT_POLL_MS);
      r = await exec('az', ['aks', 'command', 'result', ...target, '--command-id', id, '-o', 'json'], { cwd: dir }); sub = 'result';
      if (r.code !== 0 || !read(r)) break;
    }
  }
  if (r.code !== 0 || !logs) {
    say(`UNMEASURED: az aks command ${sub} ${r.code !== 0 ? `exited ${r.code}` : `returned no pod logs (state=${redact(state || 'unreported', 20)})`}: ${redact(scrub(r.stderr || '(no stderr)', secrets), 300)}`);
    return undefined;
  }
  return scrub(logs, secrets);
}

export async function phaseMap(c, deps = {}) {
  const secrets = [c.oid, c.cpToken];
  const say = mkSay(deps, secrets);
  const api = (method, path, body) => cpCall(deps, method, `${new URL(c.cpUrl).origin}${path}`, { body, bearer: c.cpToken });
  const oid = c.oid.toLowerCase();
  const fu = `/api/health/auth/tenants/${encodeURIComponent(c.tenant)}/fhir-users/${encodeURIComponent(oid)}`;
  let clientId;
  let dir;
  let code = 0;
  const wipe = () => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } };
  const onSig = () => { wipe(); process.exit(143); };
  try {
    const t = await api('GET', `/api/health/tenants/${encodeURIComponent(c.tenant)}`);
    if (t.status === 404) { say(`REFUSED: tenant ${c.tenant} does not exist (HTTP 404). Nothing was created.`); return (code = 1); }
    if (t.status !== 200 || !t.json?.data) { say(`UNMEASURED: could not read tenant ${c.tenant}: ${errText(t)}. Nothing was created.`); return (code = 2); }
    if (t.json.data.stampId !== c.stamp) { say(`REFUSED: tenant ${c.tenant} is on stamp ${redact(t.json.data.stampId, 20)}, not ${c.stamp}. Nothing was created.`); return (code = 1); }
    if (t.json.data.status !== 'active') { say(`REFUSED: tenant ${c.tenant} is ${redact(t.json.data.status, 20)}, not active. Nothing was created.`); return (code = 1); }

    const m = await api('GET', fu);
    let existingId = '';
    if (m.status === 200) {
      const res = String(m.json?.data?.resource ?? '');
      const pm = /^Practitioner\/(.+)$/.exec(res);
      if (!pm || !FHIR_ID.test(pm[1])) {
        say(`REFUSED: this oid is already mapped on ${c.tenant} to a ${redact(res.split('/')[0] || 'malformed reference', 20)}, not a Practitioner. This workflow does not overwrite a mapping it did not make. Nothing was changed.`);
        return (code = 1);
      }
      existingId = pm[1];
      say(`an existing mapping points at Practitioner/${existingId}; verifying it resolves before doing anything else`);
    } else if (m.status !== 404) {
      say(`UNMEASURED: could not read the existing mapping: ${errText(m)}. Nothing was created.`);
      return (code = 2);
    } else say(`no fhirUser mapping for this oid on ${c.tenant} yet`);

    const tok = await mintTenantToken({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken, tenant: c.tenant, issuerPath: c.issuerPath, ...GRANT });
    clientId = tok.clientId;
    secrets.push(tok.accessToken);
    const granted = new Set(tok.scope.split(' ').filter(Boolean));
    if (granted.size !== 1 || !granted.has(GRANT.scope)) { say(`REFUSED: the minted token carries scope "${redact(tok.scope, 120)}", not exactly ${GRANT.scope}. The engine was not contacted.`); return (code = 1); }
    say(`temporary client ${clientId} minted scope=${GRANT.scope} role=${GRANT.roleIds[0]}`);

    dir = mkdtempSync(join(deps.tmpRoot ?? process.env.RUNNER_TEMP ?? tmpdir(), 'lhds-fumap-'));
    process.once('SIGTERM', onSig);
    process.once('SIGINT', onSig);
    try { chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
    const put = (name, text) => { writeFileSync(join(dir, name), text, { mode: 0o600 }); try { chmodSync(join(dir, name), 0o600); } catch { /* as above */ } };
    put('map.sh', renderMapScript({ tenant: c.tenant, existingId }));
    put('hdr', `Authorization: Bearer ${tok.accessToken}\n`);
    put('practitioner.json', JSON.stringify(practitionerBody({ displayName: c.displayName, runRef: c.runRef })));
    say(`running in the aks-command pod of ${redact(c.aksName, 60)} against the bare base of ${c.tenant}`);
    const logs = await invokeInCluster(c, deps, say, dir, secrets);
    if (logs === undefined) return (code = 2);
    const v = judgeMap(parseMapLogs(logs), existingId);
    say(`engine: ${v.code === 0 ? 'OK' : v.code === 1 ? 'FAIL' : 'UNMEASURED'} ${redact(v.note, 400)}`);
    if (v.code !== 0) return (code = v.code);
    const ref = `Practitioner/${v.id}`;

    if (v.kind === 'created') {
      const p = await api('PUT', fu, { resource: ref });
      if (p.status !== 200 || p.json?.data?.resource !== ref) {
        say(`FAIL: the mapping PUT did not confirm ${ref}: ${p.status === 200 ? `data.resource=${redact(p.json?.data?.resource, 80)}` : errText(p)}. ${ref} exists in the engine but is NOT mapped.`);
        return (code = p.status === 'network-error' || p.status === 503 ? 2 : 1);
      }
    }
    const back = await api('GET', fu);
    if (back.status !== 200 || back.json?.data?.resource !== ref || String(back.json?.data?.oid ?? '').toLowerCase() !== oid) {
      say(`FAIL: the mapping read-back does not equal ${ref} for this oid: ${back.status === 200 ? `data.resource=${redact(back.json?.data?.resource, 80)} oid_matches=${String(back.json?.data?.oid ?? '').toLowerCase() === oid}` : errText(back)}`);
      return (code = 1);
    }
    say(`mapping ${v.kind === 'existing' ? 'already present and verified' : 'written and read back'}: ${ref}; sign-in will carry fhirUser=${redact(back.json.data.fhirUser, 200)}`);
    if (c.summaryFile) appendFileSync(c.summaryFile, `## lhds fhirUser map\n\n- tenant: ${c.tenant}\n- fhirUser: ${ref}\n- mapping=ok (${v.kind})\n`);
    return (code = 0);
  } catch (e) {
    if (e instanceof MintError) { say(`mint failed class=${e.cls}: ${redact(scrub(e.message, secrets), 500)}`); return (code = e.exit); }
    say(`unexpected ${redact(e?.name ?? 'error', 40)}: ${redact(scrub(e?.message ?? '', secrets), 200)}`);
    return (code = 1);
  } finally {
    wipe();
    process.removeListener('SIGTERM', onSig);
    process.removeListener('SIGINT', onSig);
    if (clientId) {
      const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, clientId).catch(() => false);
      say(`cleanup client ${clientId} disabled=${ok}${ok ? '' : ' (NOT confirmed: the always() cleanup step retries it)'}`);
    }
    say(`VERDICT ${code === 0 ? 'MAPPED' : code === 1 ? 'FAIL' : 'UNMEASURED'}`);
  }
}

/** Disable every still-active `fu-<tenant>-` client of the tenant. 0 = none left active, 1 = one could not be disabled or listed. */
export async function phaseCleanup(c, deps = {}) {
  const say = mkSay(deps, [c.oid, c.cpToken]);
  const list = await cpCall(deps, 'GET', `${new URL(c.cpUrl).origin}/api/health/auth/clients`, { bearer: c.cpToken });
  if (list.status !== 200 || !Array.isArray(list.json?.data?.clients)) { say(`COULD NOT LIST clients, so a temporary writer client may still be ACTIVE: ${errText(list)}`); return 1; }
  const prefix = clientPrefixFor(c.tenant);
  const live = list.json.data.clients.filter((x) => x?.tenant === c.tenant && String(x?.clientId ?? '').startsWith(prefix) && x?.status !== 'disabled');
  let rc = 0;
  for (const cl of live) {
    const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, cl.clientId).catch(() => false);
    say(`cleanup client ${redact(cl.clientId, 64)} disabled=${ok}`);
    if (!ok) rc = 1;
  }
  say(rc === 0 ? `cleanup complete: no active ${prefix}* client remains on ${c.tenant} (${live.length} disabled now)` : 'cleanup INCOMPLETE: a temporary writer client is still active; see lines above');
  return rc;
}

export async function main(argv, env, deps = {}) {
  const c = parseArgs(argv, env);
  const bad = validate(c);
  if (bad) { mkSay(deps, [c.oid, c.cpToken])(`REFUSED (input): ${redact(bad, 200)}. Nothing was contacted.`); return 2; }
  return c.phase === 'map' ? phaseMap(c, deps) : phaseCleanup(c, deps);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main(process.argv.slice(2), process.env).then((code) => process.exit(code));
