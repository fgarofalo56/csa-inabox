#!/usr/bin/env node
/**
 * Orchestrator for .github/workflows/lhds-fhiruser-map.yml (Inferno one-off, operator-approved 2026-11-27; the durable
 * console surface is #5472). Makes a real Entra user's SMART sign-in carry a `fhirUser` claim on an EXISTING LHDS tenant:
 *
 *   map      1. GET the tenant (must exist, be `active`, and live on --stamp).
 *            2. GET the fhir-users mapping for the oid. A mapping to anything but a Practitioner is REFUSED. A mapping to
 *               Practitioner/<id> is verified in-cluster; if that Practitioner answers 404/410 the run REFUSES (nothing
 *               changed) unless --replace-missing true, because the mapping may be one this tool did not make.
 *            3. Register a TEMPORARY backend client (prefix `fu`, scope system/Practitioner.cr, role fhir-data-writer)
 *               and mint its token (mint-tenant-token.mjs: ES384 key in memory, private_key_jwt, issuer discovered).
 *               Its id is appended to --client-file as soon as the mint returns (a `pending` line is written BEFORE the
 *               mint, so cleanup knows one was requested).
 *            4. ONE `az aks command invoke` runs a generated sh+curl script in the aks-command pod against the tenant's
 *               engine ClusterIP Service at the BARE base (http://fhir-<slug>.loom-health.svc.cluster.local:80/fhir,
 *               the DEFAULT partition since #5496). Not mapped (or replacing a missing target) = a CONDITIONAL create
 *               (If-None-Exist on the STABLE identifier urn:loom:lhds:synthetic-practitioner|fhiruser-map-<tenant>) of
 *               one SYNTHETIC Practitioner (meta.tag v3-ActReason HTEST, name.text = --display-name): 201 creates it,
 *               200 reuses the one an earlier run made, so a re-run never makes a duplicate. Then it is read back.
 *            5. PUT /api/health/auth/tenants/{t}/fhir-users/{oid} {resource:"Practitioner/<id>"} and read it back.
 *               The route takes no If-Match: it re-reads its own etag between its get and replace. So there is a
 *               GET->PUT race with a concurrent writer of the SAME mapping (the console, #5472); the read-back after the
 *               PUT is what detects a lost race, nothing here makes the write exclusive.
 *            OPTIONAL, additive (each off unless asked for; the map part above runs exactly as without them):
 *   bind     --bind-group-id <GUID> [--bind-role fhir-smart-user|fhir-data-reader]: a PREFLIGHT after the mapping
 *            checks and BEFORE the mint GETs /api/health/auth/tenants/{t}/bindings and decides (refusals here create
 *            nothing). Only AFTER the mapping succeeds is it re-read, the pair MERGED into the existing list (never
 *            dropping one, nothing added when present), PUT back with v1Scopes:false, and read back (the pair, every
 *            prior pair, v1Scopes:false). So a map refusal or failure leaves the bindings unwritten. The role must be
 *            one of BINDABLE_ROLES (read-only SMART ceilings: the job has no environment approval, so no writer,
 *            exporter, tenant-admin or break-glass role is one dispatch away) AND an id in
 *            apps/loom-health-cp/src/auth/role-scope-map.v1.json, read from that file at run time (fails closed if
 *            removed). The group id must not equal the oid secret (it is printed; the oid is not).
 *            Why v1Scopes:false: parseDataScope accepts v2 permissions (.rs) whatever the flag, so v1 does NOT block
 *            Inferno's scopes. false KEEPS the effective state of a tenant with no doc (auth reads a missing doc as
 *            `b?.v1Scopes ?? false`, although the GET of a missing doc answers v1Scopes:true, which is why that value is
 *            never echoed back), and stops advertising `permission-v1`. Why a flip is guarded: on an EXISTING doc with
 *            v1Scopes:true, false stops v1 scopes (.read/.write/.*) being accepted on every SMART authorize of the
 *            tenant, for every client. So such a doc with bindings other than this pair is REFUSED unless
 *            --set-v2-scopes true. The PUT takes no If-Match: a concurrent writer can race the GET->PUT; the read-back
 *            detects a lost pair, it does not prevent one.
 *   seed     --seed-patient true: the same temporary client, its scope widened to system/Practitioner.cr
 *            system/Patient.cr (ONLY then), and the same pod run does a CONDITIONAL create (If-None-Exist on
 *            urn:loom:lhds:synthetic-patient|fhiruser-map-<tenant>) of ONE synthetic Patient (HTEST meta.tag, name
 *            "Synthetic InfernoPatient", no PHI) at the bare base, then reads it back. 201 SEEDED, 200 UNCHANGED. It
 *            is SKIPPED when the mapped Practitioner did not resolve (a refusal creates nothing).
 *            The VERDICT line names each part: map=MAPPED|UNCHANGED, bind=BOUND|UNCHANGED, seed=SEEDED|UNCHANGED
 *            (or not-requested / not-run / not-written / skipped / FAIL / UNMEASURED).
 *            The minted client is DISABLED in a finally on the normal and error paths. On SIGTERM/SIGINT a bounded
 *            (SIGNAL_DISABLE_MS) best-effort disable runs before exit 143. A SIGKILL or a lost runner skips both:
 *            that is what the cleanup phase is for.
 *   cleanup  (workflow `if: always()`) PATCH-disables every client id recorded in --client-file and checks the PATCH
 *            answer says `disabled` (the control plane has no single-client GET; the PATCH returns the replaced doc).
 *            Only when the file shows a mint was requested but no id was recorded does it fall back to listing
 *            clients; that list is capped at 500 by the control plane (server.ts stores.clients.list(500)) and sorted
 *            by id, so a page of 500 is reported UNMEASURED (exit 1), never "complete".
 *
 * The oid comes ONLY from env LHDS_FHIRUSER_OID (a repo secret: the repo is public, inputs are visible). It is never
 * printed: every output line is scrubbed of it in every letter case BEFORE any truncation, and the summary carries only
 * the tenant, the Practitioner reference and mapping=ok (plus, when asked for, the bound group id + role and the Patient
 * reference; a group id is not the user's oid). Tokens and keys are never printed or written outside a 0600
 * temp dir that is deleted in a finally.
 *
 * Exit 0 mapped (created, reused or already mapped), 1 defect / refused, 2 unmeasured (deploy-integrity R7: an outcome
 * that was not established is never reported as a defect or as a pass).
 *
 * Args: --phase map|cleanup --cp-url --tenant --stamp [--display-name] [--replace-missing true|false] [--issuer-path]
 *       [--aks-rg --aks-name --aks-subscription] [--summary-file] [--client-file]
 *       [--bind-group-id <GUID> --bind-role <role> --set-v2-scopes true|false] [--seed-patient true|false] [--role-map]
 * Env:  LHDS_CP_TOKEN (control-plane bearer), LHDS_FHIRUSER_OID (map only).
 */
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** STABLE per tenant, so the conditional create of a re-run matches the Practitioner an earlier run made. */
export const syntheticIdentifierValue = (tenant) => `fhiruser-map-${tenant}`;
export const clientPrefixFor = (tenant) => `${GRANT.clientPrefix}-${tenant}-`;
/** The grant ONLY when --seed-patient true: the Practitioner grant plus exactly the Patient create/read. */
export const SEED_GRANT = Object.freeze({ ...GRANT, scope: 'system/Practitioner.cr system/Patient.cr', allowedScopes: ['system/Practitioner.cr', 'system/Patient.cr'] });
export const grantFor = (seed) => (seed ? SEED_GRANT : GRANT);
export const SYNTHETIC_PATIENT_IDENTIFIER_SYSTEM = 'urn:loom:lhds:synthetic-patient';
export const SYNTHETIC_PATIENT_NAME = Object.freeze({ use: 'official', text: 'Synthetic InfernoPatient', family: 'Synthetic', given: ['InfernoPatient'] });
export const DEFAULT_BIND_ROLE = 'fhir-smart-user';
/** The control plane's role list source (role-map.ts imports it; ROLE_IDS = its roles[].id). Read, never transcribed. */
export const ROLE_MAP_URL = new URL('../../../apps/loom-health-cp/src/auth/role-scope-map.v1.json', import.meta.url);
/**
 * The ONLY roles a dispatch input may bind: read-only SMART ceilings. The job has no environment approval, so a writer,
 * exporter, tenant-admin or break-glass role must never be one dispatch away. Intersected with the ids READ from the
 * role map, so a role removed from the file fails closed and the file stays the source of what exists.
 */
