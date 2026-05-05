/* CSA-in-a-Box Copilot Chat Widget — Vanilla JS (Security-Hardened) */
(function () {
  "use strict";

  var SITE_URL = "https://fgarofalo56.github.io/csa-inabox/";
  var REPO_URL = "https://github.com/fgarofalo56/csa-inabox";

  // Hardcoded configuration — no runtime override allowed (SEC-COPILOT)
  // Backend lives in:
  //   tenant : limitlessdata.ai (d1fc0498-f208-4b49-8376-beb9293acdf6)
  //   sub    : FedCiv ATU FFL - DLZ (363ef5d1-0e77-4594-a530-f51af23dbf8c)
  //   rg     : rg-dlz-aiml-stack-dev
  //   region : eastus
  // See azure-functions/copilot-chat/DEPLOYMENT.md for full provenance.
  var CONFIG = {
    apiEndpoint:
      "https://func-csa-inabox-copilot-fg.azurewebsites.net/api/chat",
    maxHistory: 10,
    rateLimitMs: 3000,
    maxMessageLength: 2000,
    welcomeMessage:
      "Hi! I'm the **CSA-in-a-Box Copilot**. Ask me anything about the codebase, architecture, deployment, or troubleshooting.",
  };

  /* ── Request Token Generation (SEC-COPILOT) ──────── */
  function generateRequestToken() {
    var ts = Math.floor(Date.now() / 30000); // 30-second windows
    var payload = ts + ":csa-copilot-2024";
    // Simple hash — not cryptographically secure but raises the bar
    var hash = 0;
    for (var i = 0; i < payload.length; i++) {
      var ch = payload.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Match backend SHA-256 — use SubtleCrypto if available
    if (window.crypto && window.crypto.subtle) {
      return window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(payload)
      ).then(function (buf) {
        var arr = Array.from(new Uint8Array(buf));
        var hex = arr.map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
        return ts + ":" + hex.substring(0, 16);
      });
    }
    // Fallback: use timestamp + simple hash (backend will also validate)
    var simpleHash = Math.abs(hash).toString(16).padStart(8, "0").substring(0, 16);
    return Promise.resolve(ts + ":" + simpleHash);
  }

  /* ── Search Index ─────────────────────────────────── */
  var searchIndex = [];
  var searchReady = false;

  function loadSearchIndex() {
    var base = document.querySelector('meta[name="base_url"]');
    var baseUrl = base ? base.getAttribute("content") : "/csa-inabox/";
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    var url = baseUrl + "search/search_index.json";

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Deduplicate to page-level (drop anchor fragments)
        var seen = {};
        (data.docs || []).forEach(function (doc) {
          var page = (doc.location || "").split("#")[0];
          if (!page && doc.location === "") page = "";
          if (page in seen) {
            // merge text into existing entry
            seen[page].text += " " + (doc.text || "");
          } else {
            seen[page] = { location: page, title: doc.title || "", text: doc.text || "" };
          }
        });
        searchIndex = Object.values(seen);
        searchReady = true;
      })
      .catch(function () { /* search unavailable — widget still works */ });
  }

  // Common English stop-words — dropped from search queries so "how the X works"
  // ranks pages by X, not by which page happens to use "the" the most.
  var STOP_WORDS = {
    a:1, an:1, and:1, are:1, as:1, at:1, be:1, been:1, but:1, by:1, can:1,
    could:1, did:1, do:1, does:1, doing:1, done:1, for:1, from:1, had:1,
    has:1, have:1, how:1, if:1, in:1, into:1, is:1, it:1, its:1, just:1,
    may:1, might:1, more:1, most:1, must:1, my:1, no:1, not:1, of:1, on:1,
    only:1, or:1, our:1, out:1, over:1, own:1, see:1, should:1, so:1, some:1,
    such:1, than:1, that:1, the:1, their:1, them:1, then:1, there:1,
    these:1, they:1, this:1, those:1, to:1, under:1, up:1, use:1, used:1,
    using:1, very:1, was:1, way:1, we:1, were:1, what:1, when:1, where:1,
    which:1, while:1, who:1, whom:1, whose:1, why:1, will:1, with:1,
    within:1, would:1, you:1, your:1
  };

  function searchPages(query, maxResults) {
    if (!searchReady || !query) return [];
    maxResults = maxResults || 5;

    var rawTerms = query.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);
    var terms = rawTerms.filter(function (t) {
      return t.length > 2 && !STOP_WORDS[t];
    });
    // If everything was stop-worded out, fall back to non-stop-word terms of
    // any length so a "what is X" query still finds X.
    if (!terms.length) {
      terms = rawTerms.filter(function (t) { return t.length > 1 && !STOP_WORDS[t]; });
    }
    if (!terms.length) return [];

    var scored = [];
    searchIndex.forEach(function (doc) {
      var titleLower = doc.title.toLowerCase();
      var textLower = (doc.text || "").toLowerCase().substring(0, 3000);
      var score = 0;
      var titleHits = 0;

      terms.forEach(function (term) {
        // Word-boundary title match weighted 15x — strong signal
        var wordRe = new RegExp("\\b" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
        if (wordRe.test(titleLower)) {
          score += 15;
          titleHits++;
        } else if (titleLower.indexOf(term) !== -1) {
          // Substring fallback (less weight)
          score += 6;
          titleHits++;
        }
        // Body matches — weighted 1x, capped at 5 per term to avoid keyword stuffing
        var idx = 0;
        var count = 0;
        while ((idx = textLower.indexOf(term, idx)) !== -1 && count < 5) {
          score += 1;
          idx += term.length;
          count++;
        }
      });

      // Bonus for matching multiple distinct terms in the title — helps
      // multi-word queries like "medallion architecture" prefer pages where
      // BOTH terms appear in the title over pages where each appears alone.
      if (titleHits > 1) score += titleHits * 5;

      if (score > 0) {
        scored.push({ doc: doc, score: score });
      }
    });

    scored.sort(function (a, b) { return b.score - a.score; });

    return scored.slice(0, maxResults).map(function (s) {
      var loc = s.doc.location;
      // Build page URL — avoid double slashes
      var locClean = loc ? loc.replace(/\/+$/, "") : "";
      var pageUrl = SITE_URL + (locClean ? locClean + "/" : "");
      // Build GitHub source URL — map location to docs/ file path
      var ghPath = locClean || "index";
      var ghUrl = REPO_URL + "/blob/main/docs/" + ghPath + ".md";

      return {
        title: s.doc.title,
        pageUrl: pageUrl,
        ghUrl: ghUrl,
        score: s.score,
      };
    });
  }

  function buildReferencesCard(results) {
    if (!results || !results.length) return "";
    var html = '<div class="copilot-refs">';
    html += '<div class="copilot-refs-header">📄 Related Pages</div>';

    results.forEach(function (r) {
      html += '<div class="copilot-ref-item">';
      html += '<a class="copilot-ref-page" href="' + esc(r.pageUrl) + '" title="View documentation page">' + esc(r.title) + '</a>';
      html += '<a class="copilot-ref-gh" href="' + esc(r.ghUrl) + '" target="_blank" rel="noopener" title="View source on GitHub">';
      html += '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
      html += '</a>';
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  /* ── Minimal Markdown renderer (XSS-hardened) ────── */
  function md(text) {
    if (!text) return "";
    // Code blocks — extract first so their contents aren't mangled by later rules
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      var idx = codeBlocks.length;
      var safeLang = (lang || "").replace(/[^a-zA-Z0-9-]/g, "");
      var langAttr = safeLang ? ' data-lang="' + safeLang + '"' : "";
      var langClass = safeLang ? ' class="language-' + safeLang + '"' : "";
      codeBlocks.push(
        '<pre' + langAttr + '><button class="copilot-copy" type="button" title="Copy code" aria-label="Copy code">📋</button>' +
        '<code' + langClass + '>' + esc(code.replace(/^\n+|\n+$/g, "")) + "</code></pre>"
      );
      return "\n\n__CODEBLOCK_" + idx + "__\n\n";
    });
    // Tables — pull out and convert before inline rules touch them
    var tableBlocks = [];
    text = text.replace(/(?:^|\n)((?:\|[^\n]+\|\n)+)(\|[\s:|-]+\|\n)((?:\|[^\n]+\|\n?)*)/g,
      function (match, header, separator, body) {
        var idx = tableBlocks.length;
        var headerCells = header.trim().slice(1, -1).split("|").map(function (c) { return c.trim(); });
        var alignments = separator.trim().slice(1, -1).split("|").map(function (s) {
          s = s.trim();
          if (/^:-+:$/.test(s)) return "center";
          if (/^-+:$/.test(s)) return "right";
          return "left";
        });
        var rows = body.trim().split("\n").map(function (line) {
          line = line.trim();
          if (!line || line[0] !== "|") return null;
          return line.slice(1, -1).split("|").map(function (c) { return c.trim(); });
        }).filter(Boolean);
        var html = '<div class="copilot-table-wrap"><table class="copilot-table"><thead><tr>';
        headerCells.forEach(function (c, i) {
          html += '<th style="text-align:' + alignments[i] + '">' + inlineMd(c) + "</th>";
        });
        html += "</tr></thead><tbody>";
        rows.forEach(function (row) {
          html += "<tr>";
          row.forEach(function (c, i) {
            html += '<td style="text-align:' + (alignments[i] || "left") + '">' + inlineMd(c) + "</td>";
          });
          html += "</tr>";
        });
        html += "</tbody></table></div>";
        tableBlocks.push(html);
        return "\n\n__TABLEBLOCK_" + idx + "__\n\n";
      });
    // Apply inline rules to non-block content
    text = inlineMd(text);
    // Headings (must be before paragraphs)
    text = text.replace(/^#### (.+)$/gm, '<h4 class="copilot-h">$1</h4>');
    text = text.replace(/^### (.+)$/gm, '<h3 class="copilot-h">$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2 class="copilot-h">$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1 class="copilot-h">$1</h1>');
    // Horizontal rules
    text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, "<hr>");
    // Task lists — render as disabled checkboxes (must come before plain unordered list)
    text = text.replace(/^[-*]\s+\[([ xX])\]\s+(.+)$/gm, function (_, mark, content) {
      var checked = mark.toLowerCase() === "x" ? " checked" : "";
      return '<li class="copilot-task"><input type="checkbox" disabled' + checked + ">" + content + "</li>";
    });
    text = text.replace(/((?:<li class="copilot-task">.*<\/li>\n?)+)/g, function (m) {
      return '<ul class="copilot-task-list">' + m + "</ul>";
    });
    // Ordered lists
    text = text.replace(/^\d+\. (.+)$/gm, '<li class="copilot-ol-item">$1</li>');
    text = text.replace(/((?:<li class="copilot-ol-item">.*<\/li>\n?)+)/g, function (m) {
      return "<ol>" + m.replace(/ class="copilot-ol-item"/g, "") + "</ol>";
    });
    // Unordered lists (skip task-list items, already wrapped)
    text = text.replace(/^[-*] (?!<input)(.+)$/gm, "<li>$1</li>");
    // Wrap consecutive plain <li> in <ul>; the task-list <li> are already
    // inside <ul class="copilot-task-list"> so they won't match here.
    text = text.replace(/(?:^|\n)((?:<li>(?!<input)[^\n]*<\/li>\n?)+)/g, function (full, lis) {
      return "\n<ul>" + lis + "</ul>";
    });
    // Blockquotes
    text = text.replace(/^>\s+(.+)$/gm, '<blockquote class="copilot-quote">$1</blockquote>');
    // Paragraphs
    text = text
      .split(/\n{2,}/)
      .map(function (p) {
        p = p.trim();
        if (!p || /^<(?:pre|ul|ol|h[1-4]|hr|blockquote|div|table)/.test(p)) return p;
        if (/^__(?:CODE|TABLE)BLOCK_\d+__$/.test(p)) return p;
        return "<p>" + p + "</p>";
      })
      .join("\n");
    // Restore extracted blocks
    text = text.replace(/__CODEBLOCK_(\d+)__/g, function (_, idx) {
      return codeBlocks[parseInt(idx, 10)];
    });
    text = text.replace(/__TABLEBLOCK_(\d+)__/g, function (_, idx) {
      return tableBlocks[parseInt(idx, 10)];
    });
    return text;
  }

  /* Inline markdown rules — used both standalone and inside tables */
  function inlineMd(text) {
    if (!text) return "";
    // Inline code
    text = text.replace(/`([^`]+)`/g, function (_, code) {
      return "<code>" + esc(code) + "</code>";
    });
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic — bracketed lookarounds for non-** sibling chars
    text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    // Links — SEC-COPILOT: validate URL protocol to prevent javascript: XSS
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      function (_, linkText, url) {
        if (!/^https?:\/\//i.test(url.trim())) {
          return esc(linkText);
        }
        return '<a href="' + esc(url.trim()) + '" target="_blank" rel="noopener noreferrer">' + esc(linkText) + '</a>';
      }
    );
    // Inline citation markers [^N] or [N] when followed by ^ — render as superscript
    text = text.replace(/\[\^(\d+)\]/g, '<sup class="copilot-cite"><a href="#copilot-src-$1">$1</a></sup>');
    return text;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ── Lazy-load highlight.js for code syntax colours ─── */
  var hljsLoading = null;
  function ensureHljs() {
    if (window.hljs) return Promise.resolve(window.hljs);
    if (hljsLoading) return hljsLoading;
    var version = "11.10.0";
    var script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/" + version + "/highlight.min.js";
    // Note: SRI hash intentionally omitted — pinning to the cdnjs URL +
    // explicit version is sufficient defence-in-depth for a public docs
    // site. Adding a wrong hash would silently break syntax highlighting.
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    var lightCss = document.createElement("link");
    lightCss.rel = "stylesheet";
    lightCss.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/" + version + "/styles/github.min.css";
    lightCss.media = "(prefers-color-scheme: light)";
    var darkCss = document.createElement("link");
    darkCss.rel = "stylesheet";
    darkCss.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/" + version + "/styles/github-dark.min.css";
    darkCss.media = "(prefers-color-scheme: dark)";
    document.head.appendChild(lightCss);
    document.head.appendChild(darkCss);
    hljsLoading = new Promise(function (resolve) {
      script.onload = function () { resolve(window.hljs); };
      script.onerror = function () { resolve(null); };
      document.head.appendChild(script);
    });
    return hljsLoading;
  }

  function enhanceCodeBlocks(root) {
    var blocks = root.querySelectorAll("pre code");
    if (!blocks.length) return;
    ensureHljs().then(function (hljs) {
      if (!hljs) return;
      blocks.forEach(function (b) {
        if (!b.dataset.hl) {
          try { hljs.highlightElement(b); b.dataset.hl = "1"; } catch (_) { /* ignore */ }
        }
      });
    });
    // Wire copy buttons (work even if highlight.js never loads)
    root.querySelectorAll("pre .copilot-copy").forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        var code = btn.parentElement.querySelector("code");
        var text = code ? code.textContent : "";
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(showCopied);
        } else {
          var ta = document.createElement("textarea");
          ta.value = text; ta.setAttribute("readonly", "");
          ta.style.position = "absolute"; ta.style.left = "-9999px";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); showCopied(); } catch (_) { /* noop */ }
          document.body.removeChild(ta);
        }
        function showCopied() {
          var orig = btn.textContent;
          btn.textContent = "✓";
          btn.classList.add("copilot-copied");
          setTimeout(function () {
            btn.textContent = orig;
            btn.classList.remove("copilot-copied");
          }, 1400);
        }
      });
    });
  }

  /* ── State ─────────────────────────────────────────── */
  var history = [];
  var lastSendTime = 0;
  var sending = false;
  var isOpen = false;
  var isFullPage = false;

  /* ── DOM Creation ──────────────────────────────────── */
  function createWidget() {
    // Load search index for page references
    loadSearchIndex();

    var fullPageEl = document.getElementById("copilot-fullpage");
    isFullPage = !!fullPageEl;

    // FAB button
    var fab = document.createElement("button");
    fab.className = "copilot-fab";
    fab.setAttribute("aria-label", "Open Copilot chat");
    fab.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';
    document.body.appendChild(fab);

    // Panel
    var panel = document.createElement("div");
    panel.className = "copilot-panel copilot-hidden";
    panel.innerHTML =
      '<div class="copilot-resize" title="Drag to resize"></div>' +
      '<div class="copilot-header">' +
      "  <span>🤖 CSA-in-a-Box Copilot</span>" +
      '  <div class="copilot-header-actions">' +
      '    <button class="copilot-clear" title="Clear chat">↻</button>' +
      '    <button class="copilot-fullscreen" title="Full-page chat">⛶</button>' +
      "  </div>" +
      "</div>" +
      '<div class="copilot-messages"></div>' +
      '<div class="copilot-input-area">' +
      '  <textarea class="copilot-input" placeholder="Ask about CSA-in-a-Box..." rows="1" maxlength="' + CONFIG.maxMessageLength + '"></textarea>' +
      '  <button class="copilot-send">Send</button>' +
      "</div>";

    if (isFullPage) {
      document.body.classList.add("copilot-fullpage-mode");
      fullPageEl.appendChild(panel);
      panel.classList.remove("copilot-hidden");
      panel.classList.add("copilot-visible");
      isOpen = true;
    } else {
      document.body.appendChild(panel);
    }

    var messagesEl = panel.querySelector(".copilot-messages");
    var inputEl = panel.querySelector(".copilot-input");
    var sendBtn = panel.querySelector(".copilot-send");

    // Welcome message
    appendMessage("assistant", CONFIG.welcomeMessage);

    // Toggle panel
    fab.addEventListener("click", function () {
      isOpen = !isOpen;
      panel.classList.toggle("copilot-hidden", !isOpen);
      panel.classList.toggle("copilot-visible", isOpen);
      if (isOpen) inputEl.focus();
    });

    // Clear
    panel.querySelector(".copilot-clear").addEventListener("click", function () {
      history = [];
      messagesEl.innerHTML = "";
      appendMessage("assistant", CONFIG.welcomeMessage);
    });

    // Fullscreen
    panel.querySelector(".copilot-fullscreen").addEventListener("click", function () {
      window.location.href = (window.__md_scope || "") + "chat/";
    });

    // Send
    sendBtn.addEventListener("click", doSend);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    // Auto-resize textarea
    inputEl.addEventListener("input", function () {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 100) + "px";
    });

    // Drag-to-resize from top-left corner
    var resizeHandle = panel.querySelector(".copilot-resize");
    if (resizeHandle && !isFullPage) {
      var startX, startY, startW, startH;

      resizeHandle.addEventListener("mousedown", onResizeStart);
      resizeHandle.addEventListener("touchstart", onResizeStart, { passive: false });

      function onResizeStart(e) {
        e.preventDefault();
        e.stopPropagation();
        var ev = e.touches ? e.touches[0] : e;
        startX = ev.clientX;
        startY = ev.clientY;
        startW = panel.offsetWidth;
        startH = panel.offsetHeight;
        panel.classList.add("copilot-resizing");
        document.addEventListener("mousemove", onResizeMove);
        document.addEventListener("mouseup", onResizeEnd);
        document.addEventListener("touchmove", onResizeMove, { passive: false });
        document.addEventListener("touchend", onResizeEnd);
      }

      function onResizeMove(e) {
        var ev = e.touches ? e.touches[0] : e;
        // Panel is anchored bottom-right, so dragging top-left outward = larger
        var dw = startX - ev.clientX;
        var dh = startY - ev.clientY;
        var newW = Math.max(300, Math.min(startW + dw, window.innerWidth - 32));
        var newH = Math.max(280, Math.min(startH + dh, window.innerHeight - 120));
        panel.style.width = newW + "px";
        panel.style.height = newH + "px";
      }

      function onResizeEnd() {
        panel.classList.remove("copilot-resizing");
        document.removeEventListener("mousemove", onResizeMove);
        document.removeEventListener("mouseup", onResizeEnd);
        document.removeEventListener("touchmove", onResizeMove);
        document.removeEventListener("touchend", onResizeEnd);
      }
    }

    /* ── Send Logic ────────────────────────────────── */
    function doSend() {
      var text = inputEl.value.trim();
      if (!text || sending) return;

      // SEC-COPILOT: Client-side message length enforcement
      if (text.length > CONFIG.maxMessageLength) {
        text = text.substring(0, CONFIG.maxMessageLength);
      }

      // SEC-COPILOT: Rate limiting (3 seconds between sends)
      var now = Date.now();
      if (now - lastSendTime < CONFIG.rateLimitMs) return;
      lastSendTime = now;

      sending = true;
      sendBtn.disabled = true;
      inputEl.value = "";
      inputEl.style.height = "auto";

      appendMessage("user", text);
      history.push({ role: "user", content: text });
      if (history.length > CONFIG.maxHistory * 2)
        history = history.slice(-CONFIG.maxHistory * 2);

      var streamingEl = appendMessage("assistant", "Thinking...", true);

      var userQuery = text; // capture for reference card
      // Pre-search local docs index so the backend can ground citations
      var grounding = searchPages(userQuery, 5);

      sendToBackend(text, grounding, function onChunk(partial) {
        updateBubble(streamingEl, partial, false);
      })
        .then(function (result) {
          var reply = (result && result.reply) || "";
          var sources = (result && result.sources) || [];
          updateBubble(streamingEl, reply || "(empty response)", true);
          history.push({ role: "assistant", content: reply });

          // Inline citation footer (AI-curated, ordered)
          appendCitations(sources);

          // Always also offer the Related Pages card from local index — broader coverage
          var refs = searchPages(userQuery);
          if (refs.length > 0) {
            appendReferences(refs);
          }
        })
        .catch(function (err) {
          updateBubble(streamingEl,
            "**Error:** " +
              (err.message || "Could not reach the Copilot backend. Make sure the Azure Function is deployed."),
            true);
        })
        .finally(function () {
          sending = false;
          sendBtn.disabled = false;
        });
    }

    /* ── Append Message ────────────────────────────── */
    function appendMessage(role, text, isTyping) {
      var wrap = document.createElement("div");
      wrap.className = "copilot-msg copilot-msg-" + role;

      var avatar = document.createElement("div");
      avatar.className = "copilot-avatar";
      avatar.textContent = role === "assistant" ? "🤖" : "👤";

      var bubble = document.createElement("div");
      bubble.className = "copilot-bubble";
      if (isTyping) bubble.classList.add("copilot-typing");
      bubble.innerHTML = md(text);

      wrap.appendChild(avatar);
      wrap.appendChild(bubble);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      enhanceCodeBlocks(bubble);
      return wrap;
    }

    /* Update an existing assistant bubble in place (used during streaming) */
    function updateBubble(wrap, text, finalize) {
      var bubble = wrap.querySelector(".copilot-bubble");
      if (!bubble) return;
      bubble.classList.remove("copilot-typing");
      bubble.innerHTML = md(text);
      // Stick to bottom while user hasn't scrolled up
      var nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
      if (finalize) enhanceCodeBlocks(bubble);
    }

    /* Render the AI-supplied structured citations as an inline footer */
    function appendCitations(sources) {
      if (!sources || !sources.length) return;
      var wrap = document.createElement("div");
      wrap.className = "copilot-msg copilot-msg-assistant";
      var spacer = document.createElement("div");
      spacer.className = "copilot-avatar";
      var card = document.createElement("div");
      card.className = "copilot-bubble copilot-citations-bubble";
      var html = '<div class="copilot-citations-header">📚 Sources</div><ol class="copilot-citations-list">';
      sources.forEach(function (s, i) {
        var n = i + 1;
        var url = (s && s.url) || "";
        var title = (s && s.title) || url || ("Source " + n);
        var safeUrl = /^https?:\/\//i.test(url) ? url : "";
        if (safeUrl) {
          html += '<li id="copilot-src-' + n + '"><a href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + "</a></li>";
        } else {
          html += '<li id="copilot-src-' + n + '">' + esc(title) + "</li>";
        }
      });
      html += "</ol>";
      card.innerHTML = html;
      wrap.appendChild(spacer);
      wrap.appendChild(card);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /* ── Append References Card ─────────────────────── */
    function appendReferences(results) {
      var wrap = document.createElement("div");
      wrap.className = "copilot-msg copilot-msg-assistant";

      var spacer = document.createElement("div");
      spacer.className = "copilot-avatar";
      // empty spacer to align with bubbles

      var card = document.createElement("div");
      card.className = "copilot-bubble copilot-refs-bubble";
      card.innerHTML = buildReferencesCard(results);

      wrap.appendChild(spacer);
      wrap.appendChild(card);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  /* ── Backend Communication ─────────────────────────── */
  /**
   * @param {string} message — user input
   * @param {Array} grounding — pre-searched local docs (frontend-side RAG)
   * @param {Function} onChunk — called with the accumulating reply text as
   *                             chunks arrive (for progressive UI rendering)
   * @returns {Promise<{reply: string, sources: Array}>}
   */
  function sendToBackend(message, grounding, onChunk) {
    var pageContext = {
      url: window.location.href,
      title: document.title,
      path: window.location.pathname,
    };

    // SEC-COPILOT: Generate time-based request token
    return generateRequestToken().then(function (token) {
      return fetch(CONFIG.apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Copilot-Token": token,
        },
        body: JSON.stringify({
          message: message,
          history: history.slice(-CONFIG.maxHistory * 2),
          pageContext: pageContext,
          grounding: (grounding || []).map(function (g) {
            return { title: g.title || "", url: g.pageUrl || "" };
          }),
        }),
      });
    }).then(function (resp) {
      if (!resp.ok)
        return resp.json().then(function (e) {
          throw new Error(e.error || "Request failed (" + resp.status + ")");
        });

      var ct = resp.headers.get("content-type") || "";

      // Streaming (ndjson)
      if (ct.includes("ndjson") || ct.includes("stream")) {
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var result = "";
        var sources = [];
        var meta = null;
        function read() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              return { reply: result, sources: sources, meta: meta };
            }
            var text = decoder.decode(chunk.value, { stream: true });
            text.split("\n").forEach(function (line) {
              line = line.trim();
              if (!line) return;
              try {
                var j = JSON.parse(line);
                if (j.content) {
                  result += j.content;
                  if (typeof onChunk === "function") onChunk(result);
                } else if (j.sources) {
                  sources = j.sources;
                } else if (j.meta) {
                  meta = j.meta;
                }
              } catch (_) {
                result += line;
                if (typeof onChunk === "function") onChunk(result);
              }
            });
            return read();
          });
        }
        return read();
      }

      // Standard JSON
      return resp.json().then(function (data) {
        var reply = data.reply || data.content || "";
        var sources = data.sources || [];
        if (typeof onChunk === "function" && reply) onChunk(reply);
        return { reply: reply, sources: sources };
      });
    });
  }

  /* ── Init ──────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createWidget);
  } else {
    createWidget();
  }
})();
