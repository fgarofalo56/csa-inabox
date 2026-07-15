# SCIM 2.0 provisioning

Provision **users and groups** into Loom from your identity provider (Microsoft
Entra ID, Okta, …) using the standard **SCIM 2.0** protocol (RFC 7643 / 7644).

Base URL: `https://<your-loom-host>/api/scim/v2`

## Endpoints

| Resource | Verbs |
|----------|-------|
| `/ServiceProviderConfig` | GET (capabilities discovery) |
| `/ResourceTypes` | GET |
| `/Users` | GET (list + `?filter`), POST |
| `/Users/{id}` | GET, PUT, PATCH, DELETE |
| `/Groups` | GET (list + `?filter`), POST |
| `/Groups/{id}` | GET, PUT, PATCH, DELETE |

- **Filtering:** `eq/ne/co/sw/ew/pr/gt/ge/lt/le` on a single attribute, with
  `and`/`or` — e.g. `userName eq "alice@contoso.com"`.
- **PATCH:** user deactivation (`{op:"replace", value:{active:false}}`) and group
  membership add/remove (`members[value eq "<id>"]`) are supported.
- **Persistence:** real — every resource is stored in Cosmos (`loom-scim-users` /
  `loom-scim-groups`). Group membership is bidirectional (a user's `groups` and a
  group's `members` stay consistent).

## Authentication

SCIM uses a **dedicated provisioning bearer token**, separate from the
cookie/PAT surface. Set it on the deployment as the secret
**`LOOM_SCIM_BEARER_TOKEN`**, then configure the SAME value in your IdP's
provisioning connector.

Until `LOOM_SCIM_BEARER_TOKEN` is set, every SCIM endpoint returns an honest
`501` naming the exact secret to configure — the surface never accepts
unauthenticated provisioning traffic.

```bash
curl -H "Authorization: Bearer $LOOM_SCIM_TOKEN" \
  https://<host>/api/scim/v2/Users?filter=userName%20eq%20%22alice@contoso.com%22
```

## Configure Entra provisioning

1. Set `LOOM_SCIM_BEARER_TOKEN` on the Loom console app (a long random secret).
2. In Entra → **Enterprise applications** → your Loom app → **Provisioning**:
   - **Tenant URL:** `https://<your-loom-host>/api/scim/v2`
   - **Secret Token:** the same `LOOM_SCIM_BEARER_TOKEN` value.
3. **Test Connection** (Entra calls `/ServiceProviderConfig` + a probe query),
   then start provisioning.

## Government

SCIM is transport-only over HTTPS — it works identically on Government
deployments. Point the IdP at the Government host; no Fabric dependency.
