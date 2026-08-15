/*
 * CSA Loom result-grid webview script. Renders three states from host messages:
 *   { type: 'loading', title, engine }                    → shimmer skeleton
 *   { type: 'result', title, engine, columns, rows, meta } → type-badged grid
 *   { type: 'message', title, engine, message, isError }   → honest message pane
 *
 * It receives ONLY column/row/meta data — never a credential (the host strips
 * everything else). It does no network I/O and runs under a strict CSP. All
 * values are inserted via textContent (never innerHTML) so a cell that looks
 * like markup can never execute.
 */
(function () {
  'use strict';
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const statusbar = document.getElementById('statusbar');
  const content = document.getElementById('content');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtMs(ms) {
    if (typeof ms !== 'number') return '';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function renderStatus(title, engine, meta) {
    clear(statusbar);
    statusbar.appendChild(el('span', 'title', title || 'Results'));
    if (engine) statusbar.appendChild(el('span', 'stat', engine.toUpperCase()));
    if (meta) {
      const rc = el('span', 'stat');
      rc.appendChild(document.createTextNode('rows '));
      rc.appendChild(el('span', 'num', meta.rowCount != null ? meta.rowCount : 0));
      statusbar.appendChild(rc);
      if (meta.elapsedMs != null) {
        const t = el('span', 'stat');
        t.appendChild(document.createTextNode('time '));
        t.appendChild(el('span', 'num', fmtMs(meta.elapsedMs)));
        statusbar.appendChild(t);
      }
      if (meta.truncated) {
        const label = meta.cappedBy === 'bytes' ? 'capped (size)' : 'capped (rows)';
        statusbar.appendChild(el('span', 'cap', label));
      }
    }
  }

  function renderLoading(msg) {
    renderStatus(msg.title, msg.engine, null);
    clear(content);
    const sk = el('div', 'skeleton');
    for (let i = 0; i < 6; i++) sk.appendChild(el('div', 'bar'));
    content.appendChild(sk);
  }

  function renderMessage(msg) {
    renderStatus(msg.title, msg.engine, null);
    clear(content);
    content.appendChild(el('div', 'msg' + (msg.isError ? ' error' : ''), msg.message || ''));
  }

  function renderGrid(msg) {
    renderStatus(msg.title, msg.engine, msg.meta);
    clear(content);
    const columns = Array.isArray(msg.columns) ? msg.columns : [];
    const rows = Array.isArray(msg.rows) ? msg.rows : [];

    if (columns.length === 0) {
      content.appendChild(el('div', 'msg', 'The query returned no columns.'));
      return;
    }

    const wrap = el('div', 'grid-wrap');
    const table = el('table', 'grid');

    const thead = el('thead');
    const htr = el('tr');
    htr.appendChild(el('th', 'rownum', '#'));
    for (const col of columns) {
      const th = el('th');
      th.appendChild(el('span', 'col-name', col && col.name != null ? col.name : ''));
      if (col && col.type) th.appendChild(el('span', 'col-type', col.type));
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (let r = 0; r < rows.length; r++) {
      const tr = el('tr');
      tr.appendChild(el('td', 'rownum', r + 1));
      const cells = Array.isArray(rows[r]) ? rows[r] : [];
      for (let c = 0; c < columns.length; c++) {
        const raw = cells[c];
        const isNull = raw === 'NULL';
        tr.appendChild(el('td', isNull ? 'null' : undefined, raw != null ? raw : ''));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    content.appendChild(wrap);
  }

  /**
   * ORIGIN GUARD (CodeQL js/missing-origin-check #766 / CWE-940).
   *
   * `window.addEventListener('message', ...)` accepts a post from ANY window
   * that holds a handle to this one. This view is driven entirely by the
   * extension host, so anything else is forgery: a foreign post can repaint the
   * status bar and the whole grid, and a fabricated "rows 0 / no matches" over a
   * query the user actually ran is a lie the UI has no way to detect. Nothing
   * here is injected as markup (every value goes in via textContent), so the
   * damage is integrity, not execution — a believable WRONG answer.
   *
   * WHY SAME-ORIGIN IS SUFFICIENT, read off the pinned VS Code 1.102 webview
   * host (src/vs/workbench/contrib/webview/browser/pre/index.html) rather than
   * assumed. Every post into this document — both of them, lines 1126 and 1242,
   * and there are no others — supplies a targetOrigin:
   *
   *     contentWindow.postMessage(message.message, window.origin, …)
   *
   * and the frame is created with
   *
   *     const sandboxRules = new Set(['allow-same-origin', 'allow-pointer-lock']);
   *
   * `allow-same-origin` is unconditional, so this document shares the host's
   * origin. And because a targetOrigin is given (never `'*'` — zero wildcards
   * in the file), the browser refuses to DELIVER unless the receiver's origin
   * matches it. So on the legitimate path `event.origin === window.origin` is
   * not merely usually true, it is guaranteed by the delivery rule itself.
   *
   * An earlier revision also accepted `event.source === window.parent ||
   * window.top`. That is unconditional embedder trust, and per the above it
   * covers no host case this does not — so it is gone rather than documented.
   *
   * A pinned origin LITERAL is still wrong: the value is host- and
   * version-specific (`vscode-webview://<uuid>` desktop, `https://<uuid>.
   * vscode-cdn.net` web) and hard-coding one would blank this panel the day
   * either changes. Comparing to our own origin tracks it automatically.
   *
   * The `'null'` exclusion is not decorative. An opaque-origin document reports
   * `window.origin === 'null'`, and so does every opaque-origin SENDER, so the
   * comparison would degenerate into "accept anyone". Unreachable while
   * `allow-same-origin` is unconditional above — this keeps the check honest if
   * that ever changes, rather than leaving our safety contingent on an
   * implementation detail of another product.
   *
   * REACHABILITY, stated honestly and in the right direction: not exploitable
   * as this panel ships. CSP `default-src 'none'` (frame-src falls back to it)
   * means this document EMBEDS nothing, and the only script here never calls
   * `window.open` — so it hands no OUTBOUND handle to anyone. That says nothing
   * about who may embed US; there is no `frame-ancestors` anywhere in the host
   * page, and that constraint comes instead from the `vscode-webview://`
   * scheme. The guard is what makes the inbound direction safe on its own.
   */
  window.addEventListener('message', function (event) {
    const sameRealOrigin =
      event.origin === window.origin && event.origin !== 'null' && event.origin !== '';
    if (!sameRealOrigin) return;

    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'loading') renderLoading(msg);
    else if (msg.type === 'message') renderMessage(msg);
    else if (msg.type === 'result') renderGrid(msg);
  });

  if (vscode) vscode.postMessage({ type: 'ready' });
})();
