'use client';

/**
 * useItemDocState — the load/save primitive that makes a FAILED READ impossible
 * to mistake for EMPTY CONTENT, and impossible to overwrite.
 *
 * ## The bug this exists to kill (FINISHLINE C19, user-harm data loss)
 *
 * Three editors — `fusion-sheet`, `notepad`, `analysis-board` — loaded their
 * persisted state like this:
 *
 * ```ts
 * try {
 *   const r = await clientFetch(`/api/cosmos-items/<slug>/${id}`);
 *   const j = await r.json().catch(() => ({}));
 *   if (j?.state?.cells) setCells(j.state.cells);
 * } catch { /* keep empty *\/ }
 * ```
 *
 * A 500 / 403 / network blip therefore rendered a surface **visually identical
 * to a genuinely empty item**. The user, seeing a blank sheet, starts typing —
 * and Save then PATCHes `{state:{cells:{}}}` **over their real persisted
 * content**. A transient backend error silently destroys work, with no error
 * shown at any point. Same class as apex A3 / C14's `ducklake-catalog` fix and
 * the `s3-gateway` reference implementation, except those only rendered a lie;
 * these three DELETED DATA.
 *
 * ## The three invariants this hook enforces
 *
 * 1. **Loaded-empty and failed-to-load are DIFFERENT STATES.** `status` is an
 *    explicit union, never inferred from "is the state object empty?".
 * 2. **Save is REFUSED unless the load actually succeeded.** `save()` returns
 *    `false` with an honest reason when `status !== 'loaded' && status !==
 *    'absent' && status !== 'new'`. This is the real data-loss guard: it lives
 *    INSIDE the primitive so a consumer cannot forget it (the guard-adoption
 *    gap — a correct pattern that siblings never adopt is exactly how this bug
 *    reached three editors).
 * 3. **A failed read says so** (`deploy-integrity.md` R7: an error must not
 *    assert something it did not establish). `<ItemLoadErrorBar>` renders the
 *    honest Fluent MessageBar + Retry; the editor surface stays up around it.
 *
 * ## Status semantics
 *
 * | status    | meaning                                            | save allowed |
 * |-----------|----------------------------------------------------|--------------|
 * | `new`     | id is `new` — nothing to read, nothing to destroy  | yes          |
 * | `loading` | the read is genuinely in flight                     | NO           |
 * | `loaded`  | the read succeeded and returned state               | yes          |
 * | `absent`  | the read succeeded; the record carries no state yet | yes          |
 * | `error`   | the read FAILED — content is UNKNOWN                | **NO**       |
 *
 * `absent` is the subtle one and it is why "state is empty" can never be the
 * test: a real, successfully-read, brand-new item legitimately has no state,
 * and saving over nothing destroys nothing.
 *
 * Azure-native, no Fabric. Fluent v9 + Loom tokens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

/** Explicit load lifecycle. NEVER inferred from the shape of the state. */
export type ItemLoadStatus = 'new' | 'loading' | 'loaded' | 'absent' | 'error';

/** The statuses under which PATCHing state back over the record is safe. */
const PERSISTABLE: ReadonlySet<ItemLoadStatus> = new Set<ItemLoadStatus>(['new', 'loaded', 'absent']);

/**
 * Is it safe to persist? Exported so a consumer that owns its own save (or a
 * test) can assert the same rule the hook enforces internally.
 */
export function canPersistItemState(status: ItemLoadStatus): boolean {
  return PERSISTABLE.has(status);
}

/**
 * The refusal message shown when Save is attempted over an unknown/unread
 * document. Exported so specs assert the exact user-visible string rather than
 * a paraphrase.
 */
export const SAVE_REFUSED_UNLOADED =
  'Not saved — this item’s saved content could not be read, so saving now would overwrite it with what is on screen. Retry the load first.';

export interface ItemLoad {
  status: ItemLoadStatus;
  /** Human-readable failure reason. Non-null only when status === 'error'. */
  error: string | null;
  /** Re-runs the read. Safe to call at any time. */
  retry: () => void;
}

export interface UseItemDocStateOptions<T> {
  /** Item type slug, e.g. 'fusion-sheet'. */
  slug: string;
  /** Item id. `'new'` (or empty) short-circuits the read. */
  id: string;
  /** State used before a successful load, and for a genuinely new item. */
  empty: T;
  /**
   * Pull the editor's state out of the fetched item document. Return
   * `undefined` when the document carries no state for this editor yet — that
   * is `absent`, NOT an error.
   */
  select: (doc: unknown) => T | undefined;
  /** Build the PATCH body from current state. Defaults to `{ state }`. */
  toPatchBody?: (state: T) => unknown;
  /** Route family for the READ. Default `cosmos-items`. */
  readRoute?: 'cosmos-items' | 'items';
  /** Route family for the WRITE. Default `items`. */
  writeRoute?: 'cosmos-items' | 'items';
}

export interface UseItemDocState<T> {
  state: T;
  setState: React.Dispatch<React.SetStateAction<T>>;
  load: ItemLoad;
  /** Mirrors `canPersistItemState(load.status)` — bind Save's `disabled` to `!canSave`. */
  canSave: boolean;
  saving: boolean;
  /** Last save outcome, user-visible. Null until a save is attempted. */
  saveMessage: string | null;
  /** True when the last save outcome was a failure/refusal (drives intent). */
  saveFailed: boolean;
  /**
   * PATCH the current state. REFUSES (returns false, sets `saveMessage`) when
   * the load did not succeed — the data-loss guard. Never issues the request in
   * that case, so a failed read can never reach the backend as content.
   */
  save: () => Promise<boolean>;
}

