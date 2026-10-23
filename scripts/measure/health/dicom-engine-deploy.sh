#!/usr/bin/env bash
# dicom-engine-deploy.sh - LHDS W0-2: dcm4chee-arc-light on AKS + PostgreSQL + Azure Blob storage descriptor,
# in the SANDBOX resource group only (sandbox.sh creates the group, AKS, PostgreSQL, Key Vault, CMK key and VNet).
#
# STATUS: executed against the DEV sandbox on 2026-10-23 (see PRPs/active/loom-health-data-services/W0-RECEIPT.md
# section 3, "DEV run"). Anything that run did not exercise is called out in the KNOWN GAPS below.
#
# HARD GUARDS (checked first, before any az call):
#   - LHDS_SANDBOX_SUBSCRIPTION and LHDS_SANDBOX_RG must both be set. There is NO default and the script never
#     reads `az account show` to pick one.
#   - After `az account set`, the active subscription id must equal LHDS_SANDBOX_SUBSCRIPTION or it aborts.
#   - The resource group must already exist (operator-created); this script never creates a resource group.
#   - Without LHDS_DEPLOY_CONFIRM=yes it only PRINTS the plan and writes the values/manifests under temp/.
#
# Required env (no defaults):
#   LHDS_SANDBOX_SUBSCRIPTION  LHDS_SANDBOX_RG  LHDS_LOCATION
#   LHDS_AKS_NAME              existing or to-be-created AKS cluster name (created if absent)
#   LHDS_PG_SERVER             PostgreSQL Flexible Server name (created if absent)
#   LHDS_STORAGE_ACCOUNT       Blob account for pixel data (created if absent; flat namespace, ADR-004)
#   PostgreSQL credential, ONE of:
#     LHDS_PG_K8S_SECRET       name of an EXISTING Kubernetes secret in the namespace with keys `username` and
#                              `password` (sandbox.sh creates lhds-pg-admin). Nothing is read or printed.
#     LHDS_PG_ADMIN_PASSWORD   from env only; becomes the k8s secret lhds-pg (user from LHDS_PG_ADMIN_USER)
#   CMK (ADR-002 bar): LHDS_CMK_VAULT_URI  LHDS_CMK_KEY_NAME  LHDS_CMK_IDENTITY_ID  (or LHDS_CMK_SKIP=yes,
#                      which records "CMK NOT TESTED" in the output and means the CMK bar is unmeasured)
#   Private endpoint (ADR-002 bar): LHDS_PE_VNET_ID  LHDS_PE_SUBNET_NAME  (or LHDS_PE_SKIP=yes, same disclosure)
# Optional env:
#   LHDS_STORAGE_CREDENTIAL    account key or SAS for the jclouds descriptor. If unset the script reads the account
#                              key with `az storage account keys list` straight into memory (never printed).
#   LHDS_STORAGE_MODE=azureblob|filesystem   default azureblob. `filesystem` skips the Blob descriptor and leaves the
#                              archive on its default PVC-backed storage (the fallback when Blob fails).
#   LHDS_STORAGE_PUBLIC_NETWORK=Enabled|Disabled   default Enabled (set Disabled after bring-up to prove the
#                              private-endpoint-only path)
#   LHDS_PE_DNS_ZONE_ID (default: the script creates privatelink.blob.core.windows.net in the RG and links the VNet)
#   LHDS_PG_ADMIN_USER (pacs)  LHDS_PG_DB (pacsdb)  LHDS_PG_FQDN (default $LHDS_PG_SERVER.postgres.database.azure.com)
#   LHDS_AKS_VM_SIZE (default Standard_D8s_v5) LHDS_AKS_NODES (default 3, used only when the cluster is created)
#   LHDS_PG_SKU (default Standard_D4ds_v5, used only when the server is created)
#   LHDS_K8S_NAMESPACE (default lhds-w0-dicom) LHDS_ARC_IMAGE=dcm4che/dcm4chee-arc-psql:5.35.2
#   LHDS_LDAP_IMAGE=dcm4che/slapd-dcm4chee:2.6.15-35.2 LHDS_PG_SCHEMA_IMAGE=dcm4che/postgres-dcm4chee:17.9-35
#   LHDS_ARC_JAVA_OPTS (default heap 4g; the image default is -Xmx512m, which is a toy)  LHDS_VALUES_DIR
#   (default temp/lhds-w0/l2/deploy)
#
# KNOWN GAPS (do not paper over; each is a W0 finding to settle on the sandbox):
#   G1  The dcm4che wiki documents jclouds storage only for S3 (identity/credential/container). The Azure
#       descriptor `jclouds:azureblob:https://<acct>.blob.core.windows.net` with identity=<account name>,
#       credential=<key or SAS>, container=<name> uses the azureblob provider jar that ships in the arc image
#       (/opt/wildfly/modules/org/apache/jclouds, azureblob-2.7.0.jar). What a running archive does with it is
#       recorded in the receipt, not here. Shared-key auth also means no managed identity.
#   G2  There is no Loom-owned Helm chart yet (ADR-002 says Loom will own one). W0 uses plain manifests rendered here;
#       "Helm values" below is the parameter record that a future chart would consume.
#   G3  The schema is loaded by a one-shot Job (psql from the postgres-dcm4chee image's init SQL). The Gov path and
#       a Loom-owned schema migration are not covered.
set -euo pipefail
die() { echo "ERROR: $*" >&2; exit 1; }

