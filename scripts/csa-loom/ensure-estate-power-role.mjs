#!/usr/bin/env node
/**
 * ensure-estate-power-role.mjs -- PRP-02 step 3 (#4876): the platform creates the
 * `Estate.Power` application role on the Console app registration and grants it to
 * the CI deploy service principal, so no human performs that step.
 *
 * The console route `/api/estate/power` (apps/fiab-console/lib/estate/estate-sp-auth.ts)
 * accepts only an Entra access token for the console audience whose `roles` claim
 * carries `Estate.Power` (ESTATE_POWER_ROLE in estate-power-contract.ts). This script
 * makes that claim obtainable:
 *
 *   1. ensure the app registration has appRole {value Estate.Power, Application,
 *      enabled} with the FIXED id below (never re-minted, never duplicated);
 *   2. ensure the console service principal exists;
 *   3. resolve the deploy SP from the logged-in identity (az account show, never a
 *      secret) and ensure ONE appRoleAssignment of that role to it;
 *   4. RE-READ both and fail unless the read-back shows them (deploy-integrity R6).
 *
 * Idempotent: a second run issues zero writes.
 *
 * Cloud: Graph host is chosen from the active cloud (AZURE_CLOUD, else
 * `az cloud show`): AzureUSGovernment -> graph.microsoft.us, AzureCloud ->
 * graph.microsoft.com. Any other value fails closed.
 *
 * Failures are classified: permission (401/403 -> exit 3, names the Graph
 * permission + who consents), transient (429/5xx/network, and the short window
 * where a freshly added role is not yet visible on the service principal ->
 * bounded backoff, then exit 4), anything else (exit 1).
 *
 * SUPPLIED-APP MODE (--supplied; deploy-integrity R5): the operator names the EXISTING
 * console app registration. Then this script NEVER lists applications or service
 * principals -- it reads by alternate key (/applications(appId='..'),
 * /servicePrincipals(appId='..')) or by --object-id, VALIDATES what it read (appId,
 * object id, signInAudience, optional display name), and derives the audience from the
 * app's live identifierUris (an app with none is addressed by its bare app id).
 * Tenant-wide LISTING needs Application.Read.All or a directory role; reading one named
 * app does not enumerate the tenant. Without --supplied the behaviour is the original
 * discover-by-filter path, unchanged.
 *
 * --validate-only: read + validate the supplied app and stop (used by
 * bootstrap-msal-app-reg.sh before it touches the app). Zero writes.
 *
 * Usage: node ensure-estate-power-role.mjs --client-id <console app id> [--console-url <url>]
 *          [--supplied [--object-id <guid>] [--expected-name <name>] [--validate-only]]
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const ESTATE_POWER_ROLE_VALUE = 'Estate.Power';
// uuid v5(NAMESPACE_URL, 'csa-loom/console/appRole/Estate.Power'), committed as a literal.
export const ESTATE_POWER_ROLE_ID = '9d4ac0e8-8f4d-5fcf-b1aa-458e27f6ec02';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_PERMISSION = 3;
export const EXIT_TRANSIENT = 4;

export const MAX_ATTEMPTS = 4;
/** Reads a fresh write gets to become visible (Graph replication), ~60s total. */
export const READBACK_ATTEMPTS = 7;
export const READBACK_DELAY_MS = 10_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sovereign endpoint selection. Unknown cloud -> throws (fail closed, no Commercial default). */
export function endpointsFor(cloud) {
  const c = String(cloud || '').trim();
  if (c === 'AzureUSGovernment') {
    return { cloud: c, graph: 'https://graph.microsoft.us', login: 'https://login.microsoftonline.us' };
  }
  if (c === 'AzureCloud') {
    return { cloud: c, graph: 'https://graph.microsoft.com', login: 'https://login.microsoftonline.com' };
  }
  throw new Error(`unsupported or unknown Azure cloud '${c}' (expected AzureCloud or AzureUSGovernment)`);
}

export class GraphError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** permission | transient | defect */
export function classify(status, message = '') {
  if (status === 401 || status === 403) return 'permission';
  if (status === 0 || status === 429 || (status >= 500 && status <= 599)) return 'transient';
  // A freshly PATCHed appRole is not instantly visible on the service principal.
  if ((status === 400 || status === 404) && /permission being assigned was not found|appRoleId|does not exist/i.test(message)) {
    return 'transient';
  }
  return 'defect';
}

