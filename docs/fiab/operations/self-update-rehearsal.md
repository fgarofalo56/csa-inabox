# Self-update rehearsal runbook (operator-run)

This runbook rehearses the **in-product (no-clone) update path** end-to-end: cut
a release, publish the public images, flip the packages public, roll a live
deployment from inside the product, and verify the running version. It exists to
prove the path works **before** a customer relies on it.

!!! warning "This is operator-run — it is not automated in CI"
    The steps below mutate a **live tenant** (roll its Container Apps) and touch
    **package visibility** (a one-way, org-admin action). They are **not** run by
    an automated test and **not** run by the agent that wrote this runbook. A
    human operator with (a) release/tag rights on the repo, (b) `packages:write`
    + package-admin on the GitHub org/user, and (c) tenant-admin on a live Loom
    deployment executes them and records the results. The wiring the runbook
    depends on (the publish workflow, the apply BFF, the compat preflight, the
    `/api/version` endpoint, and the bicep env) is real and landed — see
    [In-product update path](../in-product-update-path.md).

## Preconditions

- A live CSA Loom deployment you can safely roll (a staging/dev tenant is ideal
  for the first rehearsal). You are a **tenant admin** on it (member of
  `LOOM_TENANT_ADMIN_GROUP_ID` or `LOOM_TENANT_ADMIN_OID`).
- The Console UAMI holds **Container Apps Contributor** on the admin RG (wired by
  `platform/fiab/bicep/modules/admin-plane/scaling-rbac.bicep`). No extra grant
  is needed for the image roll.
- Repo release rights (release-please runs on merge to `main`) and GitHub
  **package admin** on the owner account (to flip package visibility once).
- The target release is **at least one patch ahead** of what the tenant is
  running, so the updater has something to offer.

## Step 1 — Cut the release

1. Merge the release-please PR on `main` (or let the standing release
   authorization cut it). This creates the tag **`csa-inabox-vX.Y.Z`** and the
   GitHub Release.
2. Confirm the tag exists:

   ```bash
   gh release view csa-inabox-vX.Y.Z --json tagName,isDraft,isPrerelease
   ```

   The release must be **published** and **not** a prerelease (the updater picks
   the latest non-prerelease release).

## Step 2 — Publish the public images

The tag push triggers **`.github/workflows/publish-ghcr-images.yml`**, which
builds every deployable app from its Dockerfile and pushes to
`ghcr.io/<owner>/<app>:X.Y.Z` **and** `:latest`.

1. Watch the run:

   ```bash
   gh run list --workflow=publish-ghcr-images.yml --limit 3
   gh run watch <run-id>
   ```

2. Confirm all matrix legs are green (`loom-console`, `loom-setup-orchestrator`,
   `loom-mcp`, `loom-mcp-bridge`, `loom-activator`, `loom-mirroring`,
   `loom-direct-lake-shim`, `loom-copilot-maf`).
3. If a tag was already cut without a run, dispatch it manually:

   ```bash
   gh workflow run publish-ghcr-images.yml -f tag_override=X.Y.Z
   ```

## Step 3 — Flip the packages public (one-time per package)

ghcr packages are created **private** on first push. Anonymous ACA pulls and the
updater's manifest HEAD require them to be **public**. Run once per package (the
`publish-ghcr-images` run summary prints this same reminder):

```bash
for a in loom-console loom-mcp loom-mcp-bridge loom-activator loom-mirroring \
         loom-direct-lake-shim loom-copilot-maf loom-setup-orchestrator; do
  gh api -X PATCH "/user/packages/container/$a" -f visibility=public || true
done
```

Verify at least the console package is public:

```bash
gh api "/user/packages/container/loom-console" --jq '.visibility'   # → "public"
```

Once public on first release, this step is **not** needed for later releases.

## Step 4 — Pre-flight from inside the product

Pre-flight is a **read-only** `GET /api/admin/updates/apply` — safe to run
repeatedly; it mutates nothing.

1. Open **Admin → Updates & version sync** (`/admin/updates`). It shows
   **Currently running** vs **Latest upstream** and, when an update exists, an
   **Update to vX.Y.Z** button.
