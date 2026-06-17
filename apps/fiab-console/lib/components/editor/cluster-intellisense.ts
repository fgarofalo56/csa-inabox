'use client';

/**
 * cluster-intellisense — Monaco completion provider that serves runtime-specific
 * (Databricks / Synapse Spark / Azure ML) completions into notebook code cells,
 * and SWAPS the active set when the user switches the attached compute.
 *
 * Design mirrors sql-intellisense.ts: Monaco's
 * registerCompletionItemProvider(language, provider) is GLOBAL per language on a
 * monaco instance, so we register exactly ONE provider per Monaco language
 * ('python' | 'scala' | 'r') guarded by a module-level Set, and route each
 * invocation through the context registered most recently for the active editor.
 *
 * Switching cluster type re-registers via the returned IDisposable: the cell
 * calls dispose() (clearing its context getter) then registerClusterIntelliSense
 * again with the new runtime — the provider itself stays registered for reuse,
 * exactly like sql-intellisense. Because the context getter is read live on
 * every keystroke, in practice flipping the editor-wide runtime dropdown takes
 * effect immediately without a Monaco round-trip.
 *
 * Completions are GROUND-TRUTH (Microsoft Learn, see cluster-runtime.ts), never
 * invented. This provider is additive — it complements the Pylance/pylsp bridge
 * (real pyright completions) and the AOAI ghost-text inline completion; it just
 * guarantees the runtime's signature APIs (dbutils / mssparkutils / azure.ai.ml)
 * are always offered even before a language server attaches.
 */

import { completionsFor, type ClusterRuntime, type RuntimeCompletion } from './cluster-runtime';

type IDisposable = { dispose(): void };

export interface ClusterIntelliSenseContext {
  runtime: ClusterRuntime;
  /** Mapped Monaco language id for this editor's model ('python'|'scala'|'r'). */
  monacoLanguage: string;
}

// One provider per Monaco language; the active context getter routes results.
const registeredLangs = new Set<string>();
const activeContextByLang = new Map<string, () => ClusterIntelliSenseContext>();

function buildItems(
  monaco: any,
  completions: RuntimeCompletion[],
  range: any,
): any[] {
  const CK = monaco.languages.CompletionItemKind;
  const RULES = monaco.languages.CompletionItemInsertTextRule;
  const kindMap: Record<RuntimeCompletion['kind'], number> = {
    function: CK.Function,
    module: CK.Module,
    keyword: CK.Keyword,
    snippet: CK.Snippet,
    property: CK.Property,
  };
  return completions.map((c) => ({
    label: c.label,
    kind: kindMap[c.kind] ?? CK.Text,
    insertText: c.insertText,
    detail: c.detail,
    documentation: c.documentation,
    range,
    ...(c.snippet ? { insertTextRules: RULES.InsertAsSnippet } : {}),
  }));
}

function ensureProvider(monaco: any, langId: string) {
  if (registeredLangs.has(langId)) return;
  registeredLangs.add(langId);
  monaco.languages.registerCompletionItemProvider(langId, {
    // '%' so Synapse/Databricks magics surface at the start of a cell.
    triggerCharacters: ['.', '%'],
    provideCompletionItems(model: any, position: any) {
      const getCtx = activeContextByLang.get(langId);
      if (!getCtx) return { suggestions: [] };
      const ctx = getCtx();

      const wordUntil = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: wordUntil.startColumn,
        endColumn: position.column,
      };

      const completions = completionsFor(ctx.runtime, ctx.monacoLanguage);
      return { suggestions: buildItems(monaco, completions, range) };
    },
  });
}

/**
 * Register the cluster-aware completion provider for this editor's model and
 * point the active getter at this editor's runtime context. Returns an
 * IDisposable; disposing clears this editor's getter (the provider stays
 * registered for reuse). To SWITCH runtime, dispose then call again with the
 * new context — or just keep the same disposable and have getContext() return
 * the updated runtime (the provider reads it live).
 */
export function registerClusterIntelliSense(
  editor: any,
  monaco: any,
  getContext: () => ClusterIntelliSenseContext,
): IDisposable {
  const model = editor.getModel?.();
  if (!model) return { dispose() {} };
  const langId = model.getLanguageId?.() || 'plaintext';
  // Only the runtimes we ground completions for; plaintext/sql/etc. are no-ops.
  ensureProvider(monaco, langId);
  activeContextByLang.set(langId, getContext);

  return {
    dispose() {
      if (activeContextByLang.get(langId) === getContext) {
        activeContextByLang.delete(langId);
      }
    },
  };
}
