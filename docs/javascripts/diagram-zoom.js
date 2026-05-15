/*
 * diagram-zoom.js
 *
 * Adds a fullscreen pan/zoom viewer to Mermaid diagrams rendered by
 * Material for MkDocs. Each .mermaid block gets an "expand" button that
 * opens a modal with svg-pan-zoom controls (pan via drag, zoom via wheel
 * or buttons, fit/reset). ESC or clicking the backdrop closes the modal.
 *
 * Depends on the global `svgPanZoom` loaded from CDN via extra_javascript.
 */
(function () {
  "use strict";

  const ENHANCED_ATTR = "data-diagram-zoom-enhanced";
  const MODAL_ID = "diagram-zoom-modal";

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
        <div class="diagram-zoom-stage" data-diagram-zoom-stage></div>
        <p class="diagram-zoom-hint">Drag to pan &middot; scroll to zoom &middot; Esc to close</p>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  let activeInstance = null;

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.setAttribute("hidden", "");
    const stage = modal.querySelector("[data-diagram-zoom-stage]");
    if (stage) stage.innerHTML = "";
    if (activeInstance && typeof activeInstance.destroy === "function") {
      try { activeInstance.destroy(); } catch (e) { /* ignore */ }
    }
    activeInstance = null;
    document.body.classList.remove("diagram-zoom-open");
  }

  function openModal(sourceSvg) {
    if (!window.svgPanZoom) {
      console.warn("[diagram-zoom] svg-pan-zoom not loaded");
      return;
    }
    const modal = buildModal();
    const stage = modal.querySelector("[data-diagram-zoom-stage]");
    stage.innerHTML = "";

    const clone = sourceSvg.cloneNode(true);
    // svg-pan-zoom needs explicit width/height on the SVG element.
    clone.removeAttribute("style");
    clone.setAttribute("width", "100%");
    clone.setAttribute("height", "100%");
    clone.style.maxWidth = "100%";
    clone.style.maxHeight = "100%";
    stage.appendChild(clone);

    modal.removeAttribute("hidden");
    document.body.classList.add("diagram-zoom-open");

    // Initialize after the modal is visible so dimensions are correct.
    requestAnimationFrame(() => {
      try {
        activeInstance = window.svgPanZoom(clone, {
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

  function enhanceMermaidBlock(block) {
    if (block.getAttribute(ENHANCED_ATTR) === "true") return;
    const svg = block.querySelector("svg");
    if (!svg) return; // not rendered yet

    block.setAttribute(ENHANCED_ATTR, "true");
    block.classList.add("diagram-zoom-host");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "diagram-zoom-trigger";
    btn.setAttribute("aria-label", "Expand diagram");
    btn.title = "Expand diagram (pan/zoom)";
    btn.innerHTML = "&#x26F6;";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openModal(svg);
    });
    block.appendChild(btn);
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
    bindGlobalHandlers();
    scanForMermaid(document);

    // Mermaid renders asynchronously; observe added <svg> children inside
    // .mermaid blocks so we enhance them as soon as they appear.
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
          // Re-check existing .mermaid blocks; their inner svg may have just rendered.
          if (node.tagName === "svg" || (node.querySelector && node.querySelector("svg"))) {
            scanForMermaid(document);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Material for MkDocs ships RxJS subjects on window; document$ fires on
  // every instant-navigation page render. Fall back to DOMContentLoaded.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(() => setup());
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
