# Runbook — Boundary promotion (GCC-H → IL5)

## When to use

Customer is currently running CSA Loom in GCC-High / IL4 and needs to
promote a portion (or all) of their workload to DoD IL5 because of
classification changes or audit-scope expansion.

**v1 supports GCC-H. IL5 support lands in v1.1.** This runbook is the
authoritative procedure for the promotion once v1.1 is GA.

## Important: promotion is not in-place

IL5 requires:
- Different regions (usdodcentral / usdodeast OR usgov* with IL5
  isolation config)
- HSM-CMK storage (`requireInfrastructureEncryption: true`)
- Atlas-on-AKS catalog (Purview NOT in IL5 audit scope)
- Customer-managed plan only (publisher-managed not viable at IL5)
- Different `.bicepparam` (`il5.bicepparam`)

These differences are substantial enough that promotion = **side-by-
side deploy + migrate**, not an in-place transformation.

## Pre-promotion checklist

| Item | Verify |
|---|---|
| Customer ATO covers IL5 | Federal ATO documentation |
| Loom v1.1 GA | Release page |
| New IL5-eligible subscriptions provisioned | Azure portal |
| HSM-backed Key Vault Premium quota | Per-region quota |
| AKS cluster quota for Atlas + workloads | `az vm list-usage` |
| Power BI Premium F-SKU available in IL5 region | Power BI admin portal |
| Classification labeling on workload data | Customer-defined |

## Procedure

### Step 1 — Stand up Loom IL5 in parallel

```bash
cd platform/fiab/azd
azd env new prod-il5
azd env set AZURE_CLOUD AzureUSGovernment
az cloud set --name AzureUSGovernment
azd auth login
azd env set CSA_LOOM_BOUNDARY IL5
azd env set AZURE_LOCATION usdodcentral
azd env set CSA_LOOM_CATALOG_PRIMARY atlas-aks
azd env set CSA_LOOM_KEYVAULT_HSM_ISOLATED true
azd env set CSA_LOOM_STORAGE_REQUIRE_CMK true
azd up
```

Provisions:
- Admin Plane in IL5 sub
- DLZ(s) in IL5 subs
- Self-hosted Apache Atlas on AKS (Solr + HBase + Kafka stack)
- HSM-CMK on all storage accounts
- Customer-managed Marketplace plan (if applicable)

### Step 2 — Capture GCC-H state

```bash
fiab-migrate snapshot \
  --admin-plane-sub-id <GCC-H-SUB-A> \
  --source-boundary GCC-High \
  --output ./gcch-state.json
```

### Step 3 — Plan migration to IL5

```bash
fiab-migrate plan \
  --snapshot ./gcch-state.json \
  --target-tenant <IL5-TENANT> \
  --target-boundary IL5 \
  --output ./gcch-to-il5-plan.json
```

Plan flags items that require manual review:
- Purview catalog assets → must migrate to Atlas (UX difference)
- Sensitivity labels → must re-author for IL5 boundary
- Workloads with Defender for Cloud AI Threat Protection
  dependencies → must verify Sentinel pipeline equivalent

### Step 4 — Execute migration per workload

Workload-by-workload (NOT all at once):
```bash
fiab-migrate execute \
  --plan ./gcch-to-il5-plan.json \
  --workload finance \
  --commit
```

For each workload:
1. Copy Delta tables from GCC-H ADLS to IL5 ADLS (azcopy)
2. Re-deploy semantic models in IL5 Power BI workspace
3. Re-register Activator rules in IL5 Activator Engine
4. Re-import Data Agents to IL5
5. Re-bind Power BI reports

### Step 5 — Verify per workload

```bash
fiab-migrate verify --workload finance --target il5
```

Manual checks:
- Sample queries return same results in IL5 as GCC-H
- Audit logs flowing to IL5 Sentinel
- Data residency tagging correct (CUI-NSS for CNSSI 1253)
- HSM-CMK rotation working

### Step 6 — Cutover per workload

After validation period:
- Point IL5-classified consumers at IL5 workload
- Keep GCC-H workspace operational for non-IL5 data
- Decommission GCC-H workspace if all data moved to IL5

### Step 7 — Optionally decommission GCC-H entirely

If all workloads promote to IL5:
- Stop GCC-H Loom Console + parity services
- Tear down GCC-H Admin Plane RG
- Retain ADLS data per data-retention policy

## Common issues

| Issue | Fix |
|---|---|
| Purview asset mapping not 1:1 to Atlas | Manual re-catalog in Atlas |
| Sensitivity labels lost in transit | Re-author MIP labels in IL5 environment |
| Foundry Agent Service unavailable at IL5 | MAF + AOAI direct (already the Gov default) |
| F-SKU regional availability at usdodcentral/east | Use usgov* with IL5 isolation config as alternative |

## Related

- Operations: [Upgrade & migration](../operations/upgrade-migration.md)
- Compliance: [DoD IL5](../compliance/dod-il5.md)
- ADR: [fiab-0010 Container host](../adr/0010-container-host.md), [fiab-0011 Tenancy model](../adr/0011-tenancy-model.md)
