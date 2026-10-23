#!/usr/bin/env bash
# fhir-engine-deploy.sh - LHDS W0-1: HAPI FHIR JPA and Medplum (plus the Redis Medplum needs) on the SANDBOX AKS,
# each against its OWN database on the sandbox PostgreSQL server (`hapi`, `medplum`; sandbox.sh creates the
# server, the databases, the AKS cluster and the k8s secret lhds-w0/lhds-pg-admin).
#
# Usage: scripts/measure/health/fhir-engine-deploy.sh {up|down} {hapi|medplum}
#        scripts/measure/health/fhir-engine-deploy.sh client       # in-cluster load-client pod `fhir-client`
#        scripts/measure/health/fhir-engine-deploy.sh status
#
# ONE ENGINE AT A TIME. The DEV sandbox has one D8s_v5 node and a 2-vCore PostgreSQL; two engines running at once
# would make both sets of numbers meaningless. `up <engine>` therefore REFUSES while the other engine has replicas>0
# (run `down <other>` first). `down` scales to 0 and keeps the database (so the pause leaves no running pods).
#
# HARD GUARDS (checked first, before any az call; same shape as dicom-engine-deploy.sh):
#   - LHDS_SANDBOX_SUBSCRIPTION and LHDS_SANDBOX_RG must both be set. No default; `az account show` is never used to
#     pick one. After `az account set`, the active subscription id must equal LHDS_SANDBOX_SUBSCRIPTION.
#   - The resource group must already exist (operator-created); this script never creates one.
#   - Without LHDS_DEPLOY_CONFIRM=yes `up`/`down`/`client` only PRINT the plan and write the manifests under temp/.
#
# Required env: LHDS_SANDBOX_SUBSCRIPTION LHDS_SANDBOX_RG LHDS_PG_SERVER LHDS_PG_K8S_SECRET (existing secret with keys
#   `username` and `password`; nothing is read or printed) KUBECONFIG (sandbox-vars.sh sets it)
# Optional env:
#   LHDS_K8S_NAMESPACE (lhds-w0)   LHDS_PG_FQDN (default $LHDS_PG_SERVER.postgres.database.azure.com)
#   LHDS_HAPI_IMAGE   default hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e
#                     (server 8.12.0, FHIR 4.0.1: the digest the local smoke ran)
#   LHDS_MEDPLUM_IMAGE default medplum/medplum-server@sha256:7ccb89e5fcf87e611569fd818d575ad579b2b7de9752f5950ea01b6b328e74cd
#                     (5.2.7: the digest the local smoke ran)
#   LHDS_REDIS_IMAGE (redis:7)   LHDS_HAPI_JAVA_OPTS (-Xmx4g: the image default heap is 25% of the node, unrelated to
#   the engine's needs, and the local smoke ran on a much larger host)   LHDS_FHIR_VALUES_DIR (temp/lhds-w0/fhir/deploy)
#   LHDS_CLIENT_IMAGE (python:3.12-bookworm; psql comes from `apt-get install postgresql-client` inside the pod)
#
# Settings carried over from the local smoke (each was REQUIRED there, so each is an observation about the engine):
#   HAPI    HAPI_FHIR_BULK_EXPORT_ENABLED=true (else $export is off), HAPI_FHIR_ALLOW_EXTERNAL_REFERENCES=true
#   Medplum MEDPLUM_MAX_JSON_SIZE=100mb (default 1mb returned HTTP 413 on most Synthea bundles) and rate limiting off
#           (MEDPLUM_RATE_LIMITS_ENABLED=false, quota 100000000: the default quota returned per-entry 429s inside an
#           HTTP 200 transaction response). MEDPLUM_REGISTER_ENABLED=true so fhir-engine-medplum-token.py can create a
#           throwaway project IN-CLUSTER; the token it mints stays in a file inside the client pod and is never printed.
# Credentials: from the k8s secret by secretKeyRef (PostgreSQL) or generated into a mode-600 temp file and sent with
#   kubectl --from-file (Redis); sslmode=require everywhere. Nothing secret is written into the generated manifests.
#
# KNOWN GAPS
#   G1  Plain manifests, no Loom-owned Helm chart yet (ADR-001 says Loom will own the values); the manifests under the
#       values dir are the parameter record.
#   G2  Medplum reaches PostgreSQL with PGSSLMODE=require (node-postgres reads it) rather than Medplum's own
#       database.ssl config key; if the engine ignores it the rollout fails and that is a finding, not a retry.
set -euo pipefail
shopt -s inherit_errexit
die() { echo "ERROR: $*" >&2; exit 1; }
export MSYS_NO_PATHCONV=1

