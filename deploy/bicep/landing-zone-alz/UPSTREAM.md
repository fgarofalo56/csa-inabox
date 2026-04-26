# UPSTREAM provenance & re-sync runbook — `landing-zone-alz/`

This subtree is a **vendored fork-snapshot** of the
[Azure/ALZ-Bicep](https://github.com/Azure/ALZ-Bicep) reference
implementation, with local hardening overlays.  This file documents
what was vendored, why we forked, and how to re-sync safely.

> Owner: platform team.  Last reviewed: 2026-04-26 (PR #105).

## What is vendored here

The tree at `deploy/bicep/landing-zone-alz/` mirrors the directory
shape of `Azure/ALZ-Bicep` at the time of import:

| Local path | Upstream equivalent |
|------------|--------------------|
| `00_ResourceGroup/` | `infra-as-code/bicep/orchestration/subPlacementAll/` (RG step) |
| `01_Logging/` | `infra-as-code/bicep/modules/logging/` |
| `02_Policy/` | `infra-as-code/bicep/modules/policy/assignments/` |
| `03_Network/` | `infra-as-code/bicep/modules/hubNetworking/` |
| `CRML/` | `infra-as-code/bicep/CRML/` (CARML wrappers) |
| `modules/` | `infra-as-code/bicep/modules/` (shared modules: storage, networking/dns, networking/spoke, etc.) |
| `main.bicep` | Composed top-level entrypoint (local) |
| `params.*.json` | Parameter files (local; not from upstream) |

The upstream snapshot was imported in commit
[`55304a5`](https://github.com/fgarofalo56/csa-inabox/commit/55304a5)
("restructure repo for monorepo split", PR #37) without a
provenance marker.  The exact upstream commit SHA was not recorded
at import time.

## Why we forked (do NOT blind re-sync)

Local divergences from upstream that **must be preserved** during any
re-sync:

| Local change | Origin | Why |
|--------------|--------|-----|
| `00_ResourceGroup/resourceGroup.bicep` defaults flipped to `Standard_GRS` (CKV_AZURE_206) | PR #103/#104 | Cross-region durability default for lab |
| `modules/storage/storageAccount.bicep` GRS default + default-deny ACL | PR #103/#104 | Same |
| `modules/networking/dns/dnsforwarder.bicep` VMSS `automaticOSUpgradePolicy.enableAutomaticOSUpgrade=true`, `disableAutomaticRollback=false` (CKV_AZURE_95) | PR #103/#104 | Pin OS upgrades on |
| `CRML/containerRegistry/containerRegistry.bicep` quarantine + trust policy + skip annotations | PR #103 | Premium-SKU defensive defaults |
| `modules/resourceGroup/{resourceGroup,resourceGroupLock}.bicep` (created) | PR #104 (`cadd63f`) | Spoke module imports from this path; upstream emits it differently |
| Various `// #checkov:skip=...` annotations | PRs #57, #65, #103, #104 | Per-module rationale (see `.checkov.yaml`) |

Any blind `cp -r upstream/* local/` re-sync would silently undo every
one of these and re-introduce the 102-finding Checkov state we worked
down to 4.

## Re-sync runbook (3-way merge)

When upstream `Azure/ALZ-Bicep` ships a feature/fix worth pulling in,
follow this runbook.  **Do not skip steps.**

### 1. Capture the current vendored snapshot's hash

From repo root:

```bash
git -C deploy/bicep/landing-zone-alz \
    ls-files -z | xargs -0 sha256sum | sort | sha256sum > /tmp/vendored.sha
```

This gives a single deterministic hash of the current tree.

### 2. Identify the target upstream commit

```bash
gh repo clone Azure/ALZ-Bicep /tmp/alz-upstream
cd /tmp/alz-upstream
git log --oneline --since='6 months ago' -- infra-as-code/bicep/modules
# Pick a tagged release if available, e.g. v0.18.0
git checkout v0.18.0
```

### 3. Build a baseline of what we *originally* imported

There is no recorded import SHA.  Find the closest upstream commit
that matches the current vendored layout:

```bash
# Start from the import commit (PR #37, 55304a5)
git -C /path/to/csa-inabox show 55304a5 -- deploy/bicep/landing-zone-alz/modules/storage/storageAccount.bicep > /tmp/our-storage.bicep

# Bisect upstream history for a matching file
cd /tmp/alz-upstream
git log --all --oneline --diff-filter=A -- infra-as-code/bicep/modules/storageAccount/storageAccount.bicep | head
git diff <upstream-sha>:infra-as-code/bicep/modules/storageAccount/storageAccount.bicep /tmp/our-storage.bicep
```

When you find the closest match (typically within a few commits of
2024-Q3), record it:

```bash
echo "BASELINE_UPSTREAM_SHA=<sha>" >> deploy/bicep/landing-zone-alz/UPSTREAM.env
```

### 4. Generate the upstream patch and apply with conflict resolution

```bash
cd /tmp/alz-upstream
git diff <BASELINE_UPSTREAM_SHA> v0.18.0 -- infra-as-code/bicep/modules > /tmp/upstream.patch

cd /path/to/csa-inabox
git checkout -b chore/alz-resync-v0.18.0
git apply --reject --directory=deploy/bicep/landing-zone-alz/modules /tmp/upstream.patch
```

### 5. Manually resolve every `.rej` file

For each rejected hunk:
1. Compare the upstream change against our local override (use the
   "Local change" table above).
2. Decide: take upstream, keep ours, or merge by hand.
3. Re-run Checkov to confirm we have not regressed:

```bash
checkov -d deploy --framework bicep --config-file .checkov.yaml --quiet --compact
```

### 6. Re-run Bicep build on the full ALZ tree

```bash
az bicep build --file deploy/bicep/landing-zone-alz/main.bicep --stdout > /dev/null
echo "exit=$?"
```

This is the same step the `Validate Bicep (ALZ)` workflow runs.  If
it surfaces a `BCP091` (missing module reference) or `BCP104`
(referenced module has errors), see PR #104 commit `cadd63f` for the
pattern (the spoke module imports `../../resourceGroup/resourceGroup.bicep`
which upstream emits differently).

### 7. Update this file

Append to the table below:

```text
| Re-sync date | Upstream tag | New BASELINE_UPSTREAM_SHA | PR # | Reviewer |
|--------------|--------------|---------------------------|------|----------|
```

## Re-sync history

| Re-sync date | Upstream tag | BASELINE_UPSTREAM_SHA | PR # | Reviewer |
|--------------|--------------|-----------------------|------|----------|
| 2024-Q3 (import, no exact SHA) | unknown | unknown (recorded in PR #37 `55304a5`) | #37 | — |
| 2026-04-26 (provenance ADR; no re-sync) | n/a | n/a | #105 | platform team |

## When to re-sync

**Do** re-sync when:
- Upstream ships a security CVE fix in a module we use
- Upstream ships a new module we want to adopt
- We hit an Azure API version deprecation that upstream has fixed

**Do NOT** re-sync just because upstream has new commits.  The
operational cost of a full 3-way merge is days; the benefit must be
concrete.

## Alternative: drop the fork entirely

The most honest long-term answer is to **stop vendoring** and consume
ALZ as a Bicep registry reference (`br/public:avm/...`) per
[BCPv0.18+ best practice](https://learn.microsoft.com/azure/azure-resource-manager/bicep/modules#path-to-module).

Cost-benefit deferred:
- Pros: no more vendoring drift; upstream fixes flow automatically;
  Checkov soft-fail can be tightened.
- Cons: requires resolving every local hardening overlay either as an
  upstream PR (slow, multi-quarter) or as a wrapper module (additional
  layer of indirection).  The 6 commits that touched this tree over
  the past year suggest the operational cost of fork maintenance is
  currently lower than the conversion cost — but this should be
  re-evaluated annually.
