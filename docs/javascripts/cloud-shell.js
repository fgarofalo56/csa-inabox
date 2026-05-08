/* Cloud Shell + Deploy-to-Azure helpers for the docs site.
 *
 * Two patterns supported:
 *
 * 1. **Try in Cloud Shell** — adds a button to any ``<pre>`` whose
 *    ``data-cloudshell`` attribute is present (or whose language hint
 *    is ``bash`` / ``shell`` / ``azurecli`` / ``pwsh``). Clicking
 *    copies the snippet to the clipboard, opens
 *    ``https://shell.azure.com`` in a new tab, and surfaces a toast
 *    that tells the user to paste with Ctrl+Shift+V.
 *
 *    Why not pre-fill the command via URL parameter? Microsoft
 *    explicitly does not support pre-filled commands in the Cloud
 *    Shell launch URL — the only documented access points are the
 *    portal, shell.azure.com, the Azure mobile app, and the VS Code
 *    extension. No URL parameter accepts a command. (See
 *    https://learn.microsoft.com/azure/cloud-shell/overview)
 *
 * 2. **Deploy to Azure** — anchor tags rendered by mkdocs that point
 *    at ``https://portal.azure.com/#create/Microsoft.Template/uri/<encoded-raw-json>``
 *    are decorated with the standard Microsoft button image. The ARM
 *    JSON template must be public-readable (GitHub raw URL works).
 *    See https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-to-azure-button
 *
 * Privacy: this script honors the same opt-out flag the chat widget
 * uses — clicking the button still works, but the click event is not
 * tracked.
 */
(function () {
  "use strict";

  var SHELL_URL = "https://shell.azure.com/";

  var TRY_LABEL = "💻 Try in Cloud Shell";
  var COPYING_LABEL = "📋 Copied — paste in Cloud Shell";

  function findRunnableBlocks() {
    // Code blocks with explicit opt-in via data-cloudshell="" attribute
    // OR language hints that imply a runnable shell snippet.
    var hits = [];
    document.querySelectorAll("pre[data-cloudshell]").forEach(function (el) { hits.push(el); });
    document.querySelectorAll("pre[data-lang='bash'], pre[data-lang='shell'], pre[data-lang='sh'], pre[data-lang='azurecli'], pre[data-lang='powershell'], pre[data-lang='pwsh']").forEach(function (el) {
      // Don't double-count if already opted in
      if (!el.hasAttribute("data-cloudshell")) hits.push(el);
    });
    // mkdocs-material's pymdownx.highlight emits <code class="language-bash">...
    document.querySelectorAll("pre code.language-bash, pre code.language-shell, pre code.language-azurecli, pre code.language-powershell, pre code.language-pwsh").forEach(function (codeEl) {
      var pre = codeEl.parentElement;
      if (pre && pre.tagName === "PRE" && hits.indexOf(pre) === -1) {
        hits.push(pre);
      }
    });
    return hits;
  }

  function injectButton(pre) {
    if (pre.dataset.cloudshellWired === "1") return;
    pre.dataset.cloudshellWired = "1";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cloud-shell-btn";
    btn.title = "Copy this snippet and open Azure Cloud Shell in a new tab";
    btn.textContent = TRY_LABEL;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var code = pre.querySelector("code");
      var text = code ? code.textContent : pre.textContent;
      copyToClipboard(text);
      btn.textContent = COPYING_LABEL;
      btn.classList.add("cloud-shell-btn-copied");
      window.open(SHELL_URL, "_blank", "noopener,noreferrer");
      showToast("Snippet copied. Paste in Cloud Shell with Ctrl+Shift+V (Linux/Win) or ⌘+V (Mac).");
      setTimeout(function () {
        btn.textContent = TRY_LABEL;
        btn.classList.remove("cloud-shell-btn-copied");
      }, 4000);
    });
    pre.appendChild(btn);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text);
        return;
      } catch (_) { /* fall through */ }
    }
    // Fallback for browsers without async clipboard API
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) { /* noop */ }
    document.body.removeChild(ta);
  }

  function showToast(message) {
    var existing = document.querySelector(".cloud-shell-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "cloud-shell-toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("cloud-shell-toast-show"); });
    setTimeout(function () {
      toast.classList.remove("cloud-shell-toast-show");
      setTimeout(function () { toast.remove(); }, 250);
    }, 4500);
  }

  function decorateDeployButtons() {
    // Anchor tags that already point at portal.azure.com/#create/Microsoft.Template/uri/ —
    // wrap them in the standard "Deploy to Azure" image.
    var anchors = document.querySelectorAll('a[href*="portal.azure.com/#create/Microsoft.Template/uri/"]');
    anchors.forEach(function (a) {
      if (a.dataset.deployWired === "1") return;
      a.dataset.deployWired = "1";
      // If the anchor already has an img inside, skip — author rendered
      // the standard image themselves.
      if (a.querySelector("img")) return;
      a.classList.add("deploy-to-azure-link");
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  }

  function init() {
    findRunnableBlocks().forEach(injectButton);
    decorateDeployButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // mkdocs-material instant-loading swaps page content via XHR. Re-run
  // when navigation happens.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    try { window.document$.subscribe(init); } catch (_) { /* not a Material site */ }
  }
})();
