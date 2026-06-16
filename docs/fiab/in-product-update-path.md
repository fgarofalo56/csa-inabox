# In-product update path (no clone, no CI)

A deployed CSA Loom tenant can update to a new upstream core release **from
inside the product** — no repo clone, no fork, no GitHub Actions run by the
customer. This replaces the old `/admin/updates` "Open deploy workflow" steer,
which assumed the operator had the repo + CI.

## How a customer uses it

1. Open **Admin → Updates & version sync** (`/admin/updates`).
2. When an update is available, the page shows **Currently running** vs **Latest
   upstream** and an **Update to vX.Y.Z** button.
3. Click it → confirm in the dialog ("This will roll your Loom apps to vX.Y.Z and
   briefly restart them").
4. Loom rolls each Container App to the new release's public image, one at a
   time, showing live per-app status. The console itself is rolled **last**, so
   the operator's session survives until the end (a brief reconnect is expected).
5. Re-check to confirm the new running version.

If the public images for the target release are not published yet, or the
Console identity can't reach ARM, the update **refuses with an honest gate**
naming exactly what's missing — it never fakes success (`.claude/rules/no-vaporware.md`).

## Architecture

```
release tag (csa-inabox-vX.Y.Z)
   │  release-please
   ▼
.github/workflows/publish-ghcr-images.yml
   │  builds each app's Dockerfile, pushes PUBLIC images:
   ▼
ghcr.io/<owner>/<app>:X.Y.Z   +   :latest
   ▲
   │  HEAD manifest (anonymous pull token)   ARM PATCH image
   │                                              │
/admin/updates ──► GET/POST /api/admin/updates/apply ──► Microsoft.App/containerApps
                       │  preflight() + applyRoll()      (Console UAMI: ACA Contributor)
                       ▼
              lib/updates/update-apply.ts
```

### 1. Public release images (CI)

`.github/workflows/publish-ghcr-images.yml` triggers on each `csa-inabox-v*`
tag. It builds every deployable Loom app from its existing Dockerfile and pushes
to **public** GitHub Container Registry packages tagged with the **bare semver**
(`csa-inabox-v0.43.1` → `0.43.1`) plus `:latest`:

| ACA app (bicep `app.name`) | ghcr image |
| --- | --- |
| `loom-console` | `ghcr.io/<owner>/loom-console` |
| `loom-mcp` | `ghcr.io/<owner>/loom-mcp` |
| `loom-mcp-bridge` | `ghcr.io/<owner>/loom-mcp-bridge` |
| `loom-activator` | `ghcr.io/<owner>/loom-activator` |
| `loom-mirroring` | `ghcr.io/<owner>/loom-mirroring` |
| `loom-direct-lake-shim` | `ghcr.io/<owner>/loom-direct-lake-shim` |
| `loom-copilot-maf` | `ghcr.io/<owner>/loom-copilot-maf` |
| `loom-setup-orchestrator` | `ghcr.io/<owner>/loom-setup-orchestrator` |

This is **additive** — `build-fiab-images.yml` (push to the customer's **private**
ACR) still runs. The ghcr channel is the **public** self-update source.

> **One-time: make the packages public.** ghcr packages are created **private**
> on first push. Anonymous ACA pulls + the updater's manifest HEAD require them
> to be **public**. After the first publish, an org/user admin runs once per
> package:
>
> ```bash
> for a in loom-console loom-mcp loom-mcp-bridge loom-activator loom-mirroring \
>          loom-direct-lake-shim loom-copilot-maf loom-setup-orchestrator; do
>   gh api -X PATCH "/user/packages/container/$a" -f visibility=public || true
> done
> ```
>
> (The `publish-ghcr-images` workflow prints this reminder in its run summary.)

### 2. In-product apply (BFF)

`app/api/admin/updates/apply/route.ts`:

- **`GET`** — pre-flight only (no mutation; safe on page load). Resolves the
  target = latest non-prerelease release, HEADs every app's ghcr manifest, and
  checks ARM is configured. Returns the plan or a typed gate.
- **`POST`** — re-runs pre-flight, then PATCHes each app's image via
  `updateContainerAppImage` (real ARM `Microsoft.App/containerApps` PATCH),
  sequentially, reporting per-app `{ app, fromImage, toImage, status,
  provisioningState }`. Apps not deployed on this boundary (ARM 404) are
  **skipped**, not failed.

Admin-gated by `denyIfNoDlzAccess` (tenant admin or domain admin — the same gate
the Scale pane uses, since both roll Container Apps). All actions are audited.

The pre-flight + gate + roll logic lives in `lib/updates/update-apply.ts` as pure
orchestration over injected deps, unit-tested in
`lib/updates/__tests__/update-apply.test.ts` (13 tests covering every gate and
the per-app roll/skip/fail reporting).

#### Honest gates (never fake success)

| Reason | When | HTTP |
| --- | --- | --- |
| `arm-not-configured` | `LOOM_SUBSCRIPTION_ID` / RG unset | 503 |
| `no-upstream-release` | no stable release found | 409 |
| `already-up-to-date` | current ≥ target | 409 |
| `images-not-published` | a target ghcr image is missing | 409 |

`images-not-published` lists each missing `ghcr.io/<owner>/<app>:<ver>` ref and
its HTTP status so the operator sees exactly which images CI hasn't published.

### 3. Accurate running version

`app/api/version/route.ts` resolves **Currently running** in priority order:

1. `LOOM_VERSION` — set from the release tag by bicep (`admin-plane/main.bicep`
   wires `loomVersion`). When the updater rolls the apps to
   `ghcr.io/<owner>/loom-*:<X.Y.Z>`, this env follows the image, so it is the
   authoritative running version.
2. The Docker build marker (`public/build-marker.txt`, stamped by the Dockerfile
   with `sha=<git-sha>`) — a build fingerprint surfaced as `build` even before
   `LOOM_VERSION` is wired.
3. `NEXT_PUBLIC_LOOM_VERSION`, then a `build-<sha>` label, then `dev`.

## Configuration (bicep-wired by default)

| Env var | Source | Purpose |
| --- | --- | --- |
| `LOOM_VERSION` | `loomVersion` param | running version label |
| `LOOM_GHCR_OWNER` | `loomGhcrOwner` param (default `fgarofalo56`) | public image owner |
| `LOOM_SUBSCRIPTION_ID` | `subscription().subscriptionId` | ARM target |
| `LOOM_ADMIN_RG` | `resourceGroup().name` | ARM target RG |
| `LOOM_GHCR_REGISTRY` | optional | sovereign mirror override |

The Console UAMI already holds **Container Apps Contributor** on the admin RG
(`scaling-rbac.bicep`), which is the only permission the image roll needs.

## Status: real now vs. needs CI live

- **Real now (this PR):** the apply BFF + ARM image roll, the pre-flight/gate
  logic (unit-tested), the accurate-version resolution, the UI button + dialog +
  live per-app progress, the publish workflow, and the bicep env wiring. The
  updater works **the moment** the public images exist.
- **Needs the public-image CI to run + packages flipped to public:** until the
  first `publish-ghcr-images` run completes for a release and the packages are
  made public, the updater honestly gates with `images-not-published` (naming the
  missing refs) rather than rolling. This is by design — it never fakes an update.
