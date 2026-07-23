# Editor state convention — `useEditorState` (R18/R19)

**Effective: 2026-07-23. Scope: every CSA Loom editor. New editors MUST use
`lib/editors/use-editor-state.ts` for their primary document state. Existing
editors adopt opportunistically — whenever you touch an editor's save handler
(including during the R8–R12 decompositions), migrate its snapshot pattern to
`snapshot()`.**

## The gotcha this kills (why the hook exists)

Memory `csa_loom_setstate_snapshot_eager_eval_gotcha` (fix commit `d1034047`):
editors historically grabbed "fresh" state inside async save handlers with

```ts
let snapshot = DP_EMPTY;                                 // constant init — the trap
setState((prev) => { snapshot = prev; return prev; });   // relies on eager-eval
const displayName = snapshot.displayName || 'Untitled';
```

This only works via React's **eager-evaluation bailout**, which is **disabled
once the fiber already has a pending update**. If any other `setState` (a
`setStatus({kind:'saving'})`, a `setBusy(true)`) fired earlier in the same
handler AND the snapshot variable was initialized to a constant, the updater is
deferred to render and the handler silently reads **stale** state. On
2026-06-29 the data-product editor persisted a fully **empty** record (Untitled,
no owner, no description) no matter what the user typed — every CI gate green,
only a physical browser walk caught it.

The safe pattern is a ref mirror:

```ts
const stateRef = useRef(state);
stateRef.current = state;
// in handlers:
const snapshot = stateRef.current;
```

`useEditorState` bakes that mirror in (updated **synchronously** inside every
mutator, not just per-render) so the gotcha is structurally impossible for
adopters — plus dirty-tracking and undo/redo integration points every editor
re-implements ad hoc today (~288 `useRef` mirror sites across 67 editor files).

## The API

```ts
import { useEditorState } from '@/lib/editors/use-editor-state';

const s = useEditorState<TDoc>(initialDoc, { onDirtyChange });

s.doc             // current committed state (reactive)
s.ref.current     // ALWAYS-fresh mirror — the stateRef fix, built in
s.set(patch)      // shallow-merge update, marks dirty, pushes undo history
s.replace(next)   // full replace
s.snapshot()      // snapshot-safe read for async save handlers (reads the ref)
s.isDirty         // dirty vs the last-published baseline
s.markPublished() // clears dirty after a successful save/publish
                  //   markPublished(serverDoc) adopts the acknowledged doc
s.undo() / s.redo() / s.canUndo / s.canRedo   // history ring integration points
```

Options: `isEqual` (custom dirty comparator; default is shallow structural
equality), `historyLimit` (undo ring capacity, default 50), `onDirtyChange`
(fires on dirty **transitions** only).

### Snapshot safety

`snapshot()` reads the internal ref, never the eager-eval trick. The ref is
assigned synchronously inside `set`/`replace`/`undo`/`redo`, so this is safe:

```ts
const save = useCallback(async () => {
  setStatus({ kind: 'saving' });          // other setStates first? fine.
  const doc = s.snapshot();               // ALWAYS the freshest committed doc
  await clientFetch('/api/items/...', { method: 'PUT', body: JSON.stringify(doc) });
  s.markPublished();
}, [s.snapshot, s.markPublished]);
```

### Draft/publish seam

`isDirty` + `markPublished()` are the seam the ux-baseline draft/publish rule
requires ("a surface silently save-on-editing a live topology needs
draft/publish"). Drive the Publish button's enabled state from `isDirty`; call
`markPublished()` (optionally with the server-normalized doc) on save success.

### Undo integration

Editors with a canvas wire `undo`/`redo`/`canUndo` to the existing canvas
undo/redo commands — the hook provides the **state half**, the canvas provides
the **command half**. Do not reimplement a second history stack.

## Migration rules (R19)

1. **New editors:** primary document state goes through `useEditorState`. A new
   editor hand-rolling `useRef(state)` mirrors + ad-hoc dirty flags is a review
   defect.
2. **Touched editors:** when a PR touches an editor's save handler, migrate any
   `setState(prev => { snap = prev; return prev; })` read to `snapshot()` (or
   at minimum a stateRef mirror) in the same PR.
3. **Review checklist row** (ux-standards §7 editor gate): "☐ async save
   handlers read via `useEditorState().snapshot()` / a stateRef mirror, never
   the `setState(prev => { snap = prev })` trick".
4. **No mechanical codemod.** The ~288 existing mirror sites are too varied to
   rewrite safely in bulk; adoption is opportunistic and G1-verified
   (browser E2E) like any editor behavior change.

First real adopter: R10's `useSemanticModel()` reducer/context (semantic-model
decomposition). Tests: `lib/editors/__tests__/use-editor-state.test.tsx`
includes the regression test that reproduces the eager-eval gotcha
(status-setState-then-read) and proves `snapshot()` stays fresh.