export const BINDABLE_ROLES = Object.freeze(['fhir-smart-user', 'fhir-data-reader']);
export const bindableRoles = (fileRoles) => new Set(BINDABLE_ROLES.filter((r) => fileRoles.has(r)));
/** server.ts BindingsSchema: bindings .max(100). */
export const BINDINGS_MAX = 100;

/** The role ids the control plane accepts, read from role-scope-map.v1.json (or a test file). Throws when unreadable. */
export function roleIdsFrom(file = ROLE_MAP_URL) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(j?.roles)) throw new Error('the role map has no roles[] array');
  return new Set(j.roles.map((r) => r?.id).filter((x) => typeof x === 'string'));
}
/** The control plane's client list cap (apps/loom-health-cp/src/auth/server.ts `stores.clients.list(500)`). */
export const CLIENT_LIST_CAP = 500;
export const SIGNAL_DISABLE_MS = 10_000;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{3,64}$/;

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
    displayName: pick('display-name', DEFAULT_DISPLAY_NAME), replaceMissing: pick('replace-missing', 'false'),
    issuerPath: pick('issuer-path', '/auth'), aksRg: pick('aks-rg'), aksName: pick('aks-name'), aksSub: pick('aks-subscription'),
    summaryFile: pick('summary-file'), clientFile: pick('client-file'),
    bindGroupId: pick('bind-group-id'), bindRole: pick('bind-role', DEFAULT_BIND_ROLE) || DEFAULT_BIND_ROLE,
    setV2Scopes: pick('set-v2-scopes', 'false'), seedPatient: pick('seed-patient', 'false'), roleMap: pick('role-map'),
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
  if (!['true', 'false'].includes(c.replaceMissing)) return 'replace-missing must be true or false';
  if (!/^[A-Za-z0-9._()-]{1,90}$/.test(c.aksRg)) return 'aks-rg is required (the stamp resource group)';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(c.aksName)) return 'aks-name is required (the stamp AKS cluster)';
  if (c.aksSub && !GUID_RE.test(c.aksSub)) return 'aks-subscription must be a GUID when given';
  if (!['true', 'false'].includes(c.seedPatient ?? 'false')) return 'seed-patient must be true or false';
  if (!['true', 'false'].includes(c.setV2Scopes ?? 'false')) return 'set-v2-scopes must be true or false';
  if (c.bindGroupId) {
    if (!GUID_RE.test(c.bindGroupId)) return 'bind-group-id must be a GUID (the Entra group object id)';
    // The user's oid is a secret; a group id is printed. Equal = the operator pasted the oid: refuse, echo neither.
    if (c.oid && c.bindGroupId.toLowerCase() === c.oid.toLowerCase()) return 'bind-group-id equals the LHDS_FHIRUSER_OID secret (a user object id, not a group); neither value is printed';
    if (!/^[a-z0-9-]{1,64}$/.test(c.bindRole)) return 'bind-role must be 1-64 chars of a-z, 0-9 and hyphen';
    let roles;
    try { roles = roleIdsFrom(c.roleMap || ROLE_MAP_URL); } catch (e) { return `could not read the role map (${redact(e?.message ?? 'error', 120)}), so bind-role is not validated`; }
    const allowed = bindableRoles(roles);
    if (!allowed.has(c.bindRole)) return `bind-role ${c.bindRole} is not bindable by this workflow: allowed are ${[...allowed].join(', ') || '(none: the role map has neither)'} (the read-only SMART roles present in role-scope-map.v1.json)`;
  }
  return null;
}

