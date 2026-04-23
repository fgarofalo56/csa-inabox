#!/usr/bin/env python3
"""
Download Commerce Department retail and economic data.

Downloads Monthly Retail Trade Survey data and other economic indicators
from the US Census Bureau (part of Commerce Department).

Data sources:
- Monthly Retail Trade: https://www.census.gov/retail/index.html
- Economic Indicators: https://www.census.gov/economic-indicators/
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


class CommerceDownloader:
    """Download retail and economic data from Commerce Department."""

    RETAIL_BASE_URL = "https://www.census.gov/retail/mrts/www/data/excel/"
    ECON_BASE_URL = "https://www.census.gov/economic-indicators/"

    def __init__(self):
        """Initialize downloader."""
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'CSA-in-a-Box Data Downloader (research/educational use)'
        })

    def _download_file(self, url: str, description: str) -> Optional[bytes]:
        """Download file with progress bar and return content."""
        try:
            response = self.session.get(url, stream=True, timeout=60)
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

    def download_monthly_retail_trade(self, year: str) -> List[Dict]:
        """Download Monthly Retail Trade Survey data."""
        # Monthly retail trade data is typically available as Excel files
        filename = f"mrtssales{year}.xlsx"
        url = f"{self.RETAIL_BASE_URL}{filename}"

        content = self._download_file(url, f"Monthly Retail Trade {year}")
        if not content:
            # Try alternative filename format
            filename = f"mrts{year}.xlsx"
            url = f"{self.RETAIL_BASE_URL}{filename}"
            content = self._download_file(url, f"Monthly Retail Trade {year} (alt)")

        if not content:
            logging.warning(f"Could not download retail trade data for {year}")
            return []

        try:
            # Read Excel file
            excel_file = BytesIO(content)
            df = pd.read_excel(excel_file, engine='openpyxl', header=0)

            # Clean up the data
            df = df.dropna(how='all')  # Remove empty rows
            return df.to_dict('records')

        except Exception as e:
            logging.error(f"Failed to parse retail trade data: {e}")
            return []

    def download_retail_ecommerce(self, year: str) -> List[Dict]:
        """Download E-commerce retail sales data."""
        filename = f"ecomm{year}.xlsx"
        url = f"{self.RETAIL_BASE_URL}{filename}"

        content = self._download_file(url, f"E-commerce Retail {year}")
        if not content:
            return []

        try:
            # Read Excel file
            excel_file = BytesIO(content)
            df = pd.read_excel(excel_file, engine='openpyxl', header=0)

            # Clean up the data
            df = df.dropna(how='all')  # Remove empty rows
            return df.to_dict('records')

        except Exception as e:
            logging.error(f"Failed to parse e-commerce data: {e}")
            return []

    def download_quarterly_services(self, year: str) -> List[Dict]:
        """Download Quarterly Services Survey data."""
        # QSS data is often available through Economic Indicators
        # This is a simplified implementation - actual URLs may vary
        try:
            # Try to find QSS data via the economic indicators page
            # This would typically require scraping the page to find current links
            logging.warning("Quarterly Services Survey data requires specific URL discovery")
            return []

        except Exception as e:
            logging.error(f"Failed to download quarterly services data: {e}")
            return []

    def download_business_formation_statistics(self, year: str) -> List[Dict]:
        """Download Business Formation Statistics (if available)."""
        # This is newer data that may be available via API or direct download
        try:
            # Check for CSV downloads
            filename = f"bfs_{year}.csv"
            url = f"https://www.census.gov/econ/bfs/csv/{filename}"

            response = self.session.get(url, timeout=30)
            if response.status_code == 200:
                df = pd.read_csv(BytesIO(response.content))
                return df.to_dict('records')

        except Exception as e:
            logging.warning(f"Business Formation Statistics not available for {year}: {e}")

        return []

    def get_available_retail_categories(self) -> List[str]:
        """Get list of retail trade categories."""
        return [
            'Total (excluding nonstore retailers)',
            'Motor vehicle and parts dealers',
            'Furniture and home furnishings stores',
            'Electronics and appliance stores',
            'Building material and garden equipment and supplies dealers',
            'Food and beverage stores',
            'Health and personal care stores',
            'Gasoline stations',
            'Clothing and clothing accessories stores',
            'Sporting goods, hobby, musical instrument, and book stores',
            'General merchandise stores',
            'Miscellaneous store retailers',
            'Nonstore retailers'
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
        description="Download Commerce Department retail and economic data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--year',
        default='2023',
        help='Year to download data for'
    )
    parser.add_argument(
        '--datasets',
        nargs='+',
        choices=['retail', 'ecommerce', 'services', 'business', 'all'],
        default=['all'],
        help='Datasets to download'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/commerce/data/raw/',
        help='Output directory for downloaded files'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    setup_logging(args.verbose)

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Initialize downloader
    downloader = CommerceDownloader()

    # Determine datasets to download
    datasets = args.datasets
    if 'all' in datasets:
        datasets = ['retail', 'ecommerce', 'services', 'business']

    try:
        # Download each dataset
        for dataset in datasets:
            logging.info(f"Downloading {dataset} data for {args.year}")

            if dataset == 'retail':
                data = downloader.download_monthly_retail_trade(args.year)
                filename = f"monthly_retail_trade_{args.year}.csv"
                description = f"Monthly Retail Trade Survey for {args.year}"
                source_url = downloader.RETAIL_BASE_URL

            elif dataset == 'ecommerce':
                data = downloader.download_retail_ecommerce(args.year)
                filename = f"ecommerce_retail_{args.year}.csv"
                description = f"E-commerce Retail Sales for {args.year}"
                source_url = downloader.RETAIL_BASE_URL

            elif dataset == 'services':
                data = downloader.download_quarterly_services(args.year)
                filename = f"quarterly_services_{args.year}.csv"
                description = f"Quarterly Services Survey for {args.year}"
                source_url = downloader.ECON_BASE_URL

            elif dataset == 'business':
                data = downloader.download_business_formation_statistics(args.year)
                filename = f"business_formation_{args.year}.csv"
                description = f"Business Formation Statistics for {args.year}"
                source_url = "https://www.census.gov/econ/bfs/"

            save_data_with_manifest(
                data, filename, output_dir,
                description, source_url
            )

        # Save retail categories reference
        categories = downloader.get_available_retail_categories()
        categories_path = output_dir / "retail_categories.json"
        with open(categories_path, 'w') as f:
            json.dump({
                'categories': categories,
                'description': 'Retail trade categories from Monthly Retail Trade Survey',
                'generated': datetime.utcnow().isoformat() + 'Z'
            }, f, indent=2)

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()