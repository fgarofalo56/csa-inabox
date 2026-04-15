# React Web App — Data Onboarding Portal

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Frontend Developers

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Pages](#pages)
- [Components](#components)
- [Deployment](#deployment)
- [Azure Government](#azure-government)
- [Development](#development)
- [Related Documentation](#related-documentation)

A full-featured React/Next.js web application for data source registration,
pipeline management, and data marketplace discovery. This is the most
customizable portal implementation in CSA-in-a-Box.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (Next.js)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Register │ │ Pipeline │ │  Market- │ │    Access     │   │
│  │  Source   │ │ Monitor  │ │  place   │ │  Requests    │   │
│  └─────┬────┘ └─────┬────┘ └─────┬────┘ └──────┬───────┘   │
│        └──────────┬──┴──────────┬─┘             │           │
│              ┌────┴─────────────┴───────────────┘           │
│              │     Shared API Client (axios/fetch)           │
│              └──────────────┬────────────────────            │
└─────────────────────────────┼───────────────────────────────┘
                              │ REST API
┌─────────────────────────────┼───────────────────────────────┐
│               Shared Backend (FastAPI)                       │
│  portal/shared/api/                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Sources  │ │Pipelines │ │Marketplace│ │   Access     │   │
│  │  Routes  │ │  Routes  │ │  Routes   │ │  Routes      │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | Next.js 14 (App Router) | SSR, file-based routing, API routes |
| UI | Tailwind CSS + Radix UI | Utility-first CSS, accessible components |
| Auth | MSAL.js (@azure/msal-react) | Azure AD / Entra ID integration |
| State | React Query (TanStack) | Server state, caching, optimistic updates |
| Forms | React Hook Form + Zod | Type-safe forms with validation |
| HTTP | Axios | HTTP client with interceptors |
| Charts | Recharts | Dashboard visualizations |

## Quick Start

```bash
# Install dependencies
cd portal/react-webapp
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Azure AD and API settings

# Start development server
npm run dev

# Open http://localhost:3000
```

## Environment Variables

```bash
# Azure AD / Entra ID
NEXT_PUBLIC_AZURE_AD_CLIENT_ID=your-client-id
NEXT_PUBLIC_AZURE_AD_TENANT_ID=your-tenant-id
NEXT_PUBLIC_AZURE_AD_REDIRECT_URI=http://localhost:3000

# API Backend
NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1

# Feature Flags
NEXT_PUBLIC_ENABLE_MARKETPLACE=true
NEXT_PUBLIC_ENABLE_ACCESS_REQUESTS=true
NEXT_PUBLIC_ENABLE_PIPELINE_MONITORING=true
```

## Pages

| Route | Page | Description |
|---|---|---|
| `/` | Dashboard | Platform overview with key metrics |
| `/sources` | Source Registry | List and manage registered data sources |
| `/sources/register` | Register Source | Multi-step form for new source onboarding |
| `/sources/[id]` | Source Detail | Source configuration, schema, pipeline status |
| `/pipelines` | Pipeline Monitor | Active pipeline runs and history |
| `/marketplace` | Data Marketplace | Browse and search data products |
| `/marketplace/[id]` | Product Detail | Data product details, quality, access |
| `/access` | Access Requests | Submit and track data access requests |
| `/settings` | Settings | User preferences, API keys, notifications |

## Components

### Source Registration Flow

The source registration form is a multi-step wizard:

1. **Source Type** — Select the data source type (SQL, API, file, etc.)
2. **Connection** — Configure connection details (host, port, credentials)
3. **Schema** — Preview and select tables/fields to ingest
4. **Ingestion** — Configure schedule, mode (batch/incremental/CDC)
5. **Quality** — Define data quality rules and thresholds
6. **Review** — Confirm and submit for provisioning

### Data Marketplace

The marketplace provides:
- Full-text search across data product names and descriptions
- Filter by domain, quality score, classification level
- Quality badges (freshness, completeness, accuracy)
- One-click access request with approval workflow
- Data preview (sample rows with PII masking)

## Deployment

### Azure App Service

```bash
# Build production bundle
npm run build

# Deploy via Azure CLI
az webapp up \
  --name csa-portal \
  --resource-group rg-csa-portal \
  --runtime "NODE:18-lts" \
  --sku B1
```

### Azure Container Apps

```bash
# Build container
docker build -t csa-portal:latest .

# Deploy to Container Apps
az containerapp create \
  --name csa-portal \
  --resource-group rg-csa-portal \
  --environment csa-env \
  --image csa-portal:latest \
  --target-port 3000 \
  --ingress external
```

### Azure Static Web Apps

For static export (no SSR):

```bash
npm run build:static
# Deploy via SWA CLI
npx @azure/static-web-apps-cli deploy \
  --app-location out \
  --api-location portal/shared/api
```

## Azure Government

This portal works in Azure Government with these changes:

- Set `NEXT_PUBLIC_AZURE_AD_TENANT_ID` to your Gov tenant
- Use `login.microsoftonline.us` as the authority in MSAL config
- Point `NEXT_PUBLIC_API_URL` to your Gov-hosted backend
- All Entra ID endpoints use `.us` suffix

## Development

```bash
# Run tests
npm test

# Run linter
npm run lint

# Type check
npm run type-check

# Storybook (component development)
npm run storybook
```

---

## Related Documentation

- [Portal Implementations](../README.md) — Portal implementation index
- [Shared Backend](../shared/README.md) — Shared backend API
- [Architecture](../../docs/ARCHITECTURE.md) — Overall system architecture
