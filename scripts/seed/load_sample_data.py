#!/usr/bin/env python3
"""Upload seed CSV files to ADLS Gen2 Bronze container.

Usage:
    # Upload to Azure (requires az login or managed identity):
    python load_sample_data.py --storage-account csadatalake --container raw

    # Use dbt seed instead (local Spark / Databricks):
    python load_sample_data.py --mode dbt

    # Dry run — show what would happen:
    python load_sample_data.py --storage-account csadatalake --dry-run

Prerequisites:
    pip install azure-storage-blob azure-identity
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


SEED_DIR = Path(__file__).resolve().parent.parent.parent / "domains" / "shared" / "dbt" / "seeds"
DBT_PROJECT_DIR = Path(__file__).resolve().parent.parent.parent / "domains" / "shared" / "dbt"


def upload_to_adls(
    storage_account: str,
    container: str,
    domain: str,
    dry_run: bool = False,
) -> None:
    """Upload all CSVs in SEED_DIR to ADLS Gen2 using azure-storage-blob."""
    try:
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import BlobServiceClient
    except ImportError:
        print("ERROR: azure-storage-blob and azure-identity are required.")
        print("  pip install azure-storage-blob azure-identity")
        sys.exit(1)

    account_url = f"https://{storage_account}.blob.core.windows.net"
    credential = DefaultAzureCredential()
    blob_service = BlobServiceClient(account_url=account_url, credential=credential)
    container_client = blob_service.get_container_client(container)

    csv_files = sorted(SEED_DIR.glob("*.csv"))
    if not csv_files:
        print(f"No CSV files found in {SEED_DIR}")
        sys.exit(1)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"Uploading {len(csv_files)} seed files to {account_url}/{container}/{domain}/")

    for csv_path in csv_files:
        # Upload path: {container}/{domain}/{table_name}/{filename}
        table_name = csv_path.stem  # e.g. "sample_customers"
        blob_name = f"{domain}/{table_name}/{csv_path.name}"

        if dry_run:
            size_kb = csv_path.stat().st_size / 1024
            print(f"  [DRY RUN] Would upload {csv_path.name} ({size_kb:.1f} KB) -> {blob_name}")
            continue

        print(f"  Uploading {csv_path.name} -> {blob_name} ...", end=" ")
        with open(csv_path, "rb") as f:
            container_client.upload_blob(
                name=blob_name,
                data=f,
                overwrite=True,
                metadata={
                    "uploaded_by": "csa-inabox-seed-loader",
                    "uploaded_at": now,
                    "domain": domain,
                    "source": "seed",
                },
            )
        print("done")

    print(f"\nAll files uploaded to: {account_url}/{container}/{domain}/")
    print("Next steps:")
    print("  1. Run the ADF Bronze ingestion pipeline (or dbt seed)")
    print("  2. Verify with: SELECT count(*) FROM bronze.sample_orders")


def run_dbt_seed(dry_run: bool = False) -> None:
    """Run dbt seed in the dbt project directory."""
    if not DBT_PROJECT_DIR.exists():
        print(f"ERROR: dbt project not found at {DBT_PROJECT_DIR}")
        sys.exit(1)

    cmd = ["dbt", "seed", "--project-dir", str(DBT_PROJECT_DIR)]
    if dry_run:
        print(f"[DRY RUN] Would run: {' '.join(cmd)}")
        return

    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(DBT_PROJECT_DIR), capture_output=False)
    if result.returncode != 0:
        print(f"ERROR: dbt seed failed with exit code {result.returncode}")
        sys.exit(result.returncode)

    print("\ndbt seed completed. Next steps:")
    print("  1. dbt run --select tag:bronze")
    print("  2. dbt run --select tag:silver")
    print("  3. dbt run --select tag:gold")
    print("  4. dbt test")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Load CSA-in-a-Box sample data into ADLS or via dbt seed",
    )
    parser.add_argument(
        "--mode",
        choices=["adls", "dbt"],
        default="adls",
        help="Upload to ADLS Gen2 (default) or run dbt seed",
    )
    parser.add_argument(
        "--storage-account",
        help="ADLS Gen2 storage account name (required for adls mode)",
    )
    parser.add_argument(
        "--container",
        default="raw",
        help="ADLS container name (default: raw)",
    )
    parser.add_argument(
        "--domain",
        default="shared",
        help="Domain path prefix in container (default: shared)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would happen without making changes",
    )

    args = parser.parse_args()

    if args.mode == "adls":
        if not args.storage_account:
            parser.error("--storage-account is required for adls mode")
        upload_to_adls(
            storage_account=args.storage_account,
            container=args.container,
            domain=args.domain,
            dry_run=args.dry_run,
        )
    else:
        run_dbt_seed(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
