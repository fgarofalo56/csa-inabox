"""Markdown summary for health-w0-gov-probe.yml (LHDS W0-3).

Usage: python health_w0_gov_summarize.py <probe-output-dir>

Reads status.tsv plus the raw JSON the probe step wrote and prints markdown.
Read-only: it never calls Azure. A probe marked FAILED is printed as FAILED
with its stderr; a file that cannot be parsed is printed as UNPARSEABLE, never
as an empty/negative result (an unread answer is not a "no").
"""

import json
import sys
from pathlib import Path

# Resource types whose Gov locations answer the AZURE-GOV-AVAILABILITY.md cells.
KEY_TYPES = {
    "managedClusters",
    "flexibleServers",
    "namespaces",
    "clusters",
    "service",
    "vaults",
    "profiles",
    "applicationGateways",
    "loadTests",
    "managedEnvironments",
    "storageAccounts",
    "azureFirewalls",
    "dnsResolvers",
    "privateEndpoints",
}


def load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except (OSError, ValueError) as exc:
        return None, f"{type(exc).__name__}: {exc}"


def is_gov(loc: str) -> bool:
    low = loc.lower().replace(" ", "")
    return "usgov" in low or "usdod" in low


def main(out_dir: str) -> int:
    out = Path(out_dir)
    rows = [ln.split("\t") for ln in (out / "status.tsv").read_text().splitlines() if ln]
    print("## health-w0-gov-probe (read-only)\n")
    print("| probe | result | rc |\n|---|---|---|")
    for name, result, rc, _file in rows:
        print(f"| {name} | {result} | {rc} |")
    print()

    for name, result, rc, file in rows:
        if result == "FAILED":
            err = (out / (file + ".stderr")).read_text(errors="replace")[:1500]
            print(f"### FAILED: {name} (rc={rc})\n\n```\n{err}\n```\n")
            continue
        data, perr = load(out / file)
        if perr:
            print(f"### UNPARSEABLE: {name}: {perr}\n")
            continue
        if name.startswith("provider:"):
            types = data.get("resourceTypes", [])
            print(f"### {name}: registrationState={data.get('registrationState')}, resourceTypes={len(types)}\n")
            print("| resourceType | Gov/DoD locations |\n|---|---|")
            hits = 0
            for t in types:
                if t.get("resourceType") in KEY_TYPES:
                    gov = [x for x in t.get("locations", []) if is_gov(x)]
                    print(f"| {t['resourceType']} | {', '.join(gov) or 'NONE listed'} |")
                    hits += 1
            if hits == 0:
                print("| (no key resource type in this provider) | |")
            if name == "provider:Microsoft.EventHub":
                print(
                    "\nNote: namespaces/clusters locations do not prove the Premium "
                    "SKU is orderable; no read-only SKU form was used."
                )
            print()
        elif name == "account:list-locations":
            print("### account list-locations (Gov/DoD only)\n")
            print("| name | regionType | physicalLocation | pairedRegion |\n|---|---|---|---|")
            n = 0
            for loc in data:
                if is_gov(loc.get("name", "")):
                    meta = loc.get("metadata", {})
                    paired = [p.get("name") for p in meta.get("pairedRegion", []) or []]
                    print(
                        f"| {loc['name']} | {meta.get('regionType')} | "
                        f"{meta.get('physicalLocation')} | {', '.join(paired) or 'none'} |"
                    )
                    n += 1
            print(f"\nGov/DoD locations listed: {n} of {len(data)}\n")
        elif name.startswith("postgres:list-skus"):
            blob = json.dumps(data).lower()
            names = sorted({s for s in _walk_names(data) if s.startswith("Standard_")})
            e_series = [s for s in names if s.startswith("Standard_E")]
            print(f"### {name}\n")
            print(
                f"- SKU names listed: {len(names)}; E-series: {len(e_series)} "
                f"({', '.join(e_series[:12])}{'...' if len(e_series) > 12 else ''})"
            )
            print(
                f"- substring 'premiumv2' in raw output: {'premiumv2' in blob}; "
                f"'ssdv2': {'ssdv2' in blob}  (SSD v2 judgement is made from the raw "
                "artifact, these are only hints)\n"
            )
        elif name.startswith("aks:get-versions"):
            vers = [v.get("version") for v in data.get("values", data.get("orchestrators", []))]
            print(
                f"### {name}\n\n- Kubernetes versions listed: {len(vers)} "
                f"({', '.join(str(v) for v in vers[:8])})\n- KEDA add-on availability is "
                "NOT established by this probe (no read API).\n"
            )
    return 0


def _walk_names(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "name" and isinstance(v, str):
                yield v
            yield from _walk_names(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_names(v)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
