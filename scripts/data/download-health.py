#!/usr/bin/env python3
"""
Download health and medical data.

Downloads CMS (Centers for Medicare & Medicaid Services) public use files,
including Medicare provider data and other healthcare datasets.

Data sources:
- CMS Public Use Files: https://www.cms.gov/Research-Statistics-Data-and-Systems/Statistics-Trends-and-Reports/Medicare-Provider-Charge-Data
- Medicare Provider Data: https://data.cms.gov/
"""

import argparse
import json
import logging
import os
import sys
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
import requests
from tqdm import tqdm


def setup_logging(verbose: bool = False) -> None:
    """Set up logging configuration."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )


class HealthDownloader:
    """Download health and medical data from government sources."""

    CMS_BASE_URL = "https://www.cms.gov/Research-Statistics-Data-and-Systems/Statistics-Trends-and-Reports/Medicare-Provider-Charge-Data/"
    DATA_CMS_URL = "https://data.cms.gov/data-api/v1/dataset/"

    def __init__(self):
        """Initialize downloader."""
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'CSA-in-a-Box Data Downloader (research/educational use)'
        })

    def _download_file(self, url: str, description: str) -> Optional[bytes]:
        """Download file with progress bar and return content."""
        try:
            response = self.session.get(url, stream=True, timeout=120)
            response.raise_for_status()

            # Get content length for progress bar
            total_size = int(response.headers.get('content-length', 0))

            content = []
            with tqdm(desc=description, total=total_size, unit='B', unit_scale=True) as pbar:
                for chunk in response.iter_content(chunk_size=8192):
                    content.append(chunk)
                    pbar.update(len(chunk))

            return b''.join(content)

        except requests.RequestException as e:
            logging.error(f"Failed to download {url}: {e}")
            return None

    def download_medicare_provider_utilization(self, year: str) -> List[Dict]:
        """Download Medicare Provider Utilization and Payment data."""
        # This is a large dataset - the actual filename varies by year
        filename_patterns = [
            f"Medicare_Provider_Utilization_and_Payment_Data__Physician_and_Other_Supplier_PUF_CY{year}.csv",
            f"Medicare-Physician-and-Other-Supplier-PUF-CY{year}.csv",
            f"Medicare_Provider_Util_Payment_PUF_CY{year}.csv"
        ]

        base_urls = [
            "https://www.cms.gov/Research-Statistics-Data-and-Systems/Statistics-Trends-and-Reports/Medicare-Provider-Charge-Data/Downloads/",
            "https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/medicare-physician-other-practitioners-by-provider-and-service/data/"
        ]

        for base_url in base_urls:
            for filename in filename_patterns:
                url = f"{base_url}{filename}"
                content = self._download_file(url, f"Medicare Provider {year}")

                if content:
                    try:
                        df = pd.read_csv(BytesIO(content), low_memory=False)
                        return df.to_dict('records')
                    except Exception as e:
                        logging.warning(f"Could not parse {filename}: {e}")

        logging.warning(f"Could not download Medicare provider data for {year}")
        return []

    def download_medicare_inpatient_charges(self, year: str) -> List[Dict]:
        """Download Medicare Inpatient Hospital Charge data."""
        filename_patterns = [
            f"Inpatient_Prospective_Payment_System__IPPS__Provider_Summary_for_the_Top_100_Diagnosis-Related_Groups__DRG__-_FY{year}.csv",
            f"Medicare_Provider_Charge_Inpatient_DRGALL_FY{year}.csv",
            f"Inpatient_Data_CY{year}.csv"
        ]

        base_url = "https://www.cms.gov/Research-Statistics-Data-and-Systems/Statistics-Trends-and-Reports/Medicare-Provider-Charge-Data/Downloads/"

        for filename in filename_patterns:
            url = f"{base_url}{filename}"
            content = self._download_file(url, f"Medicare Inpatient {year}")

            if content:
                try:
                    df = pd.read_csv(BytesIO(content), low_memory=False)
                    return df.to_dict('records')
                except Exception as e:
                    logging.warning(f"Could not parse {filename}: {e}")

        return []

    def download_nursing_home_data(self, year: str) -> List[Dict]:
        """Download Nursing Home Compare data."""
        # Nursing home data via data.cms.gov API or direct download
        try:
            # Try data.cms.gov API approach
            api_url = f"{self.DATA_CMS_URL}nursing-home-care-compare/data"
            response = self.session.get(api_url, timeout=30)

            if response.status_code == 200:
                data = response.json()
                return data

        except Exception as e:
            logging.warning(f"Could not access nursing home data via API: {e}")

        # Try direct CSV download
        filename = f"NH_ProviderInfo_{year}.csv"
        url = f"https://data.cms.gov/provider-data/sites/default/files/resources/{filename}"

        content = self._download_file(url, f"Nursing Home {year}")
        if content:
            try:
                df = pd.read_csv(BytesIO(content), low_memory=False)
                return df.to_dict('records')
            except Exception as e:
                logging.error(f"Could not parse nursing home data: {e}")

        return []

    def download_hospital_general_information(self, year: str) -> List[Dict]:
        """Download Hospital General Information."""
        filename = f"Hospital_General_Information.csv"
        url = f"https://data.cms.gov/provider-data/sites/default/files/resources/{filename}"

        content = self._download_file(url, f"Hospital Info {year}")
        if content:
            try:
                df = pd.read_csv(BytesIO(content), low_memory=False)
                return df.to_dict('records')
            except Exception as e:
                logging.error(f"Could not parse hospital data: {e}")

        return []

    def download_cms_datasets_catalog(self) -> Dict:
        """Get catalog of available CMS datasets."""
        try:
            url = "https://data.cms.gov/data-api/v1/dataset"
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            return response.json()

        except Exception as e:
            logging.error(f"Could not get CMS datasets catalog: {e}")
            return {}

    def get_available_health_datasets(self) -> List[str]:
        """Get list of available health datasets."""
        return [
            'Medicare Provider Utilization and Payment',
            'Medicare Inpatient Hospital Charges',
            'Nursing Home Compare',
            'Hospital General Information',
            'Home Health Care',
            'Hospice Care',
            'Dialysis Facility Compare'
        ]


def save_data_with_manifest(data: List[Dict], filename: str, output_dir: Path,
                          description: str, source_url: str) -> None:
    """Save data as CSV and update manifest."""
    if not data:
        logging.warning(f"No data to save for {description}")
        return

    # Convert to DataFrame and save
    df = pd.DataFrame(data)
    csv_path = output_dir / filename
    df.to_csv(csv_path, index=False)

    # Update manifest
    manifest_path = output_dir / "manifest.json"

    manifest = {}
    if manifest_path.exists():
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)

    file_info = {
        'filename': filename,
        'description': description,
        'source_url': source_url,
        'download_timestamp': datetime.utcnow().isoformat() + 'Z',
        'record_count': len(data),
        'file_size_bytes': csv_path.stat().st_size,
        'columns': list(df.columns) if not df.empty else []
    }

    manifest[filename] = file_info

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    logging.info(f"Saved {len(data)} records to {csv_path}")


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Download health and medical data from CMS and other sources",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--year',
        default='2022',
        help='Year to download data for (note: health data has reporting lags)'
    )
    parser.add_argument(
        '--dataset',
        choices=['provider', 'inpatient', 'nursing-home', 'hospital-info', 'all'],
        default='all',
        help='Dataset to download'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/tribal-health/data/raw/',
        help='Output directory for downloaded files'
    )
    parser.add_argument(
        '--list-datasets',
        action='store_true',
        help='List available datasets and exit'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    setup_logging(args.verbose)

    # Initialize downloader
    downloader = HealthDownloader()

    # List datasets if requested
    if args.list_datasets:
        datasets = downloader.get_available_health_datasets()
        print("Available health datasets:")
        for dataset in datasets:
            print(f"  - {dataset}")

        # Try to get CMS catalog
        catalog = downloader.download_cms_datasets_catalog()
        if catalog and 'result' in catalog:
            print(f"\nCMS Data.gov catalog contains {len(catalog['result'])} datasets")
            print("First 10 datasets:")
            for dataset in catalog['result'][:10]:
                print(f"  - {dataset.get('title', 'Unknown')}")

        return

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Download datasets
        if args.dataset in ['provider', 'all']:
            logging.info(f"Downloading Medicare Provider data for {args.year}")
            data = downloader.download_medicare_provider_utilization(args.year)
            filename = f"medicare_provider_utilization_{args.year}.csv"

            save_data_with_manifest(
                data, filename, output_dir,
                f"Medicare Provider Utilization and Payment Data for {args.year}",
                downloader.CMS_BASE_URL
            )

        if args.dataset in ['inpatient', 'all']:
            logging.info(f"Downloading Medicare Inpatient data for {args.year}")
            data = downloader.download_medicare_inpatient_charges(args.year)
            filename = f"medicare_inpatient_charges_{args.year}.csv"

            save_data_with_manifest(
                data, filename, output_dir,
                f"Medicare Inpatient Hospital Charges for {args.year}",
                downloader.CMS_BASE_URL
            )

        if args.dataset in ['nursing-home', 'all']:
            logging.info(f"Downloading Nursing Home data for {args.year}")
            data = downloader.download_nursing_home_data(args.year)
            filename = f"nursing_home_compare_{args.year}.csv"

            save_data_with_manifest(
                data, filename, output_dir,
                f"Nursing Home Compare Data for {args.year}",
                "https://data.cms.gov/provider-data"
            )

        if args.dataset in ['hospital-info', 'all']:
            logging.info(f"Downloading Hospital General Information")
            data = downloader.download_hospital_general_information(args.year)
            filename = f"hospital_general_information_{args.year}.csv"

            save_data_with_manifest(
                data, filename, output_dir,
                f"Hospital General Information",
                "https://data.cms.gov/provider-data"
            )

        # Save available datasets reference
        datasets_info = {
            'available_datasets': downloader.get_available_health_datasets(),
            'year': args.year,
            'generated': datetime.utcnow().isoformat() + 'Z',
            'note': 'Health data typically has 1-2 year reporting lag'
        }

        info_path = output_dir / "health_datasets_info.json"
        with open(info_path, 'w') as f:
            json.dump(datasets_info, f, indent=2)

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()