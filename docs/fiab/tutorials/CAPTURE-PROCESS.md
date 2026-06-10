# Visual tutorials — capture + maintenance process

Every Loom item, app, and feature has a **step-by-step tutorial with real
screenshots**. The same run is a **full functional UAT** — it walks every tab and
config option, so it validates the feature *and* produces the tutorial in one
pass. Tutorials are re-captured whenever a UI changes.

## How a capture works

`apps/fiab-console/e2e/tutorial-capture.uat.ts` captures **all three coverage
dimensions** in one pass (gate with `LOOM_TUTORIAL_DIMENSIONS`):

| Dimension  | Source of truth                                   | Slug          | What it does |
|------------|---------------------------------------------------|---------------|--------------|
| `items`    | `lib/editors/registry.ts` (103 `reg(...)` entries) | `item-<type>` | creates a demo workspace + item, opens the editor |
| `apps`     | `GET /api/apps-catalog` (curated compound apps)    | `app-<id>`    | installs the app into a demo workspace, opens it |
| `features` | `NAV_PAGES` in `e2e/_lib/uat.ts` (17 nav pages)    | `feature-<page>` | navigates to the page |

For each surface it then:
1. **Closes the "Learn about this item" Drawer** (`[aria-label="Close"]`) so the
   full surface is visible in every shot.
2. Walks every tab / config control as a functional check and captures **one
   screenshot per step**.
3. **Stages** the screenshots + a per-surface `tutorial.md` into
   `temp/azure-screenshots/redacted/loom-tutorials/<slug>/` and appends to
   `MANIFEST.md`.

## Run it

Against the live console (minted-session cookie; `SESSION_SECRET` from Key Vault):

```bash
cd apps/fiab-console
SESSION_SECRET=<kv-secret> LOOM_URL=https://<front-door>.azurefd.net \
  pnpm exec playwright test --project=uat e2e/tutorial-capture.uat.ts
# scope by dimension: LOOM_TUTORIAL_DIMENSIONS="items,features" …
# scope items:        LOOM_TUTORIAL_TYPES="lakehouse,notebook,rayfin-app" …
```

Or dispatch the **`csa-loom-tutorial-capture`** GitHub workflow (resolves the
session secret from the Container App / Key Vault and uploads the staged
captures as the `loom-tutorial-captures` artifact). Inputs: `loom_url`,
`dimensions`, `types`. Re-run once per sovereign cloud (Commercial / GCC-High /
IL5) with that cloud's `loom_url` + admin RG — screenshots differ per cloud.


## Review → publish (mandatory privacy gate)

Live-console screenshots can show Azure resource names/data, so they are **staged,
not auto-published**. Review the staged images in
`temp/azure-screenshots/redacted/loom-tutorials/` (see `MANIFEST.md`). Once
approved:

```bash
node scripts/csa-loom/publish-tutorials.mjs            # all reviewed slugs
node scripts/csa-loom/publish-tutorials.mjs item-lakehouse item-notebook
```

This copies the approved markdown + screenshots into
`docs/fiab/tutorials/items/<slug>/` and **regenerates the
[`index.md`](items/index.md)** (grouped by item / app / feature) so the MkDocs
nav never needs a hand-maintained 120-entry list. Review `git diff`, then commit.

## Coverage audit

`scripts/csa-loom/check-tutorial-coverage.mjs` compares what's published against
the expected set parsed from source (`registry.ts` items + `NAV_PAGES` features;
apps via `--apps-catalog <json>`):

```bash
node scripts/csa-loom/check-tutorial-coverage.mjs            # report
node scripts/csa-loom/check-tutorial-coverage.mjs --strict   # exit 1 if any missing
```

## Maintenance

When a feature is added or a UI changes, re-run the capture for the affected
slug(s) and re-publish — tutorials and docs stay current. Treat this as part of
"done" for any UI change. Run the coverage audit (`--strict`) to confirm no
surface lost its tutorial.
