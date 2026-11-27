#!/usr/bin/env node
/**
 * bootstrap-health-cp-entra.mjs -- LHDS W1 (#5163): the Entra steps no bicep performs for
 * the health control plane (apps/loom-health-cp), so no operator pastes them.
 *
 *   1. FEDERATED CREDENTIAL on the authorization-server Entra app (--as-client-id) that
 *      trusts the control-plane managed identity (control-plane.bicep output
 *      `authFederatedCredential`: issuer {login}/{tenant}/v2.0, subject = identity
 *      principal id, audience api://AzureADTokenExchange[USGov]). ARM cannot create it.
 *   1a. `requiredResourceAccess` on that same AS app declares Microsoft Graph User.ReadBasic.All +
 *      GroupMember.Read.All
 *      (application; what its checkMemberGroups call needs) and its SERVICE PRINCIPAL is created, so
 *      admin consent is possible at all (#5346). Declaring is not consenting: nothing here grants it.
 *   2. APP ROLES `HealthCP.Reader` + `HealthCP.Admin` on the control-plane app registration
 *      (--cp-app-client-id, the token audience), fixed ids, never duplicated; then
 *      `HealthCP.Reader` assigned to the APIM gateway identity (routing-map read) and
 *      `HealthCP.Admin` to the Console UAMI AND to the CI deploy service principal
 *      (--ci-client-id, the azure/login client id; operator decision 2026-11-15, so CI receipt
 *      workflows can call the control plane). Reader on the Azure resource (apim-access.bicep)
 *      is management-plane only and does not authorize that call.
 *   1b. REPLY URL (AADSTS500113, 2026-11-27): the AS sends Entra redirect_uri = {issuer}/callback
 *      (apps/loom-health-cp/src/auth/server.ts `callbackUrl`, issuer = LOOM_HEALTH_CP_ISSUER_URL,
 *      config.ts). The issuer is read from that SAME env var on the deployed control-plane Container
 *      App, so it is whatever health.bicep rendered for this boundary (the Front Door issuer endpoint
 *      where controlPlaneConfig.frontDoor is set, else https://<stamp ingress>/auth, else an override).
 *      The callback is MERGED into the AS app's web.redirectUris (existing URIs kept, no write when
 *      present). An absent or invalid issuer fails the run BEFORE any write; it is never skipped.
 *   3. LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS on the control-plane Container App: the APIM
 *      appId, the Console UAMI client id and the CI SP app id are UNIONED into the current value (never
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
// The Microsoft Graph application permission the authorization server's group check needs.
// The AS (apps/loom-health-cp/src/auth/federation.ts) POSTs /directoryObjects/{oid}/checkMemberGroups;
// Learn (graph/api/directoryobject-checkmembergroups), table "Group memberships for other users"
// (POST /users/{id}/checkMemberGroups): Application least privileged = User.ReadBasic.All AND
// GroupMember.Read.All together; Directory.Read.All is the HIGHER-privileged alternative. Ids from
// graph/permissions-reference (Application column). Graph's resource appId is the same in every cloud.
// Declaring is NOT consent: a Global Administrator still grants it.
export const GRAPH_RESOURCE_APP_ID = '00000003-0000-0000-c000-000000000000';
export const GRAPH_PERMISSIONS = [
  { name: 'User.ReadBasic.All', id: '97235f07-e226-4f63-ace3-39588e11d3a1', type: 'Role' },
  { name: 'GroupMember.Read.All', id: '98830695-27a2-44f7-8c18-0c3ebc9698f6', type: 'Role' },
];
// Declared by an earlier version of this script. Never added now; if present it is LEFT in place (removing a
// declaration is not this script's call) and reported, so the operator can remove it.
export const GRAPH_BROAD_PERMISSION_ID = '7ab1d382-f21e-4acd-a863-ba3e13f7da61';
export const ALLOWLIST_ENV = 'LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS';
// The env var the AS reads its public issuer from (apps/loom-health-cp/src/auth/config.ts) and the path it appends for the
// Entra redirect target (server.ts `callbackUrl`). The test lifts both from the AS source.
export const ISSUER_ENV = 'LOOM_HEALTH_CP_ISSUER_URL';
export const AS_CALLBACK_PATH = '/callback';

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

/** requiredResourceAccess with every GRAPH_PERMISSIONS role declared, every other entry kept. Pure; returns null when all are already declared. */
export function withGraphPermission(current) {
  const list = Array.isArray(current) ? current.map((r) => ({ ...r, resourceAccess: [...(r.resourceAccess ?? [])] })) : [];
  let graph = list.find((r) => String(r.resourceAppId).toLowerCase() === GRAPH_RESOURCE_APP_ID);
  const has = (g) => graph?.resourceAccess.some((a) => a.id === g.id && a.type === g.type);
  const missing = GRAPH_PERMISSIONS.filter((g) => !has(g));
  if (missing.length === 0) return null;
  if (!graph) { graph = { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [] }; list.push(graph); }
  for (const g of missing) graph.resourceAccess.push({ id: g.id, type: g.type });
  return list;
}

