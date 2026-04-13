# ARM Templates (Deprecated)

This directory contains legacy Azure Resource Manager (ARM) templates from
the original CSA-in-a-Box deployment.

**ARM templates are deprecated.** All new infrastructure is authored in
[Bicep](../bicep/) which compiles to ARM JSON but provides:

- Concise, readable syntax
- First-class parameter validation (`@allowed`, `@minLength`)
- Module composition and code reuse
- Integrated linting via `bicepconfig.json`

## Migration Status

| Component | ARM Status | Bicep Module |
|-----------|-----------|-------------|
| Purview | Retained for reference | `deploy/bicep/DMLZ/modules/governance/governance.bicep` |
| Data Landing Zone | Migrated | `deploy/bicep/DLZ/` |
| Data Management LZ | Migrated | `deploy/bicep/DMLZ/` |
| Landing Zone (ALZ) | Migrated | `deploy/bicep/LandingZone-ALZ/` |

## Usage

Do **not** deploy from ARM templates directly. Use the Bicep modules:

```bash
az deployment sub create \
  --location eastus \
  --template-file deploy/bicep/DLZ/main.bicep \
  --parameters deploy/bicep/DLZ/params.dev.json
```

See [Getting Started](../../docs/GETTING_STARTED.md) for the full deployment guide.
