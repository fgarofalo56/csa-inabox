# Global parity gap: Sign-in flow

**Validated**: 2026-05-26  
**Surface**: `/auth/sign-in` → MSAL redirect → `/auth/callback` → home  
**Component**: `apps/fiab-console/app/auth/sign-in/route.ts` + `app/auth/callback/route.ts` + `lib/auth/msal.ts`  
**Fabric reference**: Fabric uses MSAL → app.fabric.microsoft.com after token mint  
**Backend probed**: Live navigation to `/auth/sign-in`

## What renders

- Navigate to `/auth/sign-in?returnTo=/` → 302 to `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
- Tenant ID: `<tenant-id>`
- Client ID: `<app-client-id>`
- Scopes: `openid profile email offline_access User.Read`
- redirect_uri: `https://<your-console-hostname>/auth/callback`
- response_mode: `query`
- response_type: `code`
- prompt: `select_account`
- MSAL Node SDK: `msal.js.node 2.16.3`
- Auth code flow with PKCE (`client_info=1`)

## Functional probes

- Visit `/auth/sign-in` → MSAL handshake URL is correct — PASS
- Microsoft sign-in page renders normally — PASS
- (Did NOT submit credentials in this run; that would require user interaction)
- After successful sign-in earlier in this session, `/api/me` returned `{authenticated:true, user:{name:"Platform Admin (UAT)", email:"admin@contoso.gov", upn:"admin@contoso.gov", oid:"866a2e12-..."}}` — PASS

## Observations

- Auth state in the MCP browser repeatedly dropped during the session. Sometimes `/api/me` returned `{authenticated:false}` even though the page header showed "FG" avatar. This suggests a **cookie / SameSite race** between Front Door routing and Next.js server-rendering. Real users on stable browsers may not experience this, but it's an instability to flag.
- After auth dropped, refreshing the page sometimes restored auth (presumably the silent token refresh path), sometimes did not. The user experience here is **unpredictable**.

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| MSAL redirect on sign-in | YES | — | Correct tenant, scopes, redirect_uri |
| Account picker (`prompt=select_account`) | YES | — | |
| PKCE | YES (`client_info=1`) | — | |
| `/auth/callback` exchange | YES (code-level) | — | Not validated end-to-end |
| Silent token refresh | UNCLEAR | MAJOR | Auth state instability observed |
| Sign-out flow | NOT TESTED | — | |
| Multi-tenant guest support | NOT TESTED | — | |

## Grade: **B-**

The MSAL handshake URL is well-formed. The redirect dance works at the front. But session stability is suspect — auth flapped during this validation. Needs a follow-up dedicated to silent-refresh debugging.
