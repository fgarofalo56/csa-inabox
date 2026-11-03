#!/usr/bin/env node
/**
 * bootstrap-health-cp-entra.mjs -- LHDS W1 (#5163): the Entra steps no bicep performs for
 * the health control plane (apps/loom-health-cp), so no operator pastes them.
 *
 *   1. FEDERATED CREDENTIAL on the authorization-server Entra app (--as-client-id) that
 *      trusts the control-plane managed identity (control-plane.bicep output
 *      `authFederatedCredential`: issuer {login}/{tenant}/v2.0, subject = identity
 *      principal id, audience api://AzureADTokenExchange[USGov]). ARM cannot create it.
 *   2. APP ROLES `HealthCP.Reader` + `HealthCP.Admin` on the control-plane app registration
 *      (--cp-app-client-id, the token audience), fixed ids, never duplicated; then
 *      `HealthCP.Reader` assigned to the APIM gateway identity (routing-map read) and
 *      `HealthCP.Admin` to the Console UAMI. Reader on the Azure resource (apim-access.bicep)
 *      is management-plane only and does not authorize that call.
 *   3. LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS on the control-plane Container App: the APIM
 *      appId and the Console UAMI client id are UNIONED into the current value (never
 *      overwritten, never removed).
 *
 * Idempotent: a converged run issues zero writes. --dry-run reads everything and reports
 * the writes it would make, issuing none. Every write is read back (R6); a write that does
 * not appear fails the run.
 *
 * Cloud: Graph and Entra hosts come from AZURE_CLOUD (else `az cloud show`):
 * AzureUSGovernment -> graph.microsoft.us / login.microsoftonline.us, AzureCloud ->
 * graph.microsoft.com / login.microsoftonline.com. Anything else fails closed. The issuer and
 * audience of the credential are checked against that cloud before any write, so a Commercial
 * credential can never be attached to a Gov app or the reverse. GCC is not a supported value.
 *
 * Failures are classified: permission (401/403 -> exit 3, names the Graph permission),
 * transient (429/5xx/network -> bounded backoff, exit 4), unsupported (exit 5), defect (exit 1).
 *
 * Scope limit, stated: only the Container Apps control plane is wired (env var set with
 * `az containerapp update`). The aks path is refused with exit 5, never reported as done.
 * A later health.bicep deploy re-renders the env var from controlPlaneConfig.allowedCallerAppIds,
 * dropping what this script added; re-run the bootstrap after it (or set that param).
 */
import { spawnSync } from 'node:child_process';
import { GraphError, classify, endpointsFor, realIo as baseIo, EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_PERMISSION, EXIT_TRANSIENT } from './ensure-estate-power-role.mjs';

export { EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_PERMISSION, EXIT_TRANSIENT };
export const EXIT_UNSUPPORTED = 5;

// uuid v5(NAMESPACE_URL, 'csa-loom/health-cp/appRole/<value>'), committed as literals.
export const ROLE_READER = { value: 'HealthCP.Reader', id: '71f8acc4-d1c5-52b8-88a5-af68cf307ac1', displayName: 'Health control plane reader', description: 'Read stamps, tenants, the routing map, SLO, jobs and the PDP bundle.' };
export const ROLE_ADMIN = { value: 'HealthCP.Admin', id: '271ee6d8-ae5e-56cd-ab75-2cf66efe03a3', displayName: 'Health control plane administrator', description: 'Everything HealthCP.Reader can do, plus create and change stamps, tenants, routing and jobs.' };
export const FED_CRED_NAME = 'lhds-control-plane-identity';
export const ALLOWLIST_ENV = 'LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS';

export const MAX_ATTEMPTS = 4;
export const READBACK_ATTEMPTS = 7;
export const READBACK_DELAY_MS = 10_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Fatal extends Error {
  constructor(exit, message) {
    super(message);
    this.exit = exit;
  }
}

