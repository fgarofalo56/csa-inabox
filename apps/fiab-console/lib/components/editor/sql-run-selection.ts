/**
 * sql-run-selection — pure run-selection helper (no React / Fluent imports) so
 * it can be unit-tested in a node environment. Re-exported by sql-editor-kit.
 */

/**
 * Run-selection. If the Monaco editor has a non-empty selection, returns just
 * the highlighted text; otherwise returns the full editor text (SSMS / Azure
 * Data Studio behaviour). `editorRef` is the IStandaloneCodeEditor captured via
 * MonacoTextarea.onReady.
 */
export function getRunSql(editorRef: { current: any }, fullSql: string): string {
  const ed = editorRef.current;
  if (ed && typeof ed.getSelection === 'function') {
    const sel = ed.getSelection();
    const model = typeof ed.getModel === 'function' ? ed.getModel() : null;
    if (sel && model && typeof sel.isEmpty === 'function' && !sel.isEmpty()) {
      const selText = String(model.getValueInRange(sel) || '').trim();
      if (selText) return selText;
    }
  }
  return fullSql;
}
