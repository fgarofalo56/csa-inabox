// @ts-nocheck
/**
 * notebook-lsp-client — wires a live Monaco editor model to a Pylance-grade
 * Python language server (python-lsp-server + pyright) over the WebSocket
 * bridge at /api/notebook/<id>/lsp.
 *
 * This is the browser half of the "Monaco cell editor + Pylance LSP bridge"
 * feature. It speaks the Language Server Protocol over a WebSocket using the
 * same JSON-RPC-over-WS wire that monaco-languageclient / vscode-ws-jsonrpc
 * use, but drives Monaco's own provider registry directly so it stays
 * compatible with the app's vanilla monaco-editor@0.52 + @monaco-editor/react
 * stack (monaco-languageclient v9 swaps in the @codingame monaco-vscode-api
 * runtime, which conflicts with that stack). One frame on the socket = one
 * complete JSON-RPC message; the server bridge handles Content-Length framing
 * to/from the pylsp stdio process.
 *
 * Real backend: every completion/hover comes from pylsp (pyright stubs,
 * pandas-stubs, etc.) running in the Console container — no canned lists.
 *
 * Plain .mjs (excluded from the TS program: tsconfig has allowJs:false and
 * includes only **/*.ts(x)). Dynamically imported from code-cell.tsx so SSR
 * never touches it.
 *
 * Returns a disposer; call it on cell unmount / model dispose.
 */

const LSP_COMPLETION_KIND = {
  1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field',
  6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module', 10: 'Property',
  11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet',
  16: 'Color', 17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember',
  21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
};

function mapCompletionKind(monaco, lspKind) {
  const name = LSP_COMPLETION_KIND[lspKind] || 'Text';
  const K = monaco.languages.CompletionItemKind;
  return K[name] !== undefined ? K[name] : K.Text;
}

function lspToMonacoMarkdown(documentation) {
  if (!documentation) return undefined;
  if (typeof documentation === 'string') return { value: documentation };
  // MarkupContent { kind, value }
  if (typeof documentation === 'object' && typeof documentation.value === 'string') {
    return { value: documentation.value, isTrusted: false };
  }
  return undefined;
}

