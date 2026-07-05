# Data disclosure — what leaves your tenant

CSA Loom is designed to run entirely inside **your** Azure tenant. Its data
plane (lakehouses, warehouses, Cosmos metadata, Synapse, ADX, Databricks,
Purview, AI Foundry) never leaves your subscription. This page documents the
**only** outbound flow to a service the product maintainers operate, exactly
what it contains, and how to turn it off.

!!! info "TL;DR"
    The single optional outbound flow is the **in-product feedback / error
    reporter**. It forwards **redacted** bug reports, feature requests, and
    auto-captured crash reports to the CSA Loom project's public GitHub issue
    tracker. It is **off unless a maintainer token is configured**, it carries
    **no PII, no GUIDs, no data values**, and a tenant admin can disable
    auto-error forwarding entirely from **Admin → Tenant settings**.

## The one outbound flow: feedback & error reporting

| | |
| --- | --- |
| **What** | Bug reports, feature requests (user-initiated), and auto-captured application errors (fired by the client error boundary). |
| **Where it goes** | The CSA Loom project's GitHub issue tracker (`fgarofalo56/csa-inabox` by default; overridable via `LOOM_FEEDBACK_REPO_OWNER` / `LOOM_FEEDBACK_REPO_NAME`). |
| **Transport** | HTTPS to `api.github.com`, server-side from the Console. Browsers never call GitHub directly. |
| **When it is active** | **Only** when `LOOM_FEEDBACK_GITHUB_TOKEN` is set on the Console app. If unset, reports are accepted and logged locally and **nothing is forwarded** — this is the correct posture for air-gapped / sovereign deployments. |
| **Code of record** | `apps/fiab-console/app/api/feedback/route.ts` and the redaction rules in `apps/fiab-console/lib/feedback/redaction.ts`. |

### Exactly what is sent

Each forwarded item becomes a GitHub issue containing **only**:

- A **kind** tag: `bug`, `feature`, or `auto-error`.
- A **title** and **description** (bug / feature) or an **error class + message**
  (auto-error) — each passed through the redactor below.
- A **stack trace** trimmed to frames **inside Loom application code only**
  (`/lib` and `/app` frames), then redacted, capped at 12 frames.
- **Coarse environment**: the **route path only** (no host, no query string),
  the **browser + OS family** (user-agent up to the first `)` — no full UA), and
  the running **Loom version**.
- A **one-way hash of your tenant id** (SHA-256, first 8 characters). This lets a
  maintainer group reports from the same deployment **without** learning which
  tenant you are — it cannot be reversed to your tenant id.
- For auto-errors, a short **fingerprint** (hash of error name + message + route)
  used to de-duplicate crash loops.

### What is redacted before anything is sent

Redaction runs **server-side** (re-applied even to an already-scrubbed client
payload — defense in depth). The following are replaced with a
`[REDACTED:<kind>]` placeholder wherever they appear in a title, description, or
stack frame:

- **Email addresses**, **phone numbers**, **credit-card-like** number runs.
- **IPv4 and IPv6 addresses**.
- **Any GUID** — workspace ids, item ids, object ids, subscription ids — so
  customer topology cannot leak.
- **Tenant-specific hostnames** — `loom-*` Container Apps hosts,
  `*.fabric.microsoft.com`, `*.dfs.core.windows.net`, `*.blob.core.windows.net`,
  `*.azurecontainerapps.io`.
- **Long hex / base64 tokens** (32+ chars) — a defensive catch for anything
  secret-shaped.

### What is **never** sent

- The signed-in user's **name, email, UPN, or object id** (identity is used
  only, server-side, to rate-limit reports; it is never included in the issue
  and never logged).
- **Workspace / item / resource identifiers** (removed by the GUID and
  tenant-host rules).
- **Any data values** — no table rows, no query results, no file contents, no
  BFF response bodies. Only an error class and Loom-internal stack frame paths.

### Abuse controls (not privacy, but relevant)

- **Bug / feature** reports require an authenticated session and are rate-limited
  per user.
- **Auto-errors** are anonymous (the boundary fires before the user can act) but
  are hard-throttled per IP (5/hour) and de-duplicated for 24h so a render loop
  cannot spam the tracker.

## How to disable it

You have three independent controls, from broadest to narrowest:

1. **Never configure the token (air-gapped default).** Leave
   `LOOM_FEEDBACK_GITHUB_TOKEN` unset. The endpoint then forwards **nothing** —
   reports are logged locally only. This is the recommended posture for GCC-High
   / IL5 / DoD and any tenant with an outbound-egress policy.

2. **Disable auto-error forwarding (tenant admin, in-product).** Go to
   **Admin → Tenant settings → Feedback & error forwarding** and turn **off**
   *Forward auto-captured errors*. This persists a deployment-wide setting to
   Cosmos; the feedback route reads it and accepts auto-errors locally without
   forwarding. User-initiated bug/feature reports — a deliberate, consented
   action — continue to send. The switch is backed by
   `/api/admin/feedback-forwarding` and audited on every change.

3. **Hide the widget entirely.** Turn off **Help & support → Send-feedback
   widget** in the same Tenant settings page to remove the in-app entry point.

## Everything else stays in your tenant

For completeness, the product also makes outbound calls that are **not** data
egress about you:

- **`api.github.com` releases** — the updater checks the public
  `csa-inabox` releases list to tell you when a new version exists
  (`/api/version`). This is a public read; **your tenant identity is not sent**.
- **Public image pulls (`ghcr.io`)** — the optional in-product self-update
  path pulls **public** container images. See
  [In-product update path](in-product-update-path.md).

Both are outbound reads to public endpoints and carry no tenant data.

## Sovereign / air-gapped guidance

For GCC-High, IL5, DoD, or any tenant with a strict egress policy: leave
`LOOM_FEEDBACK_GITHUB_TOKEN` unset (control #1). With no token, the feedback
route forwards nothing and the version check is the only outbound call — and that
is a public, identity-free read you can also block at the firewall without
affecting the product's data plane.