/** The synthetic Practitioner. No PHI: a fixed family name, the operator's display text, a synthetic tag and a STABLE identifier. */
export function practitionerBody({ displayName, tenant }) {
  if (!DISPLAY_NAME_RE.test(displayName)) throw new Error('practitionerBody: display name has characters outside the allowed set');
  if (!SLUG_RE.test(tenant)) throw new Error('practitionerBody: tenant is not a slug');
  return {
    resourceType: 'Practitioner',
    meta: { tag: [{ ...SYNTHETIC_TAG }] },
    identifier: [{ system: SYNTHETIC_IDENTIFIER_SYSTEM, value: syntheticIdentifierValue(tenant) }],
    active: true,
    name: [{ use: 'official', text: displayName, family: 'Synthetic', given: ['Inferno'] }],
  };
}

/** The synthetic Patient (--seed-patient). No PHI: a fixed synthetic name, the HTEST tag and a STABLE identifier. */
export function patientBody({ tenant }) {
  if (!SLUG_RE.test(tenant)) throw new Error('patientBody: tenant is not a slug');
  return {
    resourceType: 'Patient',
    meta: { tag: [{ ...SYNTHETIC_TAG }] },
    identifier: [{ system: SYNTHETIC_PATIENT_IDENTIFIER_SYSTEM, value: syntheticIdentifierValue(tenant) }],
    active: true,
    name: [{ ...SYNTHETIC_PATIENT_NAME, given: [...SYNTHETIC_PATIENT_NAME.given] }],
  };
}

/**
 * The script run in the aks-command pod (sh builtins + curl only, as the CRUD probe measured). The token is NOT in this
 * text: it arrives as the header file `hdr`, read with `curl -H @hdr`. The body arrives as practitioner.json. Prints
 * only `MAP ...` lines. With an existing id it GETs that Practitioner first; it goes on to the create only on a 404/410
 * answer AND replaceMissing. The create is conditional on the stable identifier (If-None-Exist). With seed, a second
 * block conditionally creates the synthetic Patient from patient.json and prints `SEED ...` lines; it runs whatever the
 * Practitioner block concluded (it is judged separately).
 */
