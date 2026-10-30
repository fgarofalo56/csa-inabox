# Security and compliance — the API & AI Gateway Plane

Binding for every wave. Adopted from Mosaic's security model (README,
ADR 0001/0004/0010/0011/0017/0018/0021/0026) with Loom's identities. Nothing
here is a compliance claim; `cloud-parity.md` and `csa_loom_region_availability_is_not_audit_scope`
govern what may be said about Government.

## 1. Trust boundaries

| Boundary | Credential | Rule |
|---|---|---|
| Browser → console | Loom session (existing MSAL sign-in) | plane admin routes require the `apiplane-admin` capability (tenant admins are a superset; Q9, 2026-10-29); self routes resolve the caller from the session only |
| Console → ARM / Log Analytics / Graph / Key Vault | Console UAMI | reads everywhere it is granted; writes only to gateways in `manage` mode and only from a reviewed plan; Graph is read-only; Key Vault holds secret URIs the plane reads for key checks and writes once for pasted keys |
| Client → gateway | APIM subscription key tied to one grant and cost center, or an Entra token for `api://<runtime>` | both must be valid and name the same grant if both are sent; neither enabled = deny; group grants are token-only |
| Gateway → backend | APIM system-assigned identity (role at the account scope) or a Key Vault-backed `<backend>-key` named value | the plane never passes a key through itself to a backend; caller credentials are stripped before forwarding |
| Console → Government (cross-cloud, opt-in) | Government-tenant service principal, secret in the isolated management vault | management only; never a runtime credential; never in named values, backends or the marketplace |
| Worker job → everything above | Console UAMI | same grants; leases prevent concurrent writers |

## 2. What the plane keeps and never keeps

| Item | Kept? | Where | Never |
|---|---|---|---|
| Policy XML | **no** | SHA-256 digest + redacted facets in `apiplane-observed` / plan docs | persisted, logged, sent to the browser; URLs lose query and fragment before entering any record |
| APIM subscription keys | **no** | APIM owns them; the plane stores subscription IDs and ownership evidence | cached, logged, placed in URLs, history, storage or query caches; reveal is explicit, owner-only, audited, transient (60 s), non-cacheable |
| Backend API keys an administrator pastes | **once, in Key Vault** (`loom-apiplane-key-<resource>-<hex>`, tags `managedBy: loom-apiplane`) | the plane stores the versionless secret identifier and `keyStoredByPlane: true` | returned, echoed in validation errors (422 bodies drop `input`), present in traceback locals, read back from Key Vault's write response |
| Backend keys an administrator keeps in their own vault | **no** | secret URI only | — |
| Government management secret | **once, in the management vault** | reference + safe metadata in `apiplane-desired` | the environment vault APIM reads; runtime named values; the marketplace |
| MCP server bearer tokens (static) | **no** | Key Vault secret identifier | — |
| Tokens from callers | **no** | — | forwarded upstream; MCP and model fragments strip `Authorization`, `Ocp-Apim-Subscription-Key`, `api-key`, `x-api-key`, `subscription-key` |
| Object IDs and client IDs in rollups | **yes** (personal data) | `apiplane-usage`, retention `LOOM_APIPLANE_USAGE_RETENTION_DAYS` | shown to other users; portal views are user-scoped |
| Prompt and completion bodies | **no** | the diagnostics writer sets prompt/completion bytes to 0; the Telemetry card warns when a customer-authored diagnostic logs bodies | — |

## 3. Write gates (in order; each must pass)

1. The gateway is `ownedBy:'deploy'` or `registered`, and `managementMode ==
   'manage'`; `observe` refuses every write regardless of Azure permissions.
2. Preflight has recorded `canWrite` within the last 24 h.
3. A plan exists, its digest equals the digest recomputed at apply time
   (facets + environment fingerprint + applied-state version); `409 stalePlan`
   otherwise, `409 planRequired` without one.
4. The gateway write lock is free or held by this run; a held lock after a
   crash requires the explicit recovery action with a stated confirmation.
5. Each step re-reads the resource; a resource the plan expected to create
   that now exists is refused.
6. The outcome is recorded before the next step; LROs are polled to terminal
   state; an uncertain outcome is never replayed.
7. Audit written with `kind:'apiplane.<area>.<verb>'`, actor, gateway, plan
   ID, step results (never XML, never key material).