/**
 * The Entra redirect_uri the AS sends, from its issuer exactly as the AS forms it: trimmed (config.ts `need`), trailing
 * slashes dropped (config.ts `cleanHttps`), then AS_CALLBACK_PATH appended (server.ts). Returns null for a value the AS
 * itself refuses to start with (absent, not https, userinfo, query or fragment). Pure.
 */
export function asCallbackUrl(issuer) {
  const v = String(issuer ?? '').trim();
  if (!v) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || /^[^:]+:\/\/[^/?#]*@/.test(v) || u.search || u.hash) return null;
  return `${v.replace(/\/+$/, '')}${AS_CALLBACK_PATH}`;
}

/** web.redirectUris with `uri` added once (exact match, as Entra compares the reply URL), every other entry kept in order. Pure; null when already present. */
export function withRedirectUri(current, uri) {
  const list = Array.isArray(current) ? [...current] : [];
  return list.includes(uri) ? null : [...list, uri];
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

  // The AS callback (1b) is derived before any write, so an unknown issuer changes nothing.
  const app = { name: opts.cpAppName, resourceGroup: opts.cpResourceGroup, subscription: opts.subscription };
  const issuerRaw = io.getAppEnv(app).find((e) => e.name === ISSUER_ENV)?.value;
  const callback = asCallbackUrl(issuerRaw);
  if (!callback) {
    throw new Fatal(EXIT_FAILED, `could not determine the issuer: ${ISSUER_ENV} on the control-plane Container App ${opts.cpAppName} (${opts.cpResourceGroup}) is ${issuerRaw === undefined ? 'not set' : `'${String(issuerRaw).slice(0, 200)}', not an https URL without userinfo, query or fragment`}. The authorization-server reply URL (<issuer>${AS_CALLBACK_PATH}) cannot be registered without it, so nothing was changed. health.bicep renders it (controlPlaneConfig.authIssuerUrl, else the Front Door issuer endpoint, else the stamp ingress /auth); a non-empty healthControlPlaneState.authServerMissing names why it is empty. Re-deploy health, then re-run this bootstrap.`);
  }
  io.log(`bootstrap-health-cp-entra: authorization-server reply URL = ${callback} (from ${ISSUER_ENV})`);

  // The credential values are validated against THIS cloud before any write.
  const fed = expectedFederatedCredential(io.cloud(), opts.tenantId, opts.cpIdentityPrincipalId);

  // ---- 1. federated credential on the authorization-server app ----
  const asApp = await readApp(io, host, opts.asClientId, 'id,appId,displayName,requiredResourceAccess,web', 'authorization-server');
  // 1a. declare the Graph permission its group check needs, and make sure its service principal
  // exists. Without both, admin consent is impossible (#5346). NOT consent itself.
  const rra = withGraphPermission(asApp.requiredResourceAccess);
  if ((asApp.requiredResourceAccess ?? []).some((r) => (r.resourceAccess ?? []).some((a) => a.id === GRAPH_BROAD_PERMISSION_ID))) io.log(`bootstrap-health-cp-entra: NOTE: the authorization-server app still declares Directory.Read.All from an earlier run. It is left in place (this script never removes a declaration) and is broader than the group check needs; remove it, and revoke any consent granted for it, once ${GRAPH_PERMISSIONS.map((g) => g.name).join(' + ')} are consented.`);
  if (rra) {
    if (plan.dryRun) plan.would.push(`declare Microsoft Graph ${GRAPH_PERMISSIONS.map((g) => g.name).join(' + ')} (application) in requiredResourceAccess on the authorization-server app ${opts.asClientId}`);
    else { await call(io, host, 'PATCH', `/applications/${asApp.id}`, { requiredResourceAccess: rra }, { what: `declare ${GRAPH_PERMISSIONS.map((g) => g.name).join(' + ')} on the authorization-server application ${asApp.id}` }); plan.writes++; }
  }
  // 1b. the reply URL Entra checks the AS redirect_uri against (AADSTS500113 without it). MERGE: every existing web
  // redirect URI is kept. `web: { redirectUris }` is the same partial PATCH `az ad app update --web-redirect-uris` sends.
  const redirectUris = withRedirectUri(asApp.web?.redirectUris, callback);
  if (redirectUris) {
    if (plan.dryRun) plan.would.push(`add the reply URL ${callback} to web.redirectUris on the authorization-server app ${opts.asClientId} (keeping ${(asApp.web?.redirectUris ?? []).length} existing)`);
    else { await call(io, host, 'PATCH', `/applications/${asApp.id}`, { web: { redirectUris } }, { what: `add the reply URL ${callback} to the authorization-server application ${asApp.id}` }); plan.writes++; }
  }
  await ensureServicePrincipal(io, host, opts.asClientId, 'the authorization-server app', plan);
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
  // CI deploy SP (azure/login identity): app id -> object id via Graph, like the other grants.
  const ciSp = (await call(io, host, 'GET', `/servicePrincipals(appId='${opts.ciClientId}')?$select=id,appId`, undefined, {
    what: `read the CI deploy service principal ${opts.ciClientId}`,
    notFound: () => `Graph answered 404: no service principal with appId ${opts.ciClientId} (--ci-client-id, the azure/login client id) in this tenant, so HealthCP.Admin cannot be assigned to it. Check that the workflow passes the client id of the identity it logs in with, in the right cloud.`,
  })).json;
  const grants = [];
  if (apimSp) grants.push({ who: 'APIM gateway', principalId: apimSp.id, role: ROLE_READER });
  if (opts.consolePrincipalId) grants.push({ who: 'Console UAMI', principalId: opts.consolePrincipalId, role: ROLE_ADMIN });
  // The stamp PDP's workload identity pulls its bundle with client credentials: Reader (bundle + verification key, read-only) and
  // its client (app) id on the allowlist, exactly like the CI SP (#5422). Without both it gets 403 and the PDP never becomes Ready.
  if (opts.pdpPrincipalId) grants.push({ who: 'stamp PDP identity', principalId: opts.pdpPrincipalId, role: ROLE_READER });
  grants.push({ who: 'CI deploy SP', principalId: ciSp.id, role: ROLE_ADMIN });
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
  const addIds = [apimAppId, opts.consoleClientId, opts.ciClientId, opts.pdpClientId].filter(Boolean);
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
      const asBack = await readApp(io, host, opts.asClientId, 'id,requiredResourceAccess,web', 'authorization-server');
      if (withGraphPermission(asBack.requiredResourceAccess)) problems.push(`${GRAPH_PERMISSIONS.map((g) => g.name).join(' + ')} declared in requiredResourceAccess on ${opts.asClientId}`);
      if (withRedirectUri(asBack.web?.redirectUris, callback)) problems.push(`reply URL ${callback} in web.redirectUris on ${opts.asClientId}`);
      const asSp = await call(io, host, 'GET', `/servicePrincipals(appId='${opts.asClientId}')?$select=id,appId`, undefined, { nullOn404: true, what: 'read back the authorization-server service principal' });
      if (!asSp?.json?.id) problems.push(`service principal for the authorization-server app ${opts.asClientId}`);
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
  if (!opts.pdpPrincipalId) partial.push('stamp PDP identity NOT wired (none supplied): no HealthCP.Reader, its client id not in the allowlist; a PDP deployed later gets 403 on its bundle until this is re-run');
  if (!opts.consolePrincipalId || !opts.consoleClientId) partial.push('Console UAMI NOT wired (principal id or client id not supplied)');
  const summary = plan.dryRun
    ? `DRY-RUN: ${plan.would.length} write(s) would be made${plan.would.length ? `:\n  - ${plan.would.join('\n  - ')}` : ''}`
    : `OK: ${plan.writes} write(s); federated credential ${fedAction}; allowlist now ${wanted || '(empty)'}`;
  io.log(`bootstrap-health-cp-entra: ${summary}`);
  for (const p of partial) io.log(`bootstrap-health-cp-entra: PARTIAL: ${p}`);
  io.writeOutputs?.([['writes', String(plan.writes)], ['partial', String(partial.length > 0)], ['allowed_caller_app_ids', wanted]],
    `### LHDS control-plane Entra bootstrap\n- cloud: ${ep.cloud}${plan.dryRun ? ' (dry run)' : ''}\n- ${summary.split('\n')[0]}${partial.map((p) => `\n- PARTIAL: ${p}`).join('')}`);
  return { writes: plan.writes, would: plan.would, partial, allowlist: wanted, fedAction, callback };
}

export function parseArgs(argv) {
  const keys = {
    '--as-client-id': 'asClientId', '--cp-app-client-id': 'cpAppClientId', '--tenant-id': 'tenantId',
    '--cp-identity-principal-id': 'cpIdentityPrincipalId', '--apim-principal-id': 'apimPrincipalId',
    '--console-client-id': 'consoleClientId', '--ci-client-id': 'ciClientId', '--console-principal-id': 'consolePrincipalId',
    '--pdp-principal-id': 'pdpPrincipalId', '--pdp-client-id': 'pdpClientId',
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
  const guids = { 'as-client-id': opts.asClientId, 'cp-app-client-id': opts.cpAppClientId, 'tenant-id': opts.tenantId, 'ci-client-id': opts.ciClientId, 'cp-identity-principal-id': opts.cpIdentityPrincipalId };
  for (const [k, v] of Object.entries(guids)) if (!GUID.test(v ?? '')) { io.log(`bootstrap-health-cp-entra: --${k} <GUID> is required (got '${v ?? ''}').${k === 'ci-client-id' ? ' It is the client id the workflow logs in with (AZURE_CLIENT_ID for Commercial, AZURE_GOV_CLIENT_ID for GCC-High/IL5, AZURE_GCC_CLIENT_ID for GCC); without it the CI service principal gets no HealthCP.Admin and its control-plane calls 403. Nothing was changed.' : ''}`); return EXIT_USAGE; }
  if (Boolean(opts.pdpPrincipalId) !== Boolean(opts.pdpClientId)) { io.log('bootstrap-health-cp-entra: --pdp-principal-id and --pdp-client-id must be supplied together (the role goes to the object id, the allowlist takes the client id). Nothing was changed.'); return EXIT_USAGE; }
  for (const k of ['apimPrincipalId', 'consoleClientId', 'consolePrincipalId', 'pdpPrincipalId', 'pdpClientId']) if (opts[k] && !GUID.test(opts[k])) { io.log(`bootstrap-health-cp-entra: --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a GUID.`); return EXIT_USAGE; }
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