ACTION="${1:-}"; ENGINE="${2:-}"
case "$ACTION" in
  up | down) [[ "$ENGINE" == hapi || "$ENGINE" == medplum ]] || die "usage: $0 $ACTION {hapi|medplum}" ;;
  client | status) ;;
  *) die "usage: $0 {up|down} {hapi|medplum} | client | status" ;;
esac

# ---------------- guards ----------------
for v in LHDS_SANDBOX_SUBSCRIPTION LHDS_SANDBOX_RG LHDS_PG_SERVER LHDS_PG_K8S_SECRET KUBECONFIG; do
  [[ -n "${!v:-}" ]] || die "required env var $v is not set - refusing (no default subscription or resource group, by design)"
done
SUB="$LHDS_SANDBOX_SUBSCRIPTION"; RG="$LHDS_SANDBOX_RG"
NS="${LHDS_K8S_NAMESPACE:-lhds-w0}"
PG_FQDN="${LHDS_PG_FQDN:-$LHDS_PG_SERVER.postgres.database.azure.com}"
PG_SECRET="$LHDS_PG_K8S_SECRET"
HAPI_IMAGE="${LHDS_HAPI_IMAGE:-hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e}"
MEDPLUM_IMAGE="${LHDS_MEDPLUM_IMAGE:-medplum/medplum-server@sha256:7ccb89e5fcf87e611569fd818d575ad579b2b7de9752f5950ea01b6b328e74cd}"
REDIS_IMAGE="${LHDS_REDIS_IMAGE:-redis:7}"
CLIENT_IMAGE="${LHDS_CLIENT_IMAGE:-python:3.12-bookworm}"
HAPI_JAVA_OPTS="${LHDS_HAPI_JAVA_OPTS:--Xmx4g}"
VALUES_DIR="${LHDS_FHIR_VALUES_DIR:-temp/lhds-w0/fhir/deploy}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$VALUES_DIR" temp/lhds-w0

# ---------------- manifests (written to temp/, no secrets inside) ----------------
cat > "$VALUES_DIR/hapi.yaml" <<MANIFEST
apiVersion: v1
kind: Service
metadata: {name: hapi, namespace: $NS}
spec: {selector: {app: hapi}, ports: [{name: http, port: 8080}]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: hapi, namespace: $NS}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: hapi}}
  template:
    metadata: {labels: {app: hapi}}
    spec:
      containers:
        - name: hapi
          image: $HAPI_IMAGE
          ports: [{containerPort: 8080}]
          env:
            - {name: SPRING_DATASOURCE_URL, value: "jdbc:postgresql://$PG_FQDN:5432/hapi?sslmode=require"}
            - {name: SPRING_DATASOURCE_USERNAME, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: username}}}
            - {name: SPRING_DATASOURCE_PASSWORD, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: password}}}
            - {name: SPRING_DATASOURCE_DRIVERCLASSNAME, value: org.postgresql.Driver}
            - {name: SPRING_JPA_PROPERTIES_HIBERNATE_DIALECT, value: ca.uhn.fhir.jpa.model.dialect.HapiFhirPostgresDialect}
            - {name: HAPI_FHIR_BULK_EXPORT_ENABLED, value: "true"}
            - {name: HAPI_FHIR_ALLOW_EXTERNAL_REFERENCES, value: "true"}
            - {name: JAVA_TOOL_OPTIONS, value: "$HAPI_JAVA_OPTS"}
          resources: {requests: {cpu: "2", memory: 6Gi}, limits: {memory: 8Gi}}
          # Ready only when the CapabilityStatement answers (value that breaks it: a booted JVM whose JPA layer failed).
          startupProbe: {httpGet: {path: /fhir/metadata, port: 8080}, periodSeconds: 5, failureThreshold: 120}
          readinessProbe: {httpGet: {path: /fhir/metadata, port: 8080}, periodSeconds: 10, failureThreshold: 3}
