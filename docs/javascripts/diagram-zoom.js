/*
 * diagram-zoom.js
 *
 * Adds a fullscreen pan/zoom viewer to Mermaid diagrams rendered by
 * Material for MkDocs. Each .mermaid block is wrapped in a clickable
 * host with an always-visible expand button; clicking either opens a
 * modal that re-renders the Mermaid SVG and wires up svg-pan-zoom
 * (drag-pan, wheel-zoom, toolbar buttons, keyboard shortcuts).
 *
 * Why we can't reuse the inline SVG: Material for MkDocs 9.x renders
 * each Mermaid diagram into a *closed* shadow root on the .mermaid
 * div, which means querySelector("svg") from light DOM returns null.
 * We work around that by recovering the original ``` mermaid source
 * from the cached page HTML and asking mermaid.render() for a fresh
 * SVG to display in the modal.
 *
 * Depends on the global `svgPanZoom` (CDN) and `window.mermaid`
 * (Material lazy-loads mermaid@11 when any pre.mermaid is on a page).
 */
(function () {
  "use strict";

  const ENHANCED_ATTR = "data-diagram-zoom-enhanced";
  const SOURCE_INDEX_ATTR = "data-diagram-zoom-index";
  const MODAL_ID = "diagram-zoom-modal";

  // Per-page cache of Mermaid sources, in document order.
  let pageSources = null;
  let pageSourcesUrl = null;

  function decodeHtmlEntities(str) {
    return str
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  async function loadPageMermaidSources() {
    if (pageSources && pageSourcesUrl === window.location.href) return pageSources;

    // First try the live DOM (works if Material hasn't transformed yet).
    const live = Array.from(document.querySelectorAll("pre.mermaid > code"))
      .map((code) => code.textContent);
    if (live.length) {
      pageSources = live;
      pageSourcesUrl = window.location.href;
      return pageSources;
    }

    // Fallback: re-fetch the current page (browser cache will satisfy this)
    // and pull <pre class="mermaid"><code>...</code></pre> source blocks.
    try {
      const res = await fetch(window.location.href, { cache: "force-cache" });
      const html = await res.text();
      const re = /<pre class="mermaid"><code>([\s\S]*?)<\/code><\/pre>/g;
      const sources = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        sources.push(decodeHtmlEntities(m[1]));
      }
      pageSources = sources;
      pageSourcesUrl = window.location.href;
      return pageSources;
    } catch (e) {
      console.warn("[diagram-zoom] failed to recover mermaid sources", e);
      pageSources = [];
      pageSourcesUrl = window.location.href;
      return pageSources;
    }
  }

  function buildModal() {
    if (document.getElementById(MODAL_ID)) return document.getElementById(MODAL_ID);

    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = "diagram-zoom-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Diagram viewer");
    modal.setAttribute("hidden", "");
    modal.innerHTML = `
      <div class="diagram-zoom-backdrop" data-diagram-zoom-close></div>
      <div class="diagram-zoom-frame">
        <div class="diagram-zoom-toolbar">
          <button type="button" class="diagram-zoom-btn" data-diagram-zoom-action="zoom-in" aria-label="Zoom in" title="Zoom in (+)">+</button>
          <button type="button" class="diagram-zoom-btn" data-diagram-zoom-action="zoom-out" aria-label="Zoom out" title="Zoom out (-)">&minus;</button>
          <button type="button" class="diagram-zoom-btn" data-diagram-zoom-action="reset" aria-label="Reset view" title="Reset (0)">&#x21BA;</button>
          <button type="button" class="diagram-zoom-btn" data-diagram-zoom-action="fit" aria-label="Fit to screen" title="Fit (F)">&#x26F6;</button>
          <span class="diagram-zoom-spacer"></span>
          <button type="button" class="diagram-zoom-btn diagram-zoom-close-btn" data-diagram-zoom-close aria-label="Close (Esc)" title="Close (Esc)">&times;</button>
        </div>
        <div class="diagram-zoom-stage" data-diagram-zoom-stage>
          <div class="diagram-zoom-loading">Rendering diagram&hellip;</div>
        </div>
        <p class="diagram-zoom-hint">Drag to pan &middot; scroll to zoom &middot; Esc to close</p>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  let activeInstance = null;
  let renderSeq = 0;

  function destroyActivePanZoom() {
    if (activeInstance && typeof activeInstance.destroy === "function") {
      try { activeInstance.destroy(); } catch (e) { /* ignore */ }
    }
    activeInstance = null;
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.setAttribute("hidden", "");
    destroyActivePanZoom();
    const stage = modal.querySelector("[data-diagram-zoom-stage]");
    if (stage) stage.innerHTML = '<div class="diagram-zoom-loading">Rendering diagram&hellip;</div>';
    document.body.classList.remove("diagram-zoom-open");
  }

  function initPanZoom(svgEl) {
    if (!window.svgPanZoom) {
      console.warn("[diagram-zoom] svg-pan-zoom not loaded");
      return;
    }
    requestAnimationFrame(() => {
      try {
        activeInstance = window.svgPanZoom(svgEl, {
          zoomEnabled: true,
          controlIconsEnabled: false,
          fit: true,
          center: true,
          minZoom: 0.2,
          maxZoom: 20,
          zoomScaleSensitivity: 0.35,
        });
      } catch (e) {
        console.warn("[diagram-zoom] svgPanZoom init failed", e);
      }
    });
  }

  async function openModalForIndex(index) {
    const modal = buildModal();
    const stage = modal.querySelector("[data-diagram-zoom-stage]");
    stage.innerHTML = '<div class="diagram-zoom-loading">Rendering diagram&hellip;</div>';
    modal.removeAttribute("hidden");
    document.body.classList.add("diagram-zoom-open");

    const sources = await loadPageMermaidSources();
    const source = sources[index];
    if (!source) {
      stage.innerHTML = '<div class="diagram-zoom-loading">Could not recover diagram source.</div>';
      return;
    }
    if (!window.mermaid || typeof window.mermaid.render !== "function") {
      stage.innerHTML = '<div class="diagram-zoom-loading">Mermaid library not loaded.</div>';
      return;
    }

    const id = `diagram-zoom-svg-${++renderSeq}`;
    let svgMarkup;
    try {
      const result = await window.mermaid.render(id, source);
      svgMarkup = result && result.svg;
    } catch (e) {
      console.warn("[diagram-zoom] mermaid.render failed", e);
      stage.innerHTML = '<div class="diagram-zoom-loading">Failed to render diagram.</div>';
      return;
    }
    if (!svgMarkup) {
      stage.innerHTML = '<div class="diagram-zoom-loading">Empty render output.</div>';
      return;
    }

    stage.innerHTML = svgMarkup;
    const svgEl = stage.querySelector("svg");
    if (!svgEl) return;
    svgEl.removeAttribute("style");
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
    svgEl.style.maxWidth = "100%";
    svgEl.style.maxHeight = "100%";
    initPanZoom(svgEl);
  }

  function enhanceMermaidBlock(block) {
    if (block.getAttribute(ENHANCED_ATTR) === "true") return;
    if (block.parentElement && block.parentElement.classList.contains("diagram-zoom-host")) {
      return;
    }
    block.setAttribute(ENHANCED_ATTR, "true");

    // Document-order index so the modal can look up the source.
    const allBlocks = Array.from(document.querySelectorAll(".mermaid"));
    const index = allBlocks.indexOf(block);
    block.setAttribute(SOURCE_INDEX_ATTR, String(index));

    const wrapper = document.createElement("div");
    wrapper.className = "diagram-zoom-host";
    block.parentNode.insertBefore(wrapper, block);
    wrapper.appendChild(block);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "diagram-zoom-trigger";
    btn.setAttribute("aria-label", "Expand diagram");
    btn.title = "Expand diagram (pan / zoom)";
    btn.innerHTML = '<span aria-hidden="true">&#x26F6;</span><span class="diagram-zoom-trigger-label">Expand</span>';
    wrapper.appendChild(btn);

    const open = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openModalForIndex(parseInt(block.getAttribute(SOURCE_INDEX_ATTR) || "0", 10));
    };
    btn.addEventListener("click", open);
    wrapper.addEventListener("click", (ev) => {
      if (ev.target.closest(".diagram-zoom-trigger")) return;
      if (window.getSelection && String(window.getSelection())) return;
      open(ev);
    });
  }

  function scanForMermaid(root) {
    const blocks = (root || document).querySelectorAll(".mermaid");
    blocks.forEach(enhanceMermaidBlock);
  }

  function bindGlobalHandlers() {
    if (window.__diagramZoomBound) return;
    window.__diagramZoomBound = true;

    document.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-diagram-zoom-close]")) {
        closeModal();
        return;
      }
      const actionBtn = target.closest("[data-diagram-zoom-action]");
      if (actionBtn && activeInstance) {
        const action = actionBtn.getAttribute("data-diagram-zoom-action");
        switch (action) {
          case "zoom-in": activeInstance.zoomIn(); break;
          case "zoom-out": activeInstance.zoomOut(); break;
          case "reset": activeInstance.resetZoom(); activeInstance.center(); break;
          case "fit": activeInstance.fit(); activeInstance.center(); break;
        }
      }
    });

    document.addEventListener("keydown", (ev) => {
      const modal = document.getElementById(MODAL_ID);
      if (!modal || modal.hasAttribute("hidden")) return;
      if (ev.key === "Escape") { closeModal(); return; }
      if (!activeInstance) return;
      if (ev.key === "+" || ev.key === "=") { activeInstance.zoomIn(); ev.preventDefault(); }
      else if (ev.key === "-" || ev.key === "_") { activeInstance.zoomOut(); ev.preventDefault(); }
      else if (ev.key === "0") { activeInstance.resetZoom(); activeInstance.center(); ev.preventDefault(); }
      else if (ev.key === "f" || ev.key === "F") { activeInstance.fit(); activeInstance.center(); ev.preventDefault(); }
    });
  }

  function setup() {
    pageSources = null;
    pageSourcesUrl = null;
    bindGlobalHandlers();
    scanForMermaid(document);

    // Material renders mermaid into a closed shadow root and removes the
    // original <pre>, so we can't watch for inner SVG. Instead, watch for
    // new .mermaid divs being inserted (instant nav, dynamic content).
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (!m.addedNodes || m.addedNodes.length === 0) continue;
        m.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches && node.matches(".mermaid")) {
            enhanceMermaidBlock(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll(".mermaid").forEach(enhanceMermaidBlock);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(() => setup());
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
