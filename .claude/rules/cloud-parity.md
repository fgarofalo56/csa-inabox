# CLOUD PARITY — same capabilities, every cloud (die-hard rule)

**Effective: 2026-08-07. Scope: every CSA Loom capability, item type, editor,
app, provisioner, API route, bicep module, and workflow — Commercial, GCC,
GCC-High, IL5, DoD, and any sovereign boundary Loom claims to support. All
branches, all contributors (human or agent). This rule sits ABOVE convenience
and ABOVE shipping speed.**

## The rule (operator intent, 2026-08-07)

> "They need parallel support offering the same capabilities and features no
> matter the cloud."

**A capability that works in Commercial and not in Gov is INCOMPLETE, not
"Commercial-first".** There is no tier of customer who gets a lesser product
because of the boundary they run in. Feature parity across clouds is the
definition of done, not a follow-up item.

## Why this is load-bearing, not aspirational

Sovereign customers are frequently the ones who need Loom's differentiators
MOST, because the managed services they would otherwise use do not exist in
their boundary. The clearest case: **Databricks Unity Catalog is not available
in Azure Government.** Loom Unity + Iceberg/Trino external-engine federation is
therefore not a parity checkbox in Gov — it IS the catalog and federation story
for those customers. Shipping it Commercial-only inverts the priority: the
boundary with the greatest need gets the least product.

## What "done" means

1. **A feature ships to ALL supported boundaries or it is not shipped.** If Gov
   lags, that lag is a tracked defect with an owner and a date — never a silent
   state, and never an unstated assumption in a status report.
2. **Every bicep module, param file, and workflow covers every boundary.** A
   module gated on `containerPlatform == 'containerApps'` must be verified to
   take that branch in the Gov params too, not assumed to.
3. **Where a cloud genuinely lacks a dependency, Loom supplies the
   Azure-native/OSS equivalent** — the same answer `no-fabric-dependency.md`
   gives for Fabric. "That Azure service isn't in Gov" is the START of the
   design problem, not the end of it.
4. **Parity is claimed only with a per-cloud receipt.** Commercial green proves
   nothing about Gov. Per `deploy-integrity.md` R4 each boundary is verified
   independently, and per the Gov access rule that receipt comes from a GitHub
   Actions run, never local `az`.
5. **Docs state per-cloud status explicitly.** A feature page that describes
   only the Commercial path is incomplete documentation.

## Explicitly forbidden

- "Commercial-first, Gov later" as a shipping plan with no dated owner.
- A capability marked done/A-grade on a Commercial-only receipt.
- A bicep module or workflow that silently no-ops in a sovereign boundary.
- A status report that says a feature works without naming which clouds.
- Treating a Gov gap as lower priority than a Commercial polish item.

## How to spot a violation

```bash
# Modules invoked on Commercial but not on the Gov path:
grep -rn "module loom" platform/fiab/bicep/modules/admin-plane/main.bicep
grep -rn "containerPlatform" platform/fiab/bicep/params/*gov* platform/fiab/bicep/params/*gcc* 2>/dev/null
# Backends enabled in Commercial params but absent from Gov params:
diff <(grep -o "loomBackends[^,]*" platform/fiab/bicep/params/commercial-full.bicepparam | sort) \
     <(grep -o "loomBackends[^,]*" platform/fiab/bicep/params/gov*.bicepparam 2>/dev/null | sort)
# Gov workflows that have never produced a receipt:
for wf in gov-build-images gov-provision-dataplane-images gov-provision-streaming-migrate gov-workspace-identity; do
  echo "== $wf"; gh run list --workflow "$wf.yml" --limit 1 --json conclusion --jq '.[].conclusion // "NEVER RUN"'
done
```

## Verification per merge

A PR adding or changing a capability states which boundaries it was verified
against and how. Commercial-only is declared Commercial-only — never implied
complete. An untested boundary is named as untested.

Related: `deploy-integrity.md` (R4 both clouds, R2 merged ≠ done),
`no-fabric-dependency.md` (supply the Azure-native equivalent),
`no-vaporware.md`, `auto-bind-by-default.md`.
