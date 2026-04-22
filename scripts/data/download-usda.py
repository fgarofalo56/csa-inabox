#!/usr/bin/env python3
"""
Download USDA NASS QuickStats agricultural data.

Downloads crop yields, livestock counts, and land use data from the USDA NASS QuickStats API.
Supports pagination for large datasets and saves data as CSV files with metadata manifest.

Data source: https://quickstats.nass.usda.gov/api
API documentation: https://quickstats.nass.usda.gov/api
"""

import argparse
import json
import logging
import os
import sys
from datetime import datetime
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


class USDADownloader:
    """Download agricultural data from USDA NASS QuickStats API."""

    BASE_URL = "https://quickstats.nass.usda.gov/api/api_GET/"
    MAX_RECORDS = 50000  # API limit per request

    def __init__(self, api_key: str):
        """Initialize with API key."""
        self.api_key = api_key
        self.session = requests.Session()
        self.session.params = {'key': api_key, 'format': 'JSON'}

    def _make_request(self, params: Dict) -> Dict:
        """Make API request with error handling and retry logic."""
        for attempt in range(3):
            try:
                response = self.session.get(self.BASE_URL, params=params, timeout=30)
                response.raise_for_status()
                data = response.json()

                if 'error' in data:
                    raise requests.RequestException(f"API Error: {data['error']}")

                return data

            except requests.RequestException as e:
                logging.warning(f"Request attempt {attempt + 1} failed: {e}")
                if attempt == 2:
                    raise

    def get_count(self, params: Dict) -> int:
        """Get total count of records for a query."""
        count_params = params.copy()
        count_params.update({'statisticcat_desc': 'AREA HARVESTED', 'format': 'JSON'})

        # Remove offset for count query
        count_params.pop('offset', None)

        try:
            data = self._make_request(count_params)
            return len(data.get('data', []))
        except Exception as e:
            logging.warning(f"Could not get count: {e}")
            return 0

    def download_data(self, params: Dict, description: str) -> List[Dict]:
        """Download data with pagination support."""
        all_data = []
        offset = 0

        # Get approximate total for progress bar
        total_estimate = self.get_count(params)

        with tqdm(desc=description, unit="records") as pbar:
            while True:
                page_params = params.copy()
                page_params['offset'] = offset

                try:
                    data = self._make_request(page_params)
                    records = data.get('data', [])

                    if not records:
                        break

                    all_data.extend(records)
                    pbar.update(len(records))

                    # Check if we got full page (more data available)
                    if len(records) < self.MAX_RECORDS:
                        break

                    offset += self.MAX_RECORDS

                except Exception as e:
                    logging.error(f"Failed to download data at offset {offset}: {e}")
                    break

        logging.info(f"Downloaded {len(all_data)} records for {description}")
        return all_data

    def download_crop_yields(self, year: str, state: Optional[str] = None) -> List[Dict]:
        """Download crop yield data."""
        params = {
            'source_desc': 'SURVEY',
            'sector_desc': 'CROPS',
            'group_desc': 'FIELD CROPS',
            'statisticcat_desc': 'YIELD',
            'year': year,
            'agg_level_desc': 'STATE'
        }

        if state:
            params['state_name'] = state.upper()

        return self.download_data(params, f"Crop yields {year}")

    def download_livestock_counts(self, year: str, state: Optional[str] = None) -> List[Dict]:
        """Download livestock inventory data."""
        params = {
            'source_desc': 'SURVEY',
            'sector_desc': 'ANIMALS & PRODUCTS',
            'statisticcat_desc': 'INVENTORY',
            'year': year,
            'agg_level_desc': 'STATE'
        }

        if state:
            params['state_name'] = state.upper()

        return self.download_data(params, f"Livestock counts {year}")

    def download_land_use(self, year: str, state: Optional[str] = None) -> List[Dict]:
        """Download land use data."""
        params = {
            'source_desc': 'SURVEY',
            'sector_desc': 'CROPS',
            'statisticcat_desc': 'AREA HARVESTED',
            'year': year,
            'agg_level_desc': 'STATE'
        }

        if state:
            params['state_name'] = state.upper()

        return self.download_data(params, f"Land use {year}")


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
        description="Download USDA NASS QuickStats agricultural data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--api-key',
        required=True,
        help='NASS API key (or set NASS_API_KEY environment variable)'
    )
    parser.add_argument(
        '--year',
        default='2023',
        help='Year to download data for'
    )
    parser.add_argument(
        '--state',
        help='Specific state to download (default: all states)'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/usda/data/raw/',
        help='Output directory for downloaded files'
    )
    parser.add_argument(
        '--datasets',
        nargs='+',
        choices=['crops', 'livestock', 'landuse', 'all'],
        default=['all'],
        help='Datasets to download'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    # Get API key from args or environment
    api_key = args.api_key or os.getenv('NASS_API_KEY')
    if not api_key:
        print("Error: API key required. Use --api-key or set NASS_API_KEY environment variable.")
        sys.exit(1)

    setup_logging(args.verbose)

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Initialize downloader
    downloader = USDADownloader(api_key)

    # Determine datasets to download
    datasets = args.datasets
    if 'all' in datasets:
        datasets = ['crops', 'livestock', 'landuse']

    try:
        # Download each dataset
        for dataset in datasets:
            logging.info(f"Downloading {dataset} data for {args.year}")

            if dataset == 'crops':
                data = downloader.download_crop_yields(args.year, args.state)
                filename = f"crop_yields_{args.year}"
                if args.state:
                    filename += f"_{args.state.lower()}"
                filename += ".csv"
                save_data_with_manifest(
                    data, filename, output_dir,
                    f"Crop yields for {args.year}",
                    "https://quickstats.nass.usda.gov/api"
                )

            elif dataset == 'livestock':
                data = downloader.download_livestock_counts(args.year, args.state)
                filename = f"livestock_counts_{args.year}"
                if args.state:
                    filename += f"_{args.state.lower()}"
                filename += ".csv"
                save_data_with_manifest(
                    data, filename, output_dir,
                    f"Livestock inventory for {args.year}",
                    "https://quickstats.nass.usda.gov/api"
                )

            elif dataset == 'landuse':
                data = downloader.download_land_use(args.year, args.state)
                filename = f"land_use_{args.year}"
                if args.state:
                    filename += f"_{args.state.lower()}"
                filename += ".csv"
                save_data_with_manifest(
                    data, filename, output_dir,
                    f"Land use data for {args.year}",
                    "https://quickstats.nass.usda.gov/api"
                )

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()