/**
 * `<loom-report>` — a framework-free custom element that renders a governed
 * Loom report (a metric result grid) from an EMBED TOKEN, in ANY host page.
 *
 *   <script type="module" src="/embed/loom-report.js"></script>
 *   <loom-report
 *     base-url="https://csa-loom.limitlessdata.ai"
 *     token="loom_embed_…"
 *     metric="net_revenue"
 *     dimensions="region,order_date"
 *     grain="month">
 *   </loom-report>
 *
 * Data flows through {@link LoomEmbedClient} → `POST /api/embed/query`; the token
 * carries the effective identity, and ROW-LEVEL SECURITY is enforced SERVER-SIDE
 * by the N15 metric compiler (the identity's claims are ANDed into the WHERE).
 * The element renders ONLY real returned rows — loading, error, and empty states
 * are honest, never mock data.
 *
 * Self-contained styles live in the shadow root so the widget can't be styled to
 * leak into or clash with the host page.
 */

import { LoomEmbedClient, toReportView, type EmbedMetricResult, type MetricEngine } from './embed-client.js';

const TAG = 'loom-report';

const STYLE = `
:host { display:block; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:#1b1a19; }
.loom-embed-wrap { border:1px solid #edebe9; border-radius:8px; overflow:hidden; background:#fff; }
.loom-embed-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid #edebe9; }
.loom-embed-title { font-weight:600; font-size:13px; }
.loom-embed-meta { font-size:11px; color:#605e5c; }
.loom-embed-body { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:12px; }
th, td { text-align:left; padding:6px 12px; border-bottom:1px solid #f3f2f1; white-space:nowrap; }
th { position:sticky; top:0; background:#faf9f8; font-weight:600; color:#323130; }
td.num { text-align:right; font-variant-numeric: tabular-nums; }
.loom-embed-state { padding:16px 12px; font-size:12px; color:#605e5c; }
.loom-embed-error { padding:12px; margin:12px; font-size:12px; color:#a4262c; background:#fde7e9; border:1px solid #f3d6d8; border-radius:6px; }
`;

function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function isNumeric(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Build the report table HTML for a result. Pure — shared with the render test. */
export function renderReportHtml(result: EmbedMetricResult): string {
  const view = toReportView(result);
  if (!view.columns.length) {
    return `<div class="loom-embed-state">No columns returned for this metric.</div>`;
  }
  const head = view.columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = view.rows.length
    ? view.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td class="${isNumeric(cell) ? 'num' : ''}">${esc(cell)}</td>`).join('')}</tr>`,
        )
        .join('')
    : `<tr><td class="loom-embed-state" colspan="${view.columns.length}">No rows visible for this identity.</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export class LoomReportElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['base-url', 'token', 'metric', 'dimensions', 'grain', 'engine'];
  }

  private root: ShadowRoot;
  private reqSeq = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    void this.refresh();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) void this.refresh();
  }

  private attr(name: string): string {
    return (this.getAttribute(name) || '').trim();
  }

  private shell(inner: string, meta = ''): void {
    const metric = esc(this.attr('metric') || 'Report');
    this.root.innerHTML =
      `<style>${STYLE}</style>` +
      `<div class="loom-embed-wrap">` +
      `<div class="loom-embed-head"><span class="loom-embed-title">${metric}</span>` +
      `<span class="loom-embed-meta">${meta}</span></div>` +
      `<div class="loom-embed-body">${inner}</div></div>`;
  }

  /** Fetch + render. Real data only; honest loading / error / empty states. */
  async refresh(): Promise<void> {
    const baseUrl = this.attr('base-url');
    const token = this.attr('token');
    const metric = this.attr('metric');
    if (!baseUrl || !token || !metric) {
      this.shell(
        `<div class="loom-embed-state">Set the <code>base-url</code>, <code>token</code>, and <code>metric</code> attributes to render a report.</div>`,
      );
      return;
    }

    const seq = ++this.reqSeq;
    this.shell(`<div class="loom-embed-state">Loading…</div>`);

    const dimensions = this.attr('dimensions')
      ? this.attr('dimensions').split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const grain = this.attr('grain') || undefined;
    const engineAttr = this.attr('engine');
    const engine: MetricEngine | undefined =
      engineAttr === 'synapse' || engineAttr === 'lakehouse' || engineAttr === 'adx' ? engineAttr : undefined;

    try {
      const client = new LoomEmbedClient({ baseUrl, token });
      const result = await client.query({ metric, dimensions, grain, engine });
      if (seq !== this.reqSeq) return; // a newer request superseded this one
      const meta = `${result.rowCount ?? 0} rows · ${result.executionMs ?? 0} ms${result.cached ? ' · cached' : ''}`;
      this.shell(renderReportHtml(result), esc(meta));
    } catch (e: unknown) {
      if (seq !== this.reqSeq) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.shell(`<div class="loom-embed-error">${esc(msg)}</div>`);
    }
  }
}

/**
 * Register `<loom-report>` once. Safe to call repeatedly / in SSR (no-ops when
 * `customElements` is unavailable or the tag is already defined).
 */
export function defineLoomReport(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(TAG)) customElements.define(TAG, LoomReportElement);
}

// Auto-register on import in a browser context (a plain <script type=module>
// drop-in "just works"); harmless under SSR/Node where customElements is absent.
defineLoomReport();
