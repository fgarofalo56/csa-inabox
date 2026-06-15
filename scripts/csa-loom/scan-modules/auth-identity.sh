#!/usr/bin/env bash
# =====================================================================
# scan-module: Auth, session & admin RBAC (GH #1383)
# =====================================================================
# Contributes the auth-domain scan-and-choose prompts to scan-and-deploy.sh:
#   1. Entra app registration (MSAL) — use-existing / provision-new / disable.
#   2. Bootstrap tenant admin — signed-in user (recommended) or a group oid.
#   3. Session secret — always provisioned new (KV); BYO via env.
#
# Emits `param` lines into $LOOM_SCAN_PARAM_OUT consumed by scan-and-deploy.sh.
# Reads: LOOM_SCAN_DEFAULTS, LOOM_SCAN_SUB, scan_choice (exported helper).
# =====================================================================

scan_auth_identity() {
  local out="${LOOM_SCAN_PARAM_OUT:?}"
  local sub="${LOOM_SCAN_SUB:-}"

  # ---- 1. Entra app registration (MSAL) -----------------------------------
  # Discover existing Loom Console app registrations in the tenant.
  local existing
  existing="$(az ad app list --filter "startswith(displayName,'CSA Loom Console')" \
                --query "[].{name:displayName, appId:appId}" -o tsv 2>/dev/null || true)"
  if [ -n "${existing}" ]; then
    echo "  Found existing Loom Console app registration(s):" >&2
    echo "${existing}" | sed 's/^/    /' >&2
  else
    echo "  No existing 'CSA Loom Console' app registration found." >&2
  fi
  local appchoice
  appchoice="$(scan_choice 'Entra app registration (MSAL sign-in)' new)"
  case "${appchoice}" in
    existing)
      local appid
      appid="$(echo "${existing}" | head -1 | awk '{print $NF}')"
      echo "param loomMsalClientId = '${appid:-}'" >> "${out}"
      echo "param loomMsalAppReg = { enabled: true, scriptIdentityId: '', scriptIdentityClientId: '', scriptSubnetId: '', consoleHosts: '' }" >> "${out}"
      ;;
    disable)
      echo "param loomMsalClientId = ''" >> "${out}"
      echo "param loomMsalAppReg = { enabled: false, scriptIdentityId: '', scriptIdentityClientId: '', scriptSubnetId: '', consoleHosts: '' }" >> "${out}"
      ;;
    *) # new (recommended)
      echo "param loomMsalAppReg = { enabled: true, scriptIdentityId: '', scriptIdentityClientId: '', scriptSubnetId: '', consoleHosts: '' }" >> "${out}"
      ;;
  esac

  # ---- 2. Bootstrap tenant admin (REQUIRED — recommend signed-in user) -----
  local me_oid
  me_oid="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
  if [ -z "${me_oid}" ]; then
    # CI / SP context — use the running SP's object id.
    me_oid="$(az ad sp show --id "$(az account show --query user.name -o tsv 2>/dev/null)" --query id -o tsv 2>/dev/null || true)"
  fi
  local adminchoice
  if [ "${LOOM_SCAN_DEFAULTS}" = "1" ]; then
    adminchoice="self"
  else
    echo "  Bootstrap tenant admin — [s]elf (${me_oid:-signed-in user}, recommended) / [g]roup oid" >&2
    read -r -p "  choice [self]: " a </dev/tty || a=""
    case "${a:-}" in g|group) adminchoice="group" ;; *) adminchoice="self" ;; esac
  fi
  if [ "${adminchoice}" = "group" ]; then
    local gid
    read -r -p "  admin group oid: " gid </dev/tty || gid=""
    echo "param loomTenantAdminGroupId = '${gid}'" >> "${out}"
  else
    echo "param loomTenantAdminOid = '${me_oid:-}'" >> "${out}"
  fi

  # ---- 3. Session secret (always provisioned; BYO via env) -----------------
  # Provisioned to Key Vault by the entra-app-registration script / bootstrap.
  # Honor an explicit BYO value if the operator exported one.
  if [ -n "${LOOM_SESSION_SECRET:-}" ]; then
    echo "param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', '')" >> "${out}"
  fi

  echo "  auth-identity: wiring emitted (app=${appchoice}, admin=${adminchoice:-self})" >&2
}
