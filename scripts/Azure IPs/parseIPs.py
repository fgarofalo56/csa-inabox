"""
Azure Service Tags IP Prefix Parser and Aggregator

Parses Azure Service Tags JSON files, extracts IP prefixes,
and merges/collapses them into the most compact CIDR representation.
"""

import ipaddress
import json
import sys
from pathlib import Path


def extract_address_prefixes(directory: str) -> tuple[set[str], set[str]]:
    """Extract IPv4 and IPv6 address prefixes from Azure Service Tags JSON files.

    Args:
        directory: Path to directory containing Service Tags JSON files.

    Returns:
        Tuple of (ipv4_prefixes, ipv6_prefixes) as sets of CIDR strings.

    Raises:
        FileNotFoundError: If directory does not exist.
    """
    directory_path = Path(directory)
    if not directory_path.is_dir():
        raise FileNotFoundError(f"Directory not found: {directory}")

    ipv4_prefixes: set[str] = set()
    ipv6_prefixes: set[str] = set()

    json_files = list(directory_path.glob("*.json"))
    if not json_files:
        print(f"Warning: No JSON files found in {directory}")
        return ipv4_prefixes, ipv6_prefixes

    for filepath in json_files:
        try:
            with open(filepath, encoding="utf-8") as file:
                data = json.load(file)
        except (json.JSONDecodeError, OSError) as e:
            print(f"Error reading {filepath}: {e}")
            continue

        for value in data.get("values", []):
            prefixes = value.get("properties", {}).get("addressPrefixes", [])
            for prefix in prefixes:
                try:
                    if ":" in prefix:
                        ipv6_prefixes.add(
                            str(ipaddress.IPv6Network(prefix, strict=False))
                        )
                    else:
                        ipv4_prefixes.add(
                            str(ipaddress.IPv4Network(prefix, strict=False))
                        )
                except ValueError:
                    print(f"Invalid IP prefix found and skipped: {prefix}")

    return ipv4_prefixes, ipv6_prefixes


def merge_prefixes(prefixes: set[str]) -> list[str]:
    """Merge and collapse a set of IP prefixes into the most compact CIDR list.

    Uses ipaddress.collapse_addresses() for correct CIDR aggregation.

    Args:
        prefixes: Set of CIDR notation strings.

    Returns:
        Sorted list of collapsed CIDR strings.
    """
    if not prefixes:
        return []

    networks = []
    for prefix in prefixes:
        try:
            networks.append(ipaddress.ip_network(prefix, strict=False))
        except ValueError as e:
            print(f"Skipping invalid prefix '{prefix}': {e}")

    if not networks:
        return []

    # Use the stdlib's correct CIDR collapse algorithm
    collapsed = list(ipaddress.collapse_addresses(networks))
    collapsed.sort(key=lambda n: (n.network_address, n.prefixlen))

    return [str(n) for n in collapsed]


def write_to_file(prefixes: list[str], output_file: str) -> None:
    """Write a list of CIDR prefixes to a file, one per line.

    Args:
        prefixes: List of CIDR notation strings (already sorted).
        output_file: Path to the output file.
    """
    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as file:
        for prefix in prefixes:
            file.write(f"{prefix}\n")

    print(f"Wrote {len(prefixes)} prefixes to {output_file}")


if __name__ == "__main__":
    # Use relative path from script location
    script_dir = Path(__file__).parent
    lists_dir = script_dir / "lists"
    ipv4_output_file = script_dir / "merged_ipv4_prefixes.txt"
    ipv6_output_file = script_dir / "merged_ipv6_prefixes.txt"

    if not lists_dir.is_dir():
        print(f"Error: Lists directory not found at {lists_dir}")
        sys.exit(1)

    print(f"Scanning {lists_dir} for Service Tags JSON files...")
    ipv4_prefixes, ipv6_prefixes = extract_address_prefixes(str(lists_dir))

    print(f"Found {len(ipv4_prefixes)} IPv4 and {len(ipv6_prefixes)} IPv6 prefixes")

    merged_ipv4 = merge_prefixes(ipv4_prefixes)
    merged_ipv6 = merge_prefixes(ipv6_prefixes)

    print(f"Collapsed to {len(merged_ipv4)} IPv4 and {len(merged_ipv6)} IPv6 prefixes")

    write_to_file(merged_ipv4, str(ipv4_output_file))
    write_to_file(merged_ipv6, str(ipv6_output_file))

    print("Done.")
