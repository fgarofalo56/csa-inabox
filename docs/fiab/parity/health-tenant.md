<!-- parity-doc-meta
Reviewed-on: 2026-10-26
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
| Quotas / limits | built read-only (requests/min, storage GiB); editing MISSING |
| Access (roles -> scopes) | MISSING - W1-4 authorization server UI |
| Keys (per-tenant CMK status, rotate) | MISSING - rotate-keys job not exposed yet |
| Consent policy, Feeds, Cost, Evidence | MISSING - later waves |
| Retry after a failed deployment | built (Retry on the failure bar) |
| Pause / resume / evacuate | MISSING - W1-8 |

Five rows are MISSING, and quota editing is MISSING inside a built row. This surface cannot be A-grade until they are built or
each is replaced by an honest gate.

## Loom coverage and backend per control

| Control | Calls | Backend |
|---|---|---|
| Editor open | `GET /api/health/tenants/[id]` then `POST` (ensure) | item record + control plane `GET /api/health/tenants/{id}`, `GET /api/health/jobs/{id}` |
| Provision / self-heal / Verify now | `POST /api/health/tenants/[id]` | control plane `POST /tenants`, `POST /jobs` (`tenant.create`) |
| Retry | `POST /api/health/tenants/[id]` `{retry:true}` | control plane `POST /jobs/{id}/retry` |
| Tenant list | `GET /api/health/tenants` | control plane `GET /tenants` |

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

## Capability (D12)

`health.tenant-admin` ("Health Tenant Admin") has no parent in the capability
catalog, so a grant on Tenant administration does not cascade to it. **Known
gap:** `checkCapability` has a tenant-admin bypass (`feature-gate.ts`), so a
Loom tenant admin still passes this capability implicitly. Making it strictly
non-inherited needs a change to that shared file; not done here.

## Cloud status

Commercial and GCC-High: supported-in-code, never exercised (the control plane
and stamp have no deploy receipt). IL5/DoD: supported-in-code only. GCC: not
offered. No boundary was verified by this change.