export function permissionRemediation(host) {
  return (
    `Graph (${host}) refused the call. The deploy service principal needs the Microsoft Graph application ` +
    'permissions Application.ReadWrite.All (create the appRole on the console app registration) and ' +
    'AppRoleAssignment.ReadWrite.All (assign it), OR the Entra directory role Application Administrator / ' +
    'Cloud Application Administrator. A Global Administrator or Privileged Role Administrator must grant ' +
    'admin consent for those application permissions once. Re-run this workflow afterwards; this step is idempotent.'
  );
}

/** 403 on a WRITE: names exactly what is missing and what fixes it (R6). */
export function writeRemediation(host, what) {
  return (
    `Graph (${host}) REFUSED A WRITE. The change this run needs: ${what}. The reads before it succeeded, so the current state IS known and is NOT as required. ` +
    'Fix, either: (a) in Entra ID > App registrations > the console app > Owners, add the deploy service principal as OWNER AND grant it the Graph application permission ' +
    'Application.ReadWrite.OwnedBy (ownership by itself is not expected to authorize an app-only token; that is not verified against a live tenant). The appRole ASSIGNMENT is a write on the deploy service principal and needs ' +
    'AppRoleAssignment.ReadWrite.All or a directory role, which ownership of the app does not give; or (b) grant Application.ReadWrite.All + AppRoleAssignment.ReadWrite.All with admin consent, ' +
    'or the Application Administrator directory role. A Global Administrator or Privileged Role Administrator must grant admin consent for any application permission. If the Estate.Power role and its assignment already exist this step issues zero writes and this error cannot occur: create them once by hand and re-run.'
  );
}

/** 403 on reading the SUPPLIED app: could-not-read, NOT does-not-exist (R7). */
export function suppliedReadRemediation(host, clientId) {
  return (
    `Graph (${host}) refused the read of application ${clientId}. It is therefore UNKNOWN whether that app registration exists or is the right one; nothing was changed. ` +
    'Reading one named app needs the Graph application permission Application.Read.All (or Application.ReadWrite.OwnedBy with the deploy service principal as OWNER of the app), or a directory role such as Application Administrator / Cloud Application Administrator. ' +
    'Tenant-wide LISTING of app registrations is not what this path does.'
  );
}

