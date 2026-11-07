<!-- parity-doc-meta
Reviewed-on: 2026-10-27
Validated-against:
  - apps/fiab-console/lib/editors/health/tenant-editor.tsx
  - apps/fiab-console/lib/install/provisioners/health-tenant.ts
  - apps/fiab-console/app/api/health/tenants/**
-->

# health-tenant - parity with the Azure Health Data Services workspace blade

> **LHDS W1-7. Not A-grade.** Merged state only; the in-browser walk (G1) has NOT
> been done (the Commercial estate is paused, so there is no live control plane to
> walk against). Per `ux-baseline.md` this surface is therefore **unverified**,
> whatever the table below says is built. Azure-native: no Fabric or Power BI host
> is reachable (`no-fabric-dependency.md`).

Source UI: **Azure portal -> Azure Health Data Services workspace** (Overview,
FHIR/DICOM service list, Networking, Identity), grounded in
<https://learn.microsoft.com/azure/healthcare-apis/healthcare-apis-overview>.
Design reference: `PRPs/active/loom-health-data-services/LOOM-INTEGRATION.md` s1.

## Azure/Fabric feature inventory

| Capability on the real blade | Loom coverage |
|---|---|
| Overview: name, region, provisioning state | built (display name, tenant id, stamp, status, last verified) |
| Provisioning progress while the workspace deploys | built (create-job receipts on the Overview) |
| Child services list (FHIR, DICOM) | MISSING - arrives with W2/W3 child items |
| Services/resources behind the workspace | built (Services tab: readback kind, Azure name, id) |
| Quotas / limits | built: Quotas tab edits requests/min and storage GiB (control plane `PATCH /tenants/{id}`, validated on both sides) |
| Access (roles -> scopes) | MISSING - the authorization server's client/role endpoints are not wired into the control plane's compose/main yet (W1-4), so there is nothing to call. Its Graph-consent prerequisite is an honest gate (`health-auth-graph-consent`, below) |
| Keys (per-tenant CMK status, rotate) | MISSING - the control plane has no rotate-keys job (job kinds today: tenant.create, tenant.destroy, routing.publish, stamp.postgres-restart) |
| Consent policy, Feeds, Cost, Evidence | MISSING - later waves |
| Retry after a failed deployment | built (Retry on the failure bar) |
| Pause / resume / evacuate | MISSING - W1-8 pauses a whole stamp from the estate-power lane; the control plane has no per-tenant pause or evacuate job to call |

Five rows remain MISSING (child services, Access, Keys, Consent/Feeds/Cost/Evidence, Pause/resume/evacuate); quota editing is
now built. This surface cannot be A-grade until they are built or each is replaced by an honest gate.

## Loom coverage and backend per control

| Control | Calls | Backend |
|---|---|---|
| Editor open | `GET /api/health/tenants/[id]` then `POST` (ensure) | item record + control plane `GET /api/health/tenants/{id}`, `GET /api/health/jobs/{id}` |
| Provision / self-heal / Verify now | `POST /api/health/tenants/[id]` | control plane `POST /tenants`, `POST /jobs` (`tenant.create`) |
| Retry | `POST /api/health/tenants/[id]` `{retry:true}` | control plane `POST /jobs/{id}/retry` |
| Tenant list | `GET /api/health/tenants` | control plane `GET /tenants` |
| Save quotas | `PATCH /api/health/tenants/[id]` `{quotas}` | control plane `PATCH /tenants/{id}` |

The control plane's `tenant.create` job deploys the tenant's PostgreSQL database,
two Blob accounts, an Event Hubs hub, a managed identity, a capacity alert and
Key Vault keys on the stamp, then reads each back; the Console renders those
receipts and never calls ARM for a tenant itself.

## auto-bind behaviour

- Names: the control-plane tenant carries the item's display name verbatim; its
  id is a lowercase slug (2-30 chars) recorded on the item with a `sanitized`
  flag. A slug owned by a different tenant gets an item-id suffix.
- Self-heal: each open re-reads the tenant. A tenant removed from the control
  plane is re-registered; a lost state write is re-derived and the existing
  tenant adopted; a bound tenant is re-verified by an idempotent job once per 24 h.
- Never a bind form: provisioning progress renders on the Overview.

## Gates (G2) - `/admin/gates`

| Gate | Fix-it | Honest state |
|---|---|---|
| `health-control-plane` | env-picker (`LOOM_HEALTH_CP_URL`, `LOOM_HEALTH_CP_AUDIENCE`) | opt-in by cost: neutral until health is deployed |
| `health-stamp-capacity` | wizard (deploy a stamp, then name it) | applies only once the control plane exists |
| `health-gov-image-gate` | wizard (no operator action; blocked on #4584) | applies only once a Gov stamp exists |
| `health-lakehouse-isolation` | env-picker (`verified`) | applies only once the control plane exists |
| `health-auth-graph-consent` | wizard (a Global Administrator consents, then set `LOOM_HEALTH_AUTH_GRAPH_CONSENT=granted`) | tenant-level consent the platform cannot give; records the operator's confirmation until the control plane's `/api/health/auth/readiness` is reachable from the Console |

## Capability (D12)

`health.tenant-admin` ("Health Tenant Admin") is NOT inherited from Loom
administration. Decision D12 in
`PRPs/active/loom-health-data-services/RISKS-AND-OPEN-DECISIONS.md` resolves it as
"New `Health Tenant Admin` capability, not inherited from Loom Admin" (the
rejected alternative is "inherit"). The shared `checkCapability` returns allow for
every Loom tenant admin and walks ancestor grants, so health does not use it: the
routes and the provisioner use `app/api/health/tenants/_lib/tenant-admin-gate.ts`,
which admits only an explicit grant on `health.tenant-admin` itself. A Loom tenant
admin can still grant themselves the capability at `/admin/permissions`; the grant
is deliberate and auditable instead of implied. Device-code sessions are refused.

## Not done in this change

- Creating the item does not provision at create time. The shared create path
  (`createOwnedItem` -> `autoBindOnCreate` in `lib/azure/auto-bind.ts`) has no
  `health-tenant` arm and sits outside this lane's files; the tenant is created on
  the first editor open (idempotent, self-healing, progress on the Overview, never
  a bind form). Adding the arm is a small follow-up in that shared file.
- The in-browser walk (G1) has not been run; this is not A-grade.

## Cloud status

Commercial and GCC-High: supported-in-code, never exercised (the control plane
and stamp have no deploy receipt). IL5/DoD: supported-in-code only. GCC: not
offered. No boundary was verified by this change.