export function attachPylsp({ editor, monaco, wsUrl, language, fileUri }) {
  const uri = fileUri || `inmemory://loom/cell-${Math.random().toString(36).slice(2)}.py`;
  const model = editor.getModel();
  if (!model) return () => {};

  let disposed = false;
  let initialized = false;
  let version = 1;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  const disposables = [];
  let ws;

  const status = { state: 'connecting' };
  const listeners = new Set();
  function setState(next, detail) {
    status.state = next;
    status.detail = detail;
    for (const l of listeners) { try { l(status); } catch { /* noop */ } }
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
      // Defensive timeout so a wedged server never hangs the editor.
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`LSP ${method} timed out`)); }
      }, 15000);
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  // ---- LSP <-> Monaco position helpers (Monaco 1-based, LSP 0-based) ----
  const toLspPos = (pos) => ({ line: pos.lineNumber - 1, character: pos.column - 1 });

  // ---- Incoming dispatch ----
  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (Array.isArray(msg)) { msg.forEach(handleOne); return; }
    handleOne(msg);
  }

  function handleOne(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    // Server -> client request (needs a response)
    if (msg.id !== undefined && msg.method) {
      let result = null;
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params && msg.params.items) || [];
        result = items.map(() => ({}));
      } else if (msg.method === 'client/registerCapability' || msg.method === 'client/unregisterCapability') {
        result = null;
      } else if (msg.method === 'window/workDoneProgress/create') {
        result = null;
      }
      send({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    // Server -> client notification
    if (msg.method === 'textDocument/publishDiagnostics') {
      applyDiagnostics(msg.params);
      return;
    }
    // window/logMessage, window/showMessage, $/progress, telemetry — ignored.
  }

  function applyDiagnostics(params) {
    if (disposed || !params || params.uri !== uri) return;
    const markers = (params.diagnostics || []).map((d) => ({
      severity: d.severity === 1 ? monaco.MarkerSeverity.Error
        : d.severity === 2 ? monaco.MarkerSeverity.Warning
        : d.severity === 3 ? monaco.MarkerSeverity.Info
        : monaco.MarkerSeverity.Hint,
      message: d.message,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      source: d.source || 'pylsp',
    }));
    monaco.editor.setModelMarkers(model, 'pylsp', markers);
  }

  // ---- Monaco providers backed by pylsp ----
  function registerProviders() {
    const monacoLang = model.getLanguageId();

    disposables.push(monaco.languages.registerCompletionItemProvider(monacoLang, {
      triggerCharacters: ['.', '(', '[', '"', "'", ',', ' '],
      async provideCompletionItems(m, position) {
        if (!initialized || disposed) return { suggestions: [] };
        let res;
        try {
          res = await request('textDocument/completion', {
            textDocument: { uri },
            position: toLspPos(position),
            context: { triggerKind: 1 },
          });
        } catch { return { suggestions: [] }; }
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        const word = m.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions = items.map((it) => {
          const insert = (it.textEdit && it.textEdit.newText) || it.insertText || it.label;
          return {
            label: it.label,
            kind: mapCompletionKind(monaco, it.kind),
            detail: it.detail,
            documentation: lspToMonacoMarkdown(it.documentation),
            insertText: insert,
            filterText: it.filterText || it.label,
            sortText: it.sortText,
            range,
            // Resolve lazily so heavy docstrings aren't fetched for every row.
            _lspItem: it,
          };
        });
        return { suggestions };
      },
      async resolveCompletionItem(item) {
        if (!item._lspItem || disposed) return item;
        try {
          const resolved = await request('completionItem/resolve', item._lspItem);
          if (resolved) {
            item.detail = resolved.detail || item.detail;
            item.documentation = lspToMonacoMarkdown(resolved.documentation) || item.documentation;
          }
        } catch { /* keep the unresolved item */ }
        return item;
      },
    }));

    disposables.push(monaco.languages.registerHoverProvider(monacoLang, {
      async provideHover(m, position) {
        if (!initialized || disposed) return null;
        let res;
        try {
          res = await request('textDocument/hover', {
            textDocument: { uri },
            position: toLspPos(position),
          });
        } catch { return null; }
        if (!res || !res.contents) return null;
        const contents = [];
        const push = (c) => {
          if (!c) return;
          if (typeof c === 'string') contents.push({ value: c });
          else if (c.value) contents.push({ value: c.language ? '```' + c.language + '\n' + c.value + '\n```' : c.value });
        };
        if (Array.isArray(res.contents)) res.contents.forEach(push); else push(res.contents);
        if (!contents.length) return null;
        const range = res.range ? {
          startLineNumber: res.range.start.line + 1,
          startColumn: res.range.start.character + 1,
          endLineNumber: res.range.end.line + 1,
          endColumn: res.range.end.character + 1,
        } : undefined;
        return { range, contents };
      },
    }));

    disposables.push(monaco.languages.registerSignatureHelpProvider(monacoLang, {
      signatureHelpTriggerCharacters: ['(', ','],
      async provideSignatureHelp(m, position) {
        if (!initialized || disposed) return null;
        let res;
        try {
          res = await request('textDocument/signatureHelp', {
            textDocument: { uri },
            position: toLspPos(position),
          });
        } catch { return null; }
        if (!res || !res.signatures || !res.signatures.length) return null;
        return {
          value: {
            signatures: res.signatures.map((s) => ({
              label: s.label,
              documentation: lspToMonacoMarkdown(s.documentation),
              parameters: (s.parameters || []).map((p) => ({
                label: p.label,
                documentation: lspToMonacoMarkdown(p.documentation),
              })),
            })),
            activeSignature: res.activeSignature || 0,
            activeParameter: res.activeParameter || 0,
          },
          dispose() { /* noop */ },
        };
      },
    }));
  }

  // ---- Keep pylsp's document in sync (full-text sync) ----
  function wireDocSync() {
    const changeSub = model.onDidChangeContent(() => {
      if (!initialized || disposed) return;
      version += 1;
      notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: model.getValue() }],
      });
    });
    disposables.push(changeSub);
  }

  // ---- Boot ----
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    setState('error', String(e));
    return () => {};
  }

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') onMessage(ev.data);
    else if (ev.data instanceof Blob) ev.data.text().then(onMessage);
  };
  ws.onerror = () => setState('error', 'socket error');
  ws.onclose = () => { if (!disposed) setState('disconnected'); };

  ws.onopen = async () => {
    setState('initializing');
    try {
      await request('initialize', {
        processId: null,
        clientInfo: { name: 'csa-loom-notebook', version: '1.0.0' },
        rootUri: null,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: { properties: ['documentation', 'detail'] },
              },
              contextSupport: true,
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
            publishDiagnostics: {},
          },
          workspace: { configuration: true, didChangeConfiguration: { dynamicRegistration: true } },
        },
      });
      notify('initialized', {});
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version, text: model.getValue() },
      });
      initialized = true;
      registerProviders();
      wireDocSync();
      setState('ready');
      // Nudge a completion roundtrip-readiness; pyright warms stubs on first req.
    } catch (e) {
      setState('error', String(e && e.message ? e.message : e));
    }
  };

  // Disposer
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposables) { try { d.dispose(); } catch { /* noop */ } }
    disposables.length = 0;
    try { monaco.editor.setModelMarkers(model, 'pylsp', []); } catch { /* noop */ }
    try { if (initialized) notify('textDocument/didClose', { textDocument: { uri } }); } catch { /* noop */ }
    try { ws && ws.close(); } catch { /* noop */ }
    pending.clear();
    listeners.clear();
  };
  dispose.onStatus = (fn) => { listeners.add(fn); fn(status); return () => listeners.delete(fn); };
  dispose.uri = uri;
  return dispose;
}

// Pure helpers exported for unit tests. `mapCompletionKind`/`attachPylsp` need a
// live monaco instance so they aren't tested directly; these mappers are pure.
export const __test = { LSP_COMPLETION_KIND, lspToMonacoMarkdown };