# ---------------- guards ----------------
for v in LHDS_SANDBOX_SUBSCRIPTION LHDS_SANDBOX_RG LHDS_LOCATION LHDS_AKS_NAME LHDS_PG_SERVER LHDS_STORAGE_ACCOUNT; do
  [[ -n "${!v:-}" ]] || die "required env var $v is not set - refusing (no default subscription or resource group, by design)"
done
[[ -n "${LHDS_PG_K8S_SECRET:-}" || -n "${LHDS_PG_ADMIN_PASSWORD:-}" ]] \
  || die "set LHDS_PG_K8S_SECRET (existing secret with username/password keys) or LHDS_PG_ADMIN_PASSWORD"
STORAGE_MODE="${LHDS_STORAGE_MODE:-azureblob}"
[[ "$STORAGE_MODE" == "azureblob" || "$STORAGE_MODE" == "filesystem" ]] || die "LHDS_STORAGE_MODE must be azureblob or filesystem"
PUBNET="${LHDS_STORAGE_PUBLIC_NETWORK:-Enabled}"
[[ "$PUBNET" == "Enabled" || "$PUBNET" == "Disabled" ]] || die "LHDS_STORAGE_PUBLIC_NETWORK must be Enabled or Disabled"
if [[ "${LHDS_CMK_SKIP:-}" != "yes" ]]; then
  for v in LHDS_CMK_VAULT_URI LHDS_CMK_KEY_NAME LHDS_CMK_IDENTITY_ID; do
    [[ -n "${!v:-}" ]] || die "CMK env $v not set (or set LHDS_CMK_SKIP=yes to run without CMK, leaving that bar unmeasured)"
  done
fi
if [[ "${LHDS_PE_SKIP:-}" != "yes" ]]; then
  for v in LHDS_PE_VNET_ID LHDS_PE_SUBNET_NAME; do
    [[ -n "${!v:-}" ]] || die "private-endpoint env $v not set (or set LHDS_PE_SKIP=yes, leaving that bar unmeasured)"
  done
fi
SUB="$LHDS_SANDBOX_SUBSCRIPTION"; RG="$LHDS_SANDBOX_RG"; LOC="$LHDS_LOCATION"
NS="${LHDS_K8S_NAMESPACE:-lhds-w0-dicom}"
ARC_IMAGE="${LHDS_ARC_IMAGE:-dcm4che/dcm4chee-arc-psql:5.35.2}"
LDAP_IMAGE="${LHDS_LDAP_IMAGE:-dcm4che/slapd-dcm4chee:2.6.15-35.2}"
SCHEMA_IMAGE="${LHDS_PG_SCHEMA_IMAGE:-dcm4che/postgres-dcm4chee:17.9-35}"
VM="${LHDS_AKS_VM_SIZE:-Standard_D8s_v5}"; NODES="${LHDS_AKS_NODES:-3}"; PGSKU="${LHDS_PG_SKU:-Standard_D4ds_v5}"
PG_USER="${LHDS_PG_ADMIN_USER:-pacs}"; PG_DB="${LHDS_PG_DB:-pacsdb}"
PG_FQDN="${LHDS_PG_FQDN:-$LHDS_PG_SERVER.postgres.database.azure.com}"
PG_SECRET="${LHDS_PG_K8S_SECRET:-lhds-pg}"
JAVA_OPTS_ARC="${LHDS_ARC_JAVA_OPTS:--Xms256m -Xmx4g -XX:MetaspaceSize=96M -XX:MaxMetaspaceSize=256m -Djava.net.preferIPv4Stack=true -Djboss.modules.system.pkgs=org.jboss.byteman -Djava.awt.headless=true}"
VALUES_DIR="${LHDS_VALUES_DIR:-temp/lhds-w0/l2/deploy}"
CONTAINER=lhds-w0-dicom
export MSYS_NO_PATHCONV=1   # Git Bash would otherwise rewrite /subscriptions/... ids

