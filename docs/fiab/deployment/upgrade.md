# Upgrade lifecycle

CSA Loom releases follow semantic versioning. Customers upgrade via
`azd up` re-run or the Console "Updates" pane.

## Release channel

- **Bicep platform**: `platform/fiab/bicep/main.bicep` version tag
  (e.g., `v1.0.5`)
- **Container images**: per-workload tags (Console v1.0.5, MCP
  v1.0.5, Activator v1.0.5, etc.) pushed to public Microsoft ACR
- **Documentation**: tracks Bicep version (same `v1.0.5` tag)
- **PRPs**: separately versioned (PRP-NN-vN.md if revised post-v1)

Release cadence: quarterly for minor (v1.0 → v1.1); on-demand for
patch (v1.0.0 → v1.0.1) for security fixes or critical bugs.

## Upgrade via `azd up` re-run

```bash
cd platform/fiab/azd
git pull origin main      # or git checkout v1.0.5 tag
azd env select prod-eastus2
azd provision --preview   # see what would change
azd up                    # apply
```

What `azd up` does on upgrade:
1. Detects changed Bicep modules vs deployed state
2. Pulls new container images from public ACR
3. Performs rolling restart of Container Apps / AKS workloads
4. Runs Bicep what-if; applies idempotent changes only
5. Console serves the new version once health checks pass

## Upgrade via Console "Updates" pane

Per the MCP-as-update-channel pattern from [PRP-05](../../../PRPs/active/csa-loom/PRP-05-mcp-server.md):

1. Console "Admin → Updates" pane shows current version + available
   updates (polled from Microsoft public release feed)
2. Customer clicks **Check for updates** → MCP pings release feed
3. Customer clicks **Apply update** → MCP pulls new container images
   + runs Bicep what-if + applies incrementally
4. Console rolling-restarts; no downtime for stateless workloads

Optionally configure **auto-update** with a maintenance window:
- "Apply patches automatically Sunday 2:00 AM"
- "Notify before minor version upgrades; require admin approval"

## Bicep-module-only updates (no container changes)

For Bicep-only patches (e.g., new resource property, tagging
adjustment):
```bash
azd provision --preview   # confirms only Bicep changes
azd provision             # apply without re-pulling container images
```

## Container-image-only updates (no Bicep changes)

For container hotfixes:
- Loom Console "Updates" pane shows "Container image update available"
- Customer applies → MCP runs `kubectl rollout restart` (AKS) or
  Container App revision upgrade (ACA)
- ~2-5 min downtime per workload during rolling restart

## Major version upgrade (v1 → v2)

Major versions (v1.0 → v2.0) may introduce breaking changes:
- New required parameters
- Re-architected modules
- Removed deprecated features (called out in release notes)

Procedure:
1. Read release notes carefully
2. Run `azd provision --preview` to see destructive changes
3. Plan downtime window
4. Apply during low-traffic period

v1.1 → v2.0 (the v2 Fabric IQ family addition) is non-breaking —
new modules added; nothing removed.

## Rollback

If an upgrade fails:
```bash
# Identify the previous Bicep tag
git log --oneline -- platform/fiab/bicep/

# Roll back
git checkout <previous-tag>
azd up
```

Container images: previous tags remain in public ACR for 90 days;
roll back container revision via Bicep or `az containerapp revision`.

## Pre-upgrade testing

- Stage upgrade in a non-prod environment first (`azd env select staging`)
- Run `mkdocs build --strict` on docs if upgrading content-only
  changes
- Smoke-test Loom Console + create a test workspace + run a sample
  query

## Validation

After upgrade:
```bash
curl https://<console-url>/api/version
# Expected: {"version": "v1.0.5", "buildSha": "..."}

curl https://<console-url>/api/health
# Expected: {"status":"healthy"}
```

## Upgrade-related runbooks

- [Deploy failure runbook](../runbooks/deploy-failure.md) — generalizes
  to upgrade failures

## Major release notes

- v1.0 (initial GA — target weeks 20-24 from build start)
- v1.1 (+3 mo): +IL5; +Power BI embedded; +remaining 17 examples;
  +`fiab-migrate` CLI; +Operations Agent
- v2.0 (+6 mo): Fabric IQ family parity

## Related

- ADR: [fiab-0008 Deployment shape](../adr/0008-deployment-shape.md)
- [azd CLI deployment](azd-cli.md)
- [Operations — Upgrade & Migration](../operations/upgrade-migration.md)
