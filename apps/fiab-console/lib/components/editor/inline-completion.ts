'use client';

/**
 * Inline code completion (ghost text) wiring for Monaco code cells.
 *
 * Monaco's `registerInlineCompletionsProvider(language, provider)` registers a
 * provider GLOBALLY for a language on the monaco instance — not per editor. If
 * every notebook cell registered its own provider, all of them would fire for
 * any cell of that language and each would issue a duplicate /api/copilot/
 * complete fetch. So this module registers exactly ONE provider per language
 * (guarded by a module-level Set) and routes the per-cell context (cell lang,
 * up-to-3 prior cells, lakehouse schema, enabled/locked state) through a
 * registry keyed by the model URI.
 *
 * The provider:
 *   - 300 ms debounce per model (clears the prior timer + aborts the prior fetch)
 *   - cancellation-token aware (stale requests resolve to no suggestion)
 *   - POSTs { prefix, lang, priorCells, schemaContext } to /api/copilot/complete
 *   - returns the ghost text as an empty-range inline completion item at the
 *     cursor; Monaco renders it gray and Tab accepts it.
 *
 * No Fabric / capacity dependency — the backend is Azure OpenAI (see the route).
 */

export interface InlineCompletionContext {
  /** Per-session master switch for this cell. */
  enabled: boolean;
  /** Read-only cell — never suggest. */
  locked: boolean;
  /** Cell language for the prompt (pyspark | spark | sparksql | sparkr | tsql | python). */
  lang: string;
  /** Sources of up to 3 preceding cells (oldest first) for grounding. */
  priorCells: string[];
  /** Lakehouse / notebook schema hint. */
  schemaContext?: string;
  /** Cluster runtime so ghost text uses cluster-correct APIs. */
  runtime?: string;
}

type IDisposable = { dispose(): void };

const registeredLangs = new Set<string>();
const contextByModel = new Map<string, () => InlineCompletionContext>();
const debounceByModel = new Map<string, ReturnType<typeof setTimeout>>();
const abortByModel = new Map<string, AbortController>();

const DEBOUNCE_MS = 300;

function ensureProvider(monaco: any, langId: string) {
  if (registeredLangs.has(langId)) return;
  registeredLangs.add(langId);
  monaco.languages.registerInlineCompletionsProvider(langId, {
    provideInlineCompletions(model: any, position: any, _ctx: any, token: any) {
      const key = model.uri.toString();
      const getCtx = contextByModel.get(key);
      if (!getCtx) return { items: [] };
      const info = getCtx();
      if (!info.enabled || info.locked) return { items: [] };

      const prefix = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      if (!prefix.trim()) return { items: [] };

      return new Promise<{ items: any[] }>((resolve) => {
        const prevTimer = debounceByModel.get(key);
        if (prevTimer) clearTimeout(prevTimer);
        const prevAbort = abortByModel.get(key);
        if (prevAbort) prevAbort.abort();

        const timer = setTimeout(async () => {
          if (token?.isCancellationRequested) {
            resolve({ items: [] });
            return;
          }
          const ac = new AbortController();
          abortByModel.set(key, ac);
          try {
            const res = await fetch('/api/copilot/complete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              signal: ac.signal,
              body: JSON.stringify({
                prefix,
                lang: info.lang,
                priorCells: (info.priorCells || []).slice(-3),
                schemaContext: info.schemaContext || undefined,
                runtime: info.runtime || undefined,
              }),
            });
            const j = await res.json().catch(() => null);
            if (!j?.ok || !j.completion) {
              resolve({ items: [] });
              return;
            }
            resolve({
              items: [
                {
                  insertText: j.completion,
                  range: {
                    startLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                  },
                },
              ],
            });
          } catch {
            // Aborted / network error — yield no suggestion (plain editing).
            resolve({ items: [] });
          }
        }, DEBOUNCE_MS);
        debounceByModel.set(key, timer);
      });
    },
    freeInlineCompletions() {
      /* nothing to free — items are plain objects */
    },
  });
}

/**
 * Wire ghost-text completion onto a freshly-mounted Monaco editor. Call from
 * MonacoTextarea's `onReady`. Returns a disposable to call on unmount.
 *
 * `getContext` is read live on every provider invocation, so callers can keep
 * it backed by refs that reflect the latest cell state.
 */
export function registerInlineCompletion(
  editor: any,
  monaco: any,
  getContext: () => InlineCompletionContext,
): IDisposable {
  const model = editor.getModel?.();
  if (!model) return { dispose() {} };
  // Use the editor's actual language id so the provider matches the model.
  const langId = model.getLanguageId?.() || 'plaintext';
  ensureProvider(monaco, langId);

  const key = model.uri.toString();
  contextByModel.set(key, getContext);

  return {
    dispose() {
      contextByModel.delete(key);
      const t = debounceByModel.get(key);
      if (t) clearTimeout(t);
      debounceByModel.delete(key);
      const a = abortByModel.get(key);
      if (a) a.abort();
      abortByModel.delete(key);
    },
  };
}
