#!/usr/bin/env python3
"""Seed Purview business glossary from a YAML file.

Reads hierarchical glossary terms from a YAML file and creates them in
Microsoft Purview via the Atlas REST API, preserving parent-child relationships.

Usage:
    python scripts/governance/seed-glossary.py \
        --purview-account csadmlzdevpview \
        --glossary-file scripts/governance/glossary-terms.yaml \
        [--glossary-name "CSA Business Glossary"] \
        [--dry-run]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import requests
import yaml


def get_access_token() -> str:
    """Acquire an access token for Purview using azure-identity."""
    from azure.identity import DefaultAzureCredential

    credential = DefaultAzureCredential()
    token = credential.get_token("https://purview.azure.net/.default")
    return token.token


class PurviewGlossarySeeder:
    """Seeds a Purview glossary from a YAML definition file."""

    def __init__(self, account_name: str, token: str, dry_run: bool = False) -> None:
        self.endpoint = f"https://{account_name}.purview.azure.com"
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        self.dry_run = dry_run
        self._term_guid_cache: dict[str, str] = {}

    def _request(self, method: str, path: str, body: dict | None = None) -> dict[str, Any]:
        url = f"{self.endpoint}{path}"
        resp = requests.request(method, url, headers=self.headers, json=body, timeout=30)
        if resp.status_code >= 400:
            print(f"  ERROR: {method} {path} → {resp.status_code}: {resp.text[:200]}")
            resp.raise_for_status()
        return resp.json() if resp.text else {}

    def ensure_glossary(self, name: str) -> str:
        """Get or create the root glossary, return its GUID."""
        try:
            glossaries = self._request("GET", "/catalog/api/atlas/v2/glossary")
            if isinstance(glossaries, list):
                for g in glossaries:
                    if g.get("name") == name:
                        print(f"  Found existing glossary: {name} ({g['guid']})")
                        return g["guid"]
        except Exception:
            pass

        print(f"  Creating glossary: {name}")
        if self.dry_run:
            return "dry-run-glossary-guid"

        result = self._request("POST", "/catalog/api/atlas/v2/glossary", {
            "name": name,
            "shortDescription": "Business glossary for CSA-in-a-Box",
            "longDescription": "Automatically managed business glossary for the Cloud Scale Analytics platform.",
        })
        return result["guid"]

    def create_term(
        self,
        glossary_guid: str,
        name: str,
        definition: str,
        abbreviation: str = "",
        status: str = "Approved",
        parent_guid: str | None = None,
        contacts: list[dict] | None = None,
        related_terms: list[str] | None = None,  # noqa: ARG002
        classifications: list[str] | None = None,
    ) -> str | None:
        """Create a single glossary term, return its GUID."""
        # Check cache to avoid duplicates
        if name in self._term_guid_cache:
            return self._term_guid_cache[name]

        payload: dict[str, Any] = {
            "name": name,
            "shortDescription": definition[:256] if len(definition) > 256 else definition,
            "longDescription": definition,
            "status": status,
            "anchor": {"glossaryGuid": glossary_guid},
        }

        if abbreviation:
            payload["abbreviation"] = abbreviation

        if parent_guid:
            payload["parentRelatedTerm"] = {"termGuid": parent_guid}

        if contacts:
            contact_map: dict[str, list[dict]] = {}
            for c in contacts:
                role = c.get("type", "Expert")
                if role not in contact_map:
                    contact_map[role] = []
                contact_map[role].append({
                    "id": c.get("email", ""),
                    "info": c.get("email", ""),
                })
            payload["contacts"] = contact_map

        if classifications:
            payload["classifications"] = [
                {"typeName": cls_name} for cls_name in classifications
            ]

        print(f"  {'[DRY RUN] ' if self.dry_run else ''}Creating term: {name}" +
              (f" (parent: {parent_guid[:8]}...)" if parent_guid else ""))

        if self.dry_run:
            guid = f"dry-run-{name}"
            self._term_guid_cache[name] = guid
            return guid

        try:
            result = self._request("POST", "/catalog/api/atlas/v2/glossary/term", payload)
            guid = result.get("guid", "")
            self._term_guid_cache[name] = guid
            print(f"    ✓ Created: {guid}")
            return guid
        except Exception as e:
            print(f"    ✗ Failed: {e}")
            return None

    def seed_from_yaml(self, yaml_path: str, glossary_name: str) -> dict[str, int]:
        """Seed all terms from a YAML file, preserving hierarchy."""
        path = Path(yaml_path)
        with open(path) as f:
            data = yaml.safe_load(f)

        glossary_guid = self.ensure_glossary(glossary_name)
        stats = {"created": 0, "failed": 0, "skipped": 0}

        categories = data.get("categories", [])
        for category in categories:
            cat_name = category.get("name", "")
            cat_def = category.get("definition", cat_name)

            # Create category as a parent term
            parent_guid = self.create_term(
                glossary_guid=glossary_guid,
                name=cat_name,
                definition=cat_def,
            )
            if parent_guid:
                stats["created"] += 1
            else:
                stats["failed"] += 1
                continue

            # Create child terms
            for term in category.get("terms", []):
                term_guid = self.create_term(
                    glossary_guid=glossary_guid,
                    name=term["name"],
                    definition=term.get("definition", ""),
                    abbreviation=term.get("abbreviation", ""),
                    status=term.get("status", "Approved"),
                    parent_guid=parent_guid,
                    contacts=term.get("contacts"),
                    related_terms=term.get("relatedTerms"),
                    classifications=term.get("classifications"),
                )
                if term_guid:
                    stats["created"] += 1
                else:
                    stats["failed"] += 1

                # Handle sub-terms (third level)
                for sub_term in term.get("subTerms", []):
                    sub_guid = self.create_term(
                        glossary_guid=glossary_guid,
                        name=sub_term["name"],
                        definition=sub_term.get("definition", ""),
                        abbreviation=sub_term.get("abbreviation", ""),
                        parent_guid=term_guid,
                    )
                    if sub_guid:
                        stats["created"] += 1
                    else:
                        stats["failed"] += 1

        # Handle standalone terms (not in categories)
        for term in data.get("terms", []):
            term_guid = self.create_term(
                glossary_guid=glossary_guid,
                name=term["name"],
                definition=term.get("definition", ""),
                abbreviation=term.get("abbreviation", ""),
                status=term.get("status", "Approved"),
                contacts=term.get("contacts"),
            )
            if term_guid:
                stats["created"] += 1
            else:
                stats["failed"] += 1

        return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed Purview glossary from YAML")
    parser.add_argument("--purview-account", required=True, help="Purview account name")
    parser.add_argument("--glossary-file", required=True, help="Path to glossary YAML file")
    parser.add_argument("--glossary-name", default="CSA Business Glossary", help="Glossary name in Purview")
    parser.add_argument("--dry-run", action="store_true", help="Validate without creating terms")
    args = parser.parse_args(argv)

    if not Path(args.glossary_file).exists():
        print(f"ERROR: Glossary file not found: {args.glossary_file}")
        return 1

    print(f"Seeding glossary from: {args.glossary_file}")
    print(f"Purview account: {args.purview_account}")
    print(f"Glossary name: {args.glossary_name}")
    print(f"Dry run: {args.dry_run}")
    print()

    token = get_access_token()
    seeder = PurviewGlossarySeeder(args.purview_account, token, dry_run=args.dry_run)
    stats = seeder.seed_from_yaml(args.glossary_file, args.glossary_name)

    print()
    print(f"Results: {stats['created']} created, {stats['failed']} failed, {stats['skipped']} skipped")
    return 1 if stats["failed"] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