# ---------------- values + manifests (written to temp/, no secrets inside) ----------------
mkdir -p "$VALUES_DIR"
cat > "$VALUES_DIR/values.yaml" <<VALUES
# Parameter record for the W0-2 sandbox deploy (no secrets). Generated by dicom-engine-deploy.sh.
namespace: $NS
archive: {image: "$ARC_IMAGE", db: $PG_DB, dbHost: "$PG_FQDN", javaOpts: "$JAVA_OPTS_ARC"}
ldap: {image: "$LDAP_IMAGE", replicas: 1, kind: StatefulSet}
storage: {account: "$LHDS_STORAGE_ACCOUNT", mode: "$STORAGE_MODE", flatNamespace: true, descriptor: "jclouds:azureblob", cmkSkipped: "${LHDS_CMK_SKIP:-no}", privateEndpointSkipped: "${LHDS_PE_SKIP:-no}", publicNetwork: "$PUBNET"}
secrets: {pg: "k8s secret $PG_SECRET (username, password)", ldap: "k8s secret lhds-ldap (generated)", blob: "k8s secret lhds-blob (from az or env)"}
VALUES
cat > "$VALUES_DIR/manifests.yaml" <<MANIFESTS
apiVersion: v1
kind: Namespace
metadata: {name: $NS}
---
apiVersion: v1
kind: Service
metadata: {name: ldap, namespace: $NS}
spec: {selector: {app: ldap}, ports: [{port: 389}], clusterIP: None}
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: ldap, namespace: $NS}
spec:
  serviceName: ldap
  replicas: 1
  selector: {matchLabels: {app: ldap}}
  template:
    metadata: {labels: {app: ldap}}
    spec:
      containers:
        - name: ldap
          image: $LDAP_IMAGE
          ports: [{containerPort: 389}]
          env:
            - {name: LDAP_ROOTPASS, valueFrom: {secretKeyRef: {name: lhds-ldap, key: rootpass}}}
            - {name: LDAP_CONFIGPASS, valueFrom: {secretKeyRef: {name: lhds-ldap, key: configpass}}}
          volumeMounts:
            - {name: data, mountPath: /var/lib/openldap/openldap-data}
            - {name: conf, mountPath: /etc/openldap/slapd.d}
  volumeClaimTemplates:
    - {metadata: {name: data}, spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 2Gi}}}}
    - {metadata: {name: conf}, spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: arc-storage, namespace: $NS}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 32Gi}}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: arc, namespace: $NS}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: arc}}
  template:
    metadata: {labels: {app: arc}}
    spec:
      containers:
        - name: arc
          image: $ARC_IMAGE
          ports: [{containerPort: 8080}, {containerPort: 11112}]
          env:
            - {name: POSTGRES_HOST, value: "$PG_FQDN"}
            - {name: POSTGRES_DB, value: $PG_DB}
            - {name: POSTGRES_JDBC_PARAMS, value: "?sslmode=require"}
            - {name: POSTGRES_USER, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: username}}}
            - {name: POSTGRES_PASSWORD, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: password}}}
            - {name: LDAP_URL, value: "ldap://ldap:389"}
            - {name: LDAP_ROOTPASS, valueFrom: {secretKeyRef: {name: lhds-ldap, key: rootpass}}}
            - {name: WILDFLY_CHOWN, value: "/opt/wildfly/standalone /storage"}
            - {name: WILDFLY_WAIT_FOR, value: "ldap:389 $PG_FQDN:5432"}
            - {name: JAVA_OPTS, value: "$JAVA_OPTS_ARC"}
          # Ready only when the archive REST layer answers (value that breaks it: a booted WildFly whose EAR failed).
          readinessProbe: {httpGet: {path: /dcm4chee-arc/aets/DCM4CHEE/rs/instances/count, port: 8080}, initialDelaySeconds: 30, periodSeconds: 10, failureThreshold: 60}
          volumeMounts:
            - {name: storage, mountPath: /storage}
      volumes:
        - {name: storage, persistentVolumeClaim: {claimName: arc-storage}}