function azRun(args) {
  const r = spawnSync('az', args, { encoding: 'utf8', shell: false });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function realIo() {
  return {
    cloud() {
      if (process.env.AZURE_CLOUD) return process.env.AZURE_CLOUD;
      const r = azRun(['cloud', 'show', '--query', 'name', '-o', 'tsv']);
      if (r.status !== 0) throw new Error(`az cloud show failed: ${r.stderr.trim()}`);
      return r.stdout.trim();
    },
    /** The logged-in identity: { type: 'servicePrincipal'|'user'|..., name }. */
    identity() {
      const r = azRun(['account', 'show', '--query', 'user', '-o', 'json']);
      if (r.status !== 0) throw new Error(`az account show failed: ${r.stderr.trim()}`);
      return JSON.parse(r.stdout);
    },
    async graph(host, method, pathOrUrl, body) {
      const t = azRun(['account', 'get-access-token', '--resource', host, '--query', 'accessToken', '-o', 'tsv']);
      if (t.status !== 0) throw new GraphError(403, `could not acquire a Graph token for ${host}: ${t.stderr.trim()}`);
      const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${host}/v1.0${pathOrUrl}`;
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${t.stdout.trim()}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        throw new GraphError(0, `network error calling Graph: ${e.message}`);
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.status >= 400) {
        throw new GraphError(res.status, `${method} ${pathOrUrl.split('?')[0]} -> ${res.status}: ${(json?.error?.message ?? text).slice(0, 300)}`);
      }
      return { status: res.status, json };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stdout.write(`${line}\n`),
    writeOutputs(pairs, summary) {
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, pairs.map(([k, v]) => `${k}=${v}\n`).join(''));
      }
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    },
  };
}

class Fatal extends Error {
  constructor(exit, message) {
    super(message);
    this.exit = exit;
  }
}

/**
 * Run one Graph call with bounded retry on TRANSIENT failures only.
 * ctx.what: describes a WRITE (named in its 403 remediation). ctx.readHint: 403 text
 * for a read. ctx.nullOn404: return null on 404. ctx.notFound(e): message making a
 * 404 a definite defect instead of "not yet visible".
 */
async function call(io, host, method, path, body, ctx = {}) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await io.graph(host, method, path, body);
    } catch (e) {
      const status = e instanceof GraphError ? e.status : 0;
      if (status === 404 && ctx.nullOn404) return null;
      if (status === 404 && ctx.notFound) throw new Fatal(EXIT_FAILED, ctx.notFound(e));
      const kind = classify(status, e.message);
      if (kind === 'permission') {
        const hint = method === 'GET'
          ? (ctx.readHint ?? permissionRemediation(host))
          : writeRemediation(host, ctx.what ?? `${method} ${path.split('?')[0]}`);
        throw new Fatal(EXIT_PERMISSION, `${e.message}\n${hint}`);
      }
      if (kind === 'defect') throw new Fatal(EXIT_FAILED, e.message);
      last = e;
      if (attempt < MAX_ATTEMPTS) await io.sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Fatal(EXIT_TRANSIENT, `still failing after ${MAX_ATTEMPTS} attempts (transient): ${last.message}`);
}

async function listAll(io, host, path) {
  const out = [];
  let next = path;
  for (let page = 0; next && page < 20; page++) {
    const r = await call(io, host, 'GET', next);
    out.push(...(r.json?.value ?? []));
    const n = r.json?.['@odata.nextLink'];
    next = typeof n === 'string' && n.startsWith(`${host}/`) ? n : null;
  }
  return out;
}

const roleOk = (r) =>
  r && r.value === ESTATE_POWER_ROLE_VALUE && r.isEnabled === true &&
  Array.isArray(r.allowedMemberTypes) && r.allowedMemberTypes.includes('Application');

/** Pure check of a supplied app against what the operator named. Returns problems (empty = ok). */
export function validateSuppliedApp(app, opts) {
  const problems = [];
  if (!app || String(app.appId ?? '').toLowerCase() !== opts.clientId.toLowerCase()) {
    problems.push(`appId read back is '${app?.appId}', not the supplied '${opts.clientId}'`);
  }
  if (opts.objectId && String(app?.id ?? '').toLowerCase() !== opts.objectId.toLowerCase()) {
    problems.push(`object id read back is '${app?.id}', not the supplied '${opts.objectId}'`);
  }
  if (app?.signInAudience !== 'AzureADMyOrg') {
    problems.push(`signInAudience is '${app?.signInAudience}', expected 'AzureADMyOrg' (the single-tenant console app)`);
  }
  if (opts.expectedName && app?.displayName !== opts.expectedName) {
    problems.push(`display name is '${app?.displayName}', expected '${opts.expectedName}'`);
  }
  return problems;
}

/** Read the ONE named app (alternate key or object id) and validate it. Never lists. */
async function readSuppliedApp(io, host, opts, select) {
  const { clientId, objectId } = opts;
  const path = objectId ? `/applications/${objectId}` : `/applications(appId='${clientId}')`;
  const r = await call(io, host, 'GET', `${path}?$select=${select},signInAudience,displayName`, undefined, {
    readHint: suppliedReadRemediation(host, clientId),
    notFound: (e) => `Graph answered 404 for ${path}: no application with ${objectId ? `object id ${objectId}` : `appId ${clientId}`} is visible to the deploy identity in this tenant (${e.message}). That is a definite not-found, not a permission refusal: check the id and that this is the right tenant/cloud.`,
  });
  const problems = validateSuppliedApp(r.json, opts);
  if (problems.length > 0) {
    throw new Fatal(EXIT_FAILED, `the supplied console app is not the expected one: ${problems.join('; ')}. Nothing was changed.`);
  }
  return r.json;
}

export async function ensure(opts, io) {
  const { clientId } = opts;
  const ep = endpointsFor(io.cloud());
  const host = ep.graph;
  io.log(`ensure-estate-power-role: cloud=${ep.cloud} graph=${host} login=${ep.login} mode=${opts.supplied ? 'supplied-app (no listing)' : 'discover'}`);

  // 1. app registration + appRole
  const getApp = async (select) => (opts.supplied
    ? [await readSuppliedApp(io, host, opts, select)]
    : listAll(io, host, `/applications?$filter=appId eq '${clientId}'&$select=${select}`));
  const apps = await getApp('id,appId,appRoles,identifierUris');
  if (apps.length !== 1) throw new Fatal(EXIT_FAILED, `expected exactly 1 application with appId ${clientId}, found ${apps.length}`);
  const app = apps[0];
  if (opts.validateOnly) {
    io.log(`ensure-estate-power-role: supplied app validated: '${app.displayName}' appId=${app.appId} objectId=${app.id} signInAudience=${app.signInAudience} (0 writes)`);
    return { wrote: 0, validated: true };
  }
  const roles = app.appRoles ?? [];
  const sameValue = roles.find((r) => r.value === ESTATE_POWER_ROLE_VALUE);
  let roleId = sameValue ? sameValue.id : ESTATE_POWER_ROLE_ID;
  let wrote = 0;
  if (!sameValue) {
    const added = {
      id: ESTATE_POWER_ROLE_ID, value: ESTATE_POWER_ROLE_VALUE, displayName: 'Estate power (pause/resume)',
      description: 'Allows a CI service principal to pause and resume the estate through the console power route.',
      allowedMemberTypes: ['Application'], isEnabled: true,
    };
    await call(io, host, 'PATCH', `/applications/${app.id}`, { appRoles: [...roles, added] }, { what: `add the ${ESTATE_POWER_ROLE_VALUE} appRole to application ${app.id} (it is missing)` });
    wrote++;
  } else if (!roleOk(sameValue)) {
    const fixed = roles.map((r) => (r === sameValue ? { ...r, allowedMemberTypes: ['Application'], isEnabled: true } : r));
    await call(io, host, 'PATCH', `/applications/${app.id}`, { appRoles: fixed }, { what: `re-enable the ${ESTATE_POWER_ROLE_VALUE} appRole on application ${app.id} (present but not enabled/Application-typed)` });
    wrote++;
  }

  // 2. console service principal
  const findSp = async (appId) => {
    if (!opts.supplied) return listAll(io, host, `/servicePrincipals?$filter=appId eq '${appId}'&$select=id,appId`);
    const r = await call(io, host, 'GET', `/servicePrincipals(appId='${appId}')?$select=id,appId`, undefined, { nullOn404: true });
    return r?.json ? [r.json] : [];
  };
  let sps = await findSp(clientId);
  if (sps.length === 0) {
    await call(io, host, 'POST', '/servicePrincipals', { appId: clientId }, { what: `create the service principal for the console app ${clientId} (none exists)` });
    wrote++;
    sps = await findSp(clientId);
  }
  if (sps.length !== 1) throw new Fatal(EXIT_FAILED, `expected exactly 1 service principal for ${clientId}, found ${sps.length}`);
  const consoleSp = sps[0];

  // 3. deploy SP from the logged-in identity
  const who = io.identity();
  if (!who || who.type !== 'servicePrincipal' || !GUID.test(who.name ?? '')) {
    throw new Fatal(EXIT_FAILED, `the logged-in identity is type '${who?.type}', not a service principal with an app id; the Estate.Power role is granted to the CI deploy service principal only`);
  }
  const deploy = await findSp(who.name);
  if (deploy.length !== 1) throw new Fatal(EXIT_FAILED, `could not resolve the deploy service principal object for appId ${who.name} (found ${deploy.length})`);
  const deploySp = deploy[0];

  const assignedPath = `/servicePrincipals/${deploySp.id}/appRoleAssignments`;
  const has = (list) => list.some((a) => a.resourceId === consoleSp.id && a.appRoleId === roleId);
  if (!has(await listAll(io, host, assignedPath))) {
    await call(io, host, 'POST', assignedPath, { principalId: deploySp.id, resourceId: consoleSp.id, appRoleId: roleId }, { what: `assign appRole ${roleId} on console service principal ${consoleSp.id} to deploy service principal ${deploySp.id} (no assignment exists)` });
    wrote++;
  }

  // 4. read-back. Graph is eventually consistent: a GET straight after an
  // accepted PATCH can return the PRE-write appRoles. Measured on bootstrap run
  // 39201066384 (2026-10-19): read-back FAILED on the role, yet the role and the
  // assignment were both present minutes later. So a write is given a bounded
  // number of reads to appear; one that never appears still fails.
  let roleAfter;
  let assignAfter = [];
  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
    const appAfter = (await getApp('id,appId,appRoles'))[0];
    roleAfter = (appAfter?.appRoles ?? []).find((r) => r.value === ESTATE_POWER_ROLE_VALUE);
    assignAfter = await listAll(io, host, assignedPath);
    if ((roleOk(roleAfter) && has(assignAfter)) || wrote === 0) break;
    if (attempt < READBACK_ATTEMPTS) await io.sleep(READBACK_DELAY_MS);
  }
  if (!roleOk(roleAfter)) throw new Fatal(EXIT_FAILED, `read-back FAILED after ${READBACK_ATTEMPTS} reads: the Estate.Power appRole is not present, enabled and Application-typed on the app registration`);
  if (roleAfter.id !== roleId) throw new Fatal(EXIT_FAILED, `read-back FAILED: appRole id changed (${roleId} -> ${roleAfter.id})`);
  if (!has(assignAfter)) throw new Fatal(EXIT_FAILED, `read-back FAILED after ${READBACK_ATTEMPTS} reads: no appRoleAssignment of ${roleId} on ${consoleSp.id} for deploy SP ${deploySp.id}`);

  // Supplied app: the audience is what the app really exposes. An app with NO
  // identifier URI is addressed by its bare app id; claiming api://<id> for it would
  // state something this run did not establish (R7). Discover mode keeps api://<id>.
  const uris = app.identifierUris ?? [];
  const audience = !opts.supplied || uris.includes(`api://${clientId}`) ? `api://${clientId}` : (uris[0] ?? clientId);
  io.log(`ensure-estate-power-role: OK (${wrote} write(s)); role ${roleId} -> deploy SP ${who.name}; audience ${audience}`);
  const pairs = [['console_audience', audience], ['estate_power_role_id', roleId], ['writes', String(wrote)]];
  if (opts.consoleUrl) pairs.push(['console_url', opts.consoleUrl]);
  io.writeOutputs(
    pairs,
    `### Estate power role\n- cloud: ${ep.cloud}\n- console audience: \`${audience}\`\n- console URL: ${opts.consoleUrl || '(not resolved)'}\n- role \`${ESTATE_POWER_ROLE_VALUE}\` (${roleId}) assigned to deploy SP \`${who.name}\` (${wrote} write(s) this run)`,
  );
  return { wrote, roleId, audience };
}

export function parseArgs(argv) {
  const o = { clientId: '', consoleUrl: '', supplied: false, objectId: '', expectedName: '', validateOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--supplied') o.supplied = true;
    else if (argv[i] === '--validate-only') o.validateOnly = true;
    else if (argv[i] === '--object-id') o.objectId = argv[++i] ?? '';
    else if (argv[i] === '--expected-name') o.expectedName = argv[++i] ?? '';
    else if (argv[i] === '--client-id') o.clientId = argv[++i] ?? '';
    else if (argv[i] === '--console-url') o.consoleUrl = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

export async function run(argv, io = realIo()) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.log(`ensure-estate-power-role: ${e.message}`);
    return EXIT_USAGE;
  }
  if (!GUID.test(opts.clientId)) {
    io.log('ensure-estate-power-role: --client-id <console app registration client id (GUID)> is required.');
    return EXIT_USAGE;
  }
  if (opts.objectId && !GUID.test(opts.objectId)) {
    io.log('ensure-estate-power-role: --object-id must be a GUID.');
    return EXIT_USAGE;
  }
  if ((opts.objectId || opts.expectedName || opts.validateOnly) && !opts.supplied) {
    io.log('ensure-estate-power-role: --object-id / --expected-name / --validate-only require --supplied.');
    return EXIT_USAGE;
  }
  try {
    await ensure(opts, io);
    return EXIT_OK;
  } catch (e) {
    io.log(`ensure-estate-power-role: FAILED: ${e.message}`);
    return e instanceof Fatal ? e.exit : EXIT_FAILED;
  }
}

if (process.argv[1]?.endsWith('ensure-estate-power-role.mjs')) {
  run(process.argv.slice(2)).then((c) => process.exit(c));
}
