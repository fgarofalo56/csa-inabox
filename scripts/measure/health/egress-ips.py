"""egress-ips.py - W0-4: classify the packet witness (tcpdump output from egress-capture.sh) by destination IP.

Called by egress-report.sh; usable alone:
  python -I egress-ips.py PACKETS POD_IPS NODE_IP_FILE FQDN_IPS_TSV [SERVICE_TAGS_JSON]

Source classes (the isolation premise: the probe pool carries only the engine pods plus kubelet/CNI/DaemonSet noise):
  engine  source IP is a snapshotted engine pod IP (seen on the pod's veth, BEFORE node SNAT)
  node    source IP is the node's own IP: kubelet, CNI, image pulls, DaemonSets, and the engine's own traffic AFTER
          SNAT. Listed separately and NEVER merged into the engine rows; a node row whose destination also appears
          in an engine row is the same flow seen twice and is dropped from the node section.
Destination classes:
  azure       the IP falls inside an Azure service-tag prefix (az network list-service-tags); the most specific tag
              (longest prefix) is shown. WITHOUT a service-tags file nothing can be called azure and every public
              IP is reported "unclassified" - never silently "azure".
  NON-AZURE   public IP in no Azure prefix: a finding when the source is an engine.
IPv6 is not captured by the filter in egress-capture.sh's tcpdump expression for this lane (AKS overlay here is IPv4);
a non-IPv4 line is counted and reported, not dropped silently.
Exit: 0 clean, 11 at least one engine-sourced NON-AZURE or unclassified IP, 2 no parsable packet line at all
(capture not wired: not a clean result), 1 usage/unreadable input.
"""

import collections
import ipaddress
import json
import re
import sys

LINE = re.compile(r"IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > (\d+\.\d+\.\d+\.\d+)\.(\d+): (.*)")


def read_lines(path):
    with open(path, errors="replace") as f:
        return [ln.rstrip("\n") for ln in f]


def main(argv):
    if len(argv) not in (5, 6):
        print(__doc__, file=sys.stderr)
        return 1
    packets_f, pod_f, node_f, fqdnip_f = argv[1:5]
    tags_f = argv[5] if len(argv) == 6 else None
    try:
        pod_ips = {x.strip() for x in read_lines(pod_f) if x.strip()}
        node_ip = read_lines(node_f)[0].strip()
        lines = read_lines(packets_f)
        names = collections.defaultdict(set)
        for row in read_lines(fqdnip_f):
            if "\t" in row:
                n, ip = row.split("\t", 1)
                names[ip.strip()].add(n.strip())
    except (OSError, IndexError) as e:
        print(f"ERROR: cannot read an input: {e}", file=sys.stderr)
        return 1

    nets = []
    if tags_f:
        try:
            with open(tags_f) as tf:
                doc = json.load(tf)
            for v in doc["values"]:
                for p in v["properties"]["addressPrefixes"]:
                    if ":" not in p:
                        nets.append((ipaddress.ip_network(p), v["name"]))
        except (OSError, KeyError, ValueError) as e:
            print(f"ERROR: cannot use service tags file: {e}", file=sys.stderr)
            return 1
        if not nets:
            print("ERROR: service tags file holds 0 IPv4 prefixes", file=sys.stderr)
            return 1

    def azure_tag(ip):
        a = ipaddress.ip_address(ip)
        best = None
        for net, name in nets:
            if a in net and (best is None or net.prefixlen > best[0]):
                best = (net.prefixlen, name)
        return best[1] if best else None

    flows = collections.Counter()  # (srcclass, dst, proto, port) -> packets
    unparsed = 0
    for ln in lines:
        m = LINE.search(ln)
        if not m:
            banner = (
                "listening on",
                "packets captured",
                "received by filter",
                "dropped by kernel",
                "promiscuous",
                "Promiscuous",
                "verbose output suppressed",
            )
            if ln.strip() and not any(b in ln for b in banner):
                unparsed += 1
            continue
        src, _sp, dst, dp, rest = m.groups()
        proto = "tcp" if rest.startswith("Flags") else "udp"
        if src in pod_ips:
            sc = "engine"
        elif src == node_ip:
            sc = "node"
        else:
            sc = "other-pod"  # a non-engine pod on the probe node (DaemonSet), kept apart from both
        flows[(sc, dst, proto, dp)] += 1
    if not flows:
        print(
            f"NO parsable packet line in {packets_f}: the packet witness is not wired. Not a clean result.",
            file=sys.stderr,
        )
        return 2

    engine_dsts = {k[1] for k in flows if k[0] == "engine"}
    finding = 0

    def classify(ip):
        if not nets:
            return "unclassified (no service-tags file)"
        t = azure_tag(ip)
        return "azure:" + t if t else "NON-AZURE"

    def show(title, sel):
        nonlocal finding
        rows = sorted(sel, key=lambda k: (k[1], k[2], k[3]))
        print(f"\n{title} ({len(rows)} distinct destination flows)")
        print(
            f"{'DEST_IP':<16} {'PROTO/PORT':<9} {'PKTS':<7} {'CLASS':<34} NAMES (resolved at stop time, may have rotated)"
        )
        for k in rows:
            cls = classify(k[1])
            nm = ",".join(sorted(names.get(k[1], []))) or "(unnamed)"
            print(f"{k[1]:<16} {k[2] + '/' + k[3]:<9} {flows[k]:<7d} {cls:<34} {nm}")
            if k[0] == "engine" and not cls.startswith("azure:"):
                finding += 1

    show("ENGINE-SOURCED (pod IP source)", [k for k in flows if k[0] == "engine"])
    show(
        "NODE-LEVEL: kubelet / CNI / image pulls / SNAT'd duplicates removed",
        [k for k in flows if k[0] == "node" and k[1] not in engine_dsts],
    )
    show("OTHER PODS on the probe node (DaemonSets, not the engine)", [k for k in flows if k[0] == "other-pod"])
    print(f"\npacket lines unparsed (not IPv4 SYN/UDP shape): {unparsed}")
    if finding:
        print(f"FINDING: {finding} engine-sourced destination(s) are not Azure-owned", file=sys.stderr)
        return 11
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
