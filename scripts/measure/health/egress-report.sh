#!/usr/bin/env bash
# egress-report.sh - W0-4: classify the FQDN list produced by egress-capture.sh and print the table.
#
# Usage:
#   FQDN_FILE=./temp/lhds-w0/egress/fqdns.txt bash scripts/measure/health/egress-report.sh
#   (one FQDN per line; lines starting with # ignored)
#
# Classes:
#   in-cluster   *.svc, *.svc.cluster.local, *.cluster.local (Kubernetes service discovery)
#   azure        *.azure.com *.azure.net *.azure.us *.windows.net *.microsoft.com
#                *.microsoftonline.com *.microsoftonline.us *.azurecr.io *.azurecr.us
#                *.usgovcloudapi.net *.azmk8s.io *.azure-api.net *.msauth.net *.msftauth.net
#   non-azure    anything else = a FINDING (possible call home / telemetry / update check)
#
# Exit codes (each is a distinct, testable condition):
#   0   list non-empty, positive control satisfied, no non-azure FQDN
#   1   FQDN_FILE missing/unreadable or usage error
#   2   list is EMPTY after dropping comments: logging was not wired. This is NOT a clean result.
#   3   list is non-empty but contains NO in-cluster FQDN: every engine pod resolves at least its
#       database service name, so a list without one means the capture filter missed the engine pods
#       (the positive control fails; the list cannot be trusted either way)
#   10  report produced, positive control satisfied, >= 1 non-azure FQDN (a finding, not a script fault)

set -euo pipefail
FQDN_FILE="${FQDN_FILE:-./temp/lhds-w0/egress/fqdns.txt}"
[ -r "$FQDN_FILE" ] || { echo "ERROR: cannot read FQDN_FILE '$FQDN_FILE'" >&2; exit 1; }

PY=$(
  cat <<'EOF'
import re, sys
azure = ("azure.com", "azure.net", "azure.us", "windows.net", "microsoft.com", "microsoftonline.com",
         "microsoftonline.us", "azurecr.io", "azurecr.us", "usgovcloudapi.net", "azmk8s.io",
         "azure-api.net", "msauth.net", "msftauth.net")
def cls(n):
    if n.endswith(".svc") or n.endswith(".cluster.local") or n == "kubernetes.default":
        return "in-cluster"
    if any(n == s or n.endswith("." + s) for s in azure):
        return "azure"
    return "non-azure"
names = sorted(set(l.strip().lower().rstrip(".") for l in open(sys.argv[1]) if l.strip() and not l.lstrip().startswith("#")))
if not names:
    print("EMPTY FQDN list: egress logging was not wired. Not a clean result.", file=sys.stderr)
    sys.exit(2)
rows = [(n, cls(n)) for n in names]
w = max(len(n) for n, _ in rows)
print("%-*s  %s" % (w, "FQDN", "CLASS"))
for n, c in rows:
    print("%-*s  %s" % (w, n, c))
counts = {k: sum(1 for _, c in rows if c == k) for k in ("in-cluster", "azure", "non-azure")}
print("\nTOTAL %d  in-cluster=%d azure=%d non-azure=%d" % (len(rows), counts["in-cluster"], counts["azure"], counts["non-azure"]))
if counts["in-cluster"] == 0:
    print("POSITIVE CONTROL FAILED: no in-cluster FQDN (the engine's own database service name) in the list; capture filter missed the engine pods.", file=sys.stderr)
    sys.exit(3)
if counts["non-azure"]:
    print("FINDING: %d non-azure FQDN(s) above" % counts["non-azure"], file=sys.stderr)
    sys.exit(10)
EOF
)
python -I -c "$PY" "$FQDN_FILE"
