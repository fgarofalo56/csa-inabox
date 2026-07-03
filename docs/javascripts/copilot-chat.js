/* CSA-in-a-Box Copilot Chat Widget — Vanilla JS (Security-Hardened)
 *
 * Architecture notes:
 *
 * - All HTML produced by ``md()`` is now safe-by-construction: the input
 *   text is HTML-escaped *before* any markdown rule runs, so capture
 *   groups carry only escaped content. Every output sink that calls
 *   ``bubble.innerHTML = md(text)`` is therefore safe from LLM-emitted
 *   or LLM-relayed HTML payloads.  See SEC-COPILOT C-1 (audit
 *   2026-05-06) for the original sink and the chained-stored-XSS
 *   risk that motivated this fix.
 *
 * - Telemetry: every chat / feedback / backlog request carries a
 *   ``session_id`` (per-tab) and ``conversation_id`` (per turn). The
 *   backend uses these to stitch records in Cosmos DB and App Insights.
 *
 * - Privacy: a one-time banner asks for opt-in. Opting out is sticky
 *   (localStorage) and surfaces as the ``X-Copilot-Opt-Out: 1`` header.
 */
(function () {
  "use strict";

  var SITE_URL = "https://fgarofalo56.github.io/csa-inabox/";
  var REPO_URL = "https://github.com/fgarofalo56/csa-inabox";

  // Hardcoded configuration — no runtime override allowed (SEC-COPILOT)
  // Backend lives in:
  //   tenant : contoso.gov (<tenant-id>)
  //   sub    : FedCiv ATU FFL - DLZ (<YOUR_DLZ_SUBSCRIPTION_ID>)
  //   rg     : rg-dlz-aiml-stack-dev
  //   region : eastus
  // See azure-functions/copilot-chat/DEPLOYMENT.md for full provenance.
  var CONFIG = {
    apiBase: "https://func-csa-inabox-copilot-fg.azurewebsites.net/api",
    maxHistory: 10,
    rateLimitMs: 3000,
    maxMessageLength: 2000,
    maxImprovementLength: 1000,
    maxBacklogTitleLength: 200,
    maxBacklogDescriptionLength: 4000,
    welcomeMessage:
      "Hi! I'm the **Cloud Scale Analytics in a Box Copilot**. Ask me anything about the codebase, architecture, deployment, or troubleshooting.",
    privacyDocUrl: "https://fgarofalo56.github.io/csa-inabox/copilot-privacy/",
  };

  /* ── Storage keys (localStorage) ─────────────────────────── */
  var LS_PRIVACY_DECISION = "csa.copilot.privacy.v1";  // "accepted" | "opted_out"
  var LS_SESSION_ID = "csa.copilot.session.v1";

  /* ── Privacy state ───────────────────────────────────────── */
  function getPrivacyDecision() {
    try { return localStorage.getItem(LS_PRIVACY_DECISION) || ""; }
    catch (_) { return ""; }
  }
  function setPrivacyDecision(value) {
    try { localStorage.setItem(LS_PRIVACY_DECISION, value); } catch (_) { /* noop */ }
  }
  function isOptedOut() { return getPrivacyDecision() === "opted_out"; }

  /* ── Session / conversation IDs ──────────────────────────── */
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      try { return window.crypto.randomUUID(); }
      catch (_) { /* fall through */ }
    }
    var chars = "0123456789abcdef";
    var s = "";
    for (var i = 0; i < 32; i++) {
      var c = chars.charAt(Math.floor(Math.random() * 16));
      s += (i === 12) ? "4" : (i === 16 ? chars.charAt(8 + Math.floor(Math.random() * 4)) : c);
    }
    return s.substring(0, 8) + "-" + s.substring(8, 12) + "-" + s.substring(12, 16) + "-" + s.substring(16, 20) + "-" + s.substring(20);
  }
  function getSessionId() {
    var v = "";
    try { v = sessionStorage.getItem(LS_SESSION_ID) || ""; } catch (_) { v = ""; }
    if (!v) {
      v = uuid();
      try { sessionStorage.setItem(LS_SESSION_ID, v); } catch (_) { /* noop */ }
    }
    return v;
  }

  /* ── Request Token Generation (SEC-COPILOT) ──────── */
  function generateRequestToken() {
    var ts = Math.floor(Date.now() / 30000); // 30-second windows
    var payload = ts + ":csa-copilot-2024";
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
    // Fallback hash (legacy browsers — backend rejects mismatch with 403)
    var hash = 0;
    for (var i = 0; i < payload.length; i++) {
      var ch = payload.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash;
    }
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
        var seen = {};
        (data.docs || []).forEach(function (doc) {
          var page = (doc.location || "").split("#")[0];
          if (!page && doc.location === "") page = "";
          if (page in seen) {
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
        var wordRe = new RegExp("\\b" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
        if (wordRe.test(titleLower)) {
          score += 15;
          titleHits++;
        } else if (titleLower.indexOf(term) !== -1) {
          score += 6;
          titleHits++;
        }
        var idx = 0;
        var count = 0;
        while ((idx = textLower.indexOf(term, idx)) !== -1 && count < 5) {
          score += 1;
          idx += term.length;
          count++;
        }
      });

      if (titleHits > 1) score += titleHits * 5;

      if (score > 0) {
        scored.push({ doc: doc, score: score });
      }
    });

    scored.sort(function (a, b) { return b.score - a.score; });

    return scored.slice(0, maxResults).map(function (s) {
      var loc = s.doc.location;
      var locClean = loc ? loc.replace(/\/+$/, "") : "";
      var pageUrl = SITE_URL + (locClean ? locClean + "/" : "");
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
    // Each component runs through esc() — this card never injects raw user
    // text into HTML.
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

  /* ── Markdown renderer (XSS-hardened — see SEC-COPILOT C-1) ──
   *
   * The escape happens FIRST. Every subsequent rule operates on escaped
   * text, so capture-group interpolation cannot reintroduce HTML. The
   * inner esc() calls that used to live in the inline-code, link, and
   * code-block paths have been removed: re-escaping already-escaped
   * text would render `<` literally as the 4-character string `&lt;`.
   *
   * The only HTML we splice in ourselves is the surrounding tag scaffold
   * (e.g. `<strong>...</strong>`), which is constant — so it can never
   * be subverted by attacker input.
   */
  function md(text) {
    if (!text) return "";

    // Step 1: Escape the entire input. From this point on, capture groups
    // returned by regex callbacks are already HTML-safe.
    text = esc(text);

    // Step 2: Extract code blocks. Their interior is the original
    // (escaped) text — we already escaped it once above, so DO NOT call
    // esc() again here.
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      var idx = codeBlocks.length;
      var safeLang = (lang || "").replace(/[^a-zA-Z0-9-]/g, "");
      var langAttr = safeLang ? ' data-lang="' + safeLang + '"' : "";
      var langClass = safeLang ? ' class="language-' + safeLang + '"' : "";
      codeBlocks.push(
        '<pre' + langAttr + '><button class="copilot-copy" type="button" title="Copy code" aria-label="Copy code">📋</button>' +
        '<code' + langClass + '>' + code.replace(/^\n+|\n+$/g, "") + "</code></pre>"
      );
      return "\n\n__CODEBLOCK_" + idx + "__\n\n";
    });

    // Step 3: Tables — pull out and convert before inline rules touch them
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

    // Step 4: Apply inline rules to the rest of the (already-escaped) text
    text = inlineMd(text);

    // Step 5: Block rules — capture groups are escaped, splicing is safe
    text = text.replace(/^#### (.+)$/gm, '<h4 class="copilot-h">$1</h4>');
    text = text.replace(/^### (.+)$/gm, '<h3 class="copilot-h">$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2 class="copilot-h">$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1 class="copilot-h">$1</h1>');
    text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, "<hr>");
    text = text.replace(/^[-*]\s+\[([ xX])\]\s+(.+)$/gm, function (_, mark, content) {
      var checked = mark.toLowerCase() === "x" ? " checked" : "";
      return '<li class="copilot-task"><input type="checkbox" disabled' + checked + ">" + content + "</li>";
    });
    text = text.replace(/((?:<li class="copilot-task">.*<\/li>\n?)+)/g, function (m) {
      return '<ul class="copilot-task-list">' + m + "</ul>";
    });
    text = text.replace(/^\d+\. (.+)$/gm, '<li class="copilot-ol-item">$1</li>');
    text = text.replace(/((?:<li class="copilot-ol-item">.*<\/li>\n?)+)/g, function (m) {
      return "<ol>" + m.replace(/ class="copilot-ol-item"/g, "") + "</ol>";
    });
    text = text.replace(/^[-*] (?!<input)(.+)$/gm, "<li>$1</li>");
    text = text.replace(/(?:^|\n)((?:<li>(?!<input)[^\n]*<\/li>\n?)+)/g, function (full, lis) {
      return "\n<ul>" + lis + "</ul>";
    });
    text = text.replace(/^>\s+(.+)$/gm, '<blockquote class="copilot-quote">$1</blockquote>');
    text = text
      .split(/\n{2,}/)
      .map(function (p) {
        p = p.trim();
        if (!p || /^<(?:pre|ul|ol|h[1-4]|hr|blockquote|div|table)/.test(p)) return p;
        if (/^__(?:CODE|TABLE)BLOCK_\d+__$/.test(p)) return p;
        return "<p>" + p + "</p>";
      })
      .join("\n");

    text = text.replace(/__CODEBLOCK_(\d+)__/g, function (_, idx) {
      return codeBlocks[parseInt(idx, 10)];
    });
    text = text.replace(/__TABLEBLOCK_(\d+)__/g, function (_, idx) {
      return tableBlocks[parseInt(idx, 10)];
    });
    return text;
  }

  /* Inline markdown rules — operate on already-escaped text. */
  function inlineMd(text) {
    if (!text) return "";
    // Inline code — `code` is already escaped, no need to re-escape
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    // Links — URL & link text are already escaped; protocol check still
    // applies because escape doesn't touch ASCII letters / colons.
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      function (_, linkText, url) {
        var u = url.trim();
        if (!/^https?:\/\//i.test(u)) {
          return linkText;
        }
        return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>';
      }
    );
    // Inline citation markers [^N] — render as superscript
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
  var lastConversationId = null;
  var lastQuery = "";

  /* ── Auth + opt-out headers for API calls ─────────────── */
  function buildHeaders(token) {
    var h = {
      "Content-Type": "application/json",
      "X-Copilot-Token": token,
      "X-Copilot-Session": getSessionId(),
    };
    if (isOptedOut()) h["X-Copilot-Opt-Out"] = "1";
    return h;
  }

  /* ── DOM Creation ──────────────────────────────────── */
  function createWidget() {
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
      "  <span>🤖 CSA Copilot</span>" +
      '  <div class="copilot-header-actions">' +
      '    <button class="copilot-request" title="Request a use case or report an issue">💡</button>' +
      '    <button class="copilot-clear" title="Clear chat">↻</button>' +
      '    <button class="copilot-fullscreen" title="Full-page chat">⛶</button>' +
      "  </div>" +
      "</div>" +
      '<div class="copilot-banner copilot-hidden" role="status">' +
      '  <div class="copilot-banner-text">Help us make this Copilot better — we log questions and answers (with secrets redacted) to improve coverage. <a href="' + esc(CONFIG.privacyDocUrl) + '" target="_blank" rel="noopener">Read the privacy notice</a>.</div>' +
      '  <div class="copilot-banner-actions">' +
      '    <button class="copilot-banner-accept">Accept</button>' +
      '    <button class="copilot-banner-out">Opt out</button>' +
      '  </div>' +
      '</div>' +
      '<div class="copilot-messages"></div>' +
      '<div class="copilot-input-area">' +
      '  <textarea class="copilot-input" placeholder="Ask about Cloud Scale Analytics..." rows="1" maxlength="' + CONFIG.maxMessageLength + '"></textarea>' +
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
    var bannerEl = panel.querySelector(".copilot-banner");

    // Welcome message
    appendMessage("assistant", CONFIG.welcomeMessage);

    // Privacy banner — show on first open
    if (!getPrivacyDecision()) {
      bannerEl.classList.remove("copilot-hidden");
    }
    bannerEl.querySelector(".copilot-banner-accept").addEventListener("click", function () {
      setPrivacyDecision("accepted");
      bannerEl.classList.add("copilot-hidden");
    });
    bannerEl.querySelector(".copilot-banner-out").addEventListener("click", function () {
      setPrivacyDecision("opted_out");
      bannerEl.classList.add("copilot-hidden");
      var msg = appendMessage("assistant", "✓ You're opted out — your chats won't be logged. You can change this any time by clearing browser storage.");
      msg.classList.add("copilot-system");
    });

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
      lastConversationId = null;
      lastQuery = "";
      messagesEl.innerHTML = "";
      appendMessage("assistant", CONFIG.welcomeMessage);
    });

    // Fullscreen
    panel.querySelector(".copilot-fullscreen").addEventListener("click", function () {
      window.location.href = (window.__md_scope || "") + "chat/";
    });

    // Use-case / bug request modal
    panel.querySelector(".copilot-request").addEventListener("click", function () {
      openRequestModal();
    });

    // Send
    sendBtn.addEventListener("click", doSend);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

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

      if (text.length > CONFIG.maxMessageLength) {
        text = text.substring(0, CONFIG.maxMessageLength);
      }

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
      var conversationId = uuid();
      lastConversationId = conversationId;
      lastQuery = text;

      var grounding = searchPages(text, 5);

      sendToBackend(text, grounding, conversationId, function onChunk(partial) {
        updateBubble(streamingEl, partial, false);
      })
        .then(function (result) {
          var reply = (result && result.reply) || "";
          var sources = (result && result.sources) || [];
          var meta = (result && result.meta) || {};
          updateBubble(streamingEl, reply || "(empty response)", true);
          history.push({ role: "assistant", content: reply });

          appendCitations(sources);

          var refs = searchPages(text);
          if (refs.length > 0) {
            appendReferences(refs);
          }

          // Feedback strip on every assistant reply
          appendFeedbackStrip(conversationId);

          // If the backend flagged this as uncovered, offer a one-click
          // "add to backlog" promotion below the reply.
          if (meta.uncovered) {
            appendUncoveredPrompt(conversationId, text);
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

    function updateBubble(wrap, text, finalize) {
      var bubble = wrap.querySelector(".copilot-bubble");
      if (!bubble) return;
      bubble.classList.remove("copilot-typing");
      bubble.innerHTML = md(text);
      var nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
      if (finalize) enhanceCodeBlocks(bubble);
    }

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
        // External flag: the backend marks Microsoft Learn citations
        // with `external: "true"`. Detect that OR a learn.microsoft.com
        // URL (defense in depth) and render a small badge.
        var isExternal =
          (s && (s.external === true || s.external === "true")) ||
          /^https:\/\/learn\.microsoft\.com\//i.test(safeUrl);
        var badge = isExternal
          ? ' <span class="copilot-cite-badge copilot-cite-badge--mslearn" title="Sourced from Microsoft Learn">Microsoft Learn</span>'
          : "";
        if (safeUrl) {
          html += '<li id="copilot-src-' + n + '"><a href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + "</a>" + badge + "</li>";
        } else {
          html += '<li id="copilot-src-' + n + '">' + esc(title) + badge + "</li>";
        }
      });
      html += "</ol>";
      card.innerHTML = html;
      wrap.appendChild(spacer);
      wrap.appendChild(card);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendReferences(results) {
      var wrap = document.createElement("div");
      wrap.className = "copilot-msg copilot-msg-assistant";
      var spacer = document.createElement("div");
      spacer.className = "copilot-avatar";
      var card = document.createElement("div");
      card.className = "copilot-bubble copilot-refs-bubble";
      card.innerHTML = buildReferencesCard(results);
      wrap.appendChild(spacer);
      wrap.appendChild(card);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /* ── Feedback strip (👍 / 👎 + improvement modal) ─────── */
    function appendFeedbackStrip(conversationId) {
      var strip = document.createElement("div");
      strip.className = "copilot-feedback";
      strip.innerHTML =
        '<span class="copilot-feedback-label">Was this helpful?</span>' +
        '<button class="copilot-thumb copilot-thumb-up" title="Yes, this was helpful" aria-label="Mark as helpful">👍</button>' +
        '<button class="copilot-thumb copilot-thumb-down" title="No, this missed the mark" aria-label="Mark as unhelpful">👎</button>';
      messagesEl.appendChild(strip);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      var up = strip.querySelector(".copilot-thumb-up");
      var down = strip.querySelector(".copilot-thumb-down");

      function lock(rating) {
        up.disabled = true;
        down.disabled = true;
        strip.classList.add("copilot-feedback-locked");
        var pill = document.createElement("span");
        pill.className = "copilot-feedback-pill";
        pill.textContent = rating === "up" ? "Thanks for the signal." : "Thanks — we'll dig into this.";
        strip.appendChild(pill);
      }

      up.addEventListener("click", function () {
        submitFeedback(conversationId, "up", "");
        lock("up");
      });

      down.addEventListener("click", function () {
        openImprovementModal(conversationId, function (improvement) {
          submitFeedback(conversationId, "down", improvement);
          lock("down");
        });
      });
    }

    /* ── Uncovered-question prompt ─────────────────────── */
    function appendUncoveredPrompt(conversationId, originalQuery) {
      var prompt = document.createElement("div");
      prompt.className = "copilot-uncovered";
      prompt.innerHTML =
        '<div class="copilot-uncovered-text">Looks like the docs don\'t cover this well yet. Want to add it to the backlog so we can write something up?</div>' +
        '<div class="copilot-uncovered-actions">' +
        '  <button class="copilot-uncovered-add">Add to backlog</button>' +
        '  <button class="copilot-uncovered-skip">Not now</button>' +
        '</div>';
      messagesEl.appendChild(prompt);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      function dismiss(text) {
        prompt.innerHTML = '<div class="copilot-uncovered-thanks">' + esc(text) + '</div>';
      }

      prompt.querySelector(".copilot-uncovered-add").addEventListener("click", function () {
        submitBacklog({
          kind: "uncovered",
          title: originalQuery.substring(0, CONFIG.maxBacklogTitleLength),
          description:
            "Reported via the docs Copilot when it could not give a good answer.\n\n" +
            "Original question:\n\n" + originalQuery,
          conversation_id: conversationId,
        }).then(function () {
          dismiss("✓ Added to the backlog. Thanks!");
        }).catch(function () {
          dismiss("Couldn't reach the backlog endpoint — please report via GitHub Issues instead.");
        });
      });
      prompt.querySelector(".copilot-uncovered-skip").addEventListener("click", function () {
        prompt.remove();
      });
    }

    /* ── Modals (improvement + use-case request) ─────────── */
    function openImprovementModal(conversationId, onSubmit) {
      var modal = createModal({
        title: "What was wrong with that answer?",
        bodyHtml:
          '<p class="copilot-modal-help">Optional, but helps us improve the docs.</p>' +
          '<textarea class="copilot-modal-textarea" maxlength="' + CONFIG.maxImprovementLength + '" placeholder="What was missing, wrong, or unclear?"></textarea>',
        primaryLabel: "Submit",
        primaryHandler: function (modalEl) {
          var ta = modalEl.querySelector(".copilot-modal-textarea");
          var text = (ta.value || "").trim();
          onSubmit(text);
          closeModal(modalEl);
        },
        secondaryLabel: "Skip",
        secondaryHandler: function (modalEl) {
          onSubmit("");
          closeModal(modalEl);
        },
      });
    }

    function openRequestModal() {
      var initialKind = "feature";
      var modal = createModal({
        title: "Request a use case or report an issue",
        bodyHtml:
          '<div class="copilot-modal-tabs" role="tablist">' +
          '  <button class="copilot-modal-tab copilot-modal-tab-active" data-kind="feature">Use case</button>' +
          '  <button class="copilot-modal-tab" data-kind="bug">Bug</button>' +
          '  <button class="copilot-modal-tab" data-kind="uncovered">Doc gap</button>' +
          '</div>' +
          '<input class="copilot-modal-input" placeholder="Title" maxlength="' + CONFIG.maxBacklogTitleLength + '">' +
          '<textarea class="copilot-modal-textarea" maxlength="' + CONFIG.maxBacklogDescriptionLength + '" placeholder="What use case / bug / doc gap should we address?"></textarea>' +
          '<p class="copilot-modal-help">This is filed publicly on GitHub Issues after you submit. Don\'t paste secrets — we redact common patterns server-side, but please double-check.</p>',
        primaryLabel: "Submit",
        primaryHandler: function (modalEl) {
          var titleEl = modalEl.querySelector(".copilot-modal-input");
          var descEl = modalEl.querySelector(".copilot-modal-textarea");
          var title = (titleEl.value || "").trim();
          var description = (descEl.value || "").trim();
          if (!title || !description) {
            titleEl.classList.toggle("copilot-modal-error", !title);
            descEl.classList.toggle("copilot-modal-error", !description);
            return;
          }
          submitBacklog({
            kind: initialKind,
            title: title,
            description: description,
            conversation_id: lastConversationId || undefined,
          }).then(function () {
            closeModal(modalEl);
            var msg = appendMessage("assistant", "✓ Thanks — your submission is on the way. We'll review it on GitHub.");
            msg.classList.add("copilot-system");
          }).catch(function (err) {
            var help = modalEl.querySelector(".copilot-modal-help");
            help.textContent = "Submission failed — " + (err.message || "please try again later.");
            help.classList.add("copilot-modal-error");
          });
        },
        secondaryLabel: "Cancel",
        secondaryHandler: function (modalEl) { closeModal(modalEl); },
      });
      modal.querySelectorAll(".copilot-modal-tab").forEach(function (btn) {
        btn.addEventListener("click", function () {
          modal.querySelectorAll(".copilot-modal-tab").forEach(function (b) {
            b.classList.remove("copilot-modal-tab-active");
          });
          btn.classList.add("copilot-modal-tab-active");
          initialKind = btn.dataset.kind || "feature";
        });
      });
    }

    function createModal(opts) {
      var overlay = document.createElement("div");
      overlay.className = "copilot-modal-overlay";
      var modal = document.createElement("div");
      modal.className = "copilot-modal";
      modal.innerHTML =
        '<div class="copilot-modal-header">' + esc(opts.title) + '</div>' +
        '<div class="copilot-modal-body">' + opts.bodyHtml + '</div>' +
        '<div class="copilot-modal-actions">' +
        '  <button class="copilot-modal-secondary">' + esc(opts.secondaryLabel || "Cancel") + '</button>' +
        '  <button class="copilot-modal-primary">' + esc(opts.primaryLabel || "OK") + '</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      modal.querySelector(".copilot-modal-primary").addEventListener("click", function () {
        opts.primaryHandler(modal);
      });
      modal.querySelector(".copilot-modal-secondary").addEventListener("click", function () {
        if (opts.secondaryHandler) opts.secondaryHandler(modal);
        else closeModal(modal);
      });
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeModal(modal);
      });
      var ta = modal.querySelector(".copilot-modal-textarea");
      if (ta) setTimeout(function () { ta.focus(); }, 50);
      return modal;
    }

    function closeModal(modalEl) {
      var overlay = modalEl.parentElement;
      if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
    }
  }

  /* ── Backend Communication ─────────────────────────── */
  function sendToBackend(message, grounding, conversationId, onChunk) {
    var pageContext = {
      url: window.location.href,
      title: document.title,
      path: window.location.pathname,
    };

    return generateRequestToken().then(function (token) {
      return fetch(CONFIG.apiBase + "/chat", {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify({
          message: message,
          history: history.slice(-CONFIG.maxHistory * 2),
          pageContext: pageContext,
          grounding: (grounding || []).map(function (g) {
            return { title: g.title || "", url: g.pageUrl || "" };
          }),
          session_id: getSessionId(),
          conversation_id: conversationId,
        }),
      });
    }).then(function (resp) {
      if (!resp.ok)
        return resp.json().then(function (e) {
          throw new Error(e.error || "Request failed (" + resp.status + ")");
        });

      var ct = resp.headers.get("content-type") || "";

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

      return resp.json().then(function (data) {
        var reply = data.reply || data.content || "";
        var sources = data.sources || [];
        var meta = data.meta || null;
        if (typeof onChunk === "function" && reply) onChunk(reply);
        return { reply: reply, sources: sources, meta: meta };
      });
    });
  }

  function submitFeedback(conversationId, rating, improvement) {
    if (isOptedOut()) return Promise.resolve();
    return generateRequestToken().then(function (token) {
      return fetch(CONFIG.apiBase + "/feedback", {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify({
          session_id: getSessionId(),
          conversation_id: conversationId,
          rating: rating,
          improvement: improvement || "",
        }),
      });
    }).catch(function () { /* feedback is best-effort */ });
  }

  function submitBacklog(payload) {
    return generateRequestToken().then(function (token) {
      return fetch(CONFIG.apiBase + "/backlog", {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify({
          kind: payload.kind,
          title: (payload.title || "").substring(0, CONFIG.maxBacklogTitleLength),
          description: (payload.description || "").substring(0, CONFIG.maxBacklogDescriptionLength),
          session_id: getSessionId(),
          conversation_id: payload.conversation_id || undefined,
          page_url: window.location.href,
        }),
      }).then(function (resp) {
        if (!resp.ok) return resp.json().then(function (e) {
          throw new Error(e.error || "Submission failed (" + resp.status + ")");
        });
        return resp.json();
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