---
apiVersion: v1
kind: Service
metadata: {name: arc, namespace: $NS}
spec: {selector: {app: arc}, ports: [{name: http, port: 8080}, {name: dicom, port: 11112}]}
MANIFESTS
cat > "$VALUES_DIR/schema-job.yaml" <<JOB
apiVersion: batch/v1
kind: Job
metadata: {name: pg-schema, namespace: $NS}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: sql
          image: $SCHEMA_IMAGE
          command: [sh, -c, "cp /docker-entrypoint-initdb.d/*.sql /sql/"]
          volumeMounts: [{name: sql, mountPath: /sql}]
      containers:
        - name: psql
          image: postgres:16
          command:
            - sh
            - -c
            - |
              set -e
              # Positive control first: the credential must reach the server before "no table" means anything.
              psql -tAc "select 1" > /dev/null
              if [ -n "\$(psql -tAc "select to_regclass('public.patient')")" ]; then echo "schema already present"; exit 0; fi
              for f in /sql/10_create-psql.sql /sql/20_create-fk-index.sql /sql/30_create-case-insensitive-index.sql; do
                psql -v ON_ERROR_STOP=1 -q -f "\$f"
              done
              # equivalent of the postgres-dcm4chee image's 35_set-collapse-limit.sh, per database
              psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$PG_DB\" SET join_collapse_limit = 16" -c "ALTER DATABASE \"$PG_DB\" SET from_collapse_limit = 16"
              echo "schema loaded: \$(psql -tAc "select count(*) from information_schema.tables where table_schema='public'") tables"
          env:
            - {name: PGHOST, value: "$PG_FQDN"}
            - {name: PGDATABASE, value: "$PG_DB"}
            - {name: PGSSLMODE, value: require}
            - {name: PGUSER, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: username}}}
            - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: password}}}
          volumeMounts: [{name: sql, mountPath: /sql}]
      volumes: [{name: sql, emptyDir: {}}]
JOB
echo "wrote $VALUES_DIR/values.yaml, manifests.yaml and schema-job.yaml"

if [[ "${LHDS_DEPLOY_CONFIRM:-}" != "yes" ]]; then
  echo "PLAN ONLY (set LHDS_DEPLOY_CONFIRM=yes to execute): in subscription $SUB, RG $RG ($LOC):"
  echo "  1 verify active subscription == $SUB and RG exists"
  echo "  2 storage account $LHDS_STORAGE_ACCOUNT (StorageV2, flat namespace, versioning, soft delete 30d, public access off), mode $STORAGE_MODE"
  echo "  3 CMK skipped: ${LHDS_CMK_SKIP:-no}; private endpoint skipped: ${LHDS_PE_SKIP:-no}"
  echo "  4 PostgreSQL flexible server $LHDS_PG_SERVER ($PGSKU) if absent, database $PG_DB, schema Job"
  echo "  5 AKS $LHDS_AKS_NAME ($NODES x $VM) if absent; kubectl apply manifests; register the Blob storage descriptor"
  exit 0
fi

# ---------------- execute (sandbox only) ----------------
mkdir -p temp/lhds-w0
az account set --subscription "$SUB"
active="$(az account show --query id -o tsv)"
[[ "$active" == "$SUB" ]] || die "active subscription '$active' != LHDS_SANDBOX_SUBSCRIPTION '$SUB' - aborting before any write"

# exists CMD...: 0 if the resource exists, 1 if the service says it does not. Any OTHER failure (auth, network,
# throttling) aborts with the real stderr and is never read as "absent" (deploy-integrity R7).
exists() {
  local err rc=0
  err="$(mktemp -p temp/lhds-w0 exists.XXXXXX)"
  "$@" --only-show-errors -o none 2> "$err" || rc=$?
  if [[ $rc -eq 0 ]]; then rm -f "$err"; return 0; fi
  if grep -qiE "not ?found|could not be found|does not exist|ResourceNotFound|was not found|ResourceGroupNotFound" "$err"; then
    rm -f "$err"; return 1
  fi
  echo "ERROR: existence check failed (rc=$rc) for: $*" >&2; cat "$err" >&2; rm -f "$err"; exit 1
}
exists az group show -n "$RG" --subscription "$SUB" || die "resource group $RG does not exist in $SUB (operator creates it; this script will not)"