/**
 * Read + guarded write for a Cosmos-backed item's editor state.
 *
 * The read failing is a first-class outcome, not a silent fallback to `empty`.
 */
export function useItemDocState<T>(opts: UseItemDocStateOptions<T>): UseItemDocState<T> {
  const {
    slug, id, empty, select,
    toPatchBody = (state: T) => ({ state }),
    readRoute = 'cosmos-items',
    writeRoute = 'items',
  } = opts;

  const isNew = !id || id === 'new';
  const [state, setState] = useState<T>(empty);
  const [status, setStatus] = useState<ItemLoadStatus>(isNew ? 'new' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // `select`/`empty` are commonly inline literals; pin them in refs so a new
  // identity each render does not re-fire the read (which would thrash the
  // backend and could clobber user edits mid-typing).
  const selectRef = useRef(select);
  selectRef.current = select;
  const emptyRef = useRef(empty);

  useEffect(() => {
    if (isNew) { setStatus('new'); setError(null); return; }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const r = await clientFetch(`/api/${readRoute}/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`);
        // Read the body ONCE; a non-JSON body is itself diagnostic.
        const text = await r.text().catch(() => '');
        let doc: unknown = undefined;
        let parseFailed = false;
        if (text) {
          try { doc = JSON.parse(text); } catch { parseFailed = true; }
        }
        if (cancelled) return;

        if (!r.ok) {
          // R7: report what we actually observed — the status, and the server's
          // own error string when it gave one. Never invent a cause.
          const serverError = (doc as { error?: unknown } | undefined)?.error;
          setError(
            typeof serverError === 'string' && serverError
              ? `${serverError} (HTTP ${r.status})`
              : `The saved content could not be read (HTTP ${r.status}).`,
          );
          setStatus('error');
          return;
        }
        if (parseFailed) {
          setError('The saved content could not be read — the response was not valid JSON.');
          setStatus('error');
          return;
        }
        // Some BFF routes answer 200 with an {ok:false} envelope.
        if (doc && typeof doc === 'object' && (doc as { ok?: unknown }).ok === false) {
          const serverError = (doc as { error?: unknown }).error;
          setError(typeof serverError === 'string' && serverError ? serverError : 'The saved content could not be read.');
          setStatus('error');
          return;
        }

        const selected = selectRef.current(doc);
        if (selected === undefined) {
          // Read SUCCEEDED and the record simply has no state yet. Saving over
          // nothing destroys nothing, so this is persistable.
          setState(emptyRef.current);
          setStatus('absent');
          return;
        }
        setState(selected);
        setStatus('loaded');
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        // Transport failure / client-side timeout — we did not reach a verdict.
        setError(`The saved content could not be read: ${msg}`);
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [slug, id, isNew, readRoute, reloadTick]);

  const retry = useCallback(() => setReloadTick((n) => n + 1), []);

  const canSave = canPersistItemState(status);

  const save = useCallback(async (): Promise<boolean> => {
    // ---- THE DATA-LOSS GUARD ----------------------------------------------
    // A load that is in flight or that FAILED means the stored content is
    // UNKNOWN. Writing the on-screen state over an unknown document is exactly
    // the destruction this hook exists to prevent, so refuse BEFORE any
    // request is issued.
    if (!canPersistItemState(status)) {
      setSaveMessage(SAVE_REFUSED_UNLOADED);
      setSaveFailed(true);
      return false;
    }
    setSaving(true);
    setSaveMessage(null);
    setSaveFailed(false);
    try {
      const r = await clientFetch(`/api/${writeRoute}/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toPatchBody(state)),
      });
      if (!r.ok) { setSaveMessage('Save failed.'); setSaveFailed(true); return false; }
      setSaveMessage('Saved.');
      setSaveFailed(false);
      return true;
    } catch {
      setSaveMessage('Save failed.');
      setSaveFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
    // `toPatchBody` is commonly an inline arrow; excluding it keeps `save`
    // stable. It closes over nothing but `state`, which IS a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id, status, state, writeRoute]);

  return {
    state, setState,
    load: { status, error, retry },
    canSave, saving, saveMessage, saveFailed, save,
  };
}

/**
 * The honest error surface for a failed item-state read. Renders NOTHING unless
 * the load actually failed, so it can be dropped unconditionally into a layout.
 *
 * `subject` names the thing that could not be read, in lowercase, e.g.
 * "fusion sheet" → "Could not read this fusion sheet".
 */
export function ItemLoadErrorBar({ load, subject }: { load: ItemLoad; subject: string }) {
  if (load.status !== 'error') return null;
  return (
    <MessageBar intent="error" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>Could not read this {subject}</MessageBarTitle>
        {load.error || 'The read failed before the server answered (network or timeout).'}{' '}
        Saving is blocked until the content loads, so nothing on screen can overwrite what is stored.
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" onClick={load.retry}>Retry</Button>
      </MessageBarActions>
    </MessageBar>
  );
}
