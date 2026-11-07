#!/usr/bin/env bash
# egress-report.sh - W0-4: classify the FQDN list produced by egress-capture.sh and print the table.
#
# Usage:
#   FQDN_FILE=./temp/lhds-w0/egress/fqdns.txt bash scripts/measure/health/egress-report.sh
#   (one FQDN per line; lines starting with # ignored)
# Optional env:
#   REQUIRED_FQDNS    comma-separated exact FQDNs every engine pod MUST resolve (positive control): the PostgreSQL
#                     private FQDN and, for dcm4chee, the Blob account FQDN. Each one absent from the list = exit 4.
#   PACKETS_DIR       an egress-capture.sh OUT_DIR; when set, also classifies the packet witness by destination IP
#                     (egress-ips.py). SERVICE_TAGS_FILE (az network list-service-tags JSON) lets it call an IP azure.
#
# Classes:
#   in-cluster        *.svc, *.svc.cluster.local, *.cluster.local (Kubernetes service discovery)
#   search-expansion  resolver search-path noise: `<name>.<ns>.svc.cluster.local`, `<name>.svc.cluster.local`,
#                     `<name>.cluster.local` or `<name>.<pool>.internal.cloudapp.net` where the bare `<name>` is also
#                     in the list (pods with ndots:5 try the suffixed forms first). Listed, not a finding, and NOT
#                     counted toward the in-cluster positive control.
#   azure-required    an azure name that is in REQUIRED_FQDNS
#   azure-optional    any other azure name: *.azure.com *.azure.net *.azure.us *.windows.net *.microsoft.com
#                     *.microsoftonline.com *.microsoftonline.us *.azurecr.io *.azurecr.us *.usgovcloudapi.net
#                     *.azmk8s.io *.azure-api.net *.msauth.net *.msftauth.net
#   NON-AZURE         anything else = a FINDING (possible call home / telemetry / update check)
#
# Exit codes (each is a distinct, testable condition):
#   0   list non-empty, positive controls satisfied, no non-azure FQDN (and no non-azure engine IP when PACKETS_DIR set)
#   1   FQDN_FILE missing/unreadable or usage error
#   2   list is EMPTY after dropping comments: logging was not wired. This is NOT a clean result.
#   3   REQUIRED_FQDNS is empty AND the list contains NO true in-cluster FQDN: the fallback control (an engine that
#       reaches another service, e.g. redis or ldap, resolves it) says the capture filter missed the engine pods
#       (the list cannot be trusted either way). With REQUIRED_FQDNS set, exit 4 is the control instead.
#   4   a REQUIRED_FQDNS entry is missing from the list (the capture did not see a name every pod must resolve)
#   10  report produced, positive controls satisfied, >= 1 non-azure FQDN or engine-sourced non-azure IP (a finding,
#       not a script fault)

set -euo pipefail
FQDN_FILE="${FQDN_FILE:-./temp/lhds-w0/egress/fqdns.txt}"
REQUIRED_FQDNS="${REQUIRED_FQDNS:-}"
PACKETS_DIR="${PACKETS_DIR:-}"
SERVICE_TAGS_FILE="${SERVICE_TAGS_FILE:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -r "$FQDN_FILE" ] || { echo "ERROR: cannot read FQDN_FILE '$FQDN_FILE'" >&2; exit 1; }