if ! exists az storage account show -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB"; then
  ident=()
  [[ "${LHDS_CMK_SKIP:-}" == "yes" ]] || ident=(--identity-type UserAssigned --user-identity-id "$LHDS_CMK_IDENTITY_ID")
  az storage account create -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" -l "$LOC" --subscription "$SUB" --sku Standard_LRS \
    --kind StorageV2 --enable-hierarchical-namespace false --allow-blob-public-access false --min-tls-version TLS1_2 \
    "${ident[@]}" -o none
  az storage account blob-service-properties update --account-name "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" \
    --enable-versioning true --enable-delete-retention true --delete-retention-days 30 -o none
fi
# Container via ARM: works whatever the account's data-plane network setting is (a private-endpoint-only account
# would refuse a data-plane create from a workstation).
az storage container-rm create --storage-account "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" -n "$CONTAINER" -o none
if [[ "${LHDS_CMK_SKIP:-}" != "yes" ]]; then
  az storage account update -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" --encryption-key-source Microsoft.Keyvault \
    --encryption-key-vault "$LHDS_CMK_VAULT_URI" --encryption-key-name "$LHDS_CMK_KEY_NAME" \
    --key-vault-user-identity-id "$LHDS_CMK_IDENTITY_ID" -o none
  # Positive check: the account must now report the Key Vault key source, or the CMK cell stays unmeasured.
  ks="$(az storage account show -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" --query encryption.keySource -o tsv)"
  [[ "$ks" == "Microsoft.Keyvault" ]] || die "CMK update returned success but encryption.keySource is '$ks', not Microsoft.Keyvault"
  echo "CMK: encryption.keySource=$ks"
else
  echo "NOTE: CMK NOT TESTED (LHDS_CMK_SKIP=yes) - the ADR-002 CMK bar stays unmeasured"
fi
if [[ "${LHDS_PE_SKIP:-}" != "yes" ]]; then
  sa_id="$(az storage account show -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" --query id -o tsv)"
  pe="pe-$LHDS_STORAGE_ACCOUNT-blob"
  if ! exists az network private-endpoint show -n "$pe" -g "$RG" --subscription "$SUB"; then
    az network private-endpoint create -n "$pe" -g "$RG" -l "$LOC" --subscription "$SUB" \
      --vnet-name "${LHDS_PE_VNET_ID##*/}" --subnet "$LHDS_PE_SUBNET_NAME" --private-connection-resource-id "$sa_id" \
      --group-id blob --connection-name "$pe" -o none
  fi
  zone_id="${LHDS_PE_DNS_ZONE_ID:-}"
  if [[ -z "$zone_id" ]]; then
    zone=privatelink.blob.core.windows.net
    exists az network private-dns zone show -g "$RG" -n "$zone" --subscription "$SUB" || \
      az network private-dns zone create -g "$RG" -n "$zone" --subscription "$SUB" -o none
    exists az network private-dns link vnet show -g "$RG" -z "$zone" -n lnk-vnet-lhds-w0 --subscription "$SUB" || \
      az network private-dns link vnet create -g "$RG" -z "$zone" -n lnk-vnet-lhds-w0 -v "$LHDS_PE_VNET_ID" -e false --subscription "$SUB" -o none
    zone_id="$(az network private-dns zone show -g "$RG" -n "$zone" --subscription "$SUB" --query id -o tsv)"
  fi
  # `dns-zone-group show` prints {} and exits 0 for a group that does not exist (az 2.91), so exists() would read
  # that as present. Count through `list` instead (value that breaks it: 0 groups -> create).
  n_zg="$(az network private-endpoint dns-zone-group list -g "$RG" --subscription "$SUB" --endpoint-name "$pe" --query 'length(@)' -o tsv)"
  [[ "$n_zg" =~ ^[0-9]+$ ]] || die "could not count DNS zone groups on $pe (got '$n_zg')"
  if [[ "$n_zg" -eq 0 ]]; then
    az network private-endpoint dns-zone-group create -g "$RG" --subscription "$SUB" --endpoint-name "$pe" \
      -n default --private-dns-zone "$zone_id" --zone-name blob -o none
  fi
  # Positive check: the zone must now hold an A record for the account, or a pod can never resolve it privately.
  n_a="$(az network private-dns record-set a list -g "$RG" --subscription "$SUB" -z privatelink.blob.core.windows.net --query "[?name=='$LHDS_STORAGE_ACCOUNT'] | length(@)" -o tsv)"
  [[ "$n_a" == "1" ]] || die "private DNS zone has $n_a A records for $LHDS_STORAGE_ACCOUNT, expected 1 (zone group missing or not propagated)"