export function renderMapScript({ tenant, existingId = '', replaceMissing = false, seed = false }) {
  if (!SLUG_RE.test(tenant)) throw new Error('renderMapScript: tenant is not a slug');
  if (existingId && !FHIR_ID.test(existingId)) throw new Error('renderMapScript: existing id is not a FHIR id');
  return `#!/bin/sh
# Generated by scripts/measure/health/lhds-fhiruser-map.mjs. Holds no secret: the token is the header file hdr.
# Prints MAP and SEED lines only. curl stderr is discarded; no header, token or response body is ever printed.
set -u
BASE='${engineBase(tenant)}'
EXISTING='${existingId}'
REPLACE_MISSING='${replaceMissing ? 'yes' : 'no'}'
SEED='${seed ? 'yes' : 'no'}'
INE='If-None-Exist: identifier=${SYNTHETIC_IDENTIFIER_SYSTEM}|${syntheticIdentifierValue(tenant)}'
PINE='If-None-Exist: identifier=${SYNTHETIC_PATIENT_IDENTIFIER_SYSTEM}|${syntheticIdentifierValue(tenant)}'
TMP="\${TMPDIR:-/tmp}/lhds-fumap.$$"
HF="$TMP.h"
BF="$TMP.b"
# rm -f is already silent on a missing file.
trap 'rm -f "$HF" "$BF" hdr practitioner.json patient.json' EXIT
CR=$(printf '\\r')
CODE=000

# req <METHOD> <url> [bodyfile] -> sets CODE; headers in $HF, body in $BF. A body means a CONDITIONAL create on $INE.
req() {
  : > "$HF" 2>/dev/null; : > "$BF" 2>/dev/null
  if [ "$#" -ge 3 ]; then
    CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$1" -H "@hdr" -H "$INE" -H 'content-type: application/fhir+json' --data-binary "@$3" "$2" 2>/dev/null) || CODE=000
  else
    CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$1" -H "@hdr" -H 'accept: application/fhir+json' "$2" 2>/dev/null) || CODE=000
  fi
  case "$CODE" in [0-9][0-9][0-9]) ;; *) CODE=000 ;; esac
}

location() {
  loc=''
  while IFS= read -r line; do
    line=\${line%"$CR"}
    case "$line" in [Ll]ocation:*|[Cc]ontent-[Ll]ocation:*) [ -n "$loc" ] || loc=\${line#*:} ;; esac
  done < "$HF"
  printf '%s' "$loc"
}

# The resource type the helpers below read ($RT): Practitioner, then Patient for the seed block.
RT=Practitioner

created_id() {
  loc=$(location)
  case "$loc" in *"/$RT/"*) rest=\${loc#*/"$RT"/}; id=\${rest%%/*} ;; *) id='' ;; esac
  case "$id" in ''|*[!A-Za-z0-9.-]*) id='' ;; esac
  printf '%s' "$id"
}

location_bare() {
  case "$(location)" in *"/fhir/$RT/"*) printf 'yes' ;; *) printf 'no' ;; esac
}

body_is() { # $1 = id ; 0 when the response body is a $RT whose id is $1
  b=''
  while IFS= read -r line || [ -n "$line" ]; do b="$b$line"; done < "$BF"
  case "$b" in *'"resourceType":"'"$RT"'"'*|*'"resourceType": "'"$RT"'"'*) ;; *) return 1 ;; esac
  case "$b" in *'"id":"'"$1"'"'*|*'"id": "'"$1"'"'*) return 0 ;; esac
  return 1
}

# create_read <TAG> <bodyfile>: conditional create of $RT on $INE, then a read-back; prints <TAG> lines.
create_read() {
  req POST "$BASE/$RT" "$2"
  NID=''; BARE=no
  case "$CODE" in 200|201) NID=$(created_id); BARE=$(location_bare) ;; esac
  if [ -n "$NID" ]; then echo "$1 step=create status=$CODE id=$NID bare=$BARE"; else echo "$1 step=create status=$CODE bare=$BARE"; fi
  if [ -n "$NID" ]; then
    req GET "$BASE/$RT/$NID"
    if [ "$CODE" = "200" ] && body_is "$NID"; then echo "$1 step=read status=$CODE id_match=yes"; else echo "$1 step=read status=$CODE id_match=no"; fi
  fi
}

# STOPPED=yes when the mapped Practitioner did not resolve and nothing was created for it (a refusal or a wrong
# answer): the seed is then SKIPPED, so a refused run creates nothing anywhere.
STOPPED=no
practitioner() {
  if [ -n "$EXISTING" ]; then
    req GET "$BASE/Practitioner/$EXISTING"
    if [ "$CODE" = "200" ] && body_is "$EXISTING"; then echo "MAP step=verify status=$CODE id_match=yes"; return 0; fi
    echo "MAP step=verify status=$CODE id_match=no"
    case "$CODE" in 404|410) ;; *) STOPPED=yes; return 0 ;; esac
    [ "$REPLACE_MISSING" = "yes" ] || { STOPPED=yes; return 0; }
  fi
  create_read MAP practitioner.json
}

practitioner
if [ "$SEED" = "yes" ] && [ "$STOPPED" = "no" ]; then
  RT=Patient
  INE="$PINE"
  create_read SEED patient.json
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
 * to do), `created` (201) or `reused` (200: the conditional create matched an earlier run's Practitioner), or undefined
 * with code 1 (the engine answered wrongly, or a missing target without replaceMissing) / 2 (no usable answer).
 */
export function judgeMap(p, existingId = '', replaceMissing = false) {
  if (existingId) {
    const v = p.verify;
    if (!v) return { code: 2, note: 'no verify line for the mapped Practitioner' };
    if (v.status === 200 && v.idMatch === true) return { code: 0, kind: 'existing', id: existingId, note: 'the mapped Practitioner resolves (GET 200, same id)' };
    if (v.status === 200) return { code: 1, stopped: true, note: 'the mapped Practitioner answered 200 with a body that is not that Practitioner' };
    if (NO_ANSWER(v.status)) return { code: 2, stopped: true, note: v.status === 0 ? 'curl got no HTTP answer from the engine' : 'the engine answered 503 for the mapped Practitioner' };
    if (v.status !== 404 && v.status !== 410) return { code: 1, stopped: true, note: `the mapped Practitioner answered ${v.status}; expected 200 (or 404/410). Nothing was created` };
    if (!replaceMissing) {
      return { code: 1, stopped: true, note: `REFUSED: the mapping points at Practitioner/${existingId}, which answers ${v.status}. It may be a mapping this tool did not make, so no Practitioner was created and the mapping was not changed; dispatch again with replace_missing=true to replace it` };
    }
  }
  return judgeCreateRead(p, 'Practitioner');
}

/** The create + read-back verdict shared by the Practitioner (MAP lines) and the seeded Patient (SEED lines). */
function judgeCreateRead(p, noun) {
  const c = p.create;
  if (!c) return { code: 2, note: 'no create line from the pod' };
  if (NO_ANSWER(c.status)) return { code: 2, note: c.status === 0 ? 'curl got no HTTP answer from the engine' : 'the engine answered 503 to the create' };
  if (c.status === 403) return { code: 1, note: 'the engine refused the create (403). A PDP deny and a tenant not homed in the published bundle read the same from here; the rule that fired is in the engine audit log, not established by this run' };
  if (c.status === 412) return { code: 1, note: `the conditional create answered 412: more than one ${noun} carries the synthetic identifier, so which one to ${noun === 'Practitioner' ? 'map' : 'use'} is not established` };
  if (c.status !== 201 && c.status !== 200) return { code: 1, note: `the create answered ${c.status}; expected 201 (created) or 200 (an earlier run's ${noun} matched)` };
  if (!c.id) return { code: 1, note: `the create answered ${c.status}, but no Location carried a ${noun} id` };
  if (c.bare !== true) return { code: 1, note: 'the Location carries a partition segment: the bare-base reference would not resolve' };
  const r = p.read;
  if (!r) return { code: 2, note: 'no read-back line' };
  if (NO_ANSWER(r.status)) return { code: 2, note: 'no usable answer to the read-back' };
  if (r.status !== 200 || r.idMatch !== true) return { code: 1, note: `the read-back answered ${r.status} id_match=${r.idMatch === true}; expected 200 and the same id` };
  const kind = c.status === 201 ? 'created' : 'reused';
  return { code: 0, kind, id: c.id, note: kind === 'created' ? `a synthetic ${noun} was created and read back` : `the conditional create matched the synthetic ${noun} an earlier run made; reused and read back` };
}

const SEED_LINE = /^SEED step=(create|read) status=(\d{3})(?: id=([A-Za-z0-9.-]{1,64}))?(?: id_match=(yes|no))?(?: bare=(yes|no))?$/;

/** Only exact SEED lines are read (the Patient block). The last line per step wins. */
export function parseSeedLogs(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = SEED_LINE.exec(raw.trim());
    if (!m) continue;
    out[m[1]] = { status: Number(m[2]), ...(m[3] ? { id: m[3] } : {}), ...(m[4] ? { idMatch: m[4] === 'yes' } : {}), ...(m[5] ? { bare: m[5] === 'yes' } : {}) };
  }
  return out;
}