Exceptions, each disclosed in-product: per-API diagnostics enablement on
plane-published APIs (`gateway.telemetryEnabled`), the
`loom-blocked-cost-centers` named value write
(`gateway.blockedCostCentersUpdated`), and key creation/rotation/deletion on a
grant's own subscription at the owner's request.

## 4. Audit kinds (minimum)

`apiplane.gateway.{registered,modeChanged,synced,telemetryEnabled,blockedCostCentersUpdated,removed}`,
`apiplane.endpoint.{registered,keyReplaced,removed}`,
`apiplane.publication.{created,planned,applied,rolledBack,unpublished,recovered}`,
`apiplane.mcp.{registered,published,unpublished,modelCallerChanged}`,
`apiplane.pool.{created,applied,memberDrained}`,
`apiplane.deployment.{planned,applied,reconciled}`,
`apiplane.entitlement.{created,approved,denied,revoked,keyCreated,keyRotated,keyDeleted,keyRevealed}`,
`apiplane.costCenter.{created,updated,memberRemoved,recheck}`,
`apiplane.budget.{set,thresholdFired,blocked,unblocked,removed}`,
`apiplane.environment.{assigned,catalogChanged,requireClassificationChanged}`,
`apiplane.pricing.priceRecorded`, `apiplane.connection.{created,secretReplaced,removed,tested}`,
`apiplane.notification.{sent,retried,deadLettered}`.

## 5. Outbound-call safety (MCP read-only client, key checks)

- HTTPS only outside tests; loopback, link-local, private, reserved,
  multicast literal addresses and `169.254.169.254` refused; redirects never
  followed; URLs with userinfo **rejected**; response bytes and `tools/list`
  pages capped; managed-identity token attached only to an operator-stated
  audience; `tools/call` has no code path.
- Residual: literal-address checks do not stop DNS rebinding; registration is
  tenant-admin only, which is the primary control (Mosaic ADR 0007).
- Key checks send one unbilled `GET /openai/models` and read only the status.

## 6. Government and audit scope

- Each boundary's Loom is its own control plane by default; data stays in
  the boundary.
- Cross-cloud (W8) processes Government resource metadata, access records,
  telemetry and the management credential in Commercial. The Connections page
  states this verbatim and requires an explicit enable; the readiness page
  lists it as "cross-cloud management (not sovereign)"; Government runtime
  access is subscription-key only; Commercial tokens and group membership are
  never a runtime fallback; unavailable or unknown Government features stay
  blocked or unknown, never substituted with Commercial credentials, hosts or
  prices.
- Capabilities whose Government availability is unmeasured are gates with
  owners: `llm-*` policies and LLM logs (#4460, W0-1/W0-2), Entra Agent ID
  (W0-4), Anthropic-on-Foundry (W0-8), Retail Prices coverage (W0-5). Content
  safety at the gateway stays #4442's declared gap (IL5) and is displayed, not
  re-decided, here.
- "Supported-in-code, never exercised" (GCC) and "no deploy run" (IL5) are
  stated on every boundary table in this set.

## 7. Public repository rules

No tenant IDs beyond those already tracked, no subscription keys, no real
usage figures, no screenshots of real callers. Playwright screenshots come
from a seeded test tenant. PR bodies, titles, annotations and artifacts are
publication surfaces (`csa_loom_public_repo_has_three_publication_surfaces`).

## 8. Threats and mitigations (summary)

| Threat | Mitigation |
|---|---|
| Plane compromise used to grant model access broadly | writes only from reviewed plans; observe mode default; audit; tenant-admin only; no Copilot tool writes |
| Key exfiltration via logs or UI | keys never stored or cached; reveal transient and audited; 422 bodies scrubbed; `show_locals=false` equivalent in structured logging |
| Customer policy overwritten | plane owns only `loom-*` fragments and the APIs it created; API policy is a thin include; refuses to take over resources it did not create |
| Over-permissive role requested | API Management Service Contributor on managed gateways only; Reader for onboarding; Monitoring Reader for logs; Graph read-only; narrower custom roles documented as an option |
| Budget bypass | fail-closed: a non-plane-written block list yields 503 `r=budget-list`; blocks lift only by month end, raise, disable or delete |
| Cross-tenant key misuse | key-authenticated endpoints only for Azure AI hosts; declared deployments; readiness proves the gateway identity can read the secret |
| SSRF through MCP registration | § 5 |
| Group overage silently granting | overage fails closed; remedy is a direct grant; shown in the console |