else
  echo "NOTE: private endpoint NOT TESTED (LHDS_PE_SKIP=yes) - the ADR-002 private-endpoint bar stays unmeasured"
fi
az storage account update -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" --public-network-access "$PUBNET" -o none

if ! exists az postgres flexible-server show -n "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB"; then
  [[ -n "${LHDS_PG_ADMIN_PASSWORD:-}" ]] || die "PostgreSQL server $LHDS_PG_SERVER is absent and no LHDS_PG_ADMIN_PASSWORD was given to create it"
  az postgres flexible-server create -n "$LHDS_PG_SERVER" -g "$RG" -l "$LOC" --subscription "$SUB" --tier GeneralPurpose \
    --sku-name "$PGSKU" --admin-user "$PG_USER" --admin-password "$LHDS_PG_ADMIN_PASSWORD" --public-access None -o none
fi
exists az postgres flexible-server db show --server-name "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" -n "$PG_DB" || \
  az postgres flexible-server db create --server-name "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" -n "$PG_DB" -o none

if ! exists az aks show -n "$LHDS_AKS_NAME" -g "$RG" --subscription "$SUB"; then
  az aks create -n "$LHDS_AKS_NAME" -g "$RG" -l "$LOC" --subscription "$SUB" --node-count "$NODES" --node-vm-size "$VM" \
    --generate-ssh-keys -o none
fi
# Use the KUBECONFIG the caller exported when there is one (sandbox-vars.sh sets a repo-local file); otherwise
# merge into the default kubeconfig.
if [[ -n "${KUBECONFIG:-}" ]]; then
  az aks get-credentials -n "$LHDS_AKS_NAME" -g "$RG" --subscription "$SUB" --overwrite-existing --file "$KUBECONFIG"
else
  az aks get-credentials -n "$LHDS_AKS_NAME" -g "$RG" --subscription "$SUB" --overwrite-existing
fi

# ---- secrets: values travel az/env -> mode-600 temp file -> kubectl --from-file -> file removed; never printed ----
sec_tmp="$(mktemp -d -p temp/lhds-w0 sec.XXXXXX)"; chmod 700 "$sec_tmp"
trap 'rm -rf "$sec_tmp"' EXIT
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - > /dev/null
if [[ -z "${LHDS_PG_K8S_SECRET:-}" ]]; then
  ( umask 077; printf '%s' "$PG_USER" > "$sec_tmp/username"; printf '%s' "$LHDS_PG_ADMIN_PASSWORD" > "$sec_tmp/password" )
  kubectl -n "$NS" create secret generic lhds-pg --from-file=username="$sec_tmp/username" --from-file=password="$sec_tmp/password" \
    --dry-run=client -o yaml | kubectl apply -f - > /dev/null
else
  # Assertion: the named secret must exist and carry both keys (breaks on a missing secret or a renamed key).
  # shellcheck disable=SC2016  # the go-template variables must reach kubectl unexpanded
  keys="$(kubectl -n "$NS" get secret "$PG_SECRET" -o go-template='{{range $k,$v := .data}}{{$k}} {{end}}')" \
    || die "k8s secret $PG_SECRET not found in namespace $NS"
  [[ " $keys" == *" username "* && "$keys" == *"password "* ]] || die "k8s secret $PG_SECRET lacks username/password keys (has: $keys)"
fi
if ! kubectl -n "$NS" get secret lhds-ldap -o name > /dev/null 2>&1; then   # first run only: generate, never rotate under a live LDAP volume
  ( umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$sec_tmp/rootpass"; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$sec_tmp/configpass" )
  kubectl -n "$NS" create secret generic lhds-ldap --from-file=rootpass="$sec_tmp/rootpass" --from-file=configpass="$sec_tmp/configpass" > /dev/null