MANIFEST
cat > "$VALUES_DIR/medplum.yaml" <<MANIFEST
apiVersion: v1
kind: Service
metadata: {name: redis, namespace: $NS}
spec: {selector: {app: redis}, ports: [{port: 6379}]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: redis, namespace: $NS}
spec:
  replicas: 1
  selector: {matchLabels: {app: redis}}
  template:
    metadata: {labels: {app: redis}}
    spec:
      containers:
        - name: redis
          image: $REDIS_IMAGE
          args: [redis-server, --requirepass, \$(REDIS_PASSWORD)]
          env:
            - {name: REDIS_PASSWORD, valueFrom: {secretKeyRef: {name: lhds-redis, key: password}}}
          ports: [{containerPort: 6379}]
          resources: {requests: {cpu: 100m, memory: 256Mi}}
---
apiVersion: v1
kind: Service
metadata: {name: medplum, namespace: $NS}
spec: {selector: {app: medplum}, ports: [{name: http, port: 8103}]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: medplum, namespace: $NS}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: medplum}}
  template:
    metadata: {labels: {app: medplum}}
    spec:
      containers:
        - name: medplum
          image: $MEDPLUM_IMAGE
          # The image CMD is the config location ("file:medplum.config.json", absent in the image: CrashLoopBackOff,
          # measured). \`env\` selects configuration from MEDPLUM_* variables, as the local smoke did.
          args: [env]
          ports: [{containerPort: 8103}]
          env:
            - {name: MEDPLUM_PORT, value: "8103"}
            - {name: MEDPLUM_BASE_URL, value: "http://medplum:8103/"}
            - {name: MEDPLUM_APP_BASE_URL, value: "http://localhost:3000/"}
            - {name: MEDPLUM_STORAGE_BASE_URL, value: "http://medplum:8103/storage/"}
            - {name: MEDPLUM_BINARY_STORAGE, value: "file:./binary/"}
            - {name: MEDPLUM_DATABASE_HOST, value: "$PG_FQDN"}
            - {name: MEDPLUM_DATABASE_PORT, value: "5432"}
            - {name: MEDPLUM_DATABASE_DBNAME, value: medplum}
            - {name: PGSSLMODE, value: require}
            - {name: MEDPLUM_DATABASE_USERNAME, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: username}}}
            - {name: MEDPLUM_DATABASE_PASSWORD, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: password}}}
            - {name: MEDPLUM_REDIS_HOST, value: redis}
            - {name: MEDPLUM_REDIS_PORT, value: "6379"}
            - {name: MEDPLUM_REDIS_PASSWORD, valueFrom: {secretKeyRef: {name: lhds-redis, key: password}}}
            - {name: MEDPLUM_REGISTER_ENABLED, value: "true"}
            - {name: MEDPLUM_MAX_JSON_SIZE, value: 100mb}
            - {name: MEDPLUM_RATE_LIMITS_ENABLED, value: "false"}
            - {name: MEDPLUM_DEFAULT_FHIR_QUOTA, value: "100000000"}
            - {name: MEDPLUM_DEFAULT_RATE_LIMIT, value: "-1"}
          resources: {requests: {cpu: "2", memory: 4Gi}, limits: {memory: 8Gi}}
          startupProbe: {httpGet: {path: /healthcheck, port: 8103}, periodSeconds: 5, failureThreshold: 120}
          readinessProbe: {httpGet: {path: /healthcheck, port: 8103}, periodSeconds: 10, failureThreshold: 3}
