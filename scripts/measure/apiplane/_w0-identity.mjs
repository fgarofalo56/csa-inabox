/**
 * _w0-identity.mjs - family `identity` (PRP item W0-4).
 *
 * READ-ONLY Graph GETs with the run's OWN identity (the deploy service
 * principal). Three questions, each answered `yes` | `no` | `unknown:<reason>`:
 *   (a) does the Microsoft Graph service principal list the app role
 *       `AgentIdentity.Read.All` in this tenant;
 *   (b) which Graph app roles does the Console UAMI currently hold (role NAMES
 *       only - never an id);
 *   (c) is `groupMembershipClaims` == SecurityGroup on the sign-in app registration.
 *
 * AN UNREADABLE GRAPH IS UNKNOWN, NEVER NO. A 401/403 names the permission it
 * needed; a read that worked but matched nothing is `unknown:not-located` (the
 * search rule may be wrong), never `no`. None of the three is a REQUIRED cell, so
 * an unreadable Graph exits 0 - the PRP says so - but a control that FAILS (a 200
 * that is not the Graph service principal) is still exit 2.
 *
 * CONTROL: the Graph service principal read itself succeeded. Without it a `no`
 * in (a) could be an empty directory answer.
 *
 * HOW THE UAMI AND THE APP ARE LOCATED (the way the repo does it)
 *   - the Console UAMI is `uami-loom-console-<region>` in rg-csa-loom-admin-<region>
 *     (identity.bicep; .github/workflows/csa-loom-post-deploy-bootstrap.yml resolves
 *     it, and deploy-copilot-evaluator.yml falls back to
 *     `[?starts_with(name,'uami-loom-console')]`). The probe lists the subscription's
 *     user-assigned identities and matches that prefix.
 *   - the sign-in app is "CSA Loom Console (<KEYVAULT_NAME>)" (APP_DISPLAY_NAME in
 *     scripts/csa-loom/bootstrap-msal-app-reg.sh), which sets
 *     `groupMembershipClaims=SecurityGroup`. The probe matches the display-name
 *     prefix "CSA Loom Console"; exactly one match is required to answer yes/no.
 *
 * GROUNDING (Learn, fetched 2026-10-29)
 *   GET /servicePrincipals(appId='{appId}') and $select; least privilege Application.Read.All:
 *     https://learn.microsoft.com/en-us/graph/api/serviceprincipal-get
 *   GET /servicePrincipals/{id}/appRoleAssignments (Application.Read.All):
 *     https://learn.microsoft.com/en-us/graph/api/serviceprincipal-list-approleassignments
 *   GET /applications ($filter, $select, ConsistencyLevel: eventual with $count):
 *     https://learn.microsoft.com/en-us/graph/api/application-list
 *   `AgentIdentity.Read.All` is a Graph application permission:
 *     https://learn.microsoft.com/en-us/graph/permissions-reference
 *   User-assigned identities list (properties.principalId), 2023-01-31:
 *     https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/list-by-subscription?view=rest-managedidentity-2023-01-31
 *   Graph endpoint per cloud (graph.microsoft.com / graph.microsoft.us):
 *     https://learn.microsoft.com/en-us/graph/deployments
 */
import { API, listAll, measured, quote, reasonForFailure, unknown } from './_w0-core.mjs';

const F = 'identity';
const id = (s) => `${F}.${s}`;

export const CELL_IDS = Object.freeze([
  'graph.agentIdentityReadAll', 'uami.graphAppRoles', 'signinApp.groupMembershipClaims',
].map(id));

/** The well-known appId of the Microsoft Graph service principal (grant-uami-graph-roles.sh uses the same). */
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const ROLE = 'Application.Read.All';
const UAMI_PREFIX = 'uami-loom-console';
const SIGNIN_APP_PREFIX = 'CSA Loom Console';
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const graphFail = (res) => reasonForFailure(res, { role: ROLE, scope: 'tenant' }) ?? 'tooling-error';

/**
 * @param {object} ctx
 * @param {{cells:Array, controls:Array}} acc
 */
