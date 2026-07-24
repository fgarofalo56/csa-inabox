# @csa-loom/embed

Embedded analytics for **CSA Loom** — drop a governed Loom report into any host
page with a `<loom-report>` web component or a React `<LoomReport>` wrapper,
authenticated by a short-lived, **row-level-security-scoped embed token**.

**Fabric-free by design.** Power BI Embedded now requires a Microsoft Fabric
F-SKU capacity. `@csa-loom/embed` is the Azure-native replacement: there is **no
Power BI host, no F-SKU, and no Fabric workspace** — it works identically on
every cloud, including Government. Built on [`@csa-loom/sdk`](../loom-sdk).

## How it works

```
 host server                       host page (browser)                Loom
 ───────────                       ───────────────────                ────
 POST /api/embed/token   ── mints ──►  embed token (10 min) ─┐
   { reportId, identity:{ sub, rls }}                        │
                                                             ▼
                                     <loom-report token …>  ── POST /api/embed/query
                                                                   (x-loom-embed-token)
                                                                        │
                                        rows filtered by the identity's │ RLS at the
                                        SQL/KQL engine (N15 compiler) ◄─┘ WHERE clause
```

Row-level security is enforced **at query time, in the engine** — the token's
`rls` claims are ANDed into the compiled `WHERE` as bound parameters (Synapse)
or centrally-escaped literals (ADX). Two different token identities read
**different rows from the same report** — never client-side row hiding.

## Web component

```html
<script type="module" src="https://unpkg.com/@csa-loom/embed/dist/loom-report.js"></script>

<loom-report
  base-url="https://csa-loom.limitlessdata.ai"
  token="loom_embed_…"
  metric="net_revenue"
  dimensions="region,order_date"
  grain="month">
</loom-report>
```

## React

```tsx
import { LoomReport } from '@csa-loom/embed/react';

<LoomReport
  baseUrl="https://csa-loom.limitlessdata.ai"
  token={embedToken}          // from POST /api/embed/token
  metric="net_revenue"
  dimensions={['region']}
  grain="month"
/>
```

Or fetch the raw governed result and render it yourself:

```tsx
import { useLoomReport } from '@csa-loom/embed/react';

const { data, error, loading } = useLoomReport({
  baseUrl, token, metric: 'net_revenue', dimensions: ['region'],
});
```

## Minting a token (host server)

```ts
// The host app is authenticated to Loom (a cookie/PAT session it owns) and mints
// a scoped token per end-user. `rls` claims key on governed dimension names.
const res = await fetch(`${LOOM}/api/embed/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: `loom_session=${sessionCookie}` },
  body: JSON.stringify({
    reportId: 'sales-overview',
    identity: { sub: 'acme-tenant', rls: { region: 'West', department: ['Sales', 'Ops'] } },
    ttlSeconds: 600,
  }),
});
const { token } = await res.json();
```

Tokens are HMAC-signed (key derived from the deployment's `SESSION_SECRET`),
single-audience, and TTL-clamped to **[30 s, 60 min]** (default 10 min). An
expired or tampered token is rejected server-side.

## License

MIT.
