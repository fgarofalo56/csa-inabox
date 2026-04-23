#!/usr/bin/env python3
"""
Download Department of Transportation data.

Downloads FARS (Fatality Analysis Reporting System) fatal crash data from NHTSA
and BTS (Bureau of Transportation Statistics) airline on-time performance data.

Data sources:
- FARS: https://www.nhtsa.gov/research-data/fatality-analysis-reporting-system-fars
- BTS Airline Data: https://www.transtats.bts.gov/
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


class DOTDownloader:
    """Download transportation data from Department of Transportation."""

    FARS_BASE_URL = "https://www.nhtsa.gov/file-downloads"
    BTS_BASE_URL = "https://www.transtats.bts.gov/PREZIP/"

    def __init__(self):
        """Initialize downloader."""
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'CSA-in-a-Box Data Downloader (research/educational use)'
        })

    def _download_file(self, url: str, description: str) -> Optional[bytes]:
        """Download file with progress bar and return content."""
        try:
            response = self.session.get(url, stream=True, timeout=120)  # Longer timeout for large files
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

    def download_fars_data(self, year: str) -> Dict[str, List[Dict]]:
        """Download FARS fatal crash data for specified year."""
        # FARS data is typically available as a ZIP file containing multiple CSV files
        filename = f"FARS{year}NationalCSV.zip"

        # Try multiple URL patterns as NHTSA sometimes changes structure
        url_patterns = [
            f"https://www.nhtsa.gov/file-downloads?p=nhtsa/downloads/FARS/{year}/National/FARS{year}NationalCSV.zip",
            f"https://www.nhtsa.gov/sites/nhtsa.dot.gov/files/documents/FARS{year}NationalCSV.zip",
            f"https://crashstats.nhtsa.dot.gov/Api/Public/ViewPublication/813417"  # Example for API approach
        ]

        # Simplified approach - try direct download first
        direct_url = f"https://www.nhtsa.gov/sites/nhtsa.dot.gov/files/documents/FARS{year}NationalCSV.zip"

        content = self._download_file(direct_url, f"FARS {year}")
        if not content:
            logging.warning(f"Could not download FARS data for {year} via direct URL")
            return {}

        try:
            # Extract ZIP file and read CSV files
            fars_data = {}
            with zipfile.ZipFile(BytesIO(content)) as zf:
                csv_files = [f for f in zf.namelist() if f.endswith('.csv') or f.endswith('.CSV')]

                for csv_file in csv_files:
                    try:
                        with zf.open(csv_file) as f:
                            df = pd.read_csv(f, encoding='latin-1', low_memory=False)
                            table_name = csv_file.replace('.csv', '').replace('.CSV', '').lower()
                            fars_data[table_name] = df.to_dict('records')
                            logging.info(f"Loaded FARS table: {table_name} ({len(df)} records)")
                    except Exception as e:
                        logging.warning(f"Could not parse {csv_file}: {e}")

            return fars_data

        except Exception as e:
            logging.error(f"Failed to extract FARS data: {e}")
            return {}

    def download_airline_ontime(self, year: str, month: Optional[str] = None) -> List[Dict]:
        """Download BTS airline on-time performance data."""
        # BTS on-time data is available monthly
        if month:
            months = [month]
        else:
            months = [f"{i:02d}" for i in range(1, 13)]  # All months

        all_data = []

        for month in months:
            filename = f"On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{year}_{month}.zip"
            url = f"{self.BTS_BASE_URL}{filename}"

            content = self._download_file(url, f"Airline On-Time {year}-{month}")
            if not content:
                continue

            try:
                # Extract and read CSV
                with zipfile.ZipFile(BytesIO(content)) as zf:
                    csv_files = [f for f in zf.namelist() if f.endswith('.csv')]

                    if csv_files:
                        with zf.open(csv_files[0]) as f:
                            df = pd.read_csv(f, low_memory=False)
                            all_data.extend(df.to_dict('records'))

            except Exception as e:
                logging.warning(f"Could not parse airline data for {year}-{month}: {e}")

        return all_data

    def download_traffic_volume(self, year: str) -> List[Dict]:
        """Download traffic volume data (if available)."""
        # Traffic volume data from FHWA
        try:
            url = f"https://www.fhwa.dot.gov/policyinformation/travel_monitoring/tvt/archive/tvt{year}.csv"
            response = self.session.get(url, timeout=30)

            if response.status_code == 200:
                df = pd.read_csv(BytesIO(response.content))
                return df.to_dict('records')

        except Exception as e:
            logging.warning(f"Traffic volume data not available for {year}: {e}")

        return []

    def get_fars_table_descriptions(self) -> Dict[str, str]:
        """Get descriptions of FARS data tables."""
        return {
            'accident': 'Crash-level data including date, time, location, and severity',
            'person': 'Person-level data for drivers, passengers, and non-motorists',
            'vehicle': 'Vehicle-level data including make, model, and damage',
            'parkwork': 'Parked and working vehicle data',
            'cevent': 'Sequence of events in crashes',
            'factor': 'Contributing factors in crashes',
            'maneuver': 'Driver actions and maneuvers',
            'violatn': 'Traffic violations',
            'vision': 'Driver vision conditions',
            'weather': 'Weather and environmental conditions'
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


def save_fars_tables(fars_data: Dict[str, List[Dict]], output_dir: Path, year: str) -> None:
    """Save FARS tables with combined manifest."""
    if not fars_data:
        return

    manifest_path = output_dir / "manifest.json"
    manifest = {}
    if manifest_path.exists():
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)

    for table_name, data in fars_data.items():
        if not data:
            continue

        filename = f"fars_{table_name}_{year}.csv"
        df = pd.DataFrame(data)
        csv_path = output_dir / filename
        df.to_csv(csv_path, index=False)

        file_info = {
            'filename': filename,
            'description': f"FARS {table_name} table for {year}",
            'source_url': "https://www.nhtsa.gov/research-data/fatality-analysis-reporting-system-fars",
            'download_timestamp': datetime.utcnow().isoformat() + 'Z',
            'record_count': len(data),
            'file_size_bytes': csv_path.stat().st_size,
            'columns': list(df.columns) if not df.empty else [],
            'table_type': table_name
        }

        manifest[filename] = file_info
        logging.info(f"Saved FARS {table_name}: {len(data)} records")

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Download Department of Transportation data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--year',
        default='2022',
        help='Year to download data for (note: FARS data has a lag)'
    )
    parser.add_argument(
        '--dataset',
        choices=['fars', 'airline', 'traffic', 'all'],
        default='all',
        help='Dataset to download'
    )
    parser.add_argument(
        '--month',
        help='Specific month for airline data (01-12, default: all months)'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/transportation/data/raw/',
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
    downloader = DOTDownloader()

    try:
        # Download datasets
        if args.dataset in ['fars', 'all']:
            logging.info(f"Downloading FARS data for {args.year}")
            fars_data = downloader.download_fars_data(args.year)
            save_fars_tables(fars_data, output_dir, args.year)

            # Save table descriptions
            descriptions = downloader.get_fars_table_descriptions()
            desc_path = output_dir / "fars_table_descriptions.json"
            with open(desc_path, 'w') as f:
                json.dump({
                    'descriptions': descriptions,
                    'year': args.year,
                    'generated': datetime.utcnow().isoformat() + 'Z'
                }, f, indent=2)

        if args.dataset in ['airline', 'all']:
            logging.info(f"Downloading airline on-time data for {args.year}")
            airline_data = downloader.download_airline_ontime(args.year, args.month)

            month_suffix = f"_{args.month}" if args.month else ""
            filename = f"airline_ontime_{args.year}{month_suffix}.csv"

            save_data_with_manifest(
                airline_data, filename, output_dir,
                f"BTS Airline On-Time Performance for {args.year}",
                downloader.BTS_BASE_URL
            )

        if args.dataset in ['traffic', 'all']:
            logging.info(f"Downloading traffic volume data for {args.year}")
            traffic_data = downloader.download_traffic_volume(args.year)
            filename = f"traffic_volume_{args.year}.csv"

            save_data_with_manifest(
                traffic_data, filename, output_dir,
                f"FHWA Traffic Volume Trends for {args.year}",
                "https://www.fhwa.dot.gov/policyinformation/travel_monitoring/tvt/"
            )

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()