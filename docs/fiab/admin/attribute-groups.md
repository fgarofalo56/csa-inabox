# Custom attributes (attribute groups) admin page

> **Surface:** `/admin/attribute-groups`
> **Store:** Cosmos `attribute-groups` (PK `/tenantId`)

The **Custom attributes** page defines per-domain attribute schemas — typed
fields (text, number, date, single-select) that then appear in the Create wizard
and item Edit dialogs. It's how an organization extends Loom's item metadata with
its own governance vocabulary without a code change.

## What you can do

- **Define attribute groups** — a named set of typed fields scoped to a
  governance domain.
- **Choose field types** — text, number, date, or single-select (with an
  enumerated option list) per attribute.
- **Surface them everywhere** — defined attributes render in the item Create
  wizard and Edit dialogs for items in that domain, so metadata is captured at
  authoring time.

## Backend

| Control | Backend |
|---|---|
| Attribute schemas | Cosmos `attribute-groups` (PK `/tenantId`) |
| Rendering | The Create wizard + item Edit dialog read the domain's groups |

Attributes are Loom-native (no Fabric dependency); values are stored on the item
and are queryable by the catalog.

## RBAC & honest gates

Tenant-admin / governance-admin. Attribute groups are always available (no infra
gate); a domain with no groups simply adds no custom fields.

## Related

- [Catalog domains](../catalog/domains.md) — the scope attributes attach to.
- [Feature permissions](feature-rbac.md)
