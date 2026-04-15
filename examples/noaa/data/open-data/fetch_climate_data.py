#!/usr/bin/env python3
"""
NOAA Climate Data Fetcher

This script fetches climate and weather data from the NOAA National Centers
for Environmental Information (NCEI) Climate Data Online (CDO) API and
CO-OPS tidal/oceanographic data API.

Usage:
    python fetch_climate_data.py --api-key YOUR_TOKEN --stations "USW00094728,USW00014739"
    python fetch_climate_data.py --help
"""

import argparse
import csv
import json
import logging
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class NOAADataFetcher:
    """Fetch data from NOAA NCEI CDO API and CO-OPS API."""

    def __init__(self, api_key: str, base_url: str = None, delay: float = 0.3):
        """Initialize the NOAA data fetcher.

        Args:
            api_key: NOAA CDO API token (register at https://www.ncdc.noaa.gov/cdo-web/token)
            base_url: Base URL for CDO API (optional override)
            delay: Delay between API requests in seconds
        """
        self.api_key = api_key
        self.cdo_url = base_url or "https://www.ncei.noaa.gov/cdo-web/api/v2"
        self.coops_url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
        self.delay = delay

        self.headers = {
            'token': self.api_key
        }

        # CDO dataset IDs
        self.datasets = {
            'GHCND': {
                'id': 'GHCND',
                'description': 'Global Historical Climatology Network - Daily'
            },
            'GSOM': {
                'id': 'GSOM',
                'description': 'Global Summary of the Month'
            },
            'GSOY': {
                'id': 'GSOY',
                'description': 'Global Summary of the Year'
            },
            'NORMAL_DLY': {
                'id': 'NORMAL_DLY',
                'description': '1991-2020 Daily Normals'
            }
        }

        # Common GHCND data types
        self.data_types = {
            'TMAX': 'Maximum temperature (tenths of C)',
            'TMIN': 'Minimum temperature (tenths of C)',
            'PRCP': 'Precipitation (tenths of mm)',
            'SNOW': 'Snowfall (mm)',
            'SNWD': 'Snow depth (mm)',
            'AWND': 'Average wind speed (tenths of m/s)',
            'TAVG': 'Average temperature (tenths of C)'
        }

        # CO-OPS data products
        self.coops_products = {
            'water_level': 'Preliminary 6-minute water level data',
            'hourly_height': 'Verified hourly height water level data',
            'wind': 'Wind speed, direction, and gusts',
            'air_temperature': 'Air temperature',
            'water_temperature': 'Water temperature',
            'air_pressure': 'Barometric pressure',
            'predictions': 'Tide predictions'
        }

    def fetch_cdo_data(
        self,
        dataset_id: str = 'GHCND',
        station_ids: list[str] = None,
        data_types: list[str] = None,
        start_date: str = None,
        end_date: str = None,
        location_id: str = None,
        limit: int = 1000
    ) -> list[dict[str, Any]]:
        """Fetch data from CDO API.

        Args:
            dataset_id: Dataset identifier (GHCND, GSOM, etc.)
            station_ids: List of station identifiers
            data_types: List of data type codes (TMAX, TMIN, PRCP, etc.)
            start_date: Start date (YYYY-MM-DD)
            end_date: End date (YYYY-MM-DD)
            location_id: Location identifier (FIPS:36 for New York state)
            limit: Maximum records per request (max 1000)

        Returns:
            List of observation records
        """
        url = f"{self.cdo_url}/data"
        all_records = []
        offset = 1

        params = {
            'datasetid': dataset_id,
            'limit': min(limit, 1000),
            'offset': offset
        }

        if station_ids:
            params['stationid'] = ','.join(
                [f"GHCND:{s}" if not s.startswith('GHCND:') else s for s in station_ids]
            )
        if data_types:
            params['datatypeid'] = ','.join(data_types)
        if start_date:
            params['startdate'] = start_date
        if end_date:
            params['enddate'] = end_date
        if location_id:
            params['locationid'] = location_id

        while True:
            try:
                logger.debug(f"CDO request offset={offset}")

                response = requests.get(url, headers=self.headers, params=params, timeout=60)
                response.raise_for_status()

                data = response.json()
                results = data.get('results', [])

                if not results:
                    break

                all_records.extend(results)

                # Check if more data available
                metadata = data.get('metadata', {}).get('resultset', {})
                total_count = metadata.get('count', 0)

                if len(all_records) >= total_count:
                    break

                offset += limit
                params['offset'] = offset
                time.sleep(self.delay)

            except requests.exceptions.HTTPError as e:
                if response.status_code == 429:
                    logger.warning("Rate limit hit, waiting 5 seconds...")
                    time.sleep(5)
                    continue
                logger.error(f"CDO HTTP error: {e}")
                break
            except Exception as e:
                logger.error(f"CDO request failed: {e}")
                break

        logger.info(f"Fetched {len(all_records)} records from CDO ({dataset_id})")
        return all_records

    def fetch_stations(
        self,
        dataset_id: str = 'GHCND',
        location_id: str = None,
        extent: str = None,
        limit: int = 1000
    ) -> list[dict[str, Any]]:
        """Fetch station metadata from CDO API.

        Args:
            dataset_id: Dataset identifier
            location_id: Location filter (e.g., FIPS:36)
            extent: Bounding box (south_lat,west_lon,north_lat,east_lon)
            limit: Maximum stations per request

        Returns:
            List of station metadata records
        """
        url = f"{self.cdo_url}/stations"
        params = {
            'datasetid': dataset_id,
            'limit': min(limit, 1000)
        }

        if location_id:
            params['locationid'] = location_id
        if extent:
            params['extent'] = extent

        all_stations = []
        offset = 1

        while True:
            params['offset'] = offset

            try:
                response = requests.get(url, headers=self.headers, params=params, timeout=30)
                response.raise_for_status()

                data = response.json()
                results = data.get('results', [])

                if not results:
                    break

                all_stations.extend(results)

                metadata = data.get('metadata', {}).get('resultset', {})
                total = metadata.get('count', 0)
                if len(all_stations) >= total:
                    break

                offset += limit
                time.sleep(self.delay)

            except Exception as e:
                logger.error(f"Station fetch failed: {e}")
                break

        logger.info(f"Fetched {len(all_stations)} stations")
        return all_stations

    def fetch_coops_data(
        self,
        station_id: str,
        product: str = 'water_level',
        begin_date: str = None,
        end_date: str = None,
        datum: str = 'MLLW',
        units: str = 'metric',
        time_zone: str = 'gmt'
    ) -> list[dict[str, Any]]:
        """Fetch data from NOAA CO-OPS Tides & Currents API.

        Args:
            station_id: CO-OPS station ID (e.g., "8454000" for Providence, RI)
            product: Data product (water_level, wind, air_temperature, etc.)
            begin_date: Start date (YYYYMMDD)
            end_date: End date (YYYYMMDD)
            datum: Tidal datum reference (MLLW, MSL, etc.)
            units: Unit system (metric, english)
            time_zone: Time zone (gmt, lst, lst_ldt)

        Returns:
            List of observation records
        """
        params = {
            'station': station_id,
            'product': product,
            'datum': datum,
            'units': units,
            'time_zone': time_zone,
            'format': 'json',
            'application': 'noaa_climate_fetcher'
        }

        if begin_date:
            params['begin_date'] = begin_date
        if end_date:
            params['end_date'] = end_date

        try:
            response = requests.get(self.coops_url, params=params, timeout=60)
            response.raise_for_status()

            data = response.json()

            if 'error' in data:
                logger.error(f"CO-OPS error: {data['error'].get('message', 'Unknown')}")
                return []

            records = data.get('data', [])

            # Add station_id to each record
            for r in records:
                r['station_id'] = station_id
                r['product'] = product

            logger.info(f"Fetched {len(records)} CO-OPS records for station {station_id}")
            time.sleep(self.delay)

            return records

        except Exception as e:
            logger.error(f"CO-OPS request failed for station {station_id}: {e}")
            return []

    def fetch_multiple_stations_cdo(
        self,
        station_ids: list[str],
        data_types: list[str],
        start_date: str,
        end_date: str,
        dataset_id: str = 'GHCND'
    ) -> dict[str, list[dict[str, Any]]]:
        """Fetch CDO data for multiple stations.

        Args:
            station_ids: List of station identifiers
            data_types: List of data type codes
            start_date: Start date (YYYY-MM-DD)
            end_date: End date (YYYY-MM-DD)
            dataset_id: Dataset identifier

        Returns:
            Dictionary mapping station IDs to data records
        """
        results = {}

        for station_id in station_ids:
            records = self.fetch_cdo_data(
                dataset_id=dataset_id,
                station_ids=[station_id],
                data_types=data_types,
                start_date=start_date,
                end_date=end_date
            )
            results[station_id] = records

        return results

    def save_data(
        self,
        data: list[dict[str, Any]],
        output_path: Path,
        format_type: str = 'csv'
    ) -> None:
        """Save fetched data to file."""
        if not data:
            logger.warning(f"No data to save to {output_path}")
            return

        output_path.parent.mkdir(parents=True, exist_ok=True)

        if format_type.lower() == 'csv':
            fieldnames = set()
            for record in data:
                fieldnames.update(record.keys())
            fieldnames = sorted(fieldnames)

            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(data)

        elif format_type.lower() == 'json':
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, default=str)

        logger.info(f"Saved {len(data)} records to {output_path}")

    def test_api_connection(self) -> bool:
        """Test NOAA CDO API connection."""
        try:
            url = f"{self.cdo_url}/datasets"
            params = {'limit': 1}
            response = requests.get(url, headers=self.headers, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()
            if data.get('results'):
                logger.info("NOAA CDO API connection test successful")
                return True
            logger.error("CDO API returned empty response")
            return False
        except Exception as e:
            logger.error(f"CDO API connection test failed: {e}")
            return False

    def test_coops_connection(self) -> bool:
        """Test CO-OPS API connection."""
        try:
            today = date.today().strftime('%Y%m%d')
            records = self.fetch_coops_data(
                station_id='8454000',
                product='air_temperature',
                begin_date=today,
                end_date=today
            )
            if records is not None:
                logger.info("CO-OPS API connection test successful")
                return True
            return False
        except Exception as e:
            logger.error(f"CO-OPS API connection test failed: {e}")
            return False


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch climate data from NOAA NCEI CDO and CO-OPS APIs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch daily temperature data for Central Park
  python fetch_climate_data.py --api-key YOUR_TOKEN --source cdo \\
      --stations "USW00094728" --data-types "TMAX,TMIN,PRCP" \\
      --start-date 2023-01-01 --end-date 2023-12-31

  # Fetch tidal data from CO-OPS
  python fetch_climate_data.py --api-key YOUR_TOKEN --source coops \\
      --coops-station 8454000 --coops-product water_level \\
      --start-date 20230101 --end-date 20230131

  # Find stations in New York state
  python fetch_climate_data.py --api-key YOUR_TOKEN --list-stations --location "FIPS:36"

  # Test API connections
  python fetch_climate_data.py --api-key YOUR_TOKEN --test-connection
        """
    )

    parser.add_argument('--api-key', type=str, required=True, help='NOAA CDO API token')

    parser.add_argument('--source', choices=['cdo', 'coops'], default='cdo',
                        help='Data source (cdo or coops)')

    parser.add_argument('--dataset', choices=['GHCND', 'GSOM', 'GSOY', 'NORMAL_DLY'],
                        default='GHCND', help='CDO dataset ID')

    parser.add_argument('--stations', type=str, help='Comma-separated CDO station IDs')

    parser.add_argument('--data-types', type=str,
                        help='Comma-separated data type codes (TMAX,TMIN,PRCP)')

    parser.add_argument('--start-date', type=str, help='Start date (YYYY-MM-DD for CDO, YYYYMMDD for CO-OPS)')

    parser.add_argument('--end-date', type=str, help='End date')

    parser.add_argument('--location', type=str, help='Location filter (e.g., FIPS:36)')

    parser.add_argument('--coops-station', type=str, help='CO-OPS station ID')

    parser.add_argument('--coops-product', choices=list(NOAADataFetcher(api_key='').coops_products.keys()),
                        default='water_level', help='CO-OPS data product')

    parser.add_argument('--output-dir', type=Path, default=Path('./noaa_data'), help='Output directory')

    parser.add_argument('--format', choices=['csv', 'json'], default='csv', help='Output format')

    parser.add_argument('--delay', type=float, default=0.3, help='Request delay in seconds')

    parser.add_argument('--test-connection', action='store_true', help='Test API connections')

    parser.add_argument('--list-stations', action='store_true', help='List available stations')

    parser.add_argument('--list-datasets', action='store_true', help='List available datasets')

    parser.add_argument('--list-data-types', action='store_true', help='List data type codes')

    parser.add_argument('--verbose', action='store_true', help='Verbose logging')

    parser.add_argument('--quiet', action='store_true', help='Quiet mode')

    return parser.parse_args()


def main():
    """Main function."""
    args = parse_arguments()

    if args.quiet:
        logging.getLogger().setLevel(logging.ERROR)
    elif args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    fetcher = NOAADataFetcher(api_key=args.api_key, delay=args.delay)

    try:
        if args.test_connection:
            cdo_ok = fetcher.test_api_connection()
            coops_ok = fetcher.test_coops_connection()
            print(f"CDO API: {'OK' if cdo_ok else 'FAILED'}")
            print(f"CO-OPS API: {'OK' if coops_ok else 'FAILED'}")
            sys.exit(0 if (cdo_ok or coops_ok) else 1)

        if args.list_datasets:
            print("CDO Datasets:")
            for name, info in fetcher.datasets.items():
                print(f"  - {name}: {info['description']}")
            print("\nCO-OPS Products:")
            for name, desc in fetcher.coops_products.items():
                print(f"  - {name}: {desc}")
            sys.exit(0)

        if args.list_data_types:
            print("GHCND Data Types:")
            for code, desc in fetcher.data_types.items():
                print(f"  - {code}: {desc}")
            sys.exit(0)

        if args.list_stations:
            stations = fetcher.fetch_stations(
                dataset_id=args.dataset,
                location_id=args.location
            )
            for s in stations[:50]:
                print(f"  {s.get('id', 'N/A')}: {s.get('name', 'N/A')} "
                      f"({s.get('latitude', 'N/A')}, {s.get('longitude', 'N/A')})")
            print(f"\nTotal: {len(stations)} stations")
            sys.exit(0)

        args.output_dir.mkdir(parents=True, exist_ok=True)

        if args.source == 'cdo':
            stations = [s.strip() for s in args.stations.split(',')] if args.stations else None
            data_types = [d.strip() for d in args.data_types.split(',')] if args.data_types else None

            if not stations:
                logger.error("--stations required for CDO data fetching")
                sys.exit(1)

            data = fetcher.fetch_cdo_data(
                dataset_id=args.dataset,
                station_ids=stations,
                data_types=data_types,
                start_date=args.start_date,
                end_date=args.end_date,
                location_id=args.location
            )

            output_file = args.output_dir / f"noaa_{args.dataset.lower()}.{args.format}"
            fetcher.save_data(data, output_file, args.format)

        elif args.source == 'coops':
            if not args.coops_station:
                logger.error("--coops-station required for CO-OPS data")
                sys.exit(1)

            data = fetcher.fetch_coops_data(
                station_id=args.coops_station,
                product=args.coops_product,
                begin_date=args.start_date,
                end_date=args.end_date
            )

            output_file = args.output_dir / f"coops_{args.coops_product}.{args.format}"
            fetcher.save_data(data, output_file, args.format)

        logger.info("Operation completed successfully")

    except KeyboardInterrupt:
        logger.info("Operation cancelled by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Operation failed: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
