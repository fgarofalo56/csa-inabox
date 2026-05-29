# UI PARITY — one-for-one with Azure & Fabric

**Effective: 2026-05-29. Scope: every CSA Loom editor, page, and surface.**
**This rule sits ABOVE convenience. It is the definition of "done" for a UI.**

## The standard (verbatim from the operator)

> Compare how the front-end UI works in Azure, feature for feature, and build
> that in CSA Loom's UI. Same thing for any Fabric one-for-one parities.
> Compare everything available in Fabric — all the features, how it looks and
> feels, how it works — and build it in CSA Loom. It should be one-for-one
> with the CSA Loom theme applied, but FULL functionality. Whatever you can do
> in Azure's UI for each service, you should be able to do in CSA Loom.
> Whatever you can do in Fabric's UIs for each object type, you should be able
> to do in CSA Loom. The answer isn't removing a header or a banner — it's
> making sure the feature parity is there. **Usable feature parity. Feature
> completeness must match.**

## What "done" means for any editor / page

For the Azure service or Fabric object type the surface represents:

1. **Inventory the real UI first.** Enumerate EVERY capability the actual
   Azure portal / Fabric UI exposes for this service/object — every tab,
   panel, button, dialog, wizard, context menu, inline action, and the
   workflow that connects them. Ground this in Microsoft Learn
   (`microsoft_docs_search` / `microsoft_docs_fetch`) and the live portal,
   not from memory. Write the inventory down.

2. **Build it one-for-one.** Every capability in that inventory exists in the
   Loom editor and WORKS — same workflow, same affordances, same outcome.
   Only the *theme* (Fluent v9 + Loom tokens) differs. Layout, panels, tabs,
   and interaction model match the source UI.

3. **Full functionality, real backend.** Every control calls the real Azure
   REST / Fabric REST / data-plane (per `no-vaporware.md`). The only allowed
   non-functional state is an **honest infra-gate**: a Fluent MessageBar
   `intent="warning"` naming the exact env var / role / resource to provision
   — and even then the full UI surface still renders.

## Explicitly forbidden (the shortcuts that are NOT done)

- Removing a header / banner / button to make a thin editor "look clean."
- Disabling a button with a "deferred to vN" / "Phase 1 stub" / "tracked for
  follow-up" tooltip instead of building it.
- A tab that exists but renders empty.
- Replacing a rich Azure/Fabric surface (canvas, designer, wizard, schema
  tree, query grid) with a single form or a JSON textarea.
- Claiming parity without a feature-by-feature comparison artifact.

## Per-surface deliverable

Each editor/page gets a parity doc at `docs/fiab/parity/<slug>.md`:

```
# <slug> — parity with <Azure service | Fabric object>
Source UI: <portal/Fabric URL or Learn doc>
## Azure/Fabric feature inventory   (every capability, grounded in Learn)
## Loom coverage                    (built ✅ / honest-gate ⚠️ / MISSING ❌)
## Backend per control              (which REST/data-plane each calls)
```

A surface is **A-grade only when its parity doc shows every inventory row
built ✅ or honest-gate ⚠️ — zero ❌, zero stub banners.**

## Verification

`pnpm uat` (deep-functional spec) + a live side-by-side against the real
Azure/Fabric UI. Per the no-scaffold rule, DOM strings ≠ parity — the
operator (or agent with browser) clicks every control and confirms it does
the same thing the Azure/Fabric UI does.
