# API Management admin page

> **Surface:** `/admin/api-management`
> **Backend:** Azure API Management (ARM + APIM management plane)

The **API Management** page is the full administration surface for the Azure API
Management instance Loom fronts its published APIs with. From here an operator
manages APIs, products, subscriptions, policies, named values and backends —
end-to-end marketplace administration without leaving the console.

## What you can do

- **APIs** — list, import and configure APIs, their operations and revisions.
- **Products** — bundle APIs into products, set visibility and subscription
  requirements/approval.
- **Subscriptions** — issue, view and revoke subscription keys per product / user.
- **Policies** — edit inbound / outbound / backend policy (rate-limit, transform,
  auth) at the API or product scope.
- **Named values & backends** — manage the reusable named values (including Key
  Vault-backed secrets) and backend service definitions the policies reference.

## Backend

All operations are real Azure API Management management-plane calls
(`Microsoft.ApiManagement/service/*`) executed as the Console UAMI — no mock
inventory. Secret named values are Key Vault references, never stored in the
console.

## RBAC & honest gates

Runs as the Console UAMI, which needs **API Management Service Contributor** on
the APIM instance. When APIM isn't provisioned, or the role is missing, the page
shows an honest `MessageBar` with the resource / role to set rather than an empty
console.

## Related

- [Scale by SKU](scaling.md) — change the APIM SKU + capacity.
- [MCP Servers](mcp-servers.md)
