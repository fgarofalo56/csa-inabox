# identity-picker — parity with Azure portal "Select members" / Fabric people-picker

Source UI:
- Azure portal — Access control (IAM) → Add role assignment → Members → "Select members" blade
  (https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal)
- Microsoft Graph identity search (https://learn.microsoft.com/graph/search-query-parameter)
- Group transitive membership (https://learn.microsoft.com/graph/api/group-list-transitivemembers)

The Identity Picker is a reusable Loom primitive (`lib/components/ui/identity-picker.tsx`)
used wherever a principal must be selected: RBAC grants, access policies, item
ownership, sharing. It mirrors the Azure "Select members" blade and the Fabric
people-picker, themed with Fluent v9 + Loom tokens.

## Azure / Graph feature inventory

| # | Capability (real portal / Graph) | Notes |
|---|----------------------------------|-------|
| 1 | Search by user display name | Tokenized — substring matches, not just prefix |
| 2 | Search by userPrincipalName (UPN) | Type a real UPN → the user resolves |
| 3 | Search by mail | Secondary match field |
| 4 | Search groups by display name / description | Security + M365 groups |
| 5 | Search service principals / managed identities | Apps + UAMIs |
| 6 | Switch principal kind (Users / Groups / Service principals) | Tabbed in the blade |
| 7 | See a group's members, including nested groups | Transitive (flattened) membership |
| 8 | Distinguish member kind in expanded list | user vs nested group vs SPN |
| 9 | Select a principal (returns id + type + displayName) | Drives the downstream grant |
| 10 | Clear the current selection | |
| 11 | Honest state when directory read is not permitted | Portal shows an error; Loom names the grant |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | `searchUsers` — `$search="displayName:<q>"` + `ConsistencyLevel: eventual` |
| 2 | ✅ built | `searchUsers` — `$search` includes `"userPrincipalName:<q>"` (tokenized, real UPN resolves) |
| 3 | ✅ built | `searchUsers` — `$search` includes `"mail:<q>"`; `secondary()` shows mail |
| 4 | ✅ built | `searchGroups` — `$search` over displayName + description + mail |
| 5 | ✅ built | `searchServicePrincipals` — `$search` over displayName + description; `servicePrincipalType` badge |
| 6 | ✅ built | `<IdentityPicker kind="all">` → Fluent `TabList` (Users / Groups / Service principals) |
| 7 | ✅ built | `getGroupTransitiveMembers` → `GET /v1.0/groups/{id}/transitiveMembers`; inline expand row with chevron |
| 8 | ✅ built | `@odata.type` → `user` / `group` / `spn`, per-row kind icon |
| 9 | ✅ built | `onSelect(hit)` — returns `{ id, type, displayName, upn?, appId? }` |
| 10 | ✅ built | Selected chip with a `Dismiss16Regular` clear button |
| 11 | ⚠️ honest-gate | 503 from the BFF → Fluent `MessageBar intent="warning"` naming the exact 3 AppRole grants + consent step |

Zero ❌ — every inventory row is built ✅ or honest-gate ⚠️.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Users tab search | `GET {graphBase}/v1.0/users?$search="displayName:<q>" OR "userPrincipalName:<q>" OR "mail:<q>"` (`ConsistencyLevel: eventual`) |
| Groups tab search | `GET {graphBase}/v1.0/groups?$search="displayName:<q>" OR "description:<q>" OR "mail:<q>"` |
| Service principals tab search | `GET {graphBase}/v1.0/servicePrincipals?$search="displayName:<q>" OR "description:<q>"` |
| All-kinds search | `searchAll` — parallel `Promise.allSettled` of the three above, merged + deduped |
| Group "Members" expand | `GET {graphBase}/v1.0/groups/{id}/transitiveMembers?$select=…,@odata.type` (paginated via `@odata.nextLink`) |
| Honest gate | BFF 503 `{ ok:false, error:'not_configured'\|'graph_403', hint:{ rolesRequired[] } }` |

`{graphBase}` = `LOOM_GRAPH_BASE` — `graph.microsoft.com` (Commercial/GCC),
`graph.microsoft.us` (GCC-High), `dod-graph.microsoft.us` (IL5). The token
scope is derived from the same base, so gov tenants mint a sovereign-scoped
token (the older mip/dlp clients hard-code the commercial scope — a separate
follow-up).

## No Fabric dependency

All calls are pure Microsoft Graph / Entra. Nothing reads `fabricWorkspaceId`,
`LOOM_DEFAULT_FABRIC_WORKSPACE`, or any Fabric/Power BI host. Works fully with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Enablement (bicep-synced)

- Param: `loomIdentityPickerEnabled` (top-level `main.bicep` → `admin-plane/main.bicep`)
- Env: `LOOM_IDENTITY_PICKER_ENABLED=true` + `LOOM_GRAPH_BASE` wired into the loom-console Container App
- Module: `admin-plane/identity-graph-rbac.bicep` (documents the 3 AppRoles + sovereign endpoint)
- Grants: `scripts/csa-loom/grant-identity-graph-approles.sh` + post-deploy-bootstrap job
- Consent: Tenant Admin grants admin consent (Entra → Enterprise applications → Console UAMI → Permissions)
