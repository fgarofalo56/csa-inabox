// @vitest-environment jsdom
/**
 * Regression test for issue #2669 / CodeQL alert #320 —
 * `js/xss-through-dom` in `docs/javascripts/diagram-zoom.js`.
 *
 * WHAT WAS WRONG. The diagram zoom viewer recovered a diagram's ``` mermaid
 * source from the page (`code.textContent`, diagram-zoom.js:45), asked Mermaid
 * to compile it, and then assigned the returned SVG **string** straight to
 * `stage.innerHTML`. That is DOM text being reinterpreted as markup: the file
 * had no way to know what was in that string and parsed it sight-unseen.
 *
 * WHAT CHANGED. The file now hands the source to Mermaid as *text*
 * (`host.textContent = source`) and calls `mermaid.run({ nodes: [host] })`, so
 * Mermaid does its own injection. Our code never parses a derived string, and
 * the trust boundary collapses onto the one the page already accepts — the
 * same Mermaid pipeline that renders the inline diagram.
 *
 * WHY THE TEST LIVES HERE. `docs/javascripts` has no test harness of its own;
 * this is the JS suite wired into CI, so the spec reaches up to the real
 * production file rather than a copy of it.
 *
 * WHY THE MERMAID STUB IS SHAPED THE WAY IT IS. The two Mermaid APIs differ in
 * exactly one security-relevant way, and the stub models that difference
 * instead of inventing one:
 *
 *   - `render(id, text)` RETURNS AN HTML STRING. The caller must decide what to
 *     do with it, and the only safe answer is "do not parse it". The stub
 *     returns a string carrying active content so the test can detect a caller
 *     that parses it anyway. (Real Mermaid at `securityLevel: 'strict'` would
 *     not emit this — the point is that diagram-zoom.js cannot verify that.)
 *
 *   - `run({ nodes })` RETURNS NOTHING. The stub reproduces the real control
 *     flow from mermaid's `runThrowsErrors` — read `element.innerHTML`,
 *     entity-decode it, compile, then write the result back — and emits the
 *     label as character data the way strict mode does.
 *
 * The asymmetry is inherent to the two APIs, not stacked in the fix's favour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCRIPT_PATH = path.resolve(__dirname, '../../../docs/javascripts/diagram-zoom.js');
const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** SVG string a caller of `render()` cannot vet before parsing it. */
const HOSTILE_SVG =
  `<svg xmlns="${SVG_NS}" data-origin="render">` +
  '<script>window.__diagramZoomPwned = true;<\/script>' +
  `<foreignObject><div xmlns="${XHTML_NS}">` +
  '<img src="x" onerror="window.__diagramZoomPwned = true">' +
  '</div></foreignObject></svg>';

/** Mermaid decodes the host's serialised text before compiling it. */
function decodeEntities(markup: string): string {
  const ta = document.createElement('textarea');
  ta.innerHTML = markup;
  return ta.value;
}

interface Harness {
  sourcesSeenByMermaid: string[];
  panZoom: ReturnType<typeof vi.fn>;
}

function installMermaid(h: Harness) {
  (window as unknown as Record<string, unknown>).mermaid = {
    render: vi.fn(async (_id: string, text: string) => {
      h.sourcesSeenByMermaid.push(text);
      return { svg: HOSTILE_SVG };
    }),
    run: vi.fn(async ({ nodes }: { nodes: ArrayLike<HTMLElement> }) => {
      for (const el of Array.from(nodes)) {
        const decoded = decodeEntities(el.innerHTML);
        h.sourcesSeenByMermaid.push(decoded);
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('data-origin', 'run');
        const fo = document.createElementNS(SVG_NS, 'foreignObject');
        const label = document.createElementNS(XHTML_NS, 'div');
        label.textContent = decoded; // strict mode emits labels as character data
        fo.appendChild(label);
        svg.appendChild(fo);
        el.replaceChildren(svg);
      }
    }),
  };
}

/** Runs the real production IIFE against the jsdom globals. */
function loadDiagramZoomScript() {
  // The file ships as a plain browser IIFE, not a module, so it is evaluated
  // rather than imported — this asserts against the shipped artefact itself.
  new Function(readFileSync(SCRIPT_PATH, 'utf8'))();
}

function seedPage(mermaidSource: string) {
  const pre = document.createElement('pre');
  pre.className = 'mermaid';
  const code = document.createElement('code');
  code.textContent = mermaidSource; // MkDocs emits the source as escaped text
  pre.appendChild(code);
  document.body.appendChild(pre);
}

const stageEl = () => document.querySelector('[data-diagram-zoom-stage]');

