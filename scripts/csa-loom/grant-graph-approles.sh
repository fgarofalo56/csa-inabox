#!/usr/bin/env bash
# Grant Microsoft Graph application AppRoles to the Console UAMI so the
# /admin/security MIP + DLP tabs can call real Graph endpoints.
#
# Idempotent — Graph returns 201 on first grant, then a clear "permission
# already exists" error on subsequent runs (which we treat as success).
#
# For a MANAGED IDENTITY, the appRoleAssignment POST below IS the grant —
# there is NO separate "Grant admin consent" click. (That interactive consent
# step is the APP-REGISTRATION pattern, where a delegated/app permission is
# *requested* and a Global/Application Administrator must approve it. A managed
# identity has no app registration and no consent prompt: assigning the app
# role directly to the MI's service principal is the grant, and it takes effect
# immediately.) The only thing this script needs is a caller with the directory
# privilege to assign Graph app roles — AppRoleAssignment.ReadWrite.All on
# Microsoft Graph (or Privileged Role Administrator). If the caller lacks it the
# POST returns 403; see the remediation printed at the end + docs/fiab/v3-tenant-bootstrap.md.
#
# Usage:
#   az login    # as a user/SP with AppRoleAssignment.ReadWrite.All on Graph
#   CONSOLE_UAMI_PRINCIPAL=<console UAMI object id> ./grant-graph-approles.sh
#
# Default principal: c-loom-console-eastus2 UAMI object id used by the
# limitlessdata sub. Override via env if you're in a different deployment.

set -euo pipefail

CONSOLE_UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-e61f3eb3-c646-4183-8198-4c4a34cd9a01}"

echo "Target Console UAMI principal: $CONSOLE_UAMI_PRINCIPAL"
GRAPH_SP_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
echo "Microsoft Graph SP object id: $GRAPH_SP_ID"

# App-role (application permission) ids — NOT the delegated ids. Verified against
# Microsoft Graph permissions reference. The /admin/security MIP + DLP tabs call
# Graph app-only with the Console UAMI, so these MUST be the Application app-role
# ids under the Graph SP's appRoles[] (type=Role), not oauth2PermissionScopes.
#   InformationProtectionPolicy.Read.All -> MIP sensitivity-label policy reads
#   Policy.Read.All                      -> DLP / tenant policy reads
#   SecurityAlert.Read.All               -> DLP alerts/violations (alerts_v2)
#   SecurityIncident.Read.All            -> Graph Security incidents; alerts_v2
#                                           403 names this alongside SecurityAlert,
#                                           so granting both clears the DLP/IP
#                                           "Missing application roles" gate.
declare -a ROLES=(
  "InformationProtectionPolicy.Read.All:19da66cb-0fb0-4390-b071-ebc76a349482"
  "Policy.Read.All:246dd0d5-5bd0-4def-940b-0421030a5b68"
  "SensitivityLabel.Evaluate:57f0b71b-a759-45a0-9a0f-cc099fbd9a44"
  "SecurityAlert.Read.All:bf394140-e372-4bf9-a898-299cfc7564e5"
  "SecurityIncident.Read.All:45cc0394-e837-488b-a098-1918f48d186c"
)

TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

FORBIDDEN=0
for ROLE in "${ROLES[@]}"; do
  NAME="${ROLE%%:*}"
  APPROLE_ID="${ROLE##*:}"
  echo "Granting $NAME ($APPROLE_ID)..."
  PAYLOAD=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' \
    "$CONSOLE_UAMI_PRINCIPAL" "$GRAPH_SP_ID" "$APPROLE_ID")
  STATUS=$(curl -sS -w "%{http_code}" -o /tmp/approle.json -X POST \
    "https://graph.microsoft.com/v1.0/servicePrincipals/$CONSOLE_UAMI_PRINCIPAL/appRoleAssignments" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
  if [[ "$STATUS" == "201" ]]; then
    echo "  $NAME granted"
  elif grep -q "Permission being assigned already exists" /tmp/approle.json 2>/dev/null; then
    echo "  $NAME already granted (idempotent)"
  elif [[ "$STATUS" == "403" ]]; then
    FORBIDDEN=1
    echo "  $NAME grant 403 FORBIDDEN — the signed-in principal cannot assign Graph app roles."
  else
    echo "  $NAME grant returned $STATUS: $(cat /tmp/approle.json)"
  fi
done

if [[ "$FORBIDDEN" == "1" ]]; then
  cat <<EOF

==================================================================
  ONE-TIME TENANT ACTION REQUIRED — Graph AppRole grants 403'd.
==================================================================
The deploy/bootstrap principal lacks the directory privilege to assign
Microsoft Graph application roles to the Console UAMI. Assigning an app role
to a managed identity IS the grant (no interactive admin-consent step), but
it requires AppRoleAssignment.ReadWrite.All on Microsoft Graph.

A Global Administrator / Privileged Role Administrator runs ONCE (replace the
ids for your deployment):

  DEPLOY_SP_OBJID=<the deploy SP service-principal object id>
  GRAPH_SP_ID=\$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
  APPROLE_RW=\$(az ad sp show --id \$GRAPH_SP_ID \\
    --query "appRoles[?value=='AppRoleAssignment.ReadWrite.All'].id | [0]" -o tsv)
  az rest --method POST \\
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/\$DEPLOY_SP_OBJID/appRoleAssignments" \\
    --headers "Content-Type=application/json" \\
    --body "{\"principalId\":\"\$DEPLOY_SP_OBJID\",\"resourceId\":\"\$GRAPH_SP_ID\",\"appRoleId\":\"\$APPROLE_RW\"}"

Then re-run this bootstrap job — the grants succeed unattended thereafter.
Until then /admin/security MIP+DLP tabs render the honest 503 NotConfigured
MessageBar (no vaporware). Full details: docs/fiab/v3-tenant-bootstrap.md.
==================================================================
EOF
  exit 0
fi

cat <<'EOF'

Done — Graph AppRoles assigned to the Console UAMI. Because these are
app-role assignments to a MANAGED IDENTITY, they take effect immediately —
there is NO separate "Grant admin consent" click.

Make sure the Console Container App has (set day-one by the bicepparam):

    LOOM_MIP_ENABLED=true
    LOOM_DLP_ENABLED=true

(or set loomMipEnabled=true / loomDlpEnabled=true in the bicepparam and
redeploy admin-plane).

EOF
