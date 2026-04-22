/* CSA-in-a-Box Copilot Chat Widget — Vanilla JS */
(function () {
  "use strict";

  const CONFIG = Object.assign(
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

  /* ── Minimal Markdown renderer ─────────────────────── */
  function md(text) {
    if (!text) return "";
    // Code blocks
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre><code class="language-' + (lang || "") + '">' + esc(code.trim()) + "</code></pre>";
    });
    // Inline code
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // Links
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    // Unordered lists
    text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
    // Paragraphs
    text = text
      .split(/\n{2,}/)
      .map(function (p) {
        p = p.trim();
        if (!p || p.startsWith("<pre") || p.startsWith("<ul") || p.startsWith("<ol")) return p;
        return "<p>" + p + "</p>";
      })
      .join("\n");
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

      sendToBackend(text)
        .then(function (reply) {
          thinkingEl.remove();
          appendMessage("assistant", reply);
          history.push({ role: "assistant", content: reply });
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