async function openViewer() {
  const trigger = document.querySelector<HTMLButtonElement>('.diagram-zoom-trigger');
  expect(trigger, 'expand trigger should have been added to the diagram').not.toBeNull();
  trigger!.click();
  // The click handler is async...
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const stage = stageEl();
    if (stage && !stage.querySelector('.diagram-zoom-loading')) break;
  }
  // ...and initPanZoom defers through requestAnimationFrame, which jsdom runs
  // on a ~16ms timer, so let that flush before asserting.
  await new Promise((r) => setTimeout(r, 50));
}

/**
 * Every element under `root` carrying an inline event-handler attribute.
 * Indexes the NamedNodeMap via `item()` — spreading it is unreliable for
 * SVG-namespaced elements under jsdom.
 */
function elementsWithEventHandlers(root: Element): string[] {
  const found: string[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs.item(i);
      if (attr && /^on/i.test(attr.name)) {
        found.push(`${el.nodeName.toLowerCase()}[${attr.name}]`);
      }
    }
  }
  return found;
}

describe('docs/javascripts/diagram-zoom.js — page text must not become markup (#2669)', () => {
  let harness: Harness;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.getElementById('diagram-zoom-modal')?.remove();
    document.body.className = '';
    const w = window as unknown as Record<string, unknown>;
    delete w.__diagramZoomPwned;
    w.__diagramZoomBound = false;
    harness = { sourcesSeenByMermaid: [], panZoom: vi.fn(() => ({ destroy: vi.fn() })) };
    w.svgPanZoom = harness.panZoom;
    installMermaid(harness);
  });

  afterEach(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.mermaid;
    delete w.svgPanZoom;
  });

  it('never parses the diagram source into elements (RED before the fix)', async () => {
    // A diagram label that is also a live XSS payload.
    seedPage('graph TD\n  A["<img src=x onerror=alert(1)>"]');
    loadDiagramZoomScript();
    await openViewer();

    const stage = stageEl();
    expect(stage).not.toBeNull();

    // The payload must remain character data: no elements, no handlers.
    // Assert on counts, not element arrays — vitest's DOM pretty-printer
    // cannot serialise jsdom's SVG-namespaced nodes and would mask the
    // real assertion behind a TypeError.
    expect(stage!.querySelectorAll('script').length, 'script elements in stage').toBe(0);
    expect(stage!.querySelectorAll('img').length, 'img elements in stage').toBe(0);
    expect(elementsWithEventHandlers(stage!)).toEqual([]);
    expect((window as unknown as Record<string, unknown>).__diagramZoomPwned).toBeUndefined();
  });

  it('CONTROL: still renders a diagram and wires pan/zoom (green before AND after)', async () => {
    seedPage('graph TD\n  A-->B');
    loadDiagramZoomScript();
    await openViewer();

    // An over-broad "fix" that renders nothing, or drops svg-pan-zoom, fails here.
    expect(stageEl()!.querySelector('svg')).not.toBeNull();
    expect(harness.panZoom).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: hands the diagram source to Mermaid intact (green before AND after)', async () => {
    seedPage('graph TD\n  A["<img src=x onerror=alert(1)>"]');
    loadDiagramZoomScript();
    await openViewer();

    // Escaping the *source* would break every flowchart arrow, so the text
    // Mermaid receives must be byte-for-byte what the page authored.
    expect(harness.sourcesSeenByMermaid).toHaveLength(1);
    expect(harness.sourcesSeenByMermaid[0]).toContain('<img src=x onerror=alert(1)>');
  });

  it('CONTROL: shows the honest gate when Mermaid is absent (green before AND after)', async () => {
    delete (window as unknown as Record<string, unknown>).mermaid;
    seedPage('graph TD\n  A-->B');
    loadDiagramZoomScript();
    await openViewer();

    expect(stageEl()!.textContent).toContain('Mermaid library not loaded.');
  });

  it('assigns innerHTML only from constant literals (class guard, RED before the fix)', () => {
    const code = readFileSync(SCRIPT_PATH, 'utf8');

    // Every innerHTML/outerHTML write must start with a quote or backtick — a
    // bare identifier or call means a computed value is being parsed as HTML.
    const dynamic = Array.from(code.matchAll(/\.(?:innerHTML|outerHTML)\s*=\s*(.)/g))
      .filter((m) => !/['"`]/.test(m[1]))
      .map((m) => code.slice(m.index ?? 0, (m.index ?? 0) + 60).split('\n')[0]);
    expect(dynamic).toEqual([]);

    // ...and a literal must not be a template with an interpolation hole.
    expect(code).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=\s*`[^`]*\$\{/);

    // No other HTML-parsing sink may creep back in.
    for (const sink of ['insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment']) {
      expect(code, `${sink} re-introduces an HTML parsing sink`).not.toContain(sink);
    }
  });
});
