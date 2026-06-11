# loom-skills scripts

Read-only helper scripts an AI coding agent (or a developer) can run to ground
its work in the **active CSA Loom sovereign cloud** before generating code.
Neither script mutates anything.

| Script | Purpose |
|---|---|
| `loom-token.sh [resource]` | Acquire an Azure-native access token (`arm`/`storage`/`kusto`/`search`/`graph`/`synapse-sql`) for the active cloud — the Azure-native analogue of `az account get-access-token --resource https://api.fabric.microsoft.com`. Requires `az login`. |
| `loom-endpoint-probe.sh` | Print the resolved per-cloud endpoint table (ARM, DFS, Kusto, Service Bus, Synapse SQL, Key Vault, AI Search, Cosmos, Log Analytics, AOAI, Graph) so you target the right hosts. Mirrors `cloud-endpoints.ts`. |

Both honor `LOOM_CLOUD` (`Commercial|GCC|GCC-High|DoD`) then `AZURE_CLOUD`, and
`LOOM_ARM_ENDPOINT` for clouds not enumerated. They never reach a Fabric /
Power BI host.

```bash
# Which hosts am I targeting?
bash scripts/loom-endpoint-probe.sh

# Token for an ARM control-plane call (default)
bash scripts/loom-token.sh

# Token for the AI Search data plane
bash scripts/loom-token.sh search
```
