# Tutorial: Data marketplace editor

> CSA Loom `data-marketplace` — the consumer discovery hub for **Published data
> products**: faceted search, governance-domain cards, and access requests,
> backed by **Azure AI Search**. Part of the unified Loom Marketplace
> (`/marketplace`). **No Microsoft Fabric required.**

## What it is

The Data marketplace is the consumer-facing discovery surface for the tenant's
Published data products. It searches a dedicated Azure AI Search index
(`loom-data-products`) that mirrors every Published data-product item, with
faceted navigation over governance domain, type, owner, glossary terms, and
critical data elements (CDEs).

## When to use it

- You're a data consumer looking for governed, endorsed data products across
  the tenant.
- You're a producer who wants your data product discoverable with an SLA,
  owner, and glossary context.
- You need a durable access-request trail from discovery to real Azure RBAC.

## Step-by-step in Loom

1. **Open the marketplace.** Navigate to **/marketplace** (Data tab) or open
   the **Data marketplace** item from the catalog.
2. **Discover.** Search the live index — wrap a term in double quotes for an
   exact-phrase match. Use the left facet panel to filter by domain, type,
   owner, glossary term, or CDE. Only **Published** products in your tenant
   appear.
3. **Explore by domain.** The **Domains** tab shows a card per governance
   domain with a live product count from the index facet aggregate; click a
   card to filter Discover to that domain.
4. **Publish (producers).** Create a data product (workspace, name, domain,
   type, owner, glossary terms, CDEs, SLA) and set it **Published** to make it
   visible to consumers — Draft and Deprecated products are hidden from
   consumer search.
5. **Request & track access.** Request access from any result; the request is
   recorded durably. The **My data access** tab lists your requests and their
   status — owners grant access in **Governance → Policies** (real Azure RBAC).

## The Azure backend it rides on

- **Search:** a dedicated **Azure AI Search** index (`loom-data-products`) with
  facet aggregates.
- **Access:** durable request records + real Azure RBAC grants on approval.

## No Fabric required

Discovery is Azure AI Search; grants are Azure RBAC. No Fabric, OneLake, or
Power BI dependency.

## Learn more

- Purview data products concept:
  <https://learn.microsoft.com/purview/concept-data-products>