fi
if [[ "$STORAGE_MODE" == "azureblob" ]]; then
  if [[ -n "${LHDS_STORAGE_CREDENTIAL:-}" ]]; then
    ( umask 077; printf '%s' "$LHDS_STORAGE_CREDENTIAL" > "$sec_tmp/credential" )
  else
    ( umask 077; az storage account keys list -n "$LHDS_STORAGE_ACCOUNT" -g "$RG" --subscription "$SUB" --query '[0].value' -o tsv | tr -d '\r\n' > "$sec_tmp/credential" )
  fi
  [[ -s "$sec_tmp/credential" ]] || die "no storage credential obtained (shared-key access may be disabled on the account)"
  kubectl -n "$NS" create secret generic lhds-blob --from-file=credential="$sec_tmp/credential" --dry-run=client -o yaml | kubectl apply -f - > /dev/null
fi

# ---- schema, then LDAP + archive ----
kubectl -n "$NS" delete job pg-schema --ignore-not-found > /dev/null
kubectl apply -f "$VALUES_DIR/schema-job.yaml"
kubectl -n "$NS" wait --for=condition=complete job/pg-schema --timeout=300s \
  || { kubectl -n "$NS" logs job/pg-schema --all-containers --tail=40 >&2 || true; die "schema job did not complete"; }
kubectl -n "$NS" logs job/pg-schema -c psql --tail=5
kubectl apply -f "$VALUES_DIR/manifests.yaml"
kubectl -n "$NS" rollout status statefulset/ldap --timeout=300s
kubectl -n "$NS" rollout status deployment/arc --timeout=900s

# ---- Blob storage descriptor (gap G1) ----
# The LDAP clients run INSIDE ldap-0 and use that pod's own LDAP_ROOTPASS (expanded in the pod, never read here).
# shellcheck disable=SC2016
LDAP_AUTH='-x -H ldap://localhost:389 -D cn=admin,dc=dcm4che,dc=org -w "$LDAP_ROOTPASS"'
if [[ "$STORAGE_MODE" == "azureblob" ]]; then
  cred="$(cat "$sec_tmp/credential")"
  base="cn=Devices,cn=DICOM Configuration,dc=dcm4che,dc=org"
  sdn="dcmStorageID=azure1,dicomDeviceName=dcm4chee-arc,$base"
  aedn="dicomAETitle=DCM4CHEE,dicomDeviceName=dcm4chee-arc,$base"
  # Re-registration replaces the entry so a rotated key takes effect. Only "no such object" (rc 32) is tolerated.
  rc=0
  kubectl -n "$NS" exec ldap-0 -- sh -c "ldapdelete $LDAP_AUTH \"\$0\"" "$sdn" > "$sec_tmp/ldapdelete.out" 2> "$sec_tmp/ldapdelete.err" || rc=$?
  if [[ $rc -ne 0 && $rc -ne 32 ]]; then cat "$sec_tmp/ldapdelete.err" >&2; die "ldapdelete of the old descriptor failed with rc=$rc"; fi
  ldif="dn: $sdn
changetype: add
objectClass: dcmStorage
dcmStorageID: azure1
dcmURI: jclouds:azureblob:https://$LHDS_STORAGE_ACCOUNT.blob.core.windows.net
dcmDigestAlgorithm: MD5
dcmProperty: container=$CONTAINER
dcmProperty: identity=$LHDS_STORAGE_ACCOUNT
dcmProperty: credential=$cred
dcmProperty: containerExists=true

dn: $aedn
changetype: modify
replace: dcmObjectStorageID
dcmObjectStorageID: azure1
"
  printf '%s\n' "$ldif" | kubectl -n "$NS" exec -i ldap-0 -- sh -c "ldapmodify $LDAP_AUTH" > /dev/null
  unset cred ldif
  # Positive check: the AE now points at azure1 (value that breaks it: still fs1, or empty).
  ae="$(kubectl -n "$NS" exec ldap-0 -- sh -c "ldapsearch -LLL $LDAP_AUTH -b \"\$0\" -s base dcmObjectStorageID" "$aedn" | tr -d '\n ')"
  [[ "$ae" == *"dcmObjectStorageID:azure1" ]] || die "AE DCM4CHEE does not point at azure1 after the modify (got: $ae)"
  kubectl -n "$NS" rollout restart deployment/arc
  kubectl -n "$NS" rollout status deployment/arc --timeout=900s
  echo "Blob descriptor azure1 registered; the DCM4CHEE AE points at it; archive restarted and Ready."
else
  echo "filesystem mode: the DCM4CHEE AE stays on the image default fs1 (PVC arc-storage mounted at /storage)."
fi
echo "next: run dicom-engine-load.sh against the arc service."
