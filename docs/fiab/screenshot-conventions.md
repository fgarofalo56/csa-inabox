# CSA Loom — screenshot conventions

Hard rule for every CSA Loom screenshot that lands in `docs/`,
PRs, marketing, or any user-facing surface: the editor must be
captured in its **clean post-dismissal state** — no auto-opened
Drawer covering the canvas.

## The "Learn about this item" drawer

`apps/fiab-console/lib/components/item-side-panel.tsx` auto-opens
the **Learn about this item** Drawer on every first-visit landing
into a per-item editor (`/items/<type>/<id>`). Without dismissal,
every screenshot of a per-item editor captures that drawer half-
covering the canvas. Pages-site users see this as "the screenshot
is hiding the actual editor."

## How to suppress it for screenshots

Append `?screenshot=1` (or `?noLearn=1` / `?learn=0`) to the URL.
The editor side panel reads this on mount and skips the auto-open.

```
https://loom-console-…/items/lakehouse/abc-123?screenshot=1
```

Aliases — pick whichever is most readable in context:

| Query param | Effect |
|---|---|
| `?screenshot=1` | recommended for the doc-screenshot harness — semantic |
| `?noLearn=1` | recommended for tutorial walk-throughs |
| `?learn=0` | most explicit |

All three suppress the auto-open of the **Learn about this item**
drawer ONLY. They do not affect other drawers, the editor itself,
or any other behavior.

## Apply consistently in tooling

- `apps/fiab-console/tests/walkthrough.mjs` — appends `?screenshot=1`
  and also clicks a stray drawer's Close button defensively.
- Any new Playwright UAT spec that captures editor surfaces — append
  `?screenshot=1` to every per-item URL.
- Fabric ↔ Loom comparison screenshots — apply on the Loom side so
  both products are captured in their clean canonical state.

## Re-capturing existing screenshots

Existing screenshots under `docs/fiab/tutorials/` and other paths
that include the Learn drawer should be re-captured. The fastest
operator-driven path:

```bash
# 1. From a workstation with az login + KV access (the SESSION_SECRET
#    is needed for the test to mint a Loom session cookie):
export SESSION_SECRET=$(az keyvault secret show \
  --vault-name kv-loom-m56yejezt7bjo --name loom-session-secret \
  --query value -o tsv)

# 2. Run the walkthrough — the screenshot=1 flag is already baked in:
node apps/fiab-console/tests/walkthrough.mjs

# 3. Inspect temp/walkthrough/*.png and copy the clean ones into
#    docs/fiab/tutorials/<slug>.png, replacing the old captures.
```

For Fabric-side comparison shots, the operator dismisses any Fabric
"What's new" or "Get started" popovers manually before capture and
notes the convention in the screenshot's commit message.

## Why a query-param rather than a global localStorage flag

A query-param scopes the suppression to ONE page load. localStorage
would silence Learn drawer for the user's whole session, which is
exactly what we don't want — Learn is a first-visit affordance and
should still auto-open in normal navigation.

## Related

- `apps/fiab-console/lib/components/item-side-panel.tsx:55-71`
- `apps/fiab-console/tests/walkthrough.mjs:156-180`
- `.claude/rules/no-vaporware.md` — re-stamped as the parent rule
  set; screenshot conventions live here so docs stay honest.
