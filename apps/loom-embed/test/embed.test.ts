import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoomEmbedClient, toReportView, EMBED_TOKEN_HEADER, renderReportHtml } from '../src/index.js';
import { defineLoomReport } from '../src/loom-report.js';

/** The governed-metric result the embed endpoint returns. */
const RESULT = {
  metric: 'net_revenue',
  columns: ['region', 'net_revenue'],
  rows: [
    { region: 'West', net_revenue: 4200 },
    { region: 'East', net_revenue: 3100 },
  ],
  rowCount: 2,
  executionMs: 7,
  engine: 'synapse',
  dialect: 'synapse',
  cached: false,
  reportId: 'rep-1',
  ok: true,
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records the call and replies with `body`/`status`. */
function fakeFetch(reply: { status: number; body: unknown }, sink: Recorded[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sink.push({
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('LoomEmbedClient.query', () => {
  it('POSTs to /api/embed/query with the embed token header and returns rows', async () => {
    const calls: Recorded[] = [];
    const client = new LoomEmbedClient({
      baseUrl: 'https://loom.example.com/',
      token: 'loom_embed_abc.def',
      fetch: fakeFetch({ status: 200, body: RESULT }, calls),
    });
    const out = await client.query({ metric: 'net_revenue', dimensions: ['region'] });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://loom.example.com/api/embed/query');
    // The token rides in the dedicated header, never the URL.
    expect(calls[0].headers[EMBED_TOKEN_HEADER]).toBe('loom_embed_abc.def');
    expect(calls[0].body).toMatchObject({ metric: 'net_revenue', dimensions: ['region'] });
    expect(out.rows).toEqual(RESULT.rows);
    expect(out.reportId).toBe('rep-1');
  });

  it('throws with the server message + code on an error envelope', async () => {
    const client = new LoomEmbedClient({
      baseUrl: 'https://loom.example.com',
      token: 'loom_embed_abc.def',
      fetch: fakeFetch({ status: 401, body: { ok: false, error: 'invalid or expired embed token', code: 'embed_unauthorized' } }, []),
    });
    await expect(client.query({ metric: 'net_revenue' })).rejects.toMatchObject({
      status: 401,
      code: 'embed_unauthorized',
    });
  });

  it('requires a metric', async () => {
    const client = new LoomEmbedClient({ baseUrl: 'https://x', token: 't', fetch: fakeFetch({ status: 200, body: RESULT }, []) });
    await expect(client.query({ metric: '  ' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('toReportView + renderReportHtml (pure)', () => {
  it('reshapes records into a column list + row matrix', () => {
    expect(toReportView(RESULT as never)).toEqual({
      columns: ['region', 'net_revenue'],
      rows: [
        ['West', 4200],
        ['East', 3100],
      ],
      rowCount: 2,
    });
  });

  it('renders a real table (numbers right-aligned, values escaped)', () => {
    const html = renderReportHtml(RESULT as never);
    expect(html).toContain('<th>region</th>');
    expect(html).toContain('<td class="">West</td>');
    expect(html).toContain('<td class="num">4200</td>');
    expect(html).not.toContain('<script');
  });
});

describe('<loom-report> web component (mocked fetch)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = fakeFetch({ status: 200, body: RESULT }, []);
    defineLoomReport();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    document.body.innerHTML = '';
  });

  it('registers the custom element', () => {
    expect(customElements.get('loom-report')).toBeTruthy();
  });

  it('fetches through the embed endpoint and renders the returned rows', async () => {
    const el = document.createElement('loom-report');
    el.setAttribute('base-url', 'https://loom.example.com');
    el.setAttribute('token', 'loom_embed_abc.def');
    el.setAttribute('metric', 'net_revenue');
    el.setAttribute('dimensions', 'region');
    document.body.appendChild(el);

    // Wait for the async fetch → render to settle.
    await vi.waitFor(() => {
      const text = (el.shadowRoot?.textContent ?? '');
      expect(text).toContain('West');
      expect(text).toContain('4200');
    });
    const html = el.shadowRoot?.innerHTML ?? '';
    expect(html).toContain('<table>');
    expect(html).toContain('net_revenue');
  });

  it('shows an honest error state when the endpoint rejects', async () => {
    globalThis.fetch = fakeFetch({ status: 503, body: { ok: false, error: 'Embedded analytics is turned off (admin → runtime flags).' } }, []);
    const el = document.createElement('loom-report');
    el.setAttribute('base-url', 'https://loom.example.com');
    el.setAttribute('token', 'loom_embed_abc.def');
    el.setAttribute('metric', 'net_revenue');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent ?? '').toContain('turned off');
    });
    expect(el.shadowRoot?.querySelector('.loom-embed-error')).toBeTruthy();
  });
});
