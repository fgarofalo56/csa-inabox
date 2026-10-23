#!/usr/bin/env bash
# egress-capture.sh - W0-4: capture every outbound FQDN a candidate FHIR/DICOM engine image tries to
# reach, on an ISOLATED AKS node pool in the class-S sandbox. NOT EXECUTED in the W0 no-cost run
# (no sandbox exists; operator decision 2026-10-22).
#
# Method (two independent witnesses, because either alone has a blind spot):
#   1. CoreDNS query log. Every name a pod resolves is logged by CoreDNS ("log" plugin enabled via
#      the AKS-supported coredns-custom ConfigMap). Catches FQDNs; blind to hard-coded IP literals.
#   2. Packet witness. A hostNetwork netshoot pod pinned to the isolated pool runs tcpdump and keeps
#      only new outbound TCP SYNs and UDP to non-RFC1918 destinations. Catches IP literals and DNS
#      over non-CoreDNS paths; yields IPs, not names.
# Isolation: the engine namespace runs only on the pool labelled loom.io/pool=egress-probe (tainted
# loom.io/egress-probe=true:NoSchedule), so every captured packet from that node is engine traffic
# plus kubelet/CNI noise (kubelet destinations are listed separately, never merged).
#
# Subcommands:
#   start      enable CoreDNS logging, start the tcpdump witness, snapshot pod IPs
#   snapshot   append the current pod IPs of EGRESS_NAMESPACE (call after every pod restart/scale;
#              pod IPs change, and the DNS filter is by client IP)
#   stop       collect logs into OUT_DIR: dns-queries.tsv (client_ip, qtype, fqdn, rcode),
#              pod-ips.txt, packets-nonprivate.txt, and fqdns.txt (unique FQDNs from engine pod IPs)
#
# Env:
#   KUBECONFIG / current context must already point at the SANDBOX cluster (this script runs
#     `kubectl cluster-info` and prints it first; it does not run `az` and never creates Azure resources).
#   EGRESS_NAMESPACE   namespace holding the engine pods under test (required)
#   EGRESS_NODE        name of the node in the isolated pool (required)
#   OUT_DIR            output directory (default ./temp/lhds-w0/egress)
#   CAPTURE_HOURS      informational: how long the operator intends to leave this running (24 per W0-4);
#                      the script does not sleep, so there is no polling loop.
#
# FAILS (exit 1) when a required env var is missing, kubectl cannot reach the cluster, the node is
# not in the pool labelled loom.io/pool=egress-probe, or (stop) the DNS log has 0 lines from engine
# pod IPs -- that last case means logging was not wired and egress-report.sh would otherwise read an
# empty list as "no calls home".

set -euo pipefail

CMD="${1:-}"
EGRESS_NAMESPACE="${EGRESS_NAMESPACE:-}"
EGRESS_NODE="${EGRESS_NODE:-}"
OUT_DIR="${OUT_DIR:-./temp/lhds-w0/egress}"
die() { echo "ERROR: $*" >&2; exit 1; }
[ -n "$CMD" ] || die "usage: egress-capture.sh start|snapshot|stop"
[ -n "$EGRESS_NAMESPACE" ] || die "EGRESS_NAMESPACE is required"
[ -n "$EGRESS_NODE" ] || die "EGRESS_NODE is required"
mkdir -p "$OUT_DIR"

echo "cluster under capture:"
kubectl cluster-info | head -2
pool=$(kubectl get node "$EGRESS_NODE" -o jsonpath='{.metadata.labels.loom\.io/pool}')
[ "$pool" = "egress-probe" ] || die "node $EGRESS_NODE has loom.io/pool='$pool', expected 'egress-probe' (the isolation premise does not hold)"

snapshot_ips() {
  kubectl -n "$EGRESS_NAMESPACE" get pods -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}' >>"$OUT_DIR/pod-ips.raw"
  sort -u "$OUT_DIR/pod-ips.raw" | grep -E '^[0-9.]+$' >"$OUT_DIR/pod-ips.txt"
  echo "pod IPs known: $(wc -l <"$OUT_DIR/pod-ips.txt")"
}

case "$CMD" in
  start)
    kubectl -n kube-system apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  log.override: |
    log
EOF
    kubectl -n kube-system rollout restart deployment coredns
    kubectl -n kube-system rollout status deployment coredns --timeout=180s
    kubectl delete pod egress-tcpdump --ignore-not-found
    kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: egress-tcpdump
  labels: {app: egress-tcpdump}
spec:
  hostNetwork: true
  nodeName: ${EGRESS_NODE}
  tolerations: [{key: loom.io/egress-probe, operator: Exists}]
  containers:
  - name: tcpdump
    image: nicolaka/netshoot:latest
    securityContext: {capabilities: {add: [NET_RAW, NET_ADMIN]}}
    command: ["sh","-c","tcpdump -nn -l -i any 'not (dst net 10.0.0.0/8 or dst net 172.16.0.0/12 or dst net 192.168.0.0/16 or dst net 169.254.0.0/16 or dst net 127.0.0.0/8) and ((tcp[tcpflags] & (tcp-syn|tcp-ack) = tcp-syn) or udp)' 2>&1"]
EOF
    kubectl wait --for=condition=Ready pod/egress-tcpdump --timeout=180s
    : >"$OUT_DIR/pod-ips.raw"
    snapshot_ips
    echo "capture started; run '$0 snapshot' after pod restarts; run '$0 stop' after CAPTURE_HOURS=${CAPTURE_HOURS:-24}"
    ;;
  snapshot)
    snapshot_ips
    ;;
  stop)
    snapshot_ips
    kubectl -n kube-system logs deployment/coredns --all-containers --since=48h >"$OUT_DIR/coredns.raw"
    # CoreDNS log line: [INFO] 10.244.1.5:51234 - 12345 "A IN foo.example.com. udp 40 false 512" NOERROR qr,rd 100 0.001s
    python -I -c '
import re, sys
ips = set(l.strip() for l in open(sys.argv[1]) if l.strip())
pat = re.compile(r"\[INFO\] (\d+\.\d+\.\d+\.\d+):\d+ - \d+ \"(\S+) IN (\S+) \S+ \d+ \S+ \d+\" (\S+)")
rows = []
for line in open(sys.argv[2], errors="replace"):
    m = pat.search(line)
    if m and m.group(1) in ips:
        rows.append((m.group(1), m.group(2), m.group(3).rstrip(".").lower(), m.group(4)))
with open(sys.argv[3], "w") as f:
    for r in rows:
        f.write("\t".join(r) + "\n")
with open(sys.argv[4], "w") as f:
    for n in sorted(set(r[2] for r in rows)):
        f.write(n + "\n")
print("dns queries from engine pod IPs: %d, unique FQDNs: %d" % (len(rows), len(set(r[2] for r in rows))))
' "$OUT_DIR/pod-ips.txt" "$OUT_DIR/coredns.raw" "$OUT_DIR/dns-queries.tsv" "$OUT_DIR/fqdns.txt"
    kubectl logs pod/egress-tcpdump >"$OUT_DIR/packets-nonprivate.txt"
    [ -s "$OUT_DIR/dns-queries.tsv" ] || die "0 DNS queries from engine pod IPs: logging was not wired (coredns-custom not applied, wrong namespace, or pod IPs not snapshotted). Do NOT read this as 'no calls home'."
    echo "wrote $OUT_DIR/fqdns.txt; classify with egress-report.sh"
    ;;
  *)
    die "unknown subcommand '$CMD'"
    ;;
esac
