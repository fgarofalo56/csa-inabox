/* CSA-in-a-Box Copilot Chat Widget — Vanilla JS */
(function () {
  "use strict";

  var SITE_URL = "https://fgarofalo56.github.io/csa-inabox/";
  var REPO_URL = "https://github.com/fgarofalo56/csa-inabox";

  var CONFIG = Object.assign(
    {
      apiEndpoint:
        "https://func-csa-inabox-copilot.azurewebsites.net/api/chat",
      maxHistory: 20,
      rateLimitMs: 1500,
      welcomeMessage:
        "Hi! I'm the **CSA-in-a-Box Copilot**. Ask me anything about the codebase, architecture, deployment, or troubleshooting.",
    },
    window.COPILOT_CONFIG || {}
  );

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

  function searchPages(query, maxResults) {
    if (!searchReady || !query) return [];
    maxResults = maxResults || 5;

    var terms = query.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(function (t) { return t.length > 2; });
    if (!terms.length) return [];

    var scored = [];
    searchIndex.forEach(function (doc) {
      var titleLower = doc.title.toLowerCase();
      var textLower = (doc.text || "").toLowerCase().substring(0, 3000);
      var score = 0;

      terms.forEach(function (term) {
        // Title matches weighted 5x
        if (titleLower.indexOf(term) !== -1) score += 5;
        // Text matches
        var idx = 0;
        var count = 0;
        while ((idx = textLower.indexOf(term, idx)) !== -1 && count < 10) {
          score += 1;
          idx += term.length;
          count++;
        }
      });

      if (score > 0) {
        scored.push({ doc: doc, score: score });
      }
    });

    scored.sort(function (a, b) { return b.score - a.score; });

    return scored.slice(0, maxResults).map(function (s) {
      var loc = s.doc.location;
      // Build page URL
      var pageUrl = SITE_URL + (loc ? loc + "/" : "");
      // Build GitHub source URL — map location to docs/ file path
      var ghPath = loc ? loc : "index";
      // Remove trailing slashes
      ghPath = ghPath.replace(/\/+$/, "");
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
      html += '<a class="copilot-ref-page" href="' + r.pageUrl + '" title="View documentation page">' + esc(r.title) + '</a>';
      html += '<a class="copilot-ref-gh" href="' + r.ghUrl + '" target="_blank" rel="noopener" title="View source on GitHub">';
      html += '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
      html += '</a>';
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  /* ── Minimal Markdown renderer ─────────────────────── */
  function md(text) {
    if (!text) return "";
    // Code blocks — extract and replace with placeholders to protect contents
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push('<pre><code class="language-' + (lang || "") + '">' + esc(code.trim()) + "</code></pre>");
      return "\n\n__CODEBLOCK_" + idx + "__\n\n";
    });
    // Inline code
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
    // Links
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    // Headings (must be before paragraphs)
    text = text.replace(/^#### (.+)$/gm, '<h4 class="copilot-h">$1</h4>');
    text = text.replace(/^### (.+)$/gm, '<h3 class="copilot-h">$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2 class="copilot-h">$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1 class="copilot-h">$1</h1>');
    // Horizontal rules
    text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, "<hr>");
    // Ordered lists
    text = text.replace(/^\d+\. (.+)$/gm, '<li class="copilot-ol-item">$1</li>');
    text = text.replace(/((?:<li class="copilot-ol-item">.*<\/li>\n?)+)/g, function (m) {
      return "<ol>" + m.replace(/ class="copilot-ol-item"/g, "") + "</ol>";
    });
    // Unordered lists
    text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
    // Paragraphs
    text = text
      .split(/\n{2,}/)
      .map(function (p) {
        p = p.trim();
        if (!p || /^<(?:pre|ul|ol|h[1-4]|hr|blockquote|div)/.test(p)) return p;
        return "<p>" + p + "</p>";
      })
      .join("\n");
    // Restore code blocks
    text = text.replace(/__CODEBLOCK_(\d+)__/g, function (_, idx) {
      return codeBlocks[parseInt(idx, 10)];
    });
    return text;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
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
      '<div class="copilot-header">' +
      "  <span>🤖 CSA-in-a-Box Copilot</span>" +
      '  <div class="copilot-header-actions">' +
      '    <button class="copilot-clear" title="Clear chat">↻</button>' +
      '    <button class="copilot-fullscreen" title="Full-page chat">⛶</button>' +
      "  </div>" +
      "</div>" +
      '<div class="copilot-messages"></div>' +
      '<div class="copilot-input-area">' +
      '  <textarea class="copilot-input" placeholder="Ask about CSA-in-a-Box..." rows="1"></textarea>' +
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

    /* ── Send Logic ────────────────────────────────── */
    function doSend() {
      var text = inputEl.value.trim();
      if (!text || sending) return;

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

      var thinkingEl = appendMessage("assistant", "Thinking...", true);

      var userQuery = text; // capture for reference card

      sendToBackend(text)
        .then(function (reply) {
          thinkingEl.remove();
          appendMessage("assistant", reply);
          history.push({ role: "assistant", content: reply });

          // Append related pages card
          var refs = searchPages(userQuery);
          if (refs.length > 0) {
            appendReferences(refs);
          }
        })
        .catch(function (err) {
          thinkingEl.remove();
          appendMessage(
            "assistant",
            "**Error:** " +
              (err.message || "Could not reach the Copilot backend. Make sure the Azure Function is deployed.")
          );
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
      return wrap;
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
  function sendToBackend(message) {
    var pageContext = {
      url: window.location.href,
      title: document.title,
      path: window.location.pathname,
    };

    return fetch(CONFIG.apiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message,
        history: history.slice(-CONFIG.maxHistory * 2),
        pageContext: pageContext,
      }),
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
        function read() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return result;
            var text = decoder.decode(chunk.value, { stream: true });
            text.split("\n").forEach(function (line) {
              line = line.trim();
              if (!line) return;
              try {
                var j = JSON.parse(line);
                if (j.content) result += j.content;
              } catch (_) {
                result += line;
              }
            });
            return read();
          });
        }
        return read();
      }

      // Standard JSON
      return resp.json().then(function (data) {
        return data.reply || data.content || JSON.stringify(data);
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
