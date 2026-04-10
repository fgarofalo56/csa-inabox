#!/usr/bin/env python3
"""Bootstrap Purview catalog with collections, glossary terms, and scan sources.

Usage:
    python bootstrap_catalog.py --purview-account csapurview
    python bootstrap_catalog.py --purview-account csapurview --dry-run

Prerequisites:
    pip install azure-identity azure-purview-catalog azure-purview-scanning
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def get_catalog_client(account_name: str) -> Any:
    """Create Purview catalog client with DefaultAzureCredential."""
    from azure.identity import DefaultAzureCredential
    from azure.purview.catalog import PurviewCatalogClient

    endpoint = f"https://{account_name}.purview.azure.com"
    credential = DefaultAzureCredential()
    return PurviewCatalogClient(endpoint=endpoint, credential=credential)


def get_scanning_client(account_name: str) -> Any:
    """Create Purview scanning client with DefaultAzureCredential."""
    from azure.identity import DefaultAzureCredential
    from azure.purview.scanning import PurviewScanningClient

    endpoint = f"https://{account_name}.purview.azure.com"
    credential = DefaultAzureCredential()
    return PurviewScanningClient(endpoint=endpoint, credential=credential)


# ---------------------------------------------------------------------------
# Collection hierarchy
# ---------------------------------------------------------------------------
COLLECTIONS = [
    {"name": "csa-inabox", "description": "CSA-in-a-Box root collection", "parent": None},
    {"name": "shared", "description": "Shared domain - cross-cutting data assets", "parent": "csa-inabox"},
    {"name": "sales", "description": "Sales domain - orders, customers, products", "parent": "csa-inabox"},
    {"name": "finance", "description": "Finance domain - invoices, payments, reconciliation", "parent": "csa-inabox"},
]


def create_collections(client: Any, dry_run: bool = False) -> None:
    """Create collection hierarchy in Purview."""
    print("\nCreating collections...")
    for coll in COLLECTIONS:
        body: dict[str, Any] = {
            "description": coll["description"],
            "friendlyName": coll["name"],
        }
        if coll["parent"]:
            body["parentCollection"] = {"referenceName": coll["parent"]}

        if dry_run:
            print(f"  [DRY RUN] Would create collection: {coll['name']}")
            continue

        try:
            client.collection.create_or_update(coll["name"], body)
            print(f"  Created: {coll['name']}")
        except Exception as e:
            print(f"  Error creating {coll['name']}: {e}")


# ---------------------------------------------------------------------------
# Glossary terms
# ---------------------------------------------------------------------------
GLOSSARY_TERMS = [
    {
        "name": "Customer",
        "definition": "An individual or organization that purchases products or services. Identified by customer_id across all domains.",
        "domain": "shared",
        "related_assets": ["sample_customers", "dim_customers", "slv_customers"],
    },
    {
        "name": "Order",
        "definition": "A purchase transaction initiated by a customer. Tracks items, amounts, and fulfillment status through the Bronze-Silver-Gold pipeline.",
        "domain": "sales",
        "related_assets": ["sample_orders", "fact_orders", "slv_orders"],
    },
    {
        "name": "Product",
        "definition": "A good available for purchase. Categorized by type (Electronics, Clothing, Home, Books, Sports) with standardized pricing.",
        "domain": "shared",
        "related_assets": ["sample_products", "dim_products", "slv_products"],
    },
    {
        "name": "Invoice",
        "definition": "A billing document issued to a customer for goods or services delivered. Links to sales orders for revenue reconciliation.",
        "domain": "finance",
        "related_assets": ["sample_invoices", "slv_invoices", "gld_aging_report"],
    },
    {
        "name": "Payment",
        "definition": "A monetary transaction that settles an invoice. Multiple payments can apply to a single invoice (partial payments).",
        "domain": "finance",
        "related_assets": ["sample_payments", "slv_payments"],
    },
    {
        "name": "Revenue",
        "definition": "Income generated from sales of products and services. Measured at order level (sales domain) and invoice level (finance domain). The gld_revenue_reconciliation model joins both for cross-domain accuracy.",
        "domain": "shared",
        "related_assets": ["gld_monthly_revenue", "gld_revenue_reconciliation", "gld_customer_lifetime_value"],
    },
    {
        "name": "Data Product",
        "definition": "A self-contained data asset with defined schema, SLA, quality rules, and ownership. Governed by contract.yaml files under each domain's data-products/ directory.",
        "domain": "shared",
        "related_assets": [],
    },
    {
        "name": "Medallion Architecture",
        "definition": "Data lakehouse pattern with three layers: Bronze (raw ingestion), Silver (conformed, validated, flag-don't-drop), Gold (business-ready aggregates and dimensions).",
        "domain": "shared",
        "related_assets": [],
    },
]


def create_glossary_terms(client: Any, dry_run: bool = False) -> None:
    """Create business glossary terms."""
    print("\nCreating glossary terms...")
    for term in GLOSSARY_TERMS:
        body = {
            "name": term["name"],
            "longDescription": term["definition"],
            "status": "Approved",
            "anchor": {"glossaryGuid": ""},  # Will be resolved
        }

        if dry_run:
            print(f"  [DRY RUN] Would create term: {term['name']} ({term['domain']})")
            continue

        try:
            # Get the default glossary
            glossaries = client.glossary.list_glossaries()
            if glossaries:
                body["anchor"]["glossaryGuid"] = glossaries[0]["guid"]

            client.glossary.create_glossary_term(body)
            print(f"  Created: {term['name']}")
        except Exception as e:
            print(f"  Error creating {term['name']}: {e}")


# ---------------------------------------------------------------------------
# Scan sources
# ---------------------------------------------------------------------------
SCAN_SOURCES = [
    {
        "name": "adls-bronze",
        "kind": "AzureStorage",
        "description": "ADLS Gen2 Bronze layer - raw ingested data",
        "collection": "shared",
    },
    {
        "name": "adls-silver",
        "kind": "AzureStorage",
        "description": "ADLS Gen2 Silver layer - conformed and validated data",
        "collection": "shared",
    },
    {
        "name": "adls-gold",
        "kind": "AzureStorage",
        "description": "ADLS Gen2 Gold layer - business-ready aggregates",
        "collection": "shared",
    },
]


def register_scan_sources(client: Any, storage_account: str, dry_run: bool = False) -> None:
    """Register ADLS containers as Purview scan sources."""
    print("\nRegistering scan sources...")
    for source in SCAN_SOURCES:
        body = {
            "kind": source["kind"],
            "properties": {
                "endpoint": f"https://{storage_account}.blob.core.windows.net",
                "collection": {"referenceName": source["collection"], "type": "CollectionReference"},
                "description": source["description"],
            },
        }

        if dry_run:
            print(f"  [DRY RUN] Would register: {source['name']}")
            continue

        try:
            client.data_sources.create_or_update(source["name"], body)
            print(f"  Registered: {source['name']}")
        except Exception as e:
            print(f"  Error registering {source['name']}: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap Purview catalog for CSA-in-a-Box")
    parser.add_argument("--purview-account", required=True, help="Purview account name")
    parser.add_argument("--storage-account", default="csadatalake", help="ADLS storage account name")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen")
    args = parser.parse_args()

    print(f"Bootstrapping Purview catalog: {args.purview_account}")

    if args.dry_run:
        print("[DRY RUN MODE]")
        create_collections(None, dry_run=True)
        create_glossary_terms(None, dry_run=True)
        register_scan_sources(None, args.storage_account, dry_run=True)
    else:
        catalog_client = get_catalog_client(args.purview_account)
        scanning_client = get_scanning_client(args.purview_account)

        create_collections(catalog_client)
        create_glossary_terms(catalog_client)
        register_scan_sources(scanning_client, args.storage_account)

    print("\nDone!")


if __name__ == "__main__":
    main()
