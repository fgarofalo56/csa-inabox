# Canvas full-screen

> **Surface:** the maximize control on the shared `CanvasRightRail` — present on every Loom xyflow canvas (pipeline, eventstream, estate, dataflow, lineage, assets, and the rest)
> **Backend:** none — this is a pure client-side layout mode
> **Kill-switch flag:** `u9-canvas-fullscreen` (default ON)
> **Honest gate:** none

Give the canvas the whole viewport. Neither ADF nor Fabric offers a true
full-screen authoring canvas; Loom implements it once in the shared canvas kit,
so **every** canvas gets it at the same quality.

## Why it exists

Authoring a twenty-node pipeline inside a pane that shares the window with a
navigation rail, a ribbon, a tab strip and a docked inspector is cramped. The
resize grip helps, but on a laptop or an RDP session there is simply not enough
room. Full-screen trades the chrome for the graph — temporarily, with one
keystroke to get it back.

Building it in the shared kit rather than per canvas is the point: one
implementation puts every canvas ahead at once, and no canvas can drift behind.

## How to use it

1. **Open any canvas.**
2. **Click the maximize button** on the canvas's right rail (or use the keyboard
   path below). The canvas host expands to a fixed viewport overlay; the app
   chrome is covered.
3. **Author normally.** Undo/redo history, clipboard, the palette, the rails and
   all canvas state are preserved — the canvas subtree is **not remounted**, only
   the host's positioning changes.
4. **Exit** with **Esc**, **F11**, or the restore button on the rail.

### Keyboard and accessibility

- **Esc** and **F11** both exit. The document-level listener respects
  `defaultPrevented`, so a dialog or menu that consumes Esc wins first — you can
  never close the canvas by trying to close a dropdown.
- **Focus moves into** the maximized region on enter, **Tab is trapped** inside
  it while maximized, and focus **restores to the triggering element** on exit.
- A visually-hidden live region announces entering ("... Press Escape to exit.")
  and exiting, so screen-reader users are not silently relocated.

### Session-scoped by design

Nothing persists. Unlike the canvas resize grip — which remembers your height
per surface — full-screen is deliberately a momentary mode. Reload, and you are
back to the normal layout.

## How it is wired (for contributors)

`CanvasFullscreenHost` is the provider and the overlay. `ResizableCanvasRegion`
embeds it automatically, so a canvas using the standard region gets full-screen
for free; a host without the region wraps its canvas shell in it once.

While inactive the host renders as `display: contents` — it is **100%
layout-neutral**, so adding it cannot perturb an existing layout. While active
it becomes a fixed inset-0 flex-column overlay so the canvas child fills the
viewport.

`useCanvasFullscreen()` is the context read. `CanvasRightRail` consumes it to
show the maximize/restore button on every rail inside a host, which is why there
is no per-canvas wiring beyond the single host wrap.

## Honest gates

None. It is a layout mode with no backend and no infrastructure dependency.

## Kill-switch

`u9-canvas-fullscreen` — default ON, fail-open. Flipping it OFF hides the
maximize button on every canvas rail on the next render. A canvas that is
**already maximized keeps its exit button plus Esc and F11**, so nobody is ever
stranded in a full-screen overlay they cannot leave.

## Related

- [UX standards](../ux-standards.md) — the canvas kit, resizable regions and the right rail
- [Collaborative presence and comments](collaboration-presence-comments.md)
- [Mapping data flow Debug sessions](mapping-dataflow-debug.md) · [Column-level lineage](column-level-lineage.md)