/** The seeded Patient: { code, kind: created|reused, id, note }, as judgeMap's create path. */
export const judgeSeed = (p) => judgeCreateRead(p, 'Patient');

/** 1 (a defect) outranks 2 (unmeasured) outranks 0. */
const worst = (...codes) => (codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0);

/**
 * The role binding (--bind-group-id). Returns { code, state: BOUND|UNCHANGED|PLANNED, note }. Never drops a binding;
 * refuses a v1Scopes true->false flip on a tenant with OTHER bindings unless setV2. Reads back the pair, the old pairs
 * and v1Scopes. `dryRun` reads and decides only (the preflight before the mint): it never PUTs. Every refusal note says
 * only that the BINDINGS were not changed; what else the run did is the caller's to state.
 */
export async function bindGroup({ tenant, groupId, roleId, setV2, dryRun = false }, api, et) {
  const path = `/api/health/auth/tenants/${encodeURIComponent(tenant)}/bindings`;
  const pair = { groupId: groupId.toLowerCase(), roleId };
  const key = (x) => `${String(x.groupId).toLowerCase()} ${x.roleId}`;
  const g = await api('GET', path);
  if (g.status !== 200 || !Array.isArray(g.json?.data?.bindings)) return { code: 2, note: `UNMEASURED: could not read the role bindings of ${tenant}: ${et(g)}. The bindings were not changed` };
  const raw = g.json.data.bindings;
  const cur = raw.filter((x) => typeof x?.groupId === 'string' && typeof x?.roleId === 'string').map((x) => ({ groupId: x.groupId, roleId: x.roleId }));
  if (cur.length !== raw.length) return { code: 1, note: `REFUSED: a binding entry of ${tenant} is not {groupId, roleId}; this tool does not rewrite a document it cannot read. The bindings were not changed` };
  // A stored doc carries its id (binding-<tenant>); the GET of a tenant with NO doc answers { tenant, bindings: [],
  // v1Scopes: true } with no id. Auth reads a missing doc as v1 OFF (server.ts `b?.v1Scopes ?? false`), so the
  // EFFECTIVE v1 state is true only for an existing doc that says true.
  const docExists = typeof g.json.data.id === 'string' && g.json.data.id.length > 0;
  const v1 = docExists && g.json.data.v1Scopes !== false;
  const present = cur.some((x) => key(x) === key(pair));
  if (present && !v1) return { code: 0, state: 'UNCHANGED', note: `group ${pair.groupId} is already bound to ${roleId} with v1Scopes=false; nothing written` };
  const others = cur.filter((x) => key(x) !== key(pair));
  if (v1 && others.length > 0 && !setV2) {
    return { code: 1, note: `REFUSED: the bindings of ${tenant} have v1Scopes=true and ${others.length} other binding(s). Writing v1Scopes=false means v1 .read/.write/.* scopes stop being accepted on EVERY SMART authorize on this tenant and permission-v1 is no longer advertised in its smart-configuration, for every client, not only Inferno. The bindings were not changed; dispatch again with set_v2_scopes=true to accept that` };
  }
  const next = present ? cur : [...cur, pair];
  if (next.length > BINDINGS_MAX) return { code: 1, note: `REFUSED: ${tenant} already has ${cur.length} bindings; adding one exceeds the control plane cap of ${BINDINGS_MAX}. The bindings were not changed` };
  if (dryRun) return { code: 0, state: 'PLANNED', note: `preflight: group ${pair.groupId} -> ${roleId} will be written after the mapping succeeds (${others.length} other binding(s) kept${v1 ? ', v1Scopes true->false' : ''})` };
  const p = await api('PUT', path, { bindings: next, v1Scopes: false });
  if (p.status !== 200) return { code: p.status === 'network-error' || p.status === 503 ? 2 : 1, note: `FAIL: the bindings PUT was not confirmed (whether it landed is not established): ${et(p)}` };
  const back = await api('GET', path);
  const got = Array.isArray(back.json?.data?.bindings) ? back.json.data.bindings.filter((x) => typeof x?.groupId === 'string' && typeof x?.roleId === 'string') : undefined;
  if (back.status !== 200 || !got) return { code: 2, note: `UNMEASURED: the PUT answered 200 but the read-back failed: ${et(back)}` };
  const have = new Set(got.map(key));
  const lost = cur.filter((x) => !have.has(key(x)));
  if (!have.has(key(pair)) || back.json.data.v1Scopes !== false || lost.length > 0) {
    return { code: 1, note: `FAIL: the bindings read-back has pair=${have.has(key(pair))} v1Scopes=${back.json.data.v1Scopes === false ? 'false' : 'not false'} lost_prior=${lost.length}; expected the pair, v1Scopes=false and every prior binding (a concurrent writer can race the GET->PUT)` };
  }
  // A PUT was written (the pair, or only the v1Scopes flip of a present pair), so this is BOUND, never UNCHANGED.
  return { code: 0, state: 'BOUND', note: `group ${pair.groupId} bound to ${roleId}${present ? ' (already present)' : ''}; ${others.length} other binding(s) kept${v1 ? '; v1Scopes switched true->false' : docExists ? '' : '; first binding doc created with v1Scopes=false (a missing doc already read as v1 off)'}; read back` };
}

