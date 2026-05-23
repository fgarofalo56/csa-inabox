# Portal architecture — where admins and users go

The customer-facing answer to: *"Where is the admin portal? Where is
the user portal? How is this SaaS-like the way Fabric is?"*

## The short answer: ONE portal

**Loom Console** is the single SaaS-style entry point — same UI as
Microsoft Fabric's workspace experience. There is NOT a separate
"admin portal" and "user portal" — there's one Console with
**role-gated panes**, exactly the way Fabric works:

| What you see depends on... | Loom group membership | Fabric equivalent |
|---|---|---|
| Setup Wizard pane | Loom Admins | Fabric Admin Portal |
| Lakehouse / Warehouse / Notebook | Workspace member | Fabric workspace items |
| Semantic Model pane | Workspace member with build perm | Fabric semantic model |
| Activator pane | Workspace member with build perm | Reflex / Data Activator |
| Data Agent pane | Workspace member | Fabric Data Agents |
| Workspaces (home) | Anyone with any workspace assignment | Fabric Home |

The 8 panes are coded in `apps/fiab-console/lib/panes/` and the nav
visibility is controlled at the BFF layer (route guards in
`app/api/workspaces/route.ts` filter workspaces by caller's
`oid` + group membership in Cosmos).

## URL

After successful deploy with `deployAppsEnabled=true`:

```
https://loom-console.<random-suffix>.<region>.azurecontainerapps.io
```

The `<random-suffix>` is the Container Apps Env default-domain (deterministic per-env). Example from iter #8: `https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io`

## Why VNet-internal

By design (security baseline for federal customers): Console ingress
is `external: false` in `app-deployments.bicep`. The ingress only
accepts traffic from inside the Hub VNet. **Three access patterns
for end users:**

### Pattern A — Bastion + jumpbox (default, federal)
Operator deploys a Windows or Linux jumpbox VM in `snet-workloads`,
end users RDP/SSH via Azure Bastion, then browse to the Console
URL from the jumpbox.

Pros: full network isolation; aligns with FedRAMP High / IL5 access
patterns; only Bastion is internet-exposed (with MFA).

Cons: ceremony for end users; not a true "click a link" SaaS UX.

### Pattern B — Azure Front Door + WAF + Private Link Origin (production)
Operator adds:
- An Azure Front Door (Standard/Premium) with WAF Premium
- A Private Link service from the Container Apps Env
- A Front Door origin pointing at the Private Link service
- Front Door custom domain (e.g., `loom.yourorg.com`)

End users browse `https://loom.yourorg.com` from anywhere; Front
Door terminates TLS + applies WAF rules + tunnels through Private
Link to the internal Console. **This is what makes it feel like
Microsoft Fabric** — public hostname, but private origin.

Bicep stub provided at `platform/fiab/bicep/modules/admin-plane/public-frontdoor.bicep`
(gated behind `publicFrontdoorEnabled = false` by default).

### Pattern C — Demo/POC: flip ingress to external
For first-touch demos only, operator can flip the Container App
ingress to `external: true` temporarily:

```bash
az containerapp ingress update --name loom-console \
  --resource-group rg-csa-loom-admin-eastus2 \
  --type external
# After demo:
az containerapp ingress update --name loom-console \
  --resource-group rg-csa-loom-admin-eastus2 \
  --type internal
```

Now `https://loom-console.<env-default>.eastus2.azurecontainerapps.io`
is reachable from any browser. **MSAL auth still required** —
non-members get an Entra-side login redirect.

## Role-based pane visibility

Mirrors Fabric's `Member / Contributor / Admin / Viewer` model.

| Loom group | Console panes visible | Action permissions |
|---|---|---|
| Loom Admins (tenant) | All 8 panes including Setup Wizard | Provision DLZs, manage capacity, manage RBAC |
| Loom Workspace Admins (per-WS) | 7 panes (no Setup Wizard) | Full CRUD inside workspace |
| Loom Workspace Members (per-WS) | 7 panes | Create + edit items |
| Loom Workspace Viewers (per-WS) | 7 panes | Read-only |
| Loom Domain Stewards (per-domain) | Governance pane + read all WS in domain | Cross-workspace policy |

These groups are Entra security groups; assignment is the operator's
responsibility (typical: tied to existing AD groups).

## SaaS-feel design choices that match Fabric

1. **Persistent left nav** with item-type icons (Workspaces, Lakehouse,
   Warehouse, Notebook, Semantic Model, Activator, Data Agent, Setup) —
   matches Fabric's left rail
2. **Fluent UI v9** components throughout — Microsoft's official UI
   library, same library Fabric uses
3. **Dark/light theme** auto-detected from OS preference — like Fabric
4. **Brand top bar** with woven motif (CSA Loom identity) — analogous
   to Fabric's "Microsoft Fabric" header
5. **MSAL BFF auth** — same SSO flow as Fabric (Entra ID redirect →
   session cookie → server-side token exchange)
6. **OBO identity throughout** — every Data Agent query, every Activator
   action runs as the calling user (RLS/CLS applies), same as Fabric

## What this means for "have we built the Fabric experience?"

✅ **Yes for the architecture + code**:
- 8 panes coded matching Fabric's surface
- Auth, telemetry, RBAC, branding all in place
- Connects to real backing services (Databricks, Synapse, ADX,
  Cosmos, Event Hubs, Power BI XMLA)

⏳ **Pending for the running experience**:
- Container images need to be built + pushed to ACR (in flight via
  `full-app-deploy-commercial` workflow)
- Bicep needs to re-deploy with `deployAppsEnabled=true` (the
  workflow does this in its `redeploy-with-apps` job)
- End user needs Bastion access OR Front Door deployed (operator
  decision)

## Related

- App code: `apps/fiab-console/`
- Bicep app deploy: `platform/fiab/bicep/modules/admin-plane/app-deployments.bicep`
- Console pane catalog: [Loom Console panes](console/index.md)
- Operator deploy playbook: [First Deploy](runbooks/first-deploy.md)
- Iteration log: [Deploy Iteration Log](runbooks/deploy-iteration-log.md)