MANIFEST
cat > "$VALUES_DIR/client.yaml" <<MANIFEST
apiVersion: v1
kind: Pod
metadata: {name: fhir-client, namespace: $NS, labels: {app: fhir-client}}
spec:
  restartPolicy: Never
  containers:
    - name: client
      image: $CLIENT_IMAGE
      command: [sleep, "86400"]
      env:
        - {name: PGHOST, value: "$PG_FQDN"}
        - {name: PGSSLMODE, value: require}
        - {name: PGUSER, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: username}}}
        - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: $PG_SECRET, key: password}}}
      resources: {requests: {cpu: 500m, memory: 1Gi}}
MANIFEST
echo "wrote $VALUES_DIR/{hapi,medplum,client}.yaml"

if [[ "$ACTION" != status && "${LHDS_DEPLOY_CONFIRM:-}" != "yes" ]]; then
  echo "PLAN ONLY (set LHDS_DEPLOY_CONFIRM=yes to execute): subscription $SUB, RG $RG, namespace $NS, action '$ACTION' ${ENGINE:-}"
  echo "  1 verify active subscription == $SUB, RG exists, AKS powerState Running, PG server Ready"
  echo "  2 verify k8s secret $PG_SECRET has username+password; ensure database '${ENGINE:-hapi|medplum}' exists"
  echo "  3 up: refuse if the other engine runs; (medplum: generate secret lhds-redis once); apply $VALUES_DIR/<engine>.yaml; wait for rollout"
  echo "  4 down: scale the engine (and redis) to 0, keep the database"
  exit 0
fi

# ---------------- execute (sandbox only) ----------------
az account set --subscription "$SUB"
active="$(az account show --query id -o tsv)"
[[ "$active" == "$SUB" ]] || die "active subscription '$active' != LHDS_SANDBOX_SUBSCRIPTION '$SUB' - aborting before any write"

# exists CMD...: 0 if the resource exists, 1 if the service says it does not; any OTHER failure aborts with its stderr and is
# never read as "absent" (deploy-integrity R7).
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

replicas() { kubectl -n "$NS" get deployment "$1" -o jsonpath='{.spec.replicas}' --ignore-not-found; }

if [[ "$ACTION" == status ]]; then
  kubectl -n "$NS" get deployments,pods -o wide
  exit 0
fi

# Positive control: kubectl must reach the cluster before "0 replicas" means anything.
kubectl get ns "$NS" -o name > /dev/null || die "cannot reach namespace $NS with KUBECONFIG=$KUBECONFIG (AKS paused, or wrong kubeconfig)"

if [[ "$ACTION" == client ]]; then
  kubectl apply -f "$VALUES_DIR/client.yaml"
  kubectl -n "$NS" wait --for=condition=Ready pod/fhir-client --timeout=300s
  kubectl -n "$NS" exec fhir-client -- sh -c 'apt-get update -qq > /tmp/apt.log 2>&1 && apt-get install -y -qq postgresql-client >> /tmp/apt.log 2>&1 && psql --version && which bash curl awk python'
  kubectl -n "$NS" exec fhir-client -- mkdir -p /work/scripts /work/results
  tar cf - -C "$HERE" fhir-engine-lib.sh fhir-engine-load.sh fhir-engine-bytes.sh fhir-engine-query.sh fhir-engine-export.sh \
    fhir-engine-report.sh fhir-engine-atomicity.sh fhir-engine-medplum-token.py | kubectl -n "$NS" exec -i fhir-client -- tar xf - -C /work/scripts
  kubectl -n "$NS" exec fhir-client -- sh -c 'chmod +x /work/scripts/*.sh; ls /work/scripts'
  exit 0
fi

