#!/usr/bin/env python3
"""
Download NOAA weather and climate data.

Downloads GHCN-Daily weather station data and NOAA Storm Events data.
Supports multiple weather stations and states with flexible date ranges.

Data sources:
- GHCN-Daily: https://www.ncei.noaa.gov/data/global-historical-climatology-network-daily/
- Storm Events: https://www.ncei.noaa.gov/data/severe-weather-data-inventory/
"""

import argparse
import csv
import gzip
import json
import logging
import os
import sys
from datetime import datetime
from io import StringIO
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urljoin

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


class NOAADownloader:
    """Download weather and climate data from NOAA NCEI."""

    GHCN_BASE_URL = "https://www.ncei.noaa.gov/data/global-historical-climatology-network-daily/access/"
    STORM_BASE_URL = "https://www.ncei.noaa.gov/data/severe-weather-data-inventory/access/csv/"

    def __init__(self):
        """Initialize downloader."""
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'CSA-in-a-Box Data Downloader (research/educational use)'
        })

    def _download_file(self, url: str, description: str) -> Optional[str]:
        """Download file with progress bar and return content."""
        try:
            response = self.session.get(url, stream=True, timeout=30)
            response.raise_for_status()

            # Get content length for progress bar
            total_size = int(response.headers.get('content-length', 0))

            content = []
            with tqdm(desc=description, total=total_size, unit='B', unit_scale=True) as pbar:
                for chunk in response.iter_content(chunk_size=8192):
                    content.append(chunk)
                    pbar.update(len(chunk))

            return b''.join(content).decode('utf-8')

        except requests.RequestException as e:
            logging.error(f"Failed to download {url}: {e}")
            return None

    def get_station_list(self, state: Optional[str] = None) -> List[Dict]:
        """Get list of available weather stations."""
        stations_url = "https://www.ncei.noaa.gov/data/global-historical-climatology-network-daily/doc/ghcnd-stations.txt"

        content = self._download_file(stations_url, "Station list")
        if not content:
            return []

        stations = []
        for line in content.split('\n'):
            if line.strip():
                # Parse fixed-width format
                station_id = line[0:11].strip()
                lat = float(line[12:20].strip()) if line[12:20].strip() else 0.0
                lon = float(line[21:30].strip()) if line[21:30].strip() else 0.0
                elevation = line[31:37].strip()
                state_code = line[38:40].strip()
                name = line[41:71].strip()

                if state and state_code.upper() != state.upper():
                    continue

                stations.append({
                    'station_id': station_id,
                    'latitude': lat,
                    'longitude': lon,
                    'elevation': elevation,
                    'state': state_code,
                    'name': name
                })

        return stations

    def download_ghcn_daily(self, year: str, stations: List[str]) -> List[Dict]:
        """Download GHCN-Daily data for specified stations and year."""
        all_data = []

        for station_id in tqdm(stations, desc="Downloading station data"):
            url = f"{self.GHCN_BASE_URL}{year}/{station_id}.csv"

            try:
                response = self.session.get(url, timeout=30)
                if response.status_code == 404:
                    logging.warning(f"No data found for station {station_id} in {year}")
                    continue

                response.raise_for_status()

                # Parse CSV content
                csv_content = StringIO(response.text)
                reader = csv.DictReader(csv_content)

                for row in reader:
                    row['station_id'] = station_id
                    all_data.append(row)

            except requests.RequestException as e:
                logging.error(f"Failed to download data for station {station_id}: {e}")
                continue

        return all_data

    def download_storm_events(self, year: str) -> List[Dict]:
        """Download NOAA Storm Events data for specified year."""
        # Storm events are available by year
        url = f"{self.STORM_BASE_URL}StormEvents_details-ftp_v1.0_d{year}_c20230927.csv.gz"

        try:
            response = self.session.get(url, stream=True, timeout=60)
            response.raise_for_status()

            # Download and decompress gzip content
            content = []
            total_size = int(response.headers.get('content-length', 0))

            with tqdm(desc=f"Storm Events {year}", total=total_size, unit='B', unit_scale=True) as pbar:
                for chunk in response.iter_content(chunk_size=8192):
                    content.append(chunk)
                    pbar.update(len(chunk))

            # Decompress and parse CSV
            compressed_content = b''.join(content)
            decompressed = gzip.decompress(compressed_content).decode('utf-8')

            csv_content = StringIO(decompressed)
            reader = csv.DictReader(csv_content)

            return list(reader)

        except requests.RequestException as e:
            logging.error(f"Failed to download storm events for {year}: {e}")
            return []

    def get_default_stations(self, state: Optional[str] = None, limit: int = 10) -> List[str]:
        """Get default set of weather stations for a state or nationwide."""
        stations = self.get_station_list(state)

        # Filter for stations with recent data (simple heuristic)
        # In practice, you'd want to check data availability
        filtered_stations = [s for s in stations if s['station_id']]

        # Return first N stations
        return [s['station_id'] for s in filtered_stations[:limit]]


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
        description="Download NOAA weather and climate data",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        '--year',
        default='2023',
        help='Year to download data for'
    )
    parser.add_argument(
        '--state',
        help='State to download weather station data for (2-letter code)'
    )
    parser.add_argument(
        '--stations',
        help='Comma-separated list of weather station IDs'
    )
    parser.add_argument(
        '--output-dir',
        default='examples/noaa/data/raw/',
        help='Output directory for downloaded files'
    )
    parser.add_argument(
        '--datasets',
        nargs='+',
        choices=['ghcn', 'storms', 'all'],
        default=['all'],
        help='Datasets to download'
    )
    parser.add_argument(
        '--max-stations',
        type=int,
        default=10,
        help='Maximum number of weather stations to download (when not specified)'
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
    downloader = NOAADownloader()

    # Determine datasets to download
    datasets = args.datasets
    if 'all' in datasets:
        datasets = ['ghcn', 'storms']

    try:
        # Download each dataset
        for dataset in datasets:
            logging.info(f"Downloading {dataset} data for {args.year}")

            if dataset == 'ghcn':
                # Get station list
                if args.stations:
                    station_ids = [s.strip().upper() for s in args.stations.split(',')]
                else:
                    station_ids = downloader.get_default_stations(args.state, args.max_stations)

                if not station_ids:
                    logging.warning("No weather stations found")
                    continue

                logging.info(f"Downloading data for {len(station_ids)} stations")
                data = downloader.download_ghcn_daily(args.year, station_ids)

                filename = f"ghcn_daily_{args.year}"
                if args.state:
                    filename += f"_{args.state.lower()}"
                filename += ".csv"

                save_data_with_manifest(
                    data, filename, output_dir,
                    f"GHCN-Daily weather data for {args.year}",
                    downloader.GHCN_BASE_URL
                )

                # Save station list
                stations_info = downloader.get_station_list(args.state)
                stations_df = pd.DataFrame(stations_info)
                stations_path = output_dir / f"weather_stations_{args.year}.csv"
                stations_df.to_csv(stations_path, index=False)

            elif dataset == 'storms':
                data = downloader.download_storm_events(args.year)
                filename = f"storm_events_{args.year}.csv"

                save_data_with_manifest(
                    data, filename, output_dir,
                    f"NOAA Storm Events for {args.year}",
                    downloader.STORM_BASE_URL
                )

        logging.info("Download completed successfully")

    except Exception as e:
        logging.error(f"Download failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()