/** What the federated credential must look like in this cloud. Pure; unknown cloud throws. */
export function expectedFederatedCredential(cloud, tenantId, subject) {
  const ep = endpointsFor(cloud);
  const gov = ep.cloud === 'AzureUSGovernment';
  return {
    name: FED_CRED_NAME,
    issuer: `${ep.login}/${tenantId}/v2.0`,
    subject,
    audiences: [gov ? 'api://AzureADTokenExchangeUSGov' : 'api://AzureADTokenExchange'],
    description: 'LHDS control-plane managed identity (managed by bootstrap-health-cp-entra.mjs, #5163)',
  };
}

/** Union of two comma lists, order preserved, case-insensitive dedupe, blanks dropped. */
export function mergeAllowlist(current, add) {
  const out = [];
  for (const v of [...String(current ?? '').split(','), ...add]) {
    const t = String(v).trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function permissionRemediation(host, what) {
  return (
    `Graph (${host}) REFUSED: ${what}. Nothing past this point was changed. The bootstrap identity needs, with admin consent granted by a Global Administrator or Privileged Role Administrator: ` +
    'Microsoft Graph application permissions Application.ReadWrite.All (federated credential on the AS app, appRoles on the control-plane app) and AppRoleAssignment.ReadWrite.All (assign HealthCP.Reader / HealthCP.Admin), ' +
    'OR the Entra directory role Application Administrator (or Cloud Application Administrator) plus AppRoleAssignment.ReadWrite.All. ' +
    'Reading the APIM / Console identities needs Application.Read.All (included above). Re-run the bootstrap afterwards; this step is idempotent.'
  );
}

export function realIo() {
  const io = baseIo();
  const az = (args) => {
    const r = spawnSync('az', args, { encoding: 'utf8', shell: false });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const scope = (o) => ['-n', o.name, '-g', o.resourceGroup, '--subscription', o.subscription];
  return {
    ...io,
    /** Env of the control-plane Container App as {name,value}[] (value-bearing entries only). */
    getAppEnv(o) {
      const r = az(['containerapp', 'show', ...scope(o), '--query', 'properties.template.containers[].env[]', '-o', 'json']);
      if (r.status !== 0) throw new Error(`az containerapp show failed: ${r.stderr.trim().slice(0, 300)}`);
      return JSON.parse(r.stdout || '[]') ?? [];
    },
    setAppEnv(o, name, value) {
      const r = az(['containerapp', 'update', ...scope(o), '--set-env-vars', `${name}=${value}`, '-o', 'none']);
      if (r.status !== 0) throw new Error(`az containerapp update failed: ${r.stderr.trim().slice(0, 300)}`);
    },
  };
}

async function call(io, host, method, path, body, ctx = {}) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await io.graph(host, method, path, body);
    } catch (e) {
      const status = e instanceof GraphError ? e.status : 0;
      if (status === 404 && ctx.nullOn404) return null;
      const kind = classify(status, e.message);
      if (kind === 'permission') throw new Fatal(EXIT_PERMISSION, `${e.message}\n${permissionRemediation(host, ctx.what ?? `${method} ${path.split('?')[0]}`)}`);
      if (kind === 'defect') throw new Fatal(EXIT_FAILED, ctx.notFound && status === 404 ? ctx.notFound(e) : e.message);
      last = e;
      if (attempt < MAX_ATTEMPTS) await io.sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Fatal(EXIT_TRANSIENT, `still failing after ${MAX_ATTEMPTS} attempts (transient): ${last.message}`);
}

async function listAll(io, host, path, ctx) {
  const out = [];
  let next = path;
  for (let page = 0; next && page < 20; page++) {
    const r = await call(io, host, 'GET', next, undefined, ctx);
    out.push(...(r.json?.value ?? []));
    const n = r.json?.['@odata.nextLink'];
    next = typeof n === 'string' && n.startsWith(`${host}/`) ? n : null;
  }
  return out;
}

const roleOk = (r) => r && r.isEnabled === true && Array.isArray(r.allowedMemberTypes) && r.allowedMemberTypes.includes('Application');

async function readApp(io, host, clientId, select, label) {
  const r = await call(io, host, 'GET', `/applications(appId='${clientId}')?$select=${select}`, undefined, {
    what: `read the ${label} application ${clientId}`,
    notFound: () => `Graph answered 404: no application with appId ${clientId} is visible to the bootstrap identity (${label}). That is a definite not-found, not a permission refusal: check the id and that this is the right tenant and cloud.`,
  });
  return r.json;
}

async function ensureServicePrincipal(io, host, clientId, label, plan) {
  const r = await call(io, host, 'GET', `/servicePrincipals(appId='${clientId}')?$select=id,appId`, undefined, { nullOn404: true, what: `read the ${label} service principal` });
  if (r?.json?.id) return r.json;
  if (plan.dryRun) { plan.would.push(`create the service principal for ${label} (${clientId})`); return { id: '(not-created-dry-run)', appId: clientId }; }
  await call(io, host, 'POST', '/servicePrincipals', { appId: clientId }, { what: `create the service principal for ${label} (${clientId})` });
  plan.writes++;
  const again = await call(io, host, 'GET', `/servicePrincipals(appId='${clientId}')?$select=id,appId`, undefined, { what: `read back the ${label} service principal` });
  return again.json;
}

export async function ensure(opts, io) {
  const ep = endpointsFor(io.cloud());
  const host = ep.graph;
  const plan = { dryRun: !!opts.dryRun, writes: 0, would: [] };
  io.log(`bootstrap-health-cp-entra: cloud=${ep.cloud} graph=${host} login=${ep.login} mode=${plan.dryRun ? 'DRY-RUN (zero writes)' : 'apply'}`);

  if (opts.platform && opts.platform !== 'containerApps') {
    throw new Fatal(EXIT_UNSUPPORTED, `the control plane platform is '${opts.platform}'. This step only wires the Container Apps path (it sets ${ALLOWLIST_ENV} with az containerapp update). Nothing was changed; the aks path is NOT done by this run.`);
  }

  // The credential values are validated against THIS cloud before any write.
  const fed = expectedFederatedCredential(io.cloud(), opts.tenantId, opts.cpIdentityPrincipalId);

  // ---- 1. federated credential on the authorization-server app ----
  const asApp = await readApp(io, host, opts.asClientId, 'id,appId,displayName', 'authorization-server');
  const credPath = `/applications/${asApp.id}/federatedIdentityCredentials`;
  const sameCred = (c) => c.issuer === fed.issuer && c.subject === fed.subject && (c.audiences ?? []).length === 1 && c.audiences[0] === fed.audiences[0];
  const creds = await listAll(io, host, credPath, { what: `list federated credentials on the authorization-server app ${asApp.id}` });
  let fedAction = 'unchanged';
  if (!creds.some(sameCred)) {
    const named = creds.find((c) => c.name === FED_CRED_NAME);
    if (plan.dryRun) {
      plan.would.push(`${named ? 'update' : 'create'} federated credential '${FED_CRED_NAME}' on app ${opts.asClientId} (issuer ${fed.issuer}, subject ${fed.subject})`);
      fedAction = 'would-write';
    } else if (named) {
      await call(io, host, 'PATCH', `${credPath}/${named.id}`, { issuer: fed.issuer, subject: fed.subject, audiences: fed.audiences, description: fed.description }, { what: `update federated credential ${named.id} on the authorization-server app` });
      plan.writes++; fedAction = 'updated';
    } else {
      await call(io, host, 'POST', credPath, fed, { what: `create a federated credential on the authorization-server app ${asApp.id}` });
      plan.writes++; fedAction = 'created';
    }
  }

  // ---- 2. app roles on the control-plane app + assignments ----
  const cpApp = await readApp(io, host, opts.cpAppClientId, 'id,appId,appRoles,displayName', 'control-plane');
  const existing = cpApp.appRoles ?? [];
  const resolved = {};
  const next = [...existing];
  let rolesChanged = false;
  for (const want of [ROLE_READER, ROLE_ADMIN]) {
    const have = existing.find((r) => r.value === want.value);
    if (!have) {
      next.push({ id: want.id, value: want.value, displayName: want.displayName, description: want.description, allowedMemberTypes: ['Application'], isEnabled: true });
      resolved[want.value] = want.id; rolesChanged = true;
    } else if (!roleOk(have)) {
      next[next.indexOf(have)] = { ...have, allowedMemberTypes: ['Application'], isEnabled: true };
      resolved[want.value] = have.id; rolesChanged = true;
    } else resolved[want.value] = have.id;
  }
  if (rolesChanged) {
    if (plan.dryRun) plan.would.push(`add/enable appRoles ${ROLE_READER.value}, ${ROLE_ADMIN.value} on control-plane app ${opts.cpAppClientId}`);
    else { await call(io, host, 'PATCH', `/applications/${cpApp.id}`, { appRoles: next }, { what: `add/enable the HealthCP appRoles on the control-plane application ${cpApp.id}` }); plan.writes++; }
  }
  const cpSp = await ensureServicePrincipal(io, host, opts.cpAppClientId, 'the control-plane app', plan);

  // APIM gateway identity (object id -> appId) and the Console UAMI.
  let apimAppId = '';
  let apimSp = null;
  if (opts.apimPrincipalId) {
    const r = await call(io, host, 'GET', `/servicePrincipals/${opts.apimPrincipalId}?$select=id,appId`, undefined, {
      what: `read the APIM identity service principal ${opts.apimPrincipalId}`,
      notFound: () => `Graph answered 404 for the APIM identity ${opts.apimPrincipalId}: it is not a service principal in this tenant (is the APIM system-assigned identity enabled and is this the right tenant?).`,
    });
    apimSp = r.json; apimAppId = apimSp.appId;
  }
  const grants = [];
  if (apimSp) grants.push({ who: 'APIM gateway', principalId: apimSp.id, role: ROLE_READER });
  if (opts.consolePrincipalId) grants.push({ who: 'Console UAMI', principalId: opts.consolePrincipalId, role: ROLE_ADMIN });
  const assignedPath = `/servicePrincipals/${cpSp.id}/appRoleAssignedTo`;
  const has = (list, g) => list.some((a) => a.principalId === g.principalId && a.appRoleId === resolved[g.role.value]);
  const current = cpSp.id.startsWith('(') ? [] : await listAll(io, host, assignedPath, { what: 'list appRole assignments on the control-plane service principal' });
  for (const g of grants) {
    if (has(current, g)) continue;
    if (plan.dryRun) { plan.would.push(`assign ${g.role.value} to ${g.who} (${g.principalId})`); continue; }
    await call(io, host, 'POST', assignedPath, { principalId: g.principalId, resourceId: cpSp.id, appRoleId: resolved[g.role.value] }, { what: `assign ${g.role.value} to ${g.who} ${g.principalId} on the control-plane service principal` });
    plan.writes++;
  }

  // ---- 3. caller allowlist on the Container App ----
  const addIds = [apimAppId, opts.consoleClientId].filter(Boolean);
  const app = { name: opts.cpAppName, resourceGroup: opts.cpResourceGroup, subscription: opts.subscription };
  const readAllow = () => (io.getAppEnv(app).find((e) => e.name === ALLOWLIST_ENV)?.value ?? '');
  const before = readAllow();
  const wanted = mergeAllowlist(before, addIds).join(',');
  const currentList = mergeAllowlist(before, []).join(',');
  if (wanted !== currentList) {
    if (plan.dryRun) plan.would.push(`set ${ALLOWLIST_ENV} on ${opts.cpAppName} to ${wanted}`);
    else { io.setAppEnv(app, ALLOWLIST_ENV, wanted); plan.writes++; }
  }

  // ---- 4. read-back (R6): a write that never appears fails the run ----
  if (!plan.dryRun && plan.writes > 0) {
    let problems = [];
    for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
      problems = [];
      const cc = await listAll(io, host, credPath);
      if (!cc.some(sameCred)) problems.push(`federated credential on ${opts.asClientId} with issuer ${fed.issuer} / subject ${fed.subject} / audience ${fed.audiences[0]}`);
      const rr = (await readApp(io, host, opts.cpAppClientId, 'id,appRoles', 'control-plane')).appRoles ?? [];
      for (const r of [ROLE_READER, ROLE_ADMIN]) if (!roleOk(rr.find((x) => x.value === r.value))) problems.push(`appRole ${r.value} enabled and Application-typed`);
      const aa = await listAll(io, host, assignedPath);
      for (const g of grants) if (!has(aa, g)) problems.push(`${g.role.value} assignment for ${g.who} ${g.principalId}`);
      if (problems.length === 0) break;
      if (attempt < READBACK_ATTEMPTS) await io.sleep(READBACK_DELAY_MS);
    }
    const allowAfter = mergeAllowlist(readAllow(), []).map((s) => s.toLowerCase());
    for (const id of addIds) if (!allowAfter.includes(id.toLowerCase())) problems.push(`${id} in ${ALLOWLIST_ENV}`);
    if (problems.length) throw new Fatal(EXIT_FAILED, `read-back FAILED, these are not present after the writes: ${problems.join('; ')}`);
  }

  const partial = [];
  if (!opts.apimPrincipalId) partial.push('APIM gateway NOT wired (no APIM identity supplied): HealthCP.Reader not assigned, its appId not in the allowlist');
  if (!opts.consolePrincipalId || !opts.consoleClientId) partial.push('Console UAMI NOT wired (principal id or client id not supplied)');
  const summary = plan.dryRun
    ? `DRY-RUN: ${plan.would.length} write(s) would be made${plan.would.length ? `:\n  - ${plan.would.join('\n  - ')}` : ''}`
    : `OK: ${plan.writes} write(s); federated credential ${fedAction}; allowlist now ${wanted || '(empty)'}`;
  io.log(`bootstrap-health-cp-entra: ${summary}`);
  for (const p of partial) io.log(`bootstrap-health-cp-entra: PARTIAL: ${p}`);
  io.writeOutputs?.([['writes', String(plan.writes)], ['partial', String(partial.length > 0)], ['allowed_caller_app_ids', wanted]],
    `### LHDS control-plane Entra bootstrap\n- cloud: ${ep.cloud}${plan.dryRun ? ' (dry run)' : ''}\n- ${summary.split('\n')[0]}${partial.map((p) => `\n- PARTIAL: ${p}`).join('')}`);
  return { writes: plan.writes, would: plan.would, partial, allowlist: wanted, fedAction };
}

export function parseArgs(argv) {
  const keys = {
    '--as-client-id': 'asClientId', '--cp-app-client-id': 'cpAppClientId', '--tenant-id': 'tenantId',
    '--cp-identity-principal-id': 'cpIdentityPrincipalId', '--apim-principal-id': 'apimPrincipalId',
    '--console-client-id': 'consoleClientId', '--console-principal-id': 'consolePrincipalId',
    '--cp-app-name': 'cpAppName', '--cp-resource-group': 'cpResourceGroup', '--subscription': 'subscription', '--platform': 'platform',
  };
  const o = { dryRun: false, platform: 'containerApps' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') o.dryRun = true;
    else if (keys[argv[i]]) o[keys[argv[i]]] = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

export async function run(argv, io = realIo()) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { io.log(`bootstrap-health-cp-entra: ${e.message}`); return EXIT_USAGE; }
  const guids = { 'as-client-id': opts.asClientId, 'cp-app-client-id': opts.cpAppClientId, 'tenant-id': opts.tenantId, 'cp-identity-principal-id': opts.cpIdentityPrincipalId };
  for (const [k, v] of Object.entries(guids)) if (!GUID.test(v ?? '')) { io.log(`bootstrap-health-cp-entra: --${k} <GUID> is required (got '${v ?? ''}').`); return EXIT_USAGE; }
  for (const k of ['apimPrincipalId', 'consoleClientId', 'consolePrincipalId']) if (opts[k] && !GUID.test(opts[k])) { io.log(`bootstrap-health-cp-entra: --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a GUID.`); return EXIT_USAGE; }
  for (const k of ['cpAppName', 'cpResourceGroup', 'subscription']) if (!opts[k]) { io.log(`bootstrap-health-cp-entra: --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`); return EXIT_USAGE; }
  try {
    await ensure(opts, io);
    return EXIT_OK;
  } catch (e) {
    io.log(`bootstrap-health-cp-entra: FAILED: ${e.message}`);
    return e instanceof Fatal ? e.exit : EXIT_FAILED;
  }
}

if (process.argv[1]?.endsWith('bootstrap-health-cp-entra.mjs')) {
  run(process.argv.slice(2)).then((c) => process.exit(c));
}
