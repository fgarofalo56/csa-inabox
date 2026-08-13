# Access management — design

> **Status:** design proposal. Nothing in §3 onward is built yet.
> **Author:** research + design pass, 2026-08-13.
> **Scope:** how an admin grants, scopes, pauses, and revokes access to CSA Loom
> — for users inside the tenant, guests from another Entra tenant, and
> unmanaged/social identities — in Commercial, GCC, GCC-High, and IL5.
>
> Every claim about Azure behaviour cites Microsoft Learn. Every claim about
> *this* deployment is labelled **MEASURED** (I ran the read) or **INFERRED**
> (I read the code path but did not execute it). Read-only inspection only —
> no tenant object was created, modified, or deleted to produce this document.

---

## §0 — Interim runbook: grant a `@microsoft.com` user access **today**

**This is the manual path the wizard in §4 replaces.** It works right now, with
zero code changes. It takes about two minutes.

### 0.1 What is already true in this tenant (MEASURED 2026-08-13)

I read these directly from Microsoft Graph against `limitlessdata.ai` (Commercial):

| Setting | Value | What it means |
|---|---|---|
| `crossTenantAccessPolicy/default` → `b2bCollaborationInbound` | `allowed` for `AllUsers` + `AllApplications` | Guests from **any** Entra tenant may authenticate to **any** app here. No per-partner config needed. |
| `crossTenantAccessPolicy/partners` | `[]` (empty) | No partner-specific override exists for Microsoft's tenant. The permissive default applies to `@microsoft.com`. |
| `authorizationPolicy.allowInvitesFrom` | `adminsAndGuestInviters` | Only Global Admin / User Admin / Guest Inviter may invite. **Not** `none`, so app-only invitations also work ([Learn](https://learn.microsoft.com/graph/api/invitation-post?view=graph-rest-1.0#permissions): "Application permissions (app-only) don't work if B2B invitations are disabled on the tenant"). |
| `authorizationPolicy.guestUserRoleId` | **Restricted Guest User** (`2af84b1e-…`) | The most restrictive of the three levels. Guests can see only their own directory object — no user list, no group memberships ([Learn](https://learn.microsoft.com/entra/identity/users/users-restrict-guest-permissions#overview)). |
| Loom console enterprise app → `appRoleAssignmentRequired` | **`false`** | **Any** authenticated principal in the tenant — member *or* redeemed guest — can sign in to Loom. There is no app-level admission gate. |
| Loom console enterprise app → `appRoles` | **0 defined** | Loom exposes no app roles at all, so app-role-based authorization is not currently available. |
| Console UAMI Graph app roles granted | `User.Invite.All`, `User.ReadWrite.All`, `GroupMember.ReadWrite.All`, `User.Read.All`, `Group.Read.All`, `Directory.Read.All`, `Application.Read.All` | The platform *already* has the permission to do all of §4 automatically. |

**Consequence:** because inbound B2B is open and the Loom app does not require
assignment, the *only* thing standing between a `@microsoft.com` person and
CSA Loom is **the existence of a redeemed guest object in `limitlessdata.ai`**.
Create that, and they are in.

### 0.2 The click-path (portal)

1. Sign in to [entra.microsoft.com](https://entra.microsoft.com) as Global
   Administrator, User Administrator, or Guest Inviter — `allowInvitesFrom` is
   `adminsAndGuestInviters`, so a plain member account will be refused.
2. **Entra ID → Users → New user → Invite external user.**
3. Email: the person's `@microsoft.com` address. Display name: their name.
4. **Review + invite.** Entra creates a `userType: Guest` object with a UPN of
   the form `alias_microsoft.com#EXT#@limitlessdata.ai` and emails them a
   redemption link ([Learn](https://learn.microsoft.com/entra/external-id/b2b-quickstart-add-guest-users-portal)).
5. The guest clicks the link, consents, and is redirected. Since July–December
   2025 the guest authenticates against **their own** tenant's sign-in page and
   is returned here after ([Learn](https://learn.microsoft.com/entra/external-id/what-is-b2b#manage-b2b-collaboration-with-other-organizations)).
6. They browse to `https://csa-loom.limitlessdata.ai` and sign in. They are in.

### 0.3 The same thing as Graph calls

```http
POST https://graph.microsoft.com/v1.0/invitations
Content-Type: application/json

{
  "invitedUserEmailAddress": "someone@microsoft.com",
  "invitedUserDisplayName": "Someone",
  "inviteRedirectUrl": "https://csa-loom.limitlessdata.ai",
  "sendInvitationMessage": true
}
```

Returns `201` with `inviteRedeemUrl` and `invitedUser.id`
([Learn](https://learn.microsoft.com/graph/api/invitation-post?view=graph-rest-1.0)).
Least-privileged permission: `User.Invite.All`, delegated or application.

To then make them a Loom **tenant admin** (only if that is genuinely intended):

```http
POST https://graph.microsoft.com/v1.0/groups/{LOOM_TENANT_ADMIN_GROUP_ID}/members/$ref
{ "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/{invitedUser.id}" }
```

To grant something less than that today, add them to the relevant **domain
admin** or **domain contributor** Entra group instead (§2.2), or assign them a
workspace role inside Loom.

### 0.4 What to check if it does not work

| Symptom | Cause | Where to look |
|---|---|---|
| "This invitation is blocked by cross-tenant access settings" | Either tenant blocks it. Ours does not (MEASURED §0.1) — so it would be **Microsoft's outbound** setting. | Microsoft's tenant admin controls `b2bCollaborationOutbound`. You cannot fix this from here. ([Learn](https://learn.microsoft.com/entra/external-id/troubleshoot#invitation-is-blocked-due-to-cross-tenant-access-policies)) |
| "Insufficient privileges" on invite | Your account is not Global Admin / User Admin / Guest Inviter. | `allowInvitesFrom = adminsAndGuestInviters` |
| Guest redeems but Loom shows nothing useful | Expected. They are in, with no Loom role. | §2.2 — no group ⇒ `DomainTier = null` |
| `AADSTS50105` | Would mean the app requires assignment. It does **not** here (MEASURED). | Only relevant after §5 lands |
| Invitation blocked "due to suspicious activity" | Tenant-level abuse block applied by Microsoft. | Not fixable by config; open a support case ([Learn](https://learn.microsoft.com/answers/a/12704913)) |

### 0.5 The honest caveat about `@microsoft.com` specifically

B2B collaboration requires **both** ends to permit it, but asymmetrically:

- **Inbound** (this tenant accepting the guest) — MEASURED `allowed`. ✅
- **Outbound** (Microsoft's tenant letting its users be invited out) — **I
  cannot measure this.** It lives in Microsoft's own cross-tenant access
  settings, which I have no read access to
  ([Learn](https://learn.microsoft.com/entra/external-id/cross-tenant-access-overview#manage-external-access-with-inbound-and-outbound-settings)).

Microsoft's corporate tenant is large and heavily governed, and I will not
assert from memory what its outbound posture is. **The measurement is the
invitation itself**: send one and see whether redemption succeeds. If it fails
with the cross-tenant message, the block is on their side and the workaround is
for the person to use a non-`@microsoft.com` identity (§8.3).

---

## §1 — The problem, stated precisely

The operator's ask, distilled:

> When someone requests access, nothing happens except that I can see the
> request. Give me one place to (a) decide, (b) create them as a tenant member
> **or** invite them as a guest, (c) grant Loom permissions, and (d) later
> revoke or pause them.

Three of those four already have working machinery (§2). The gap is not "build
onboarding" — it is **(c) grant Loom permissions**, plus **(d) revoke/pause**,
plus the fact that the pieces that do exist are not a coherent flow and one of
them is dangerously wired (§3).

---

## §2 — What Loom already has (MEASURED)

### 2.1 The sign-in access-request pipeline — real, end to end

| Stage | Where | State |
|---|---|---|
| Submit (unauthenticated) | `lib/components/access/request-access-button.tsx` → `POST /api/access-requests/public` | ✅ Real. Honeypot, per-IP + per-email rate limit, pending-dedupe. |
| Store | Cosmos `signin-access-requests`, PK `/tenantId` = `sha256(AZURE_TENANT_ID).slice(0,16)` | ✅ Real. Single logical partition per deployment. |
| Admin queue | `GET /api/admin/access-requests` → `lib/components/admin/access-requests-panel.tsx`, surfaced at `/admin/access-governance?tab=requests` | ✅ Real. Pending / approved / denied tabs with counts. |
| **Invite as guest** | `POST /api/admin/access-requests/[id]/invite-guest` → Graph `POST /invitations` | ✅ **Real tenant write.** Idempotent via `findGuestByEmail`. |
| **Create tenant user** | `POST /api/admin/access-requests/[id]/create-user` → Graph `POST /users` | ✅ **Real tenant write.** One-time password shown once, never stored. |
| Approve only / Deny | `PATCH /api/admin/access-requests/[id]` | ✅ Real. Deny requires a note. Both write an audit entry. |

So the operator's belief that "nothing really happens" is **out of date** — #2758
shipped two working provisioning buttons. What is true is that *approving does
not grant anything in Loom*, which is the part that matters to them.

### 2.2 How Loom decides what you can do — `lib/auth/domain-role.ts`

```
tenant-admin        ← LOOM_TENANT_ADMIN_OID (single oid) OR membership of LOOM_TENANT_ADMIN_GROUP_ID
domain-admin        ← membership of a domain's adminGroupId (or legacy admins[] UPN list)
domain-contributor  ← membership of a domain's contributorGroupId / memberGroupId
workspace roles     ← resolved separately by workspace-roles-client
null                ← everyone else
```

Membership is read from the `loom_session` cookie's `groups` claim (AES-256-GCM,
8h, claims-only — no access token, because Front Door drops `Set-Cookie` past
~4 KB), with a Microsoft Graph `transitiveMembers` fallback used when that claim
is empty/absent — the >200-group overage case. `#3175` populates the claim
(`app/auth/callback/route.ts:277-283` + `groupMembershipClaims=SecurityGroup` on
the app registration).

> **Correction to a premise I was given.** My brief stated that `#3331` bounds
> the cookie. **MEASURED: it does not, on `main` at `ee33f9c9`.** There is no
> size cap, no `slice()`, and no group-count limit anywhere on `claims.groups` —
> the array is written verbatim into the cookie, and the only length reference in
> the callback is a *log line*. A user in ~150 groups is **below** Entra's ~200
> overage threshold, so the inline claim is emitted, ~150 × 36 chars ≈ 5.4 KB —
> past Front Door's header limit. The `Set-Cookie` is silently dropped and **they
> cannot sign in at all**. This is the exact failure mode `session.ts:6-11`
> documents for the access token. Tracked as a companion defect in §3.2.

**Three structural observations that drive the whole design:**

1. **There is no admission tier.** `DomainTier = null` is not "denied", it is
   "authenticated with no elevated scope". Combined with
   `appRoleAssignmentRequired: false`, *anyone who can authenticate is in Loom*.
   Loom has an authorization ladder but no front door.
2. **Every rung of the ladder is an Entra security group.** That is the right
   primitive and the design below keeps it — it means both the claim path and
   the Graph-fallback path already work, and nothing new has to be invented.
3. **But the fallback only covers *domain* tiers.** MEASURED: `isTenantAdmin`
   (`feature-gate.ts:66-72`) and `checkCapability` (`:85`) read `claims.groups`
   **directly, with no Graph fallback**. So a group-overage user who genuinely
   *is* in `LOOM_TENANT_ADMIN_GROUP_ID` is **denied tenant admin**, and their
   only way in is `LOOM_TENANT_ADMIN_OID`. Any design that keys on group
   membership must work on **both** paths — today the most important one does
   not. §3.2.

`/welcome` is the pre-auth landing surface that offers "Request access" to
people who cannot authenticate at all (`lib/auth/returning-user.ts`).

**And there is a hole between the two states.** MEASURED: `/welcome` +
`RequestAccessButton` are reachable only by a *never-signed-in* visitor (the
`loom_seen` cookie decides). A user who **can** authenticate but has no grants
just collects 403s with no in-product way to ask for access. That is precisely
the `@microsoft.com` guest's experience the moment they redeem — and it is a
natural slot for the wizard's request path (§5.1).

### 2.3 The other two "access request" systems — do not conflate them

| System | Container | Question |
|---|---|---|
| **Sign-in onboarding** (this doc) | `signin-access-requests` | "Can this person get into Loom at all?" — requester has **no session** |
| F16 multi-tier approval | `access-request-workflow` | "May this **already-signed-in** user reach this data asset?" |
| Loom access packages | `access-packages` | Loom-**native** bundles. Despite the name, these do **not** call Entra Entitlement Management — they create F16 workflow docs. |

They share a URL prefix by accident: the unauthenticated submit endpoint lives
at `app/api/access-requests/public/` (inside the F16 tree) while its admin queue
lives at `app/api/admin/access-requests/`. Worth renaming; not load-bearing.

### 2.4 Built but unreachable

`app/api/admin/directory-users/[id]/lifecycle/route.ts` implements pause /
resume / delete against Graph, with tests — and has **zero UI callers**
(measured: the only reference outside its own directory is a generated type
file). The revoke/pause backend the operator wants **already exists**; nobody
wired a button to it.

---

## §3 — P0 defect found during this research

**Approving an access request can silently make the requester a Loom tenant
admin.**

The chain, each link measured except the last:

1. `_lib/provision.ts` → `onboardingGroupId()` returns
   `LOOM_ONBOARDING_ENTRA_GROUP_ID || LOOM_TENANT_ADMIN_GROUP_ID`.
2. **MEASURED:** `LOOM_ONBOARDING_ENTRA_GROUP_ID` is not set on the live
   `loom-console` Container App, and `grep` across `platform/` and `deploy/`
   finds **zero** references — no bicep module, param file, or workflow ever
   sets it. It is read at runtime and written nowhere.
3. **MEASURED:** `LOOM_TENANT_ADMIN_GROUP_ID` *is* set on the live app. So the
   fallback resolves to the tenant-admin group.
4. **MEASURED:** the Console UAMI holds `GroupMember.ReadWrite.All`, so
   `addPrincipalToGroup` will succeed rather than 403.
5. **MEASURED:** `isTenantAdmin()` keys on membership of
   `LOOM_TENANT_ADMIN_GROUP_ID`.
6. **INFERRED** (code path read; not executed — that would mutate the tenant):
   clicking **Invite as guest** or **Create tenant user** adds the new principal
   to the tenant-admin group, making them a Loom tenant admin in one click.

The route's own comment says the group add is "so they inherit its access" — the
intent was clearly a low-privilege onboarding group. The fallback inverts it.

**Blast radius today: nil.** MEASURED — the tenant-admin group currently has 3
members and **0 guests**, and no `userType: Guest` object is in it. This is a
latent defect, not an active compromise.

**Aggravating factors:**

- The five Graph **write** helpers (`inviteExternalGuest`, `createTenantUser`,
  `addPrincipalToGroup`, `setUserAccountEnabled`, `deleteTenantUser`) do **not**
  call `assertEnabled()`. All seven `assertEnabled()` call sites are read paths.
  The identity write surface has **no env kill-switch**, unlike every other
  Graph write client in the codebase.
- `grant-identity-graph-approles.sh` grants the three write roles whenever
  `LOOM_ACCESS_GOV_DIRECTORY_WRITE` is unset (it defaults to `true`), and the
  post-deploy bootstrap workflow never sets it — yet the workflow step's own
  comment documents only the three *read* roles. The high-privilege grant is
  invisible at the workflow layer.

**Fix (immediate, ahead of everything else in this doc):** make
`onboardingGroupId()` fail closed — return `undefined` when
`LOOM_ONBOARDING_ENTRA_GROUP_ID` is unset, never fall back to the admin group —
and have the deploy create and wire a real `Loom Users` group (§7).

### 3.2 Companion defects found while researching this

Each is independently tracked; each blocks or degrades the design above.

| # | Defect | Impact on this design | Evidence |
|---|---|---|---|
| A | **`groups` claim is unbounded in the session cookie.** No cap, no truncation. ~150 groups ≈ 5.4 KB > Front Door's header limit → `Set-Cookie` dropped → **cannot sign in at all**. | The design keys authorization on group membership. A user in many groups cannot authenticate. | No cap anywhere in `session.ts` / `callback/route.ts`; only a length **log** at `callback/route.ts:417` |
| B | **Graph overage fallback covers only domain tiers.** `isTenantAdmin` and `checkCapability` read the claim with no fallback. | A >200-group tenant admin is locked out of admin surfaces unless `LOOM_TENANT_ADMIN_OID` is set. | `feature-gate.ts:66-72`, `:85` vs `domain-role.ts:132-141` |
| C | **Two divergent `graphBase()` implementations.** `msal.ts:381-386` switches on `AZURE_CLOUD`, ignores `LOOM_GRAPH_BASE`, and has **no IL5/DoD branch**. It is the one `userIsTransitiveGroupMember` uses. | **On IL5/DoD the group-membership fallback calls the wrong Graph host and — given the fail-closed posture — silently answers `false`.** Cloud-parity defect (§10). | `msal.ts:381-386` vs `graph-identity-client.ts:67`; consumer at `workspace-roles-client.ts:498` |
| D | **`loomIdentityPickerEnabled` is `false` in every shipped param file** — env-gated in `commercial-full`/`tenant-dmlz`, hard-`false` in `commercial.bicepparam:137`, absent (→ module default `false`) in `gcc`/`gcc-high`/`il5`. | `<IdentityPicker>` — which the wizard depends on — renders its 503 "not configured" gate on a **stock deploy in all four clouds**. | grep across `platform/fiab/bicep/params/` |
| E | **The identity WRITE surface has no env kill-switch.** All 7 `assertEnabled()` call sites are read paths. | No way to disable directory writes without revoking Graph consent. | `graph-identity-client.ts` — 5 write helpers, 0 gated |
| F | **`directory-users/[id]/lifecycle` has zero UI callers.** Pause/resume/delete are built and tested but unreachable. | The revoke/pause backend already exists; §5.2 is wiring, not building. | only reference outside its dir is a generated type |
| G | **Stale "Loom does not modify tenant group membership on your behalf"** in the Approve-only response and in `docs/fiab/admin/access-requests.md`. | Factually contradicted by the sibling routes since #2758. | `app/api/admin/access-requests/[id]/route.ts:43` |

Defect **C** is the one that most threatens the `cloud-parity.md` claim: without
it fixed, group-based authorization is quietly broken in IL5/DoD for exactly the
users the fallback exists to serve.

---

## §4 — Recommended model

### 4.1 The decision

**Key Loom authorization on Entra security-group membership, with a new
platform-provisioned group per Loom role, and drive everything — invite, create,
grant, pause, revoke — from a Loom-native wizard over Microsoft Graph.**

Concretely, four groups created by the deploy:

| Group | Loom meaning | Maps to |
|---|---|---|
| `Loom Users` | Baseline: may sign in and use Loom | new admission tier |
| `Loom Domain Contributors` | Per-domain contributor | existing `contributorGroupId` |
| `Loom Domain Admins` | Per-domain admin | existing `adminGroupId` |
| `Loom Tenant Admins` | Full control | existing `LOOM_TENANT_ADMIN_GROUP_ID` |

Plus: set `appRoleAssignmentRequired: true` on the Loom enterprise app and
assign `Loom Users` to it, so Entra itself enforces admission (§5.3).

### 4.2 Why groups and not app roles

The task asked me to compare these. Both are legitimate; groups win **here**:

| | Entra security group | App role (`roles` claim) |
|---|---|---|
| Already the primitive Loom reads | ✅ `domain-role.ts`, workspace roles, DLZ gates | ❌ zero app roles defined today |
| Survives the >200-group overage | ✅ Graph fallback already built | ✅ `roles` never overflows |
| Grantable to a **nested group** | ✅ transitive membership | ⚠️ assignable to a group, but the token still emits it flatly |
| Reusable outside Loom (ADLS, Synapse, Purview ACLs) | ✅ one group grants storage *and* console | ❌ app-role is Loom-only |
| Works with Entra access reviews / PIM / entitlement management | ✅ native | ⚠️ access packages can assign app roles, but PIM-for-Groups cannot |
| Revocation latency | ⚠️ up to token lifetime | ⚠️ same |

The deciding factor is the fourth row. Loom's authorization is not just "what
can you click" — the same identity needs ADLS Gen2 RBAC, Synapse SQL, Purview,
and Unity Catalog grants. A security group is the only primitive that carries
across all of them. An app role would force a second, parallel grant model.

**Adopt app roles as a *complement*, not the source of truth:** define
`Loom.User` / `Loom.DomainAdmin` / `Loom.TenantAdmin` app roles and assign the
*groups* to them. That gives Entra a hard admission gate (§5.3) and puts a
`roles` claim in the token as a fast path, while group membership remains
authoritative — so the existing Graph fallback keeps working unchanged.

### 4.3 Why not Entra Entitlement Management as the engine

Entitlement Management is an *excellent* fit on paper: request → approve →
time-bound assignment → automatic expiry → auto-invite external users as guests,
and it will even block sign-in and delete the guest 30 days after their last
assignment lapses
([Learn](https://learn.microsoft.com/entra/id-governance/entitlement-management-external-users#how-entitlement-management-can-help)).
That is exactly the operator's ask, already built by Microsoft.

**It is rejected as the *required* engine on licensing grounds.**

> **Licensing, stated plainly.** Entitlement management requires **Microsoft
> Entra ID Governance**, or **Microsoft Entra ID P2**, or **EMS E5** — and the
> licence is counted per *user who can request*, not per user who does. A policy
> scoped to 2,000 employees needs 2,000 licences even if 150 request
> ([Learn](https://learn.microsoft.com/entra/id-governance/licensing-fundamentals#microsoft-entra-id-governance-features)).
> Access reviews and PIM (including PIM for Groups) carry the **same** P2 /
> ID Governance requirement
> ([reviews](https://learn.microsoft.com/entra/id-governance/manage-guest-access-with-access-reviews),
> [PIM](https://learn.microsoft.com/entra/id-governance/licensing-fundamentals#privileged-identity-management)).
> Cross-tenant *trust settings* and per-user/per-group scoping need **P1**
> ([Learn](https://learn.microsoft.com/entra/external-id/cross-tenant-access-overview#important-considerations)).
>
> **What needs no premium licence at all:** `POST /invitations`,
> `POST /users`, group membership writes, `appRoleAssignedTo`, and
> `PATCH /users {accountEnabled}`. The entire §4.1 model runs on Entra ID Free.

So: **Loom-native is the default and must be complete on its own.** Where the
tenant *does* hold ID Governance, Loom should detect it and offer to hand the
lifecycle to Entra — a strictly better outcome, because Microsoft's expiry
engine is more reliable than a cron we write. That is an enhancement, never a
prerequisite. Detection is a `GET /subscribedSkus` call the console already
makes for `/admin/users`.

### 4.4 Why "pause" is `accountEnabled: false` plus group removal, not one of them

Four candidate mechanisms, compared:

| Mechanism | Effect | Latency | Reversible | Verdict |
|---|---|---|---|---|
| Remove from Loom group | Loses Loom role, still authenticates | Up to token lifetime | ✅ trivially | ✅ **the revoke primitive** |
| Remove app-role assignment | Blocked at Entra sign-in (once §5.3 lands) | Next sign-in | ✅ | ✅ pairs with the above |
| `PATCH /users {accountEnabled:false}` | Blocked tenant-wide, all apps | Next token request | ✅ | ✅ **the pause primitive** |
| `DELETE /users/{id}` | Object gone (30-day soft delete) | Immediate | ⚠️ only within 30 days | ⛔ terminal — offboarding only |
| Time-bound EM assignment | Lapses on its own | Scheduled | ✅ | ⚠️ licence-gated |

**Recommendation — model them as three distinct verbs, not one slider:**

- **Pause** = `accountEnabled: false`. Keeps the object and all group
  memberships so **Resume** is one call. Correct for "they're on leave", "we're
  investigating", "contract suspended". It is deliberately blunt: it stops them
  everywhere, not just Loom, which is what an admin means by "pause access".
- **Revoke Loom access** = remove from all Loom groups + remove the app-role
  assignment + `POST /users/{id}/revokeSignInSessions`. Scoped to Loom; leaves
  the person's tenant account alone. Correct for "they changed teams".
- **Offboard** = revoke, then delete the guest object. Terminal, typed
  confirmation, admin-only.

**Revocation must be guaranteed, not best-effort.** Group removal alone does not
invalidate an already-issued token — the user keeps their access until it
expires. So every revoke path must also call
`POST /users/{id}/revokeSignInSessions`, which invalidates refresh tokens, *and*
Loom must invalidate its own 8-hour session cookie for that oid. Without both,
"revoked" is a lie for up to 8 hours. This is the single most important
correctness requirement in the design.

---

## §5 — The admin wizard

One surface: **`/admin/access-management`**, three tabs — **Requests**,
**People**, **Settings**. Fluent v9 + Loom tokens, `SplitPane` where a pane is
resizable, `EmptyState` for empties, per `ux-baseline.md` and `web3-ui.md`.

### 5.1 Requests tab — the queue, upgraded to a wizard

Today's card list becomes a queue where **Review** opens a five-step
`Dialog`-hosted wizard. No freeform config: every choice is a radio, dropdown, or
identity picker.

```
┌ Step 1 · Who ──────────────────────────────────────────────┐
│ Name, email, org, stated reason, submitted-at.             │
│ Platform-computed banner, one of:                          │
│   ✓ "microsoft.com is an Entra tenant. Inbound B2B is      │
│      allowed here — a guest invite will work."             │
│   ⚠ "gmail.com is not an Entra tenant. They will be        │
│      invited as an email-OTP guest."                       │
│   ℹ "This person already exists in your tenant as a guest. │
│      Skip to step 3 to grant access."                      │
│ (Computed live from findGuestByEmail + the cross-tenant    │
│  and authorizationPolicy reads in §0.1 — never typed in.)  │
└────────────────────────────────────────────────────────────┘
┌ Step 2 · How ──────────────────────────────────────────────┐
│ ( ) Invite as guest        ← DEFAULT, pre-selected         │
│     Keeps their own credentials + MFA. No licence cost.    │
│     Recommended for anyone outside limitlessdata.ai.       │
│ ( ) Create a tenant member                                 │
│     New account under [ limitlessdata.ai ▾ ]  ← dropdown   │
│     of VERIFIED domains from GET /organization.            │
│     Consumes a licence. For staff, not collaborators.      │
│ ( ) Deny  → required note                                  │
└────────────────────────────────────────────────────────────┘
┌ Step 3 · What they can do ─────────────────────────────────┐
│ Loom role:  (•) User   ( ) Domain contributor              │
│             ( ) Domain admin   ( ) Tenant admin            │
│   Domain roles reveal a domain multi-select.               │
│   Tenant admin requires typed confirmation + a second      │
│   tenant admin's approval (§9.4).                          │
│ Access expires:  (•) Never  ( ) 30 days  ( ) 90 days       │
│                  ( ) Custom date                           │
│ Each option renders the exact effect:                      │
│   "Adds to group Loom Users; assigns app role Loom.User;   │
│    grants Storage Blob Data Reader on the bronze           │
│    container." — no hidden grants.                         │
└────────────────────────────────────────────────────────────┘
┌ Step 4 · Review ───────────────────────────────────────────┐
│ Plain-language diff of every mutation, in order, with the  │
│ Graph call behind each. Nothing has happened yet.          │
└────────────────────────────────────────────────────────────┘
┌ Step 5 · Result ───────────────────────────────────────────┐
│ Per-step ✓/✗ with the real Graph response.                 │
│ Guest → redeem URL, "Copy", "Email it".                    │
│ Member → one-time password, shown ONCE, copy-to-clipboard. │
│ Any failure names the exact remediation and offers Retry   │
│ for that step alone — partial success is never reported    │
│ as success.                                                │
└────────────────────────────────────────────────────────────┘
```

### 5.2 People tab — where revoke and pause live as first-class verbs

A `DataGrid` of every principal with Loom access — not every tenant user, which
is what `/admin/users` already shows read-only. Columns: person, type
(Member/Guest badge), Loom role, source (direct vs nested group), granted-by,
granted-at, expires, last sign-in, status.

Row actions, each a confirm dialog stating exactly what will change:

| Action | Does | Reversible |
|---|---|---|
| **Change role** | Group swap + app-role swap | ✅ |
| **Extend / set expiry** | Updates the assignment record | ✅ |
| **Pause** | `accountEnabled:false` + `revokeSignInSessions` + kill Loom session | ✅ **Resume** |
| **Revoke Loom access** | Remove from all Loom groups + app-role + `revokeSignInSessions` + kill Loom session | ✅ re-grant |
| **Offboard** | Revoke, then `DELETE /users/{id}` | ⛔ typed confirm |

This tab is mostly **wiring, not building** — `directory-users/[id]/lifecycle`
already implements pause/resume/delete with tests and has no caller (§2.4).

Bulk select for role change, expiry, pause, revoke. An **Expiring soon** filter
and a **Guests who have never signed in** filter (the cheap, licence-free
substitute for Entra access reviews).

### 5.3 Settings tab — the posture the platform manages for you

Read-only-with-Fix-it cards showing live Entra state, each with a one-click
remediation the platform performs itself:

| Card | Shows | Fix-it |
|---|---|---|
| Admission | `appRoleAssignmentRequired` | **Turn on** → `PATCH /servicePrincipals/{id} {appRoleAssignmentRequired:true}` and assign `Loom Users` |
| Who can invite | `allowInvitesFrom` | If `none`: **Allow admins to invite** → `PATCH /policies/authorizationPolicy` |
| Guest visibility | `guestUserRoleId` | Explains the current level; recommends Restricted (already set here) |
| Inbound B2B | `crossTenantAccessPolicy/default` + partner overrides | Add a partner override |
| Cross-cloud | Microsoft cloud settings | Enable Commercial↔Gov (§8.4) |
| Graph permissions | Which of the 8 app roles the UAMI holds | **Grant** if the deploy identity can; otherwise a one-click admin-consent link (§6.2) |
| Governance licence | `GET /subscribedSkus` → has ID Governance? | If yes: **Hand lifecycle to Entra** (§4.3) |

---

## §6 — Automatic vs genuinely human

`auto-bind-by-default.md` §5: if the platform *could* do it, requiring the user
to is a defect. Applying that strictly.

### 6.1 The platform does all of this, with no operator action

1. Create the four Loom groups, idempotently, on deploy.
2. Wire `LOOM_ONBOARDING_ENTRA_GROUP_ID` and the three role group ids into the
   console env — **from the deploy**, not by hand. (This is the §3 fix.)
3. Define the Loom app roles on the app registration and assign the groups.
4. Set `appRoleAssignmentRequired: true` and assign `Loom Users`.
5. Grant the Console UAMI the eight Graph app roles.
6. Invite guests, create members, add/remove group membership, assign/remove app
   roles, pause/resume/delete, revoke sessions.
7. Detect and repair drift: group deleted out-of-band → recreate and re-add;
   app-role assignment missing → re-assign; `allowInvitesFrom` flipped to `none`
   → surface with a Fix-it. Per rule §3, a stale binding is a bug to repair
   automatically, not a message.
8. Expire time-bound grants on schedule and write the audit record.
9. Detect ID Governance licensing and offer the upgrade path.

### 6.2 Genuinely human — and each is one click, in-product

| Step | Why it cannot be automated | Product shape |
|---|---|---|
| **Admin consent for the Graph app roles** | Tenant-wide consent is reserved to Global Administrator / Privileged Role Administrator. No app can self-consent. | Gate-registry entry with a **Grant consent** button deep-linking to the tenant-scoped consent URL, then re-probing and flipping green on its own. Never a paragraph of instructions. |
| **Deciding *whether* to admit a person** | A judgement call. This is the product. | The wizard. |
| **Microsoft's outbound cross-tenant setting** | Lives in a tenant we do not administer (§0.5). | Detect the failure, name it precisely as *their* side, offer the alternate-identity path (§8.3). |
| **Buying ID Governance licences** | Commercial decision. | Surfaced as an optional upgrade, never a gate. |

Everything else is a defect if it lands on a human.

### 6.3 Explicitly called out as violations of the rule today

- `LOOM_ONBOARDING_ENTRA_GROUP_ID` read at runtime, set by no deploy (§3).
- The "Approve only" path returning an instruction string telling the admin to
  go do the grant by hand in Entra — the platform holds the permission to do it.
- `/admin/users` linking out to the Entra portal for every mutation.

---

## §7 — What the deploy must provision

So a **fresh install works with no manual wiring**, per `no-vaporware.md`
§Bicep-sync and `deploy-integrity.md` R4.

### 7.1 New bicep

`platform/fiab/bicep/modules/admin-plane/access-management.bicep`, invoked from
`admin-plane/main.bicep`.

> **Note on the existing module.** `identity-graph-rbac.bicep` **grants
> nothing** — MEASURED, it is documentation-only and says so in its own header
> (`:5-15`): Graph app roles cannot be assigned from ARM. It emits
> `requiredAppRoles`, `graphBase`, `consentPortalUrl`, and `documentOnly` as
> outputs; the real grant is `scripts/csa-loom/grant-identity-graph-approles.sh`
> plus tenant-admin consent. The name reads as if it assigns roles; it does not.
> The new work extends the script and the bootstrap workflow, not this module.

Entra objects are not ARM resources, so group and app-role creation runs in a
**deploymentScript** (or, preferably, extends the existing post-deploy bootstrap
so it is re-runnable and idempotent):

| Object | Created by | Idempotency |
|---|---|---|
| `Loom Users` group | bootstrap script → `POST /groups` | look up by `mailNickname` first |
| `Loom Domain Contributors` | same | same |
| `Loom Domain Admins` | same | same |
| `Loom Tenant Admins` | reuse `FIAB_ADMIN_GROUP_ID` if supplied, else create | never clobber a supplied group |
| App roles on the app registration | `PATCH /applications/{id}` merging `appRoles[]` | merge, never replace |
| App-role assignments (group→role) | `POST /servicePrincipals/{id}/appRoleAssignedTo` | swallow "already exists" |
| `appRoleAssignmentRequired: true` | `PATCH /servicePrincipals/{id}` | idempotent |

### 7.2 New console env (all set by the deploy — none by hand)

| Var | Purpose |
|---|---|
| `LOOM_ONBOARDING_ENTRA_GROUP_ID` | **The §3 fix.** Baseline `Loom Users` group. |
| `LOOM_DOMAIN_CONTRIBUTOR_GROUP_ID` | Default contributor group |
| `LOOM_DOMAIN_ADMIN_GROUP_ID` | Default domain-admin group |
| `LOOM_ACCESS_MGMT_ENABLED` | Kill-switch for the identity **write** surface — the one §3 says is missing. Default `true`. |
| `LOOM_ACCESS_EXPIRY_ENABLED` | Enables the expiry reconciler. Default `true`. |

**Existing params that must change:**

| Param | Today (MEASURED) | Required |
|---|---|---|
| `loomIdentityPickerEnabled` | `false` in **all six** param files — hard-`false` in `commercial.bicepparam:137` | **`true` in all clouds.** The wizard's identity picker is unusable otherwise (defect D). Note siblings `loomWorkspaceM365LinkEnabled` and `loomSharepointShortcutsEnabled` already default `true` — the picker is the inconsistent one. |
| `loomDomainGroupProvisioningEnabled` | module default `false`, absent from every param file | `true` — the design provisions groups |

`LOOM_GRAPH_BASE` already exists and is set unconditionally per boundary at
`main.bicep:5242`. But see defect **C** — a second, divergent `graphBase()` in
`msal.ts` ignores it and has no IL5/DoD branch, and that is the one the group
fallback uses. Fixing C is a prerequisite for the Gov receipts in §10.

### 7.3 Graph app roles the Console UAMI needs

| App role | For | Held today? |
|---|---|---|
| `User.Invite.All` | invite guests | ✅ MEASURED |
| `User.ReadWrite.All` | create / pause / delete | ✅ MEASURED |
| `GroupMember.ReadWrite.All` | grant + revoke role | ✅ MEASURED |
| `User.Read.All` / `Group.Read.All` / `Directory.Read.All` / `Application.Read.All` | read + search | ✅ MEASURED |
| **`AppRoleAssignment.ReadWrite.All`** | assign/remove app roles | ❌ **MISSING** |
| **`Policy.Read.All`** | read the Settings-tab posture | ❌ MISSING |
| **`Policy.ReadWrite.CrossTenantAccess`** | Fix-it for cross-tenant | ❌ MISSING (optional) |
| **`Policy.ReadWrite.Authorization`** | Fix-it for `allowInvitesFrom` | ❌ MISSING (optional) |
| `EntitlementManagement.ReadWrite.All` | only on the ID Governance path | ❌ MISSING (optional) |

All are admin-consent-required. `grant-identity-graph-approles.sh` extends
naturally; the workflow step's comment must be corrected to list the write roles
it already grants (§3).

### 7.4 Reconciler

An ACA job on the existing cron pattern: expire lapsed grants, remove stale
group memberships, repair drift, alert on guests who never redeemed. It must
**fail closed** and never report success on an unverified outcome
(`deploy-integrity.md` R6).

---

## §8 — The generalized customer story

### 8.1 Same-tenant user

`someone@customer.com` already exists as a member. The wizard skips step 2
entirely (step 1 detects them), goes straight to role + expiry, and grants. No
invitation, no password. This is the majority case for most customers and today
it requires an admin to go find the right Entra group by hand.

### 8.2 Cross-tenant guest — the `@microsoft.com` case, generalized

Partner is an Entra tenant. Wizard invites as B2B guest, they keep their own
credentials and MFA, and their home tenant's Conditional Access still applies.
The customer's admin never leaves Loom.

The one thing outside the customer's control is the partner's **outbound**
setting. Loom detects the specific failure and says so precisely — "the partner
organization blocks outbound B2B collaboration; their admin must allow it" —
rather than a generic error. Per `deploy-integrity.md` R7, it must not claim a
cause it did not establish.

For a partner the customer works with repeatedly, Settings offers **Add a
trusted partner organization**, writing a `crossTenantAccessPolicy/partners`
entry — and, with P1, scoping it to specific users or groups.

### 8.3 Unmanaged / social identity

`someone@gmail.com`, or a `@microsoft.com` person whose tenant blocks outbound.
Entra falls back to **email one-time passcode** — the guest gets a code per
sign-in, no account anywhere
([Learn](https://learn.microsoft.com/entra/external-id/one-time-passcode)).
The wizard states this plainly in step 1 and recommends a shorter default expiry
(30 days), because an OTP guest has no home-tenant lifecycle to inherit — nobody
disables them when they leave their employer. That asymmetry is exactly why
expiry is a first-class field in step 3.

### 8.4 An admin at another organization

They deploy Loom into *their* tenant. Everything above works identically because
the deploy creates their groups, their app roles, and their consent gate. The
only per-customer variable is which domains are theirs, which the wizard reads
from `GET /organization` rather than asking.

---

## §9 — Security analysis

### 9.1 Least privilege

The Console UAMI holds directory-write permissions that are, in Entra terms,
substantial: `User.ReadWrite.All` can create and delete *any* user;
`GroupMember.ReadWrite.All` can add anyone to *any* group, including
`Global Administrator`-assignable ones.

Mitigations the design requires:

1. **Every write route is `withTenantAdmin`.** Already true.
2. **Group writes are allowlisted to the four Loom groups.** The client must
   refuse `addPrincipalToGroup` for any group id not in the Loom set. Without
   this, an SSRF or a route-guard slip escalates to tenant-wide group control.
   This is the highest-value hardening in the document.
3. **`LOOM_ACCESS_MGMT_ENABLED` kill-switch** on the write surface (§3).
4. **Never make the Loom groups role-assignable.** A role-assignable group could
   confer Entra directory roles; these must not be able to.
5. Prefer `Policy.Read.All` over `Directory.ReadWrite.All` for the Settings tab.

### 9.2 What a guest can actually reach

MEASURED: guest access is **Restricted** — they can read only their own
directory object, not the user list or group memberships. That is the correct
posture and the design does not change it.

Inside Loom, once §5.3 lands, a guest with only `Loom Users` gets baseline
access. **Today, with `appRoleAssignmentRequired: false` and no admission tier,
a redeemed guest is authenticated-with-no-scope and can reach every surface that
does not check a tier** — which is the real reason to build §5.3, quite apart
from the wizard.

### 9.3 Blast radius

| Compromise | Reach | Bounded by |
|---|---|---|
| A `Loom Users` guest | Baseline Loom only | app-role gate + tier checks |
| A domain admin | One domain's workspaces | `domain-role.ts` scoping |
| A tenant admin | Everything, incl. granting access | §9.4 |
| The Console UAMI | Directory-wide user + group writes | §9.1 items 2–4 |

### 9.4 Guarding tenant-admin grants

Granting tenant admin from the wizard is the one step that is self-amplifying.
It requires: typed confirmation, a second tenant admin's approval (reuse the
separation-of-duties logic already in `lib/access/approval-authority.ts`), a
high-severity audit entry, and a notification to all existing tenant admins.

### 9.5 Auditability

Every mutation writes an audit entry today (`access-request-provisioned`). The
design extends this to actor, subject, before-state, after-state, the Graph
call, and its response status — so an auditor can reconstruct *why* someone had
access on a given date, not merely that they did. Requests, grants, and
revocations must be exportable.

### 9.6 Revocation must be guaranteed

Restating §4.4 because it is the most common way an access-management feature
lies. Removing a group membership does **not** invalidate an issued token. A
revoke is only real when all four happen:

1. Remove from every Loom group.
2. Remove the app-role assignment.
3. `POST /users/{id}/revokeSignInSessions` — invalidates refresh tokens.
4. Invalidate Loom's own 8-hour session cookie for that oid — which requires a
   server-side revocation list, because the cookie is self-contained and
   stateless today. **This does not exist and must be built.**

Miss (3) and revocation is best-effort for the token lifetime. Miss (4) and it
is a lie for up to eight hours. The acceptance test is behavioural: revoke a
signed-in user in one browser and confirm their *existing* session in another
browser is dead on the next request — not that the group membership changed.

---

## §10 — Per-cloud status

`cloud-parity.md`: Commercial-only is INCOMPLETE. Assessed per boundary.

### 10.1 API availability (from Learn national-cloud tables)

| API | Commercial | GCC | GCC-High (L4) | DoD (L5) |
|---|---|---|---|---|
| `POST /invitations` | ✅ | ✅ | ✅ | ✅ |
| `POST /users`, `PATCH /users`, `DELETE /users` | ✅ | ✅ | ✅ | ✅ |
| `POST /groups/{id}/members/$ref` | ✅ | ✅ | ✅ | ✅ |
| `POST /servicePrincipals/{id}/appRoleAssignedTo` | ✅ | ✅ | ✅ | ✅ |
| `policies/authorizationPolicy` | ✅ | ✅ | ✅ | ✅ |
| `policies/crossTenantAccessPolicy` | ✅ | ✅ | ✅ | ✅ |
| Entitlement management (`accessPackage*`) | ✅ | ✅ | ✅ | ✅ |
| Access reviews | ✅ | ✅ | ✅ | ✅ |

**Every API this design depends on exists in every boundary.** Sources:
[invitation-post](https://learn.microsoft.com/graph/api/invitation-post?view=graph-rest-1.0),
[approleassignedto](https://learn.microsoft.com/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0),
[accessPackageAssignment](https://learn.microsoft.com/graph/api/accesspackageassignment-get?view=graph-rest-1.0),
[deployments](https://learn.microsoft.com/graph/deployments).

Graph endpoints differ per cloud (`graph.microsoft.com` /
`graph.microsoft.us` / `dod-graph.microsoft.us`) and `graph-identity-client.ts`
already derives **both** the base and the token scope from `LOOM_GRAPH_BASE`.
GCC uses the **worldwide** endpoint
([Learn](https://learn.microsoft.com/graph/deployments)).

### 10.2 The behavioural differences that matter

> **The big one.** `allowInvitesFrom` defaults to **`everyone` in every cloud
> except US Government, where it defaults to `none`** — *"Prevent everyone,
> including admins, from inviting guests"*
> ([Learn](https://learn.microsoft.com/graph/api/resources/authorizationpolicy?view=graph-rest-1.0#allowinvitesfrom-values)).
> And app-only invitations do **not** work when B2B invitations are disabled
> ([Learn](https://learn.microsoft.com/graph/api/invitation-post?view=graph-rest-1.0#permissions)).
>
> **So in a stock GCC-High or IL5 tenant, guest invitation — the wizard's
> default path — is blocked out of the box, for the platform identity too.**
> This is not a Loom bug; it is a sovereign default. But shipping without
> handling it would mean the wizard's primary flow fails on first use in Gov.
> It must be a detected, named, one-click Fix-it in the Settings tab (§5.3), and
> the wizard must pre-check it and offer the fix *before* the admin fills in a
> five-step form that is going to fail at step 5.

Also:

- **Cross-cloud (Commercial ↔ Gov) requires bilateral opt-in.** Both tenants
  must enable Microsoft cloud settings for the other cloud *and* add each other
  as partners. Neither side can do it alone
  ([Learn](https://learn.microsoft.com/entra/external-id/cross-cloud-settings)).
- **Cross-cloud guests must be `Guest`** — `invitedUserType: Member` is not
  supported across clouds
  ([Learn](https://learn.microsoft.com/microsoftteams/collaborate-guests-cross-cloud)).
  The wizard must disable "Create tenant member" for a cross-cloud partner.
- **Within Azure US Government**, B2B works only between tenants that both
  support it ([Learn](https://learn.microsoft.com/entra/external-id/troubleshoot#in-an-azure-us-government-tenant-i-cant-invite-a-b2b-collaboration-guest-user)).
- **ID Governance for Government** is a distinct SKU
  ([Learn](https://learn.microsoft.com/entra/id-governance/licensing-fundamentals#types-of-licenses)).

### 10.3 Status per boundary

| Boundary | This design | Caveat |
|---|---|---|
| Commercial | ✅ Fully supported | Baseline; MEASURED against the live tenant |
| GCC | ✅ Fully supported | Worldwide Graph endpoint; verify `allowInvitesFrom` |
| GCC-High (IL4) | ⚠️ Supported **after defect C** | `graph.microsoft.us`; **`allowInvitesFrom` Fix-it is mandatory**; cross-cloud is bilateral |
| DoD (IL5) | ⚠️ Supported **after defect C** | `dod-graph.microsoft.us`; **the group-membership fallback currently targets the wrong Graph host and fails closed silently** (§3.2 C); same caveats; guest-only cross-cloud |

**No capability in this design is Commercial-only** — every API exists in every
boundary. But two things are *not* Gov-ready today: defect **C** (wrong Graph
host on IL5/DoD) and defect **D** (`loomIdentityPickerEnabled` absent from all
three Gov param files). Both are Loom bugs, not Azure limitations, and both are
in the §13 ordering ahead of the wizard.

Per `cloud-parity.md` each boundary needs its own receipt, and per the Gov
access rule that receipt comes from a GitHub Actions run, never local `az`.
**Nothing here has been verified in any Gov boundary** — that is declared, not
implied.

---

## §11 — UX

Per `ux-baseline.md` and `web3-ui.md`:

- Fluent v9 + Loom tokens throughout. No hard-coded px, hex, radii, or shadows.
- `TileGrid` for card grids, `EmptyState` for empty panes, `Spinner`/`Skeleton`
  for loading — never a bare `<div>`.
- **No freeform config.** Verified domains come from `GET /organization`, not a
  text box. Identities come from the existing `<IdentityPicker>`. Roles and
  expiry are radios. The only free text in the whole flow is the deny reason and
  the optional invitation message.
- **G2 — zero day-one gates.** Every gate has an inline **Fix it**, is
  registered in `lib/gates/registry`, and appears on `/admin/gates`.
- **G3 — resizable panes** via `SplitPane` with a persisted `sizingKey`.
- **Clean first open.** No red banners on an untouched wizard; validation
  appears after touch or on submit attempt.
- Badge rows use `flexWrap` + `minWidth: 0` + truncation.
- LearnPopovers on Member-vs-Guest, on each role, and on expiry.
- **G1 — no surface is done without a browser E2E receipt.** `tsc` + `vitest`
  are not completion evidence.

### 11.1 Where it lives, and what to build it out of

**Nav slot: `/admin/access-management`**, in `lib/nav/admin-sections.ts` under
**Access & security governance**, between `/admin/permissions` and
`/admin/access-governance`. There is a genuine unowned gap there:
`/admin/permissions` grants *capabilities*; `/admin/access-governance` runs the
*request → approve → review* lifecycle; **neither binds who is a tenant admin,
domain admin, or domain contributor.** Do not add it to
`governance-sections.ts` (that mirrors the Purview IA); cross-link with
`adminOnly: true` if discoverability from `/governance` is wanted.

**Patterns to reuse (MEASURED — these exist and work):**

| Need | Use | Where |
|---|---|---|
| Route authz | `withTenantAdmin` / `withCapability` HOFs — **not** the hand-rolled `if (gate) return gate;` form, which CI cannot see when deleted | `lib/api/route-toolkit.ts:166`, `:238` |
| Fix-it dialog | `GateFixitDialog` — live option discovery, honest bounded polling (12 × 15 s), never a fake instant flip | `lib/components/shared/honest-gate.tsx:93` |
| Principal picker | `<IdentityPicker>` — real Graph search, transitive expansion, honest 503 naming the missing AppRoles | `lib/components/ui/identity-picker.tsx` |
| Multi-step shell | `workspace-create.tsx` — declarative `STEPS` array, left rail + right pane, option-cards for enums, per-cloud hiding | `lib/wizards/workspace-create.tsx` |
| Branching + long apply | `setup-wizard.tsx` — single `WizardState` object, conditional steps, terminal `deploying`/`done`, existing boundary step | `lib/panes/setup-wizard.tsx` |
| Shell + Learn | `AdminShell` with the `learn={{…}}` prop | `lib/components/admin-shell.tsx` |

> **There is no shared `<Wizard>` primitive.** MEASURED: ~20 wizards each
> hand-roll step state; `lib/components/wizard/` contains a single form, not a
> shell. This work is a good opportunity to **extract one** — a `WizardShell`
> taking a declarative `STEPS` array, rail, and Back/Next guards — rather than
> adding a 21st hand-rolled implementation.

---

## §12 — Alternatives rejected

| Alternative | Why not |
|---|---|
| **Entra Entitlement Management as the engine** | Requires ID Governance / P2 / EMS E5, licensed per *potential requester* (§4.3). Offer it as a detected upgrade, never a prerequisite. |
| **App roles as the source of truth** | Zero app roles exist today; app roles do not carry to ADLS/Synapse/Purview/Unity, forcing a second parallel grant model (§4.2). Adopt as a complement. |
| **A Loom-local user store** | Re-implements identity badly; breaks Conditional Access, MFA, and every downstream Azure RBAC grant. Violates `auto-bind-by-default.md`. |
| **Domain-suffix auto-admission** (anyone `@microsoft.com` gets in) | No revocation story, no per-person audit, no expiry, and it grants access to people who never asked. |
| **Delete as the revoke primitive** | Terminal and destructive; loses the audit subject. Reserved for offboarding (§4.4). |
| **PIM for Groups for time-bound access** | Correct primitive, but P2/ID Governance-gated and, once a group is PIM-managed, it can never be un-managed. Optional enhancement only. |
| **Keep the instruction-string approve** | The platform holds the permission to perform the grant. Telling the admin to go do it by hand is a defect under `auto-bind-by-default.md`. |

---

## §13 — Implementation order

| # | Work | Why this order |
|---|---|---|
| 0 | **Fix the §3 privilege-escalation fallback** | P0. Independent of everything else. |
| 0b | **Fix defects A, B, C** (§3.2): bound the `groups` cookie, add the Graph fallback to `isTenantAdmin`/`checkCapability`, unify `graphBase()` | All three break group-based authorization — the primitive the whole design rests on. C is the Gov blocker. |
| 1 | Deploy provisions the four groups + env wiring + flips `loomIdentityPickerEnabled` | Nothing below works without it |
| 2 | App roles + `appRoleAssignmentRequired` + admission tier | The missing front door |
| 3 | Session-revocation list | §9.6 — revocation is a lie without it |
| 4 | Extract a shared `WizardShell` | Avoids a 21st hand-rolled wizard (§11.1) |
| 5 | Requests wizard (§5.1) + in-product request path for authenticated-but-ungranted users | The operator's headline ask |
| 6 | People tab (§5.2) | Mostly wiring the orphaned lifecycle route (defect F) |
| 7 | Settings tab + gate registry (§5.3) | Includes the Gov `allowInvitesFrom` Fix-it |
| 8 | Expiry reconciler | Time-bound access becomes real |
| 9 | Gov receipts (GCC-High + IL5, via Actions) | `cloud-parity.md` — untested is not done |
| 10 | ID Governance detection + optional handoff | Enhancement |
| 11 | Correct the stale docs + instruction string (defect G) | Cheap, and they actively mislead |

---

## Appendix A — Measurement commands

Read-only. Safe to re-run. Mask GUIDs before pasting anywhere.

```bash
# Cross-tenant inbound posture + any partner overrides
az rest --method GET --url "https://graph.microsoft.com/v1.0/policies/crossTenantAccessPolicy/default"
az rest --method GET --url "https://graph.microsoft.com/v1.0/policies/crossTenantAccessPolicy/partners"

# Who may invite guests, and how much a guest can see
az rest --method GET --url "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
  --query "{invites:allowInvitesFrom, guestRole:guestUserRoleId}"

# Does the Loom app gate sign-in? Does it define any app roles?
az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals(appId='<loom-app-id>')" \
  --query "{assignmentRequired:appRoleAssignmentRequired, roles:appRoles[].value}"

# Which Graph app roles does the Console UAMI actually hold?
az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/<uami-sp-id>/appRoleAssignments"

# §3 regression guard — must print a group id once fixed
az containerapp show -n loom-console -g <rg> \
  --query "properties.template.containers[0].env[?name=='LOOM_ONBOARDING_ENTRA_GROUP_ID'].value|[0]"
```

## Appendix B — Related rules

`auto-bind-by-default.md` (§5 infra is deployed, not requested) ·
`cloud-parity.md` (same capabilities every cloud) ·
`deploy-integrity.md` (R4 both clouds, R6 self-diagnosis, R7 true errors) ·
`no-vaporware.md` (real backend, bicep sync) ·
`ux-baseline.md` (G1 browser E2E, G2 zero day-one gates, G3 resizable) ·
`web3-ui.md` (Fluent v9 + Loom tokens).
