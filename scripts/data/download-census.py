#!/usr/bin/env python3
"""
Download US Census Bureau demographic and economic data.

Downloads American Community Survey (ACS) 5-year estimates and other Census data
via the Census Bureau's API.

Data source: https://api.census.gov/data.html
ACS documentation: https://www.census.gov/data/developers/data-sets/acs-5year.html
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


class CensusDownloader:
    """Download demographic and economic data from US Census Bureau API."""

    BASE_URL = "https://api.census.gov/data"

    def __init__(self, api_key: Optional[str] = None):
        """Initialize with optional API key."""
        self.api_key = api_key
        self.session = requests.Session()

    def _make_request(self, url: str, params: Dict) -> Optional[List]:
        """Make API request with error handling."""
        if self.api_key:
            params['key'] = self.api_key

        try:
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            return response.json()

        except requests.RequestException as e:
            logging.error(f"API request failed: {e}")
            return None

    def get_available_variables(self, year: str, dataset: str = "acs/acs5") -> Dict:
        """Get list of available variables for a dataset."""
        url = f"{self.BASE_URL}/{year}/{dataset}/variables.json"

        try:
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            return response.json()

        except requests.RequestException as e:
            logging.error(f"Failed to get variables: {e}")
            return {}

    def download_acs_data(self, year: str, variables: List[str],
                         geography: str = "state:*") -> List[Dict]:
        """Download ACS 5-year estimates data."""
        url = f"{self.BASE_URL}/{year}/acs/acs5"

        # Split into chunks if too many variables
        chunk_size = 45  # API limit is around 50 variables
        all_data = []

        for i in range(0, len(variables), chunk_size):
            chunk_vars = variables[i:i + chunk_size]
            params = {
                'get': ','.join(chunk_vars),
                'for': geography
            }

            data = self._make_request(url, params)
            if not data:
                continue

            # Convert to list of dictionaries
            headers = data[0]
            rows = data[1:]

            chunk_records = []
            for row in rows:
                record = dict(zip(headers, row))
                chunk_records.append(record)

            # Merge with existing data if this is not the first chunk
            if all_data and chunk_records:
                # Merge by geographic keys (state, county, etc.)
                geo_keys = [k for k in headers if k in ['state', 'county', 'tract', 'block group']]

                for i, existing_record in enumerate(all_data):
                    matching_new = None
                    for new_record in chunk_records:
                        if all(existing_record.get(k) == new_record.get(k) for k in geo_keys):
                            matching_new = new_record
                            break

                    if matching_new:
                        # Merge the records
                        for key, value in matching_new.items():
                            if key not in geo_keys:
                                existing_record[key] = value
            else:
                all_data = chunk_records

        return all_data

    def download_decennial_data(self, year: str, variables: List[str],
                              geography: str = "state:*") -> List[Dict]:
        """Download Decennial Census data."""
        # Determine the correct dataset path for decennial data
        if year == "2020":
            dataset_path = "dec/dhc"
        elif year == "2010":
            dataset_path = "dec/sf1"
        else:
            dataset_path = f"dec/{year}/sf1"

        url = f"{self.BASE_URL}/{year}/{dataset_path}"

        params = {
            'get': ','.join(variables),
            'for': geography
        }

        data = self._make_request(url, params)
        if not data:
            return []

        # Convert to list of dictionaries
        headers = data[0]
        rows = data[1:]

        return [dict(zip(headers, row)) for row in rows]

    def get_default_demographics_variables(self) -> List[str]:
        """Get default set of demographic variables."""
        return [
            'B01003_001E',  # Total Population
            'B25003_001E',  # Total Housing Units
            'B25003_002E',  # Owner Occupied Housing Units
            'B25003_003E',  # Renter Occupied Housing Units
            'B08303_001E',  # Total Commuters
            'B08303_013E',  # Commute by Public Transportation
            'B19013_001E',  # Median Household Income
            'B25064_001E',  # Median Gross Rent
            'B01001_002E',  # Male Population
            'B01001_026E',  # Female Population
            'B02001_002E',  # White Alone
            'B02001_003E',  # Black or African American Alone
            'B02001_004E',  # American Indian and Alaska Native Alone
            'B02001_005E',  # Asian Alone
            'B02001_006E',  # Native Hawaiian and Other Pacific Islander Alone
            'B02001_007E',  # Some Other Race Alone
            'B02001_008E',  # Two or More Races
            'B03003_003E',  # Hispanic or Latino Origin
            'B15003_022E',  # Bachelor's Degree
            'B15003_023E',  # Master's Degree
            'B15003_024E',  # Professional Degree
            'B15003_025E',  # Doctorate Degree
        ]

    def get_variable_labels(self, variables: List[str], year: str,
                          dataset: str = "acs/acs5") -> Dict[str, str]:
        """Get human-readable labels for variable codes."""
        variables_info = self.get_available_variables(year, dataset)
        if not variables_info or 'variables' not in variables_info:
            return {}

        labels = {}
        for var in variables:
            if var in variables_info['variables']:
                labels[var] = variables_info['variables'][var].get('label', var)
            else:
                labels[var] = var

        return labels


def save_data_with_manifest(data: List[Dict], filename: str, output_dir: Path,
                          description: str, source_url: str,
                          variable_labels: Optional[Dict[str, str]] = None) -> None:
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
        'columns': list(df.columns) if not df.empty else [],
        'variable_labels': variable_labels or {}
    }

    manifest[filename] = file_info

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    # Save variable labels separately for easy reference
    if variable_labels:
        labels_path = output_dir / f"{filename}_variable_labels.json"
        with open(labels_path, 'w') as f:
            json.dump(variable_labels, f, indent=2)

    logging.info(f"Saved {len(data)} records to {csv_path}")


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Download US Census Bureau demographic and economic data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--api-key',
        help='Census API key (or set CENSUS_API_KEY environment variable)'
    )
    parser.add_argument(
        '--year',
        default='2022',
        help='Year to download data for (note: ACS 5-year data has a lag)'
    )
    parser.add_argument(
        '--variables',
        help='Comma-separated list of variable codes (default: common demographics)'
    )
    parser.add_argument(
        '--geography',
        default='state:*',
        help='Geographic level (state:*, county:*, tract:*, etc.)'
    )
    parser.add_argument(
        '--dataset',
        choices=['acs5', 'acs1', 'decennial'],
        default='acs5',
        help='Dataset type to download'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/census/data/raw/',
        help='Output directory for downloaded files'
    )
    parser.add_argument(
        '--list-variables',
        action='store_true',
        help='List available variables and exit'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    # Get API key from args or environment
    api_key = args.api_key or os.getenv('CENSUS_API_KEY')

    setup_logging(args.verbose)

    # Initialize downloader
    downloader = CensusDownloader(api_key)

    # List variables if requested
    if args.list_variables:
        if args.dataset == 'decennial':
            dataset_path = "dec/dhc" if args.year == "2020" else "dec/sf1"
        else:
            dataset_path = f"acs/{args.dataset}"

        variables_info = downloader.get_available_variables(args.year, dataset_path)
        if variables_info and 'variables' in variables_info:
            print(f"Available variables for {args.year} {args.dataset}:")
            for var_code, var_info in list(variables_info['variables'].items())[:50]:  # Show first 50
                print(f"  {var_code}: {var_info.get('label', 'No description')}")
            print(f"... and {len(variables_info['variables']) - 50} more variables")
        else:
            print("Could not retrieve variables list")
        return

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Get variables to download
        if args.variables:
            variables = [v.strip() for v in args.variables.split(',')]
        else:
            variables = downloader.get_default_demographics_variables()

        logging.info(f"Downloading {len(variables)} variables for {args.year}")

        # Download data based on dataset type
        if args.dataset in ['acs5', 'acs1']:
            data = downloader.download_acs_data(args.year, variables, args.geography)
            dataset_name = f"ACS {args.dataset.upper()}"
            dataset_path = f"acs/{args.dataset}"
        else:  # decennial
            data = downloader.download_decennial_data(args.year, variables, args.geography)
            dataset_name = "Decennial Census"
            dataset_path = "dec/dhc" if args.year == "2020" else "dec/sf1"

        # Get variable labels
        variable_labels = downloader.get_variable_labels(variables, args.year, dataset_path)

        # Generate filename
        geo_suffix = args.geography.replace(':', '_').replace('*', 'all')
        filename = f"census_{args.dataset}_{args.year}_{geo_suffix}.csv"

        save_data_with_manifest(
            data, filename, output_dir,
            f"US Census {dataset_name} data for {args.year} ({args.geography})",
            f"{downloader.BASE_URL}/{args.year}/{dataset_path}",
            variable_labels
        )

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()