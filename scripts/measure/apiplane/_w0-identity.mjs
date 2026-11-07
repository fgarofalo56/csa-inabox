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
 *     `groupMembershipClaims=SecurityGroup`. The exact name needs the Key Vault name,
 *     and the bootstrap workflow resolves that vault as the one named kv-loom*
 *     (keyvault.bicep: kv-loom-<uniqueString>), so the probe lists the Key Vaults,
 *     builds "CSA Loom Console (<kv-loom* name>)" and queries `displayName eq '<that>'`
 *     FIRST. Only when the exact name finds nothing (or no kv-loom* vault is visible)
 *     does it fall back to the display-name prefix "CSA Loom Console". Exactly one
 *     match is required to answer yes/no; zero or several is unknown:not-located and
 *     several lists the matched display NAMES (never an appId, object id or any GUID).
 *     NOTE the in-bicep path (main.bicep, off by default) names its app after the
 *     RESOURCE GROUP instead - "CSA Loom Console (<resource group>)" - so an estate
 *     that ran both paths holds two registrations, which is what the names expose.
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
 *   Key Vaults - List By Subscription (value[].name, nextLink; this probe reads names only). The
 *   Console uses api-version 2023-07-01 for the same list in both clouds
 *   (apps/fiab-console/lib/gates/registry/types.ts); Learn's current page is 2024-11-01:
 *     https://learn.microsoft.com/en-us/rest/api/keyvault/keyvault/vaults/list-by-subscription
 *   User-assigned identities list (properties.principalId), 2023-01-31:
 *     https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/list-by-subscription?view=rest-managedidentity-2023-01-31
 *   Graph endpoint per cloud (graph.microsoft.com / graph.microsoft.us):
 *     https://learn.microsoft.com/en-us/graph/deployments
 */
import { API, listAll, measured, quote, reasonForFailure, sanitize, unknown } from './_w0-core.mjs';

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
const KV_PREFIX = 'kv-loom';
const KV_NAME_RE = /^[a-zA-Z0-9-]{3,24}$/;
const MAX_EXACT_NAMES = 5;
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
  cells.push(await signinAppCell(ctx, opt));
}

/**
 * The Key Vault names the sign-in app can be named after. bootstrap-msal-app-reg.sh names the app "CSA Loom Console
 * (<KEYVAULT_NAME>)" and the bootstrap workflow resolves that vault as the one named kv-loom* (keyvault.bicep:
 * kv-loom-<uniqueString>), so the EXACT display name is derivable from a Key Vault list. Returns the exact display names to
 * search for, or why there are none (the lookup then falls back to the prefix search - a failed list must not blank the cell).
 */
async function exactSigninNames(ctx) {
  const vaults = await listAll(ctx, `${ctx.cloud.arm}/subscriptions/${encodeURIComponent(ctx.subscriptionId)}/providers/Microsoft.KeyVault/vaults?api-version=${API.keyVault}`);
  if (!vaults.ok) {
    return { names: [], skipped: vaults.malformed ? 'the Key Vault list answered 200 without value[]' : `the Key Vault list answered HTTP ${vaults.last?.status ?? 'network'}` };
  }
  // KV_NAME_RE is the Key Vault naming rule AND what makes a name safe to splice into an OData string literal
  const found = [...new Set(vaults.items.map((v) => v?.name).filter((n) => typeof n === 'string' && KV_NAME_RE.test(n) && n.toLowerCase().startsWith(KV_PREFIX)))].sort();
  if (found.length === 0) {
    return { names: [], skipped: `no Key Vault named ${KV_PREFIX}* is visible (${vaults.items.length} vault(s) listed${vaults.truncated ? ', the list is truncated' : ''})` };
  }
  return { names: found.slice(0, MAX_EXACT_NAMES).map((n) => `${SIGNIN_APP_PREFIX} (${n})`), skipped: null, capped: found.length > MAX_EXACT_NAMES };
}

/**
 * Which app registration is the sign-in app, and does it carry groupMembershipClaims=SecurityGroup? EXACT display name FIRST
 * (built from the kv-loom* vault), the display-name PREFIX only when the exact name finds nothing. Exactly one match answers
 * yes/no; zero or several is unknown:not-located, and several lists the matched display NAMES (names only: never an appId, an
 * object id or any GUID) so the ambiguity can be diagnosed from the artifact.
 */
async function signinAppCell(ctx, opt) {
  const cid = id('signinApp.groupMembershipClaims');
  const query = (filter) => ctx.client.request({
    service: 'graph', headers: { ConsistencyLevel: 'eventual' },
    url: `${ctx.cloud.graph}/v1.0/applications?$filter=${encodeURIComponent(filter)}&$select=id,displayName,groupMembershipClaims&$count=true`,
  });

  const exact = await exactSigninNames(ctx);
  const search = {
    exactNamesSearched: exact.names, exactNameStepSkipped: exact.skipped, searchedDisplayNamePrefix: SIGNIN_APP_PREFIX,
    ...(exact.capped ? { exactNamesCapped: MAX_EXACT_NAMES } : {}),
  };
  let matchedBy = 'exact-display-name';
  let res = null;
  if (exact.names.length) {
    res = await query(exact.names.map((n) => `displayName eq '${n}'`).join(' or '));
    if (res.ok && Array.isArray(res.json?.value) && res.json.value.length === 0) res = null; // nothing by exact name: fall back
  }
  if (res === null) {
    matchedBy = 'display-name-prefix';
    res = await query(`startswith(displayName,'${SIGNIN_APP_PREFIX}')`);
  }
  if (!res.ok) return unknown(cid, graphFail(res), { ...opt, evidence: { ...quote(res), ...search } });
  if (!Array.isArray(res.json?.value)) return unknown(cid, 'tooling-error', { ...opt, evidence: { note: 'HTTP 200 without value[]', ...search } });

  const apps = res.json.value;
  // NAMES only, and only the name: the objects also carry id / appId, which must never reach an output. sanitize() redacts a
  // GUID that a display name itself happens to contain.
  const names = apps.map((a) => sanitize(String(a?.displayName ?? ''), 120)).sort();
  if (apps.length === 0) {
    return unknown(cid, 'not-located', { ...opt, evidence: { matchedApps: 0, ...search, note: 'no app registration matched: the flag is unread, not unset' } });
  }
  if (apps.length > 1) {
    return unknown(cid, 'not-located', {
      ...opt,
      evidence: { matchedApps: apps.length, matchedBy, matchedDisplayNames: names.slice(0, 20), ...search, note: 'more than one matched: which one is the sign-in app is ambiguous - the matched display names are listed' },
    });
  }
  const claim = apps[0]?.groupMembershipClaims ?? null;
  return measured(cid, claim === 'SecurityGroup' ? 'yes' : 'no', {
    ...opt, http: res.status, evidence: { groupMembershipClaims: claim, matchedApps: 1, matchedBy, matchedDisplayName: names[0], ...search },
  });
}

/** The ARM identities list needs Reader on the subscription: name that, not the Graph role. */
function reasonForFailureOrScope(res) {
  return reasonForFailure(res, { role: 'Reader', scope: 'subscription' }) ?? 'tooling-error';
}
