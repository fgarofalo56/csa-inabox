#!/usr/bin/env python3
"""
EPA Environmental Data Fetcher

This script fetches environmental data from the EPA AirNow API for
real-time air quality and the EPA ECHO (Enforcement and Compliance
History Online) API for facility compliance data.

Usage:
    python fetch_epa_data.py --api-key YOUR_API_KEY --source airnow --zip-codes "20001,90210"
    python fetch_epa_data.py --help
"""

import argparse
import csv
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class EPADataFetcher:
    """Fetch data from EPA AirNow API and ECHO API."""

    def __init__(self, api_key: str, base_url: str = None, delay: float = 0.3):
        """Initialize the EPA data fetcher.

        Args:
            api_key: AirNow API key (register at https://docs.airnowapi.org/)
            base_url: Base URL for AirNow API (optional override)
            delay: Delay between API requests in seconds
        """
        self.api_key = api_key
        self.airnow_url = base_url or "https://www.airnowapi.org/aq"
        self.echo_url = "https://echodata.epa.gov/echo"
        self.aqs_url = "https://aqs.epa.gov/data/api"
        self.delay = delay

        # AirNow API endpoints
        self.airnow_endpoints = {
            'current_zip': {
                'path': '/observation/zipCode/current/',
                'description': 'Current AQI observation by ZIP code'
            },
            'current_latlon': {
                'path': '/observation/latLong/current/',
                'description': 'Current AQI observation by latitude/longitude'
            },
            'forecast_zip': {
                'path': '/forecast/zipCode/',
                'description': 'AQI forecast by ZIP code'
            },
            'forecast_latlon': {
                'path': '/forecast/latLong/',
                'description': 'AQI forecast by latitude/longitude'
            },
            'historical': {
                'path': '/observation/zipCode/historical/',
                'description': 'Historical AQI observations by ZIP code'
            }
        }

        # ECHO API endpoints
        self.echo_endpoints = {
            'facility_search': {
                'path': '/cwa_rest_services.get_facilities',
                'description': 'Clean Water Act facility search'
            },
            'air_facility': {
                'path': '/air_rest_services.get_facilities',
                'description': 'Clean Air Act facility search'
            },
            'sdw_facility': {
                'path': '/sdw_rest_services.get_systems',
                'description': 'Safe Drinking Water Act system search'
            },
            'rcra_facility': {
                'path': '/rcra_rest_services.get_facilities',
                'description': 'RCRA hazardous waste facility search'
            },
            'tri_facility': {
                'path': '/tri_rest_services.get_facilities',
                'description': 'Toxic Release Inventory facility search'
            }
        }

    def fetch_airnow_current(
        self,
        zip_code: str = None,
        latitude: float = None,
        longitude: float = None,
        distance: int = 25
    ) -> list[dict[str, Any]]:
        """Fetch current air quality observations from AirNow.

        Args:
            zip_code: ZIP code for observation lookup
            latitude: Latitude for location-based lookup
            longitude: Longitude for location-based lookup
            distance: Search radius in miles

        Returns:
            List of current AQI observation records
        """
        if zip_code:
            url = f"{self.airnow_url}/observation/zipCode/current/"
            params = {
                'format': 'application/json',
                'zipCode': zip_code,
                'distance': distance,
                'API_KEY': self.api_key
            }
        elif latitude is not None and longitude is not None:
            url = f"{self.airnow_url}/observation/latLong/current/"
            params = {
                'format': 'application/json',
                'latitude': latitude,
                'longitude': longitude,
                'distance': distance,
                'API_KEY': self.api_key
            }
        else:
            raise ValueError("Either zip_code or latitude/longitude required")

        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()

            data = response.json()
            if isinstance(data, list):
                logger.debug(f"Retrieved {len(data)} current AQI observations")
                time.sleep(self.delay)
                return data
            logger.warning("Unexpected response format from AirNow")
            return []

        except Exception as e:
            logger.error(f"AirNow current observation failed: {e}")
            return []

    def fetch_airnow_forecast(
        self,
        zip_code: str = None,
        latitude: float = None,
        longitude: float = None,
        forecast_date: str = None,
        distance: int = 25
    ) -> list[dict[str, Any]]:
        """Fetch AQI forecast from AirNow.

        Args:
            zip_code: ZIP code
            latitude: Latitude
            longitude: Longitude
            forecast_date: Date for forecast (YYYY-MM-DD)
            distance: Search radius in miles

        Returns:
            List of forecast records
        """
        if zip_code:
            url = f"{self.airnow_url}/forecast/zipCode/"
            params = {
                'format': 'application/json',
                'zipCode': zip_code,
                'distance': distance,
                'API_KEY': self.api_key
            }
        elif latitude is not None and longitude is not None:
            url = f"{self.airnow_url}/forecast/latLong/"
            params = {
                'format': 'application/json',
                'latitude': latitude,
                'longitude': longitude,
                'distance': distance,
                'API_KEY': self.api_key
            }
        else:
            raise ValueError("Either zip_code or latitude/longitude required")

        if forecast_date:
            params['date'] = forecast_date

        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            time.sleep(self.delay)
            return data if isinstance(data, list) else []
        except Exception as e:
            logger.error(f"AirNow forecast failed: {e}")
            return []

    def fetch_airnow_historical(
        self,
        zip_code: str,
        observation_date: str,
        distance: int = 25
    ) -> list[dict[str, Any]]:
        """Fetch historical AQI observations from AirNow.

        Args:
            zip_code: ZIP code
            observation_date: Date (YYYY-MM-DDT00-0000)
            distance: Search radius in miles

        Returns:
            List of historical observation records
        """
        url = f"{self.airnow_url}/observation/zipCode/historical/"
        params = {
            'format': 'application/json',
            'zipCode': zip_code,
            'date': observation_date,
            'distance': distance,
            'API_KEY': self.api_key
        }

        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            time.sleep(self.delay)
            return data if isinstance(data, list) else []
        except Exception as e:
            logger.error(f"AirNow historical fetch failed: {e}")
            return []

    def fetch_echo_facilities(
        self,
        state: str = None,
        zip_code: str = None,
        program: str = 'air',
        page_size: int = 100,
        max_pages: int = 10
    ) -> list[dict[str, Any]]:
        """Fetch facility data from EPA ECHO API.

        Args:
            state: Two-letter state abbreviation
            zip_code: ZIP code for facility search
            program: EPA program (air, cwa, sdw, rcra, tri)
            page_size: Results per page
            max_pages: Maximum pages to fetch

        Returns:
            List of facility records
        """
        endpoint_map = {
            'air': 'air_rest_services.get_facilities',
            'cwa': 'cwa_rest_services.get_facilities',
            'sdw': 'sdw_rest_services.get_systems',
            'rcra': 'rcra_rest_services.get_facilities',
            'tri': 'tri_rest_services.get_facilities'
        }

        if program not in endpoint_map:
            raise ValueError(f"Unknown program: {program}. Use: {', '.join(endpoint_map.keys())}")

        url = f"{self.echo_url}/{endpoint_map[program]}"
        all_facilities = []

        params = {
            'output': 'JSON',
            'p_st': state,
            'p_zip': zip_code,
            'responseset': page_size
        }

        # Remove None values
        params = {k: v for k, v in params.items() if v is not None}

        for page in range(1, max_pages + 1):
            params['pageno'] = page

            try:
                logger.debug(f"ECHO request page={page}")

                response = requests.get(url, params=params, timeout=60)
                response.raise_for_status()

                data = response.json()

                # ECHO returns results in various structures
                results = data.get('Results', {})
                facilities = results.get('Facilities', results.get('Systems', []))

                if not facilities:
                    break

                all_facilities.extend(facilities)

                # Check for more pages
                query_rows = results.get('QueryRows', '0')
                if isinstance(query_rows, str):
                    query_rows = int(query_rows)
                if len(all_facilities) >= query_rows:
                    break

                time.sleep(self.delay)

            except Exception as e:
                logger.error(f"ECHO facility fetch failed (page {page}): {e}")
                break

        logger.info(f"Fetched {len(all_facilities)} {program} facilities")
        return all_facilities

    def fetch_multiple_zips_airnow(
        self,
        zip_codes: list[str],
        data_type: str = 'current'
    ) -> dict[str, list[dict[str, Any]]]:
        """Fetch AirNow data for multiple ZIP codes.

        Args:
            zip_codes: List of ZIP codes
            data_type: 'current' or 'forecast'

        Returns:
            Dictionary mapping ZIP codes to their AQI records
        """
        results = {}

        for zip_code in zip_codes:
            try:
                if data_type == 'current':
                    records = self.fetch_airnow_current(zip_code=zip_code)
                else:
                    records = self.fetch_airnow_forecast(zip_code=zip_code)

                results[zip_code] = records

            except Exception as e:
                logger.error(f"Failed for ZIP {zip_code}: {e}")
                results[zip_code] = []

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
                if isinstance(record, dict):
                    fieldnames.update(record.keys())
            fieldnames = sorted(fieldnames)

            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for record in data:
                    if isinstance(record, dict):
                        writer.writerow(record)

        elif format_type.lower() == 'json':
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, default=str)

        logger.info(f"Saved {len(data)} records to {output_path}")

    def test_api_connection(self) -> bool:
        """Test AirNow API connection."""
        try:
            records = self.fetch_airnow_current(zip_code='20001')
            if records is not None:
                logger.info("AirNow API connection test successful")
                return True
            return False
        except Exception as e:
            logger.error(f"AirNow API connection test failed: {e}")
            return False

    def test_echo_connection(self) -> bool:
        """Test ECHO API connection."""
        try:
            records = self.fetch_echo_facilities(state='DC', program='air', max_pages=1)
            if records is not None:
                logger.info("ECHO API connection test successful")
                return True
            return False
        except Exception as e:
            logger.error(f"ECHO API connection test failed: {e}")
            return False


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch environmental data from EPA AirNow and ECHO APIs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Current AQI for ZIP codes
  python fetch_epa_data.py --api-key YOUR_KEY --source airnow --operation current \\
      --zip-codes "20001,90210,60601"

  # AQI forecast
  python fetch_epa_data.py --api-key YOUR_KEY --source airnow --operation forecast \\
      --zip-codes "20001" --forecast-date 2023-06-15

  # Historical AQI
  python fetch_epa_data.py --api-key YOUR_KEY --source airnow --operation historical \\
      --zip-codes "20001" --historical-date "2023-06-01T00-0000"

  # ECHO facility search
  python fetch_epa_data.py --api-key YOUR_KEY --source echo --program air --state "CA"

  # Test connections
  python fetch_epa_data.py --api-key YOUR_KEY --test-connection
        """
    )

    parser.add_argument('--api-key', type=str, required=True, help='AirNow API key')

    parser.add_argument('--source', choices=['airnow', 'echo'], default='airnow',
                        help='Data source (airnow or echo)')

    parser.add_argument('--operation', choices=['current', 'forecast', 'historical'],
                        default='current', help='AirNow operation type')

    parser.add_argument('--zip-codes', type=str, help='Comma-separated ZIP codes')

    parser.add_argument('--state', type=str, help='State abbreviation (for ECHO)')

    parser.add_argument('--program', choices=['air', 'cwa', 'sdw', 'rcra', 'tri'],
                        default='air', help='EPA program for ECHO search')

    parser.add_argument('--forecast-date', type=str, help='Forecast date (YYYY-MM-DD)')

    parser.add_argument('--historical-date', type=str,
                        help='Historical observation date (YYYY-MM-DDT00-0000)')

    parser.add_argument('--latitude', type=float, help='Latitude for location search')

    parser.add_argument('--longitude', type=float, help='Longitude for location search')

    parser.add_argument('--distance', type=int, default=25, help='Search radius in miles')

    parser.add_argument('--output-dir', type=Path, default=Path('./epa_data'), help='Output directory')

    parser.add_argument('--format', choices=['csv', 'json'], default='csv', help='Output format')

    parser.add_argument('--delay', type=float, default=0.3, help='Request delay in seconds')

    parser.add_argument('--test-connection', action='store_true', help='Test API connections')

    parser.add_argument('--list-endpoints', action='store_true', help='List available endpoints')

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

    fetcher = EPADataFetcher(api_key=args.api_key, delay=args.delay)

    try:
        if args.test_connection:
            airnow_ok = fetcher.test_api_connection()
            echo_ok = fetcher.test_echo_connection()
            print(f"AirNow API: {'OK' if airnow_ok else 'FAILED'}")
            print(f"ECHO API: {'OK' if echo_ok else 'FAILED'}")
            sys.exit(0 if (airnow_ok or echo_ok) else 1)

        if args.list_endpoints:
            print("AirNow Endpoints:")
            for name, info in fetcher.airnow_endpoints.items():
                print(f"  - {name}: {info['description']}")
            print("\nECHO Endpoints:")
            for name, info in fetcher.echo_endpoints.items():
                print(f"  - {name}: {info['description']}")
            sys.exit(0)

        args.output_dir.mkdir(parents=True, exist_ok=True)

        if args.source == 'airnow':
            if args.zip_codes:
                zip_codes = [z.strip() for z in args.zip_codes.split(',')]
            elif args.latitude and args.longitude:
                zip_codes = None
            else:
                logger.error("Either --zip-codes or --latitude/--longitude required")
                sys.exit(1)

            all_records = []

            if args.operation == 'current':
                if zip_codes:
                    results = fetcher.fetch_multiple_zips_airnow(zip_codes, 'current')
                    for records in results.values():
                        all_records.extend(records)
                else:
                    all_records = fetcher.fetch_airnow_current(
                        latitude=args.latitude, longitude=args.longitude
                    )

            elif args.operation == 'forecast':
                if zip_codes:
                    for zc in zip_codes:
                        records = fetcher.fetch_airnow_forecast(
                            zip_code=zc, forecast_date=args.forecast_date
                        )
                        all_records.extend(records)
                else:
                    all_records = fetcher.fetch_airnow_forecast(
                        latitude=args.latitude, longitude=args.longitude,
                        forecast_date=args.forecast_date
                    )

            elif args.operation == 'historical':
                if not args.historical_date:
                    logger.error("--historical-date required for historical operation")
                    sys.exit(1)
                for zc in (zip_codes or []):
                    records = fetcher.fetch_airnow_historical(
                        zip_code=zc, observation_date=args.historical_date
                    )
                    all_records.extend(records)

            output_file = args.output_dir / f"airnow_{args.operation}.{args.format}"
            fetcher.save_data(all_records, output_file, args.format)

        elif args.source == 'echo':
            if not args.state and not args.zip_codes:
                logger.error("--state or --zip-codes required for ECHO search")
                sys.exit(1)

            data = fetcher.fetch_echo_facilities(
                state=args.state,
                zip_code=args.zip_codes.split(',')[0] if args.zip_codes else None,
                program=args.program
            )

            output_file = args.output_dir / f"echo_{args.program}.{args.format}"
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
