# "Deploy to Azure" button

> **Not available yet.** A one-click portal "Deploy to Azure" button (with a
> pre-rendered `mainTemplate.json`) is planned but **not shipped** — there is no
> published button to click today.

Use the supported CLI path instead — it's the same underlying Bicep, driven
directly:

- **[Quick Start](quickstart.md)** — `git clone` → `az deployment sub create`
  → post-deploy bootstrap → working Console, in Azure Commercial.
- **[GCC-High deployment](gcc-high.md)** — the same flow for Government
  boundaries.

When the portal button lands, this page will document it. Until then, treat any
reference to a "Deploy to Azure button" or `azd up` for CSA Loom as **not the
supported path** — always deploy via the Quick Start.
