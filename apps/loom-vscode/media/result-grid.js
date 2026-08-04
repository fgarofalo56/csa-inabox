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

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'loading') renderLoading(msg);
    else if (msg.type === 'message') renderMessage(msg);
    else if (msg.type === 'result') renderGrid(msg);
  });

  if (vscode) vscode.postMessage({ type: 'ready' });
})();
