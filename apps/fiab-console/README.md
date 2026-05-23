# Loom Console

The CSA Loom Console — Next.js 14 + Fluent UI v9 + MSAL BFF
application that gives federal customers the Microsoft Fabric
workspace experience.

**Public brand**: Loom Console (this directory uses `fiab-console`
as the repo-internal nickname per AMENDMENTS A1).

## Status

**SCAFFOLDED.** Real implementation per [PRP-03](../../PRPs/active/csa-loom/PRP-03-loom-console.md).
v1 ships 12 panes; v1.1 adds 4 more.

## Tech stack

- Next.js 14 (App Router) — server components + client components
- Fluent UI v9 — same library Microsoft Fabric uses
- MSAL BFF auth (cookies + refresh server-side; OBO for downstream)
- React Query for server state; Zustand for ephemeral UI
- pnpm workspace
- Multi-stage Dockerfile; ACR-hosted
- Container Apps (Commercial / GCC) or AKS Helm chart (GCC-High / IL5)
- Playwright E2E + Vitest unit + axe-core accessibility

## Scaffolded structure

```
apps/fiab-console/
├── README.md
├── package.json
├── next.config.js
├── Dockerfile
├── tsconfig.json
├── app/                    # App Router pages
│   ├── layout.tsx          # Fluent UI shell
│   ├── (auth)/
│   ├── workspaces/
│   ├── catalog/
│   ├── notebooks/
│   ├── warehouse/
│   ├── kql/
│   ├── activator/
│   ├── agents/
│   ├── monitoring/
│   ├── admin/
│   ├── setup/              # Setup Wizard route
│   └── copilot/
├── lib/
│   ├── auth/               # MSAL BFF
│   ├── clients/            # Azure REST clients
│   └── components/         # Shared Fluent UI components
├── tests/
│   ├── e2e/                # Playwright
│   └── unit/               # Vitest
└── helm/                   # AKS Helm chart (Gov)
```

## v1 panes

| # | Pane | Path |
|---|---|---|
| 1 | Workspaces browser | `/workspaces` |
| 2 | Workspace home | `/workspaces/[id]` |
| 3 | Lakehouse | `/workspaces/[id]/lakehouse/[name]` |
| 4 | Warehouse | `/workspaces/[id]/warehouse` |
| 5 | Notebook | `/workspaces/[id]/notebook/[id]` (Databricks iframe) |
| 6 | KQL | `/workspaces/[id]/kql/[db]` |
| 7 | Catalog | `/catalog` |
| 8 | Activator | `/workspaces/[id]/activator/[id]` |
| 9 | Data Agents | `/workspaces/[id]/agent/[id]` |
| 10 | Monitoring | `/monitoring` |
| 11 | Admin | `/admin` |
| 12 | Setup Wizard | `/setup` |

## Build + run

Once implemented:

```bash
cd apps/fiab-console
pnpm install
pnpm dev   # http://localhost:3000
```

Container image:
```bash
docker build -t fiab-console .
docker run -p 3000:3000 fiab-console
```

Deploy via `azd up` from `platform/fiab/azd/`.

## Related

- [Loom Console docs](../../docs/fiab/console/index.md)
- [PRP-03](../../PRPs/active/csa-loom/PRP-03-loom-console.md)
- ADR: [fiab-0007 Console framework](../../docs/fiab/adr/0007-console-framework.md)
