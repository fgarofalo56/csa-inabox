# Visual tutorials — capture + maintenance process

Every Loom item, app, and feature has a **step-by-step tutorial with real
screenshots**. The same run is a **full functional UAT** — it walks every tab and
config option, so it validates the feature *and* produces the tutorial in one
pass. Tutorials are re-captured whenever a UI changes.

## How a capture works

`apps/fiab-console/e2e/tutorial-capture.uat.ts`:
1. Creates a demo workspace + item and opens each editor.
2. **Closes the "Learn about this item" Drawer** (`[aria-label="Close"]`) so the
   full surface is visible in every shot.
3. Walks every tab / config control as a functional check and captures **one
   screenshot per step**.
4. **Stages** the screenshots + a per-item `tutorial.md` into
   `temp/azure-screenshots/redacted/loom-tutorials/<slug>/` and appends to
   `MANIFEST.md`.

## Run it

Against the live console (minted-session cookie; `SESSION_SECRET` from Key Vault):

```bash
cd apps/fiab-console
SESSION_SECRET=<kv-secret> LOOM_URL=https://<front-door>.azurefd.net \
  pnpm exec playwright test --project=uat e2e/tutorial-capture.uat.ts
# scope a run:  LOOM_TUTORIAL_TYPES="lakehouse,notebook,rayfin-app" …
```

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
`docs/fiab/tutorials/items/<slug>/`. Review `git diff`, then commit.

## Maintenance

When a feature is added or a UI changes, re-run the capture for the affected
slug(s) and re-publish — tutorials and docs stay current. Treat this as part of
"done" for any UI change.