PY=$(
  cat <<'EOF'
import re, sys
azure = ("azure.com", "azure.net", "azure.us", "windows.net", "microsoft.com", "microsoftonline.com",
         "microsoftonline.us", "azurecr.io", "azurecr.us", "usgovcloudapi.net", "azmk8s.io",
         "azure-api.net", "msauth.net", "msftauth.net")
required = set(x.strip().lower().rstrip(".") for x in sys.argv[2].split(",") if x.strip())
# The pod resolver (ndots:5) tries <name>.<ns>.svc.cluster.local, <name>.svc.cluster.local, <name>.cluster.local and
# <name>.<pool>.internal.cloudapp.net BEFORE the bare <name>. A name is search-path noise when stripping one of those
# suffixes leaves a name that is itself in the list (the bare lookup always follows the failed expansions). A real
# in-cluster lookup (`ldap` -> ldap.<ns>.svc.cluster.local, answered) never sends the bare name, so it survives.
SEARCH = [re.compile(p) for p in (r"\.[a-z0-9-]+\.svc\.cluster\.local$", r"\.svc\.cluster\.local$", r"\.cluster\.local$",
                                  r"(\.[a-z0-9-]+){2}\.internal\.cloudapp\.net$")]
def expansion_of(n, names):
    for p in SEARCH:
        base = p.sub("", n)
        if base != n and base in names:
            return True
    return False
def cls(n, names):
    if expansion_of(n, names):
        return "search-expansion"
    if n.endswith(".svc") or n.endswith(".cluster.local") or n == "kubernetes.default":
        return "in-cluster"
    if any(n == s or n.endswith("." + s) for s in azure):
        return "azure-required" if n in required else "azure-optional"
    return "non-azure"
names = sorted(set(l.strip().lower().rstrip(".") for l in open(sys.argv[1]) if l.strip() and not l.lstrip().startswith("#")))
if not names:
    print("EMPTY FQDN list: egress logging was not wired. Not a clean result.", file=sys.stderr)
    sys.exit(2)
nameset = set(names)
rows = [(n, cls(n, nameset)) for n in names]
w = max(len(n) for n, _ in rows)
print("%-*s  %s" % (w, "FQDN", "CLASS"))
for n, c in rows:
    print("%-*s  %s" % (w, n, c))
keys = ("in-cluster", "search-expansion", "azure-required", "azure-optional", "non-azure")
counts = {k: sum(1 for _, c in rows if c == k) for k in keys}
print("\nTOTAL %d  %s" % (len(rows), " ".join("%s=%d" % (k, counts[k]) for k in keys)))
# The in-cluster control is the FALLBACK for a caller that names no required FQDN: an engine that only talks to
# PostgreSQL (HAPI measured: 1 real FQDN, no in-cluster service) legitimately has no in-cluster name, and for it the
# required-FQDN control below is the one that bites.
if counts["in-cluster"] == 0 and not required:
    print("POSITIVE CONTROL FAILED: no in-cluster FQDN (the engine's own service name) in the list; capture filter missed the engine pods.", file=sys.stderr)
    sys.exit(3)
missing = sorted(required - set(names))
if missing:
    print("POSITIVE CONTROL FAILED: required FQDN(s) never resolved by the engine pods: %s" % ", ".join(missing), file=sys.stderr)
    sys.exit(4)
if required:
    print("positive control: all %d required FQDN(s) present (%s)" % (len(required), ", ".join(sorted(required))))
if counts["non-azure"]:
    print("FINDING: %d non-azure FQDN(s) above" % counts["non-azure"], file=sys.stderr)
    sys.exit(10)
EOF
)
rc=0
python -I -c "$PY" "$FQDN_FILE" "$REQUIRED_FQDNS" || rc=$?
# 1/2/3/4 are control failures: stop, the IP section would not make the list trustworthy.
if [ "$rc" -ne 0 ] && [ "$rc" -ne 10 ]; then exit "$rc"; fi

if [ -n "$PACKETS_DIR" ]; then
  args=("$PACKETS_DIR/packets-nonprivate.txt" "$PACKETS_DIR/pod-ips.txt" "$PACKETS_DIR/node-ip.txt" "$PACKETS_DIR/fqdn-ips.tsv")
  [ -n "$SERVICE_TAGS_FILE" ] && args+=("$SERVICE_TAGS_FILE")
  iprc=0
  # Windows python cannot open an MSYS /e/... path: cygpath -m where it exists, the path unchanged elsewhere.
  ips_py="$HERE/egress-ips.py"
  if command -v cygpath > /dev/null; then ips_py="$(cygpath -m "$ips_py")"; fi
  python -I "$ips_py" "${args[@]}" || iprc=$?
  case "$iprc" in
    0) ;;
    11) rc=10 ;;
    *) exit "$iprc" ;;
  esac
fi
exit "$rc"
