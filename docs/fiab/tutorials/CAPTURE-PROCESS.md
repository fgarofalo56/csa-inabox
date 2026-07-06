# Visual tutorials — capture + maintenance process

Every Loom item, app, and feature has a **step-by-step tutorial with real
screenshots**. The same run is a **full functional UAT** — it walks every tab and
config option, so it validates the feature *and* produces the tutorial in one
pass. Tutorials are re-captured whenever a UI changes.

## In-app rendering (Learning Hub)

The captured walkthroughs surface **in-product** in the Learning Hub
(`/learn` → **Guides & reference**). Each editor guide card carries a **View
walkthrough** button that opens a polished, web3 `StepWalkthrough` dialog:
numbered steps, each with its clean screenshot + a concise caption of what to do.

- Step **captions** come from the item's real authored Learn content
  (`getLearn(slug).steps`) — never invented text.
- Step **screenshots** attach by index via `loomStepImageUrl(slug, n)`, gated on
  what has actually been captured (`EDITOR_STEP_IMAGE_COUNTS`). A step with no
  captured screenshot renders an **honest "screenshot coming" placeholder**, not
  a broken image (per `no-vaporware` / no-scaffold).

When a slug's multi-step screenshots are (re)published as
`docs/fiab/tutorials/img/editor-<slug>-1.png … -N.png`, bump its entry in
`EDITOR_STEP_IMAGE_COUNTS` (in `apps/fiab-console/lib/learn/content.ts`) and the
images slot straight into the walkthrough.

## How a capture works

`apps/fiab-console/e2e/tutorial-capture.uat.ts` captures **all three coverage
dimensions** in one pass (gate with `LOOM_TUTORIAL_DIMENSIONS`):

| Dimension  | Source of truth                                   | Slug          | What it does |
|------------|---------------------------------------------------|---------------|--------------|
| `items`    | `lib/editors/registry.ts` (109 `reg(...)` entries) | `item-<type>` | creates a demo workspace + item, opens the editor |
| `apps`     | `GET /api/apps-catalog` (29 curated compound apps) | `app-<id>`    | installs the app into a demo workspace, opens it |
| `features` | `NAV_PAGES` in `e2e/_lib/uat.ts` (17 nav pages)    | `feature-<page>` | navigates to the page |

The full expected set is **155** surfaces (109 + 29 + 17).

For each surface it then:
1. **Guarantees a clean surface** — the capture navigates with the
   `?screenshot=1` flag so the "Learn about this item" Drawer never auto-opens,
   and before **every** shot runs a bulletproof `closeAllOverlays()` sweep that
   dismisses any Drawer / LearnPopover / help overlay / first-run tour (explicit
   Close → Escape, looped until no `[role="dialog"]` is visible). The overlay can
   therefore **never bleed into a screenshot** — the exact defect this process
   guards against.
2. Walks every tab / config control as a functional check and captures **one
   screenshot per step**.
3. **Stages** the screenshots + a per-surface `tutorial.md` **and a
   `steps.json` step manifest** (`{ slug, title, summary, steps:[{n,caption,image}] }`)
   into `temp/azure-screenshots/redacted/loom-tutorials/<slug>/` and appends to
   `MANIFEST.md`. The `steps.json` manifest is what makes the walkthrough
   **data-driven**: the Learning Hub's `StepWalkthrough` renderer and any docs
   consumer read the ordered steps from it, so regenerated screenshots slot
   straight back in without re-parsing markdown.

## Run it

Against the live console (minted-session cookie; `SESSION_SECRET` from Key Vault):

```bash
cd apps/fiab-console
SESSION_SECRET=<kv-secret> LOOM_URL=https://<front-door><your-console-hostname> \
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
the expected set parsed from source (`registry.ts` items + `NAV_PAGES` features),
with the **apps** dimension audited offline against the checked-in fixture
`scripts/csa-loom/fixtures/apps-catalog.json`:

```bash
# Report all three dimensions (items + features + apps):
node scripts/csa-loom/check-tutorial-coverage.mjs \
  --apps-catalog scripts/csa-loom/fixtures/apps-catalog.json

# Same, but exit 1 if any of the 155 surfaces is missing a published tutorial:
node scripts/csa-loom/check-tutorial-coverage.mjs --strict \
  --apps-catalog scripts/csa-loom/fixtures/apps-catalog.json
```

The apps fixture is generated from source — never hand-edited — and kept in
sync by a generator that CI verifies on every console PR:

```bash
node scripts/csa-loom/gen-apps-catalog-fixture.mjs          # regenerate after adding/removing an app
node scripts/csa-loom/gen-apps-catalog-fixture.mjs --check  # CI: fail if drifted from CATALOG_META
```

The CI `tutorial-coverage` job runs the fixture-freshness check (**blocking**)
plus the coverage report (non-blocking). To turn coverage into a permanently
enforced gate the moment the first reviewed captures are committed, add
`--strict` to that job's coverage step (one-line change) — see
`.github/workflows/fiab-console-ci.yml`.

## Maintenance

When a feature is added or a UI changes, re-run the capture for the affected
slug(s) and re-publish — tutorials and docs stay current. Treat this as part of
"done" for any UI change. When a curated **app** is added or removed, also run
`gen-apps-catalog-fixture.mjs` and commit the regenerated fixture (CI's
`--check` enforces this). Run the coverage audit (`--strict --apps-catalog …`)
to confirm no surface lost its tutorial.