OTHER=medplum; [[ "$ENGINE" == medplum ]] && OTHER=hapi
if [[ "$ACTION" == down ]]; then
  # `kubectl scale` has no --ignore-not-found (kubectl 1.3x): test for the Deployment first.
  [[ -z "$(replicas "$ENGINE")" ]] || kubectl -n "$NS" scale deployment "$ENGINE" --replicas=0
  if [[ "$ENGINE" == medplum && -n "$(replicas redis)" ]]; then kubectl -n "$NS" scale deployment redis --replicas=0; fi
  # Positive + absence pair: the scale must have landed (replicas 0) AND no pod of the engine may remain.
  [[ "$(replicas "$ENGINE")" == "0" || -z "$(replicas "$ENGINE")" ]] || die "$ENGINE replicas is not 0 after scale"
  kubectl -n "$NS" wait --for=delete pod -l "app=$ENGINE" --timeout=180s || true
  left="$(kubectl -n "$NS" get pods -l "app=$ENGINE" -o name | wc -l)"
  [[ "$left" -eq 0 ]] || die "$left pod(s) of $ENGINE still exist after scale to 0"
  echo "$ENGINE scaled to 0 (database kept)"
  exit 0
fi

# ---- up ----
oth="$(replicas "$OTHER")"
[[ -z "$oth" || "$oth" == "0" ]] || die "$OTHER has replicas=$oth: one engine at a time (run: $0 down $OTHER)"
pgs="$(az postgres flexible-server show -n "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" --query state -o tsv)"
[[ "$pgs" == "Ready" ]] || die "PostgreSQL server $LHDS_PG_SERVER state is '$pgs', not Ready (run sandbox.sh resume)"
# shellcheck disable=SC2016  # the go-template variables must reach kubectl unexpanded
keys="$(kubectl -n "$NS" get secret "$PG_SECRET" -o go-template='{{range $k,$v := .data}}{{$k}} {{end}}')" \
  || die "k8s secret $PG_SECRET not found in namespace $NS"
[[ " $keys" == *" username "* && "$keys" == *"password "* ]] || die "k8s secret $PG_SECRET lacks username/password keys (has: $keys)"
exists az postgres flexible-server db show --server-name "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" -n "$ENGINE" || \
  az postgres flexible-server db create --server-name "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" -n "$ENGINE" -o none

if [[ "$ENGINE" == medplum ]]; then
  # Medplum's schema migration runs CREATE EXTENSION for these four. Azure Database for PostgreSQL refuses any
  # extension that is not in the server parameter azure.extensions (default empty): the first rollout died with
  # 'extension "btree_gin" is not allow-listed for users' (measured 2026-10-23). Allow-list is additive and idempotent.
  want="BTREE_GIN PG_TRGM BTREE_GIST UNACCENT"
  have="$(az postgres flexible-server parameter show --server-name "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" -n azure.extensions --query value -o tsv | tr -d '\r')"
  merged="$have"
  for x in $want; do [[ ",${merged^^}," == *",$x,"* ]] || merged="${merged:+$merged,}$x"; done
  if [[ "$merged" != "$have" ]]; then
    az postgres flexible-server parameter set --server-name "$LHDS_PG_SERVER" -g "$RG" --subscription "$SUB" -n azure.extensions --value "$merged" -o none
  fi
  echo "azure.extensions = $merged"
  if ! kubectl -n "$NS" get secret lhds-redis -o name > /dev/null 2>&1; then
    sec_tmp="$(mktemp -d -p temp/lhds-w0 sec.XXXXXX)"; chmod 700 "$sec_tmp"
    trap 'rm -rf "$sec_tmp"' EXIT
    ( umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$sec_tmp/password" )
    kubectl -n "$NS" create secret generic lhds-redis --from-file=password="$sec_tmp/password" > /dev/null
  fi
fi
kubectl apply -f "$VALUES_DIR/$ENGINE.yaml"
# apply does not change replicas on an existing Deployment that a previous `down` scaled to 0 unless the manifest says 1
# (it does: replicas: 1), but be explicit.
kubectl -n "$NS" scale deployment "$ENGINE" --replicas=1
[[ "$ENGINE" == medplum ]] && kubectl -n "$NS" scale deployment redis --replicas=1
kubectl -n "$NS" rollout status deployment/"$ENGINE" --timeout=900s \
  || { kubectl -n "$NS" logs deployment/"$ENGINE" --tail=40 >&2 || true; die "$ENGINE did not become Ready"; }
echo "$ENGINE is Ready in namespace $NS. Next: $0 client; then load via fhir-engine-load.sh inside the client pod."