export async function run(ctx, acc) {
  const { cells, controls } = acc;
  const graph = ctx.cloud.graph;
  const opt = { required: false };

  // ---- (a) + CONTROL: the Graph service principal ----
  const sp = await ctx.client.request({
    service: 'graph',
    url: `${graph}/v1.0/servicePrincipals(appId='${GRAPH_APP_ID}')?$select=id,appId,appRoles`,
  });
  let graphSpId = null;
  let roleNameById = null;
  if (!sp.ok) {
    const reason = graphFail(sp);
    controls.push({ id: 'graph-service-principal-read-succeeded', status: 'unrunnable', detail: `the Graph service principal could not be read (HTTP ${sp.status ?? 'network'})` });
    cells.push(unknown(id('graph.agentIdentityReadAll'), reason, { ...opt, evidence: quote(sp) }));
  } else {
    const roles = sp.json?.appRoles;
    const sane = Array.isArray(roles) && roles.length > 0 && String(sp.json?.appId).toLowerCase() === GRAPH_APP_ID && typeof sp.json?.id === 'string';
    controls.push({
      id: 'graph-service-principal-read-succeeded',
      status: sane ? 'passed' : 'failed',
      detail: sane ? `the Graph service principal answered 200 with ${roles.length} app roles` : 'HTTP 200, but the body is not the Microsoft Graph service principal with its appRoles',
    });
    if (!sane) {
      cells.push(unknown(id('graph.agentIdentityReadAll'), 'tooling-error', { ...opt, evidence: { note: '200 that is not the Graph service principal' } }));
    } else {
      graphSpId = sp.json.id;
      roleNameById = new Map(roles.filter((r) => r && typeof r.id === 'string' && typeof r.value === 'string').map((r) => [r.id.toLowerCase(), r.value]));
      const appRoles = roles.filter((r) => r?.isEnabled !== false && Array.isArray(r?.allowedMemberTypes) && r.allowedMemberTypes.includes('Application')).map((r) => r.value);
      const has = appRoles.includes('AgentIdentity.Read.All');
      cells.push(measured(id('graph.agentIdentityReadAll'), has ? 'yes' : 'no', {
        ...opt, http: sp.status,
        evidence: { appRoleCount: roles.length, applicationRoleCount: appRoles.length, agentIdentityRoles: appRoles.filter((n) => /^AgentIdentity\./.test(n)).sort() },
      }));
    }
  }

  // ---- (b) the Console UAMI's Graph app-role assignments ----
  const uid = id('uami.graphAppRoles');
  const idents = await listAll(ctx, `${ctx.cloud.arm}/subscriptions/${encodeURIComponent(ctx.subscriptionId)}/providers/Microsoft.ManagedIdentity/userAssignedIdentities?api-version=${API.managedIdentity}`);
  if (!idents.ok) {
    cells.push(unknown(uid, reasonForFailureOrScope(idents.last), { ...opt, evidence: quote(idents.last) }));
  } else {
    const matches = idents.items.filter((i) => typeof i?.name === 'string' && i.name.startsWith(UAMI_PREFIX)).slice(0, 3);
    if (matches.length === 0) {
      cells.push(unknown(uid, 'not-located', { ...opt, evidence: { identitiesVisible: idents.items.length, searchedNamePrefix: UAMI_PREFIX } }));
    } else if (roleNameById === null) {
      cells.push(unknown(uid, sp.ok ? 'tooling-error' : graphFail(sp), { ...opt, evidence: { note: 'role names could not be resolved: the Graph service principal was not read' } }));
    } else {
      const out = [];
      let firstFailure = null;
      const statuses = [idents.last.status];
      for (const ident of matches) {
        const pid = ident?.properties?.principalId;
        if (!GUID_RE.test(String(pid))) { firstFailure ??= { res: null, note: `${ident.name}: no principalId in the list` }; continue; }
        const asg = await listAll(ctx, `${graph}/v1.0/servicePrincipals/${pid}/appRoleAssignments?$top=999`, { service: 'graph' });
        if (!asg.ok) { firstFailure ??= { res: asg.last, note: ident.name }; continue; }
        statuses.push(asg.last.status);
        const toGraph = asg.items.filter((a) => String(a?.resourceId).toLowerCase() === String(graphSpId).toLowerCase());
        const names = toGraph.map((a) => roleNameById.get(String(a?.appRoleId).toLowerCase())).filter((n) => typeof n === 'string').sort();
        out.push({
          uami: ident.name,
          graphAppRoles: names,
          graphAssignmentsWithUnresolvedRoleName: toGraph.length - names.length,
          assignmentsToOtherApis: asg.items.length - toGraph.length,
        });
      }
      if (out.length > 0) {
        cells.push(measured(uid, out.length === 1 ? out[0] : out, { ...opt, http: statuses, evidence: { uamisMatched: matches.length, uamisRead: out.length } }));
      } else {
        const res = firstFailure?.res;
        cells.push(unknown(uid, res ? graphFail(res) : 'tooling-error', { ...opt, evidence: { ...(res ? quote(res) : {}), note: firstFailure?.note ?? null } }));
      }
    }
  }

  // ---- (c) groupMembershipClaims on the sign-in app registration ----
  const cid = id('signinApp.groupMembershipClaims');
  const filter = encodeURIComponent(`startswith(displayName,'${SIGNIN_APP_PREFIX}')`);
  const apps = await ctx.client.request({
    service: 'graph', headers: { ConsistencyLevel: 'eventual' },
    url: `${graph}/v1.0/applications?$filter=${filter}&$select=id,displayName,groupMembershipClaims&$count=true`,
  });
  if (!apps.ok) {
    cells.push(unknown(cid, graphFail(apps), { ...opt, evidence: quote(apps) }));
  } else if (!Array.isArray(apps.json?.value)) {
    cells.push(unknown(cid, 'tooling-error', { ...opt, evidence: { note: 'HTTP 200 without value[]' } }));
  } else if (apps.json.value.length !== 1) {
    cells.push(unknown(cid, 'not-located', {
      ...opt,
      evidence: { matchedApps: apps.json.value.length, searchedDisplayNamePrefix: SIGNIN_APP_PREFIX, note: apps.json.value.length === 0 ? 'no app registration matched: the flag is unread, not unset' : 'more than one matched: which one is the sign-in app is ambiguous' },
    }));
  } else {
    const claim = apps.json.value[0]?.groupMembershipClaims ?? null;
    cells.push(measured(cid, claim === 'SecurityGroup' ? 'yes' : 'no', { ...opt, http: apps.status, evidence: { groupMembershipClaims: claim, matchedApps: 1 } }));
  }
}

/** The ARM identities list needs Reader on the subscription: name that, not the Graph role. */
function reasonForFailureOrScope(res) {
  return reasonForFailure(res, { role: 'Reader', scope: 'subscription' }) ?? 'tooling-error';
}