2. Confirm pre-flight returns a **plan**, not a gate. If it returns a gate,
   resolve it before rolling:

   | Gate | Meaning | Fix |
   | --- | --- | --- |
   | `images-not-published` | a target ghcr image is missing (lists each ref + HTTP status) | re-run / finish Step 2, confirm Step 3 |
   | `arm-not-configured` | `LOOM_SUBSCRIPTION_ID` / RG unset | check Console app env |
   | `already-up-to-date` | current ≥ target | nothing to rehearse; cut a newer release |
   | `requires-infra-redeploy` | the target release newly requires a `LOOM_*` env var / infra version this deployment lacks (compat manifest, rel-T41) | re-deploy `platform/fiab/bicep` with the named remediation, then retry |

   The `requires-infra-redeploy` gate is the **compat-manifest preflight**
   (`apps/fiab-console/lib/updates/compat-manifest.ts`): it aggregates what every
   release in `(current, target]` newly requires and compares it to the running
   deployment's `process.env` + `LOOM_INFRA_VERSION`. Rehearse this branch too —
   see Step 6.

## Step 5 — Roll and verify

1. Click **Update to vX.Y.Z** and confirm the dialog. Loom PATCHes each Container
   App to the new public image **sequentially**, showing per-app status. The
   **console rolls last**, so your session survives until the end (a brief
   reconnect is expected).
2. When the roll completes, re-check the version. From the UI the **Currently
   running** badge should read `X.Y.Z`. Independently confirm via the endpoint:

   ```bash
   curl -s https://<your-console-host>/api/version | jq '{current, build, hasUpdate}'
   ```

   Expected: `current` = `X.Y.Z`, `hasUpdate` = `false`. `current` resolves from
   `package.json` baked into the image (authoritative) and then `LOOM_VERSION`,
   which follows the rolled image — see
   [In-product update path — accurate running version](../in-product-update-path.md).

3. Spot-check that each rolled app is healthy (Container Apps `provisioningState`
   = `Succeeded`, revision running) in the portal or:

   ```bash
   az containerapp show -n loom-console -g <admin-rg> --query "properties.provisioningState"
   ```

## Step 6 — Rehearse the infra-gate branch (recommended)

To prove the compat preflight actually blocks (not just passes), rehearse a
release that **newly requires** an env var the running deployment lacks:

1. On a dev tenant, confirm the shipped compat manifest and, if the target
   release added a `requiredEnv` entry, temporarily unset that var on the Console
   app (or test against a release whose requirement your deployment predates).
2. Run pre-flight — it must return **`requires-infra-redeploy`** naming the exact
   `LOOM_*` var, its reason, and the bicep remediation, and roll **nothing**.
3. Re-deploy `platform/fiab/bicep` (or restore the var), re-run pre-flight, and
   confirm it now returns a plan.

This proves the "image roll never silently comes up with a required var unset"
guarantee (rel-T41).

## What to record

Capture in the rehearsal notes (PR comment or the deploy-iteration log):

- The release tag, the `publish-ghcr-images` run URL (all legs green).
- `gh api …/visibility` output showing packages public.
- Pre-flight response (plan or the gate you resolved).
- `/api/version` before and after (`current` flipped to `X.Y.Z`,
  `hasUpdate: false`).
- Per-app roll status and any app skipped as ARM-404 (not deployed on this
  boundary — expected, not a failure).

## Rollback

The roll is an ARM image PATCH per app. To revert, re-run the updater targeting
the previous release (if still the latest it will report `already-up-to-date`;
otherwise pin via a redeploy of the prior image tag), or roll each Container App
back to its previous revision in the portal. Because the roll changes **only**
the image (env + secrets are re-sent unchanged), a revision revert is a clean
rollback.

## Related

- [In-product update path](../in-product-update-path.md) — architecture, BFF,
  gates, and version resolution.
- `.github/workflows/publish-ghcr-images.yml` — the public image supply side.
- `apps/fiab-console/lib/updates/update-apply.ts` — pre-flight + roll orchestration.
- `apps/fiab-console/lib/updates/compat-manifest.ts` — infra-vs-image compat preflight (rel-T41).
- `apps/fiab-console/app/api/version/route.ts` — running-version resolution.