const mkSay = (deps, secrets) => {
  const out = deps.out ?? ((s) => console.log(s));
  return (s) => out(scrub(`lhds-fhiruser-map: ${s}`, secrets));
};
/** Scrub BEFORE truncating: a secret straddling the cut would otherwise survive as a fragment scrub no longer matches. */
const errText = (r, secrets) => r.status === 'network-error' ? `network-error ${r.code}`
  : `HTTP ${r.status} ${redact(scrub(r.json?.error?.code ?? '-', secrets), 60)}: ${redact(scrub(r.json?.error?.message ?? '(no body)', secrets), 200)}`;

/** One in-cluster run; polls `az aks command result` while ARM reports a non-terminal state (as the CRUD probe does). */
async function invokeInCluster(c, deps, say, dir, secrets, seed = false) {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  const target = ['-g', c.aksRg, '-n', c.aksName, ...(c.aksSub ? ['--subscription', c.aksSub] : [])];
  const files = ['map.sh', 'hdr', 'practitioner.json', ...(seed ? ['patient.json'] : [])].flatMap((f) => ['--file', f]);
  let r = await exec('az', ['aks', 'command', 'invoke', ...target, '--command', 'sh map.sh', ...files, '-o', 'json'], { cwd: dir });
  let logs = ''; let state = ''; let sub = 'invoke';
  const read = (o) => { try { const j = JSON.parse(o.stdout); logs = String(j.logs ?? ''); state = String(j.provisioningState ?? ''); return j; } catch { logs = ''; state = 'unparseable'; return undefined; } };
  const first = read(r);
  const id = String(first?.id ?? '');
  if (r.code === 0 && first && !TERMINAL_RUN_STATES.has(state) && COMMAND_ID_RE.test(id)) {
    for (let i = 1; i <= RESULT_MAX_POLLS && !TERMINAL_RUN_STATES.has(state); i++) {
      say(`command is ${redact(scrub(state || 'unreported', secrets), 20)}; polling its result (${i}/${RESULT_MAX_POLLS})`);
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

/** Append one line to the client file (non-secret: `pending` or a client id). No file configured = no-op. */
function recordClient(c, line) {
  if (c.clientFile) appendFileSync(c.clientFile, `${line}\n`);
}

/** A bounded best-effort promise: resolves false after `ms` if `p` has not settled. */
const bounded = (p, ms, setT = setTimeout, clearT = clearTimeout) => new Promise((resolve) => {
  const t = setT(() => resolve(false), ms);
  Promise.resolve(p).then((v) => { clearT(t); resolve(v); }, () => { clearT(t); resolve(false); });
});

export async function phaseMap(c, deps = {}) {
  const secrets = [c.oid, c.cpToken];
  const say = mkSay(deps, secrets);
  const exit = deps.exit ?? ((n) => process.exit(n));
  const api = (method, path, body) => cpCall(deps, method, `${new URL(c.cpUrl).origin}${path}`, { body, bearer: c.cpToken });
  const et = (r) => errText(r, secrets);
  const oid = c.oid.toLowerCase();
  const replaceMissing = c.replaceMissing === 'true';
  const fu = `/api/health/auth/tenants/${encodeURIComponent(c.tenant)}/fhir-users/${encodeURIComponent(oid)}`;
  const seed = c.seedPatient === 'true';
  const grant = grantFor(seed);
  // What each part did, for the VERDICT line. A part that was not asked for is never run.
  const parts = { map: 'not-run', bind: c.bindGroupId ? 'not-run' : 'not-requested', seed: seed ? 'not-run' : 'not-requested' };
  const label = (n) => (n === 1 ? 'FAIL' : 'UNMEASURED');
  let clientId;
  let dir;
  let code = 0;
  const wipe = () => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } };
  // A signal skips the finally (process.exit), so the client is disabled HERE, bounded, before exiting.
  const onSig = async () => {
    wipe();
    if (clientId) {
      const ok = await bounded(disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, clientId), SIGNAL_DISABLE_MS);
      say(`signal: client ${clientId} disabled=${ok}${ok ? '' : ' (NOT confirmed within the bound: the always() cleanup step retries it)'}`);
    }
    exit(143);
  };
  try {
    const t = await api('GET', `/api/health/tenants/${encodeURIComponent(c.tenant)}`);
    if (t.status === 404) { say(`REFUSED: tenant ${c.tenant} does not exist (HTTP 404). Nothing was created.`); return (code = 1); }
    if (t.status !== 200 || !t.json?.data) { say(`UNMEASURED: could not read tenant ${c.tenant}: ${et(t)}. Nothing was created.`); return (code = 2); }
    if (t.json.data.stampId !== c.stamp) { say(`REFUSED: tenant ${c.tenant} is on stamp ${redact(scrub(t.json.data.stampId, secrets), 20)}, not ${c.stamp}. Nothing was created.`); return (code = 1); }
    if (t.json.data.status !== 'active') { say(`REFUSED: tenant ${c.tenant} is ${redact(scrub(t.json.data.status, secrets), 20)}, not active. Nothing was created.`); return (code = 1); }

    const m = await api('GET', fu);
    let existingId = '';
    if (m.status === 200) {
      const res = String(m.json?.data?.resource ?? '');
      const pm = /^Practitioner\/(.+)$/.exec(res);
      if (!pm || !FHIR_ID.test(pm[1])) {
        say(`REFUSED: this oid is already mapped on ${c.tenant} to a ${redact(scrub(res.split('/')[0] || 'malformed reference', secrets), 20)}, not a Practitioner. This workflow does not overwrite a mapping it did not make. Nothing was changed.`);
        return (code = 1);
      }
      existingId = pm[1];
      say(`an existing mapping points at Practitioner/${existingId}; verifying it resolves before doing anything else`);
    } else if (m.status !== 404) {
      say(`UNMEASURED: could not read the existing mapping: ${et(m)}. Nothing was created.`);
      return (code = 2);
    } else say(`no fhirUser mapping for this oid on ${c.tenant} yet`);

    const bindArgs = { tenant: c.tenant, groupId: c.bindGroupId, roleId: c.bindRole, setV2: c.setV2Scopes === 'true' };
    if (c.bindGroupId) {
      // PREFLIGHT only, BEFORE the mint: a refusal here (e.g. the v1Scopes guard) leaves nothing created anywhere. The
      // bindings are WRITTEN only after the mapping succeeds, so a later refusal or failure has not changed them either.
      const b = await bindGroup({ ...bindArgs, dryRun: true }, api, et);
      say(`bind: ${redact(scrub(b.note, secrets), 600)}`);
      if (b.code !== 0) { parts.bind = label(b.code); say('nothing was created: no client, no Practitioner, no Patient, no mapping, no binding'); return (code = b.code); }
      parts.bind = b.state === 'UNCHANGED' ? 'UNCHANGED' : 'not-written';
    }

    process.once('SIGTERM', onSig);
    process.once('SIGINT', onSig);
    recordClient(c, 'pending');
    const tok = await mintTenantToken({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken, tenant: c.tenant, issuerPath: c.issuerPath, ...grant });
    clientId = tok.clientId;
    recordClient(c, clientId);
    secrets.push(tok.accessToken);
    const granted = new Set(tok.scope.split(' ').filter(Boolean));
    if (granted.size !== grant.allowedScopes.length || !grant.allowedScopes.every((x) => granted.has(x))) { say(`REFUSED: the minted token carries scope "${redact(scrub(tok.scope, secrets), 120)}", not exactly ${grant.scope}. The engine was not contacted.`); return (code = 1); }
    say(`temporary client ${clientId} minted scope=${grant.scope} role=${grant.roleIds[0]}`);

    dir = mkdtempSync(join(deps.tmpRoot ?? process.env.RUNNER_TEMP ?? tmpdir(), 'lhds-fumap-'));
    try { chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
    const put = (name, text) => { writeFileSync(join(dir, name), text, { mode: 0o600 }); try { chmodSync(join(dir, name), 0o600); } catch { /* as above */ } };
    put('map.sh', renderMapScript({ tenant: c.tenant, existingId, replaceMissing, seed }));
    put('hdr', `Authorization: Bearer ${tok.accessToken}\n`);
    put('practitioner.json', JSON.stringify(practitionerBody({ displayName: c.displayName, tenant: c.tenant })));
    if (seed) put('patient.json', JSON.stringify(patientBody({ tenant: c.tenant })));
    say(`running in the aks-command pod of ${redact(c.aksName, 60)} against the bare base of ${c.tenant}`);
    const logs = await invokeInCluster(c, deps, say, dir, secrets, seed);
    if (logs === undefined) { parts.map = 'UNMEASURED'; if (seed) parts.seed = 'UNMEASURED'; return (code = 2); }
    const v = judgeMap(parseMapLogs(logs), existingId, replaceMissing);
    let seedV = { code: 0 };
    if (seed && v.stopped) {
      // The pod skips the Patient block when the mapped Practitioner did not resolve (STOPPED=yes); any SEED line is
      // not read, so a refused run reports no seed.
      parts.seed = 'skipped';
    } else if (seed) {
      // Judged on its own: past the verify, the Patient block runs whatever the Practitioner create concluded.
      seedV = judgeSeed(parseSeedLogs(logs));
      say(`seed: ${seedV.code === 0 ? 'OK' : label(seedV.code)} ${redact(scrub(seedV.note, secrets), 400)}`);
      parts.seed = seedV.code === 0 ? (seedV.kind === 'created' ? 'SEEDED' : 'UNCHANGED') : label(seedV.code);
    }
    say(`engine: ${v.code === 0 ? 'OK' : v.code === 1 ? 'FAIL' : 'UNMEASURED'} ${redact(scrub(v.note, secrets), 400)}`);
    if (v.code !== 0) {
      parts.map = label(v.code);
      if (v.stopped) say(`also: ${c.bindGroupId ? 'the binding was NOT written (preflight only)' : 'no binding was requested'}; ${seed ? 'the Patient seed was SKIPPED' : 'no seed was requested'}`);
      else if (c.bindGroupId && parts.bind !== 'UNCHANGED') say('also: the binding was NOT written (it is written only after the mapping succeeds)');
      return (code = worst(v.code, seedV.code));
    }
    const ref = `Practitioner/${v.id}`;

    if (v.kind !== 'existing') {
      const p = await api('PUT', fu, { resource: ref });
      if (p.status !== 200 || p.json?.data?.resource !== ref) {
        say(`FAIL: the mapping PUT did not confirm ${ref}: ${p.status === 200 ? `data.resource=${redact(scrub(p.json?.data?.resource, secrets), 80)}` : et(p)}. ${ref} exists in the engine but is NOT mapped.`);
        const pc = p.status === 'network-error' || p.status === 503 ? 2 : 1;
        parts.map = label(pc);
        return (code = worst(pc, seedV.code));
      }
    }
    const back = await api('GET', fu);
    const backOid = String(back.json?.data?.oid ?? '').toLowerCase();
    if (back.status !== 200 || back.json?.data?.resource !== ref || backOid !== oid) {
      say(`FAIL: the mapping read-back does not equal ${ref} for this oid: ${back.status === 200 ? `data.resource=${redact(scrub(back.json?.data?.resource, secrets), 80)} oid_matches=${backOid === oid}` : et(back)}`);
      parts.map = 'FAIL';
      return (code = 1);
    }
    parts.map = v.kind === 'existing' ? 'UNCHANGED' : 'MAPPED';
    say(`mapping ${v.kind === 'existing' ? 'already present and verified' : 'written and read back'}: ${ref}; sign-in will carry fhirUser=${redact(scrub(back.json.data.fhirUser, secrets), 200)}`);
    let bindCode = 0;
    if (c.bindGroupId && parts.bind !== 'UNCHANGED') {
      // Re-read and re-decide at write time (the preflight's view may be stale); a refusal here is stated as such.
      const b = await bindGroup(bindArgs, api, et);
      say(`bind: ${redact(scrub(b.note, secrets), 600)}`);
      parts.bind = b.code === 0 ? b.state : label(b.code);
      bindCode = b.code;
    }
    if (c.summaryFile) {
      const extra = [
        ...(c.bindGroupId ? [`- binding: group ${c.bindGroupId.toLowerCase()} -> ${c.bindRole} (${parts.bind}${bindCode === 0 ? ', v1Scopes=false' : ''})`] : []),
        ...(seed ? [seedV.code === 0 ? `- Patient: Patient/${seedV.id} (${parts.seed})` : `- Patient: ${parts.seed}`] : []),
      ];
      appendFileSync(c.summaryFile, `## lhds fhirUser map\n\n- tenant: ${c.tenant}\n- fhirUser: ${ref}\n- mapping=ok (${v.kind})\n${extra.map((x) => `${x}\n`).join('')}`);
    }
    if (seed && seedV.code === 0) say(`seeded patient: Patient/${seedV.id} (${parts.seed})`);
    return (code = worst(seedV.code, bindCode));
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
    say(`VERDICT ${code === 0 ? 'OK' : code === 1 ? 'FAIL' : 'UNMEASURED'} map=${parts.map} bind=${parts.bind} seed=${parts.seed}`);
  }
}

/** The client file as { pending, ids }. Absent file = nothing was requested. Lines that are not a client id are ignored. */
export function readClientFile(file) {
  if (!file || !existsSync(file)) return { pending: false, ids: [] };
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return { pending: lines.includes('pending'), ids: [...new Set(lines.filter((x) => x !== 'pending' && CLIENT_ID_RE.test(x)))] };
}

/**
 * Disable the clients THIS run recorded, by id, and confirm each from the PATCH answer. Exit 0 = every recorded client is
 * confirmed disabled (or none was requested); 1 = one is not confirmed, or a mint was requested with no id recorded and
 * the fallback list could not prove the absence of an active `fu-<tenant>-` client.
 */
export async function phaseCleanup(c, deps = {}) {
  const secrets = [c.oid, c.cpToken];
  const say = mkSay(deps, secrets);
  const rec = readClientFile(c.clientFile);
  const prefix = clientPrefixFor(c.tenant);
  let rc = 0;
  if (rec.ids.length === 0 && !rec.pending) {
    say('this run requested no temporary client (no client record); nothing to disable');
    return 0;
  }
  for (const id of rec.ids) {
    if (!id.startsWith(prefix)) { say(`IGNORED recorded id ${redact(scrub(id, secrets), 64)}: it is not a ${prefix}* client of this tenant`); rc = 1; continue; }
    const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, id).catch(() => false);
    say(`cleanup client ${id} disabled=${ok}${ok ? ' (the PATCH answer reads status=disabled)' : ' (NOT confirmed: the client may still be ACTIVE)'}`);
    if (!ok) rc = 1;
  }
  if (rec.ids.length === 0) {
    // A mint was requested but its id was never recorded (the process died between registration and the mint's return).
    say('a client was requested but no id was recorded; falling back to the client list');
    const list = await cpCall(deps, 'GET', `${new URL(c.cpUrl).origin}/api/health/auth/clients`, { bearer: c.cpToken });
    if (list.status !== 200 || !Array.isArray(list.json?.data?.clients)) { say(`UNMEASURED: COULD NOT LIST clients, so a temporary writer client may still be ACTIVE: ${errText(list, secrets)}`); return 1; }
    const all = list.json.data.clients;
    const live = all.filter((x) => x?.tenant === c.tenant && String(x?.clientId ?? '').startsWith(prefix) && x?.status !== 'disabled');
    for (const cl of live) {
      const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, cl.clientId).catch(() => false);
      say(`cleanup client ${redact(scrub(cl.clientId, secrets), 64)} disabled=${ok}`);
      if (!ok) rc = 1;
    }
    if (all.length >= CLIENT_LIST_CAP) {
      say(`UNMEASURED: the client list returned ${all.length} entries, the control plane cap (${CLIENT_LIST_CAP}); it is sorted by id, so a ${prefix}* client past the cap is invisible. Whether one is still ACTIVE is NOT established`);
      return 1;
    }
  }
  say(rc === 0 ? `cleanup complete: every temporary client this run recorded on ${c.tenant} is confirmed disabled` : 'cleanup INCOMPLETE: see lines above');
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
