#!/usr/bin/env python3
"""
Download EPA Air Quality and Toxics Release Inventory data.

Downloads EPA AQS (Air Quality System) data and TRI (Toxics Release Inventory) data
from EPA's publicly available datasets.

Data sources:
- AQS: https://aqs.epa.gov/aqsweb/airdata/download_files.html
- TRI: https://www.epa.gov/toxics-release-inventory-tri-program/tri-basic-data-files-calendar-years-1987-present
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


class EPADownloader:
    """Download EPA environmental data."""

    AQS_BASE_URL = "https://aqs.epa.gov/aqsweb/airdata/"
    TRI_BASE_URL = "https://www.epa.gov/system/files/other-files/"

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

    def download_aqs_annual(self, year: str, pollutant: str = "44201") -> List[Dict]:
        """Download AQS annual summary data for specific pollutant."""
        # 44201 = Ozone, 42401 = SO2, 42101 = CO, etc.
        filename = f"annual_conc_by_monitor_{year}.zip"
        url = f"{self.AQS_BASE_URL}{filename}"

        content = self._download_file(url, f"AQS Annual {year}")
        if not content:
            return []

        try:
            # Extract CSV from ZIP
            with zipfile.ZipFile(BytesIO(content)) as zf:
                csv_files = [f for f in zf.namelist() if f.endswith('.csv')]
                if not csv_files:
                    logging.error("No CSV files found in ZIP archive")
                    return []

                # Read the first CSV file
                with zf.open(csv_files[0]) as csv_file:
                    df = pd.read_csv(csv_file)
                    return df.to_dict('records')

        except Exception as e:
            logging.error(f"Failed to extract AQS data: {e}")
            return []

    def download_aqs_daily(self, year: str, pollutant: str = "44201") -> List[Dict]:
        """Download AQS daily summary data for specific pollutant."""
        filename = f"daily_{pollutant}_{year}.zip"
        url = f"{self.AQS_BASE_URL}{filename}"

        content = self._download_file(url, f"AQS Daily {pollutant} {year}")
        if not content:
            return []

        try:
            # Extract CSV from ZIP
            with zipfile.ZipFile(BytesIO(content)) as zf:
                csv_files = [f for f in zf.namelist() if f.endswith('.csv')]
                if not csv_files:
                    logging.error("No CSV files found in ZIP archive")
                    return []

                # Read the first CSV file
                with zf.open(csv_files[0]) as csv_file:
                    df = pd.read_csv(csv_file)
                    return df.to_dict('records')

        except Exception as e:
            logging.error(f"Failed to extract AQS daily data: {e}")
            return []

    def download_tri_basic(self, year: str) -> List[Dict]:
        """Download TRI Basic Data Files."""
        # TRI basic data file naming convention
        filename = f"tri_basic_data_file_calendar_year_{year}_comma_delimited_download.zip"

        # The URL format has changed over time, try multiple patterns
        url_patterns = [
            f"https://enviro.epa.gov/enviro/efservice/tri_facility/state_abbr/=/CSV",
            f"https://www.epa.gov/system/files/other-files/{year}-{int(year)+1}/tri_basic_data_file_calendar_year_{year}_comma_delimited_download.zip",
            f"https://www.epa.gov/system/files/other-files/2022-03/tri_basic_data_file_calendar_year_{year}_comma_delimited_download.zip"
        ]

        for url in url_patterns:
            content = self._download_file(url, f"TRI Basic {year}")
            if content:
                try:
                    # Try to extract and parse
                    with zipfile.ZipFile(BytesIO(content)) as zf:
                        csv_files = [f for f in zf.namelist() if f.endswith('.csv') or f.endswith('.txt')]
                        if csv_files:
                            # Read the first data file
                            with zf.open(csv_files[0]) as csv_file:
                                df = pd.read_csv(csv_file, encoding='latin-1', low_memory=False)
                                return df.to_dict('records')
                except Exception as e:
                    logging.warning(f"Failed to extract TRI data from {url}: {e}")
                    continue

        # If ZIP download fails, try direct CSV access
        logging.info("Attempting direct TRI facility data download...")
        return self.download_tri_facilities()

    def download_tri_facilities(self) -> List[Dict]:
        """Download TRI facility information via EPA Envirofacts API."""
        # Use EPA's Envirofacts web service for TRI facility data
        base_url = "https://enviro.epa.gov/enviro/efservice/tri_facility"

        # Get all facilities (this might be large)
        try:
            url = f"{base_url}/rows/0:10000/CSV"
            response = self.session.get(url, timeout=60)
            response.raise_for_status()

            # Parse CSV content
            from io import StringIO
            df = pd.read_csv(StringIO(response.text))
            return df.to_dict('records')

        except Exception as e:
            logging.error(f"Failed to download TRI facilities: {e}")
            return []

    def get_aqs_pollutant_codes(self) -> Dict[str, str]:
        """Get mapping of pollutant codes to names."""
        return {
            '44201': 'Ozone',
            '42401': 'Sulfur dioxide',
            '42101': 'Carbon monoxide',
            '12128': 'Lead',
            '88101': 'PM2.5 - Local Conditions',
            '88502': 'Acceptable PM2.5 AQI & Speciation Mass',
            '81102': 'PM10 - Local Conditions'
        }


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
        description="Download EPA Air Quality and Toxics Release Inventory data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--year',
        default='2023',
        help='Year to download data for (note: recent years may not be available)'
    )
    parser.add_argument(
        '--dataset',
        choices=['aqs', 'tri', 'both'],
        default='both',
        help='Dataset to download'
    )
    parser.add_argument(
        '--aqs-type',
        choices=['annual', 'daily'],
        default='annual',
        help='Type of AQS data to download'
    )
    parser.add_argument(
        '--pollutant',
        default='44201',
        help='EPA pollutant parameter code (44201=Ozone, 88101=PM2.5, etc.)'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/epa/data/raw/',
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
    downloader = EPADownloader()

    try:
        # Download datasets
        if args.dataset in ['aqs', 'both']:
            logging.info(f"Downloading AQS {args.aqs_type} data for {args.year}")

            pollutant_codes = downloader.get_aqs_pollutant_codes()
            pollutant_name = pollutant_codes.get(args.pollutant, f"Pollutant_{args.pollutant}")

            if args.aqs_type == 'annual':
                data = downloader.download_aqs_annual(args.year, args.pollutant)
                filename = f"aqs_annual_{pollutant_name.lower().replace(' ', '_')}_{args.year}.csv"
                description = f"EPA AQS Annual {pollutant_name} data for {args.year}"
            else:  # daily
                data = downloader.download_aqs_daily(args.year, args.pollutant)
                filename = f"aqs_daily_{pollutant_name.lower().replace(' ', '_')}_{args.year}.csv"
                description = f"EPA AQS Daily {pollutant_name} data for {args.year}"

            save_data_with_manifest(
                data, filename, output_dir,
                description,
                downloader.AQS_BASE_URL
            )

        if args.dataset in ['tri', 'both']:
            logging.info(f"Downloading TRI data for {args.year}")

            data = downloader.download_tri_basic(args.year)
            filename = f"tri_basic_{args.year}.csv"

            save_data_with_manifest(
                data, filename, output_dir,
                f"EPA TRI Basic Data for {args.year}",
                "https://www.epa.gov/toxics-release-inventory-tri-program"
            )

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()