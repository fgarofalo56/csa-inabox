#!/usr/bin/env python3
"""
FARS Crash Data Fetcher

This script fetches fatal crash data from the NHTSA Fatality Analysis
Reporting System (FARS) API and supplemental highway data from
data.transportation.gov SODA API.

Usage:
    python fetch_fars.py --api-key YOUR_API_KEY --states "TX,CA,FL" --years "2020,2021,2022"
    python fetch_fars.py --help
"""

import argparse
import csv
import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import requests


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# FARS state FIPS code mapping
STATE_FIPS = {
    'AL': 1, 'AK': 2, 'AZ': 4, 'AR': 5, 'CA': 6, 'CO': 8, 'CT': 9,
    'DE': 10, 'DC': 11, 'FL': 12, 'GA': 13, 'HI': 15, 'ID': 16, 'IL': 17,
    'IN': 18, 'IA': 19, 'KS': 20, 'KY': 21, 'LA': 22, 'ME': 23, 'MD': 24,
    'MA': 25, 'MI': 26, 'MN': 27, 'MS': 28, 'MO': 29, 'MT': 30, 'NE': 31,
    'NV': 32, 'NH': 33, 'NJ': 34, 'NM': 35, 'NY': 36, 'NC': 37, 'ND': 38,
    'OH': 39, 'OK': 40, 'OR': 41, 'PA': 42, 'RI': 44, 'SC': 45, 'SD': 46,
    'TN': 47, 'TX': 48, 'UT': 49, 'VT': 50, 'VA': 51, 'WA': 53, 'WV': 54,
    'WI': 55, 'WY': 56
}


class FARSDataFetcher:
    """Fetch data from NHTSA FARS CrashAPI and data.transportation.gov."""

    def __init__(self, api_key: str = None, base_url: str = None, delay: float = 0.3):
        """Initialize the FARS data fetcher.

        Args:
            api_key: Optional API key for data.transportation.gov (SODA API)
            base_url: Base URL for FARS CrashAPI (optional override)
            delay: Delay between API requests in seconds
        """
        self.api_key = api_key
        self.crash_api_url = base_url or "https://crashviewer.nhtsa.dot.gov/CrashAPI"
        self.soda_base_url = "https://data.transportation.gov/resource"
        self.delay = delay

        # FARS CrashAPI data types
        self.data_types = {
            'crashes': {
                'endpoint': '/crashes/GetCaseList',
                'description': 'Fatal crash case listing'
            },
            'crash_details': {
                'endpoint': '/crashes/GetCaseDetails',
                'description': 'Detailed crash case information'
            },
            'vehicles': {
                'endpoint': '/crashes/GetCrashVehicleList',
                'description': 'Vehicles involved in crashes'
            },
            'persons': {
                'endpoint': '/crashes/GetCrashPersonList',
                'description': 'Persons involved in crashes'
            }
        }

        # SODA datasets on data.transportation.gov
        self.soda_datasets = {
            'fatalities': {
                'resource_id': 'qg4d-ry6e',
                'description': 'FARS fatality records'
            },
            'highway_safety': {
                'resource_id': 'pu73-3h3c',
                'description': 'Highway safety performance data'
            },
            'bridge_conditions': {
                'resource_id': 'ekpr-g4vy',
                'description': 'National Bridge Inventory conditions'
            }
        }

    def fetch_crash_cases(
        self,
        state: int,
        year: int,
        max_results: int = 5000
    ) -> List[Dict[str, Any]]:
        """Fetch crash case list for a state and year.

        Args:
            state: State FIPS code
            year: Data year
            max_results: Maximum results to return

        Returns:
            List of crash case records
        """
        endpoint = f"{self.crash_api_url}/crashes/GetCaseList"
        params = {
            'StateCase': state,
            'CaseYear': year,
            'MaxResults': max_results,
            'format': 'json'
        }

        try:
            logger.debug(f"Fetching crash cases for state={state}, year={year}")

            response = requests.get(endpoint, params=params, timeout=60)
            response.raise_for_status()

            data = response.json()

            # FARS API wraps results differently
            if isinstance(data, dict):
                records = data.get('Results', data.get('results', []))
                if isinstance(records, list) and len(records) > 0:
                    # Sometimes nested one more level
                    if isinstance(records[0], dict) and 'CrashResultsCase' in records[0]:
                        records = records[0]['CrashResultsCase']
            elif isinstance(data, list):
                records = data
            else:
                records = []

            logger.info(f"Retrieved {len(records)} crash cases for state {state}, year {year}")
            time.sleep(self.delay)

            return records

        except requests.exceptions.HTTPError as e:
            logger.error(f"HTTP error for state {state}, year {year}: {e}")
            return []
        except requests.exceptions.RequestException as e:
            logger.error(f"Request failed for state {state}, year {year}: {e}")
            return []
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error for state {state}, year {year}: {e}")
            return []

    def fetch_crash_details(
        self,
        state: int,
        case_year: int,
        case_number: int
    ) -> Dict[str, Any]:
        """Fetch detailed crash case information.

        Args:
            state: State FIPS code
            case_year: Year of the crash case
            case_number: FARS case number

        Returns:
            Detailed crash case record
        """
        endpoint = f"{self.crash_api_url}/crashes/GetCaseDetails"
        params = {
            'StateCase': state,
            'CaseYear': case_year,
            'CaseNumber': case_number,
            'format': 'json'
        }

        try:
            response = requests.get(endpoint, params=params, timeout=30)
            response.raise_for_status()

            data = response.json()
            time.sleep(self.delay)

            if isinstance(data, dict) and 'Results' in data:
                return data['Results']
            return data

        except Exception as e:
            logger.error(f"Failed to fetch details for case {case_number}: {e}")
            return {}

    def fetch_soda_data(
        self,
        dataset_name: str,
        state_code: str = None,
        year: int = None,
        limit: int = 10000,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """Fetch data from data.transportation.gov SODA API.

        Args:
            dataset_name: Name of the dataset (fatalities, highway_safety, etc.)
            state_code: Optional state abbreviation filter
            year: Optional year filter
            limit: Max records per request
            offset: Pagination offset

        Returns:
            List of data records
        """
        if dataset_name not in self.soda_datasets:
            raise ValueError(f"Unknown dataset: {dataset_name}. "
                           f"Available: {', '.join(self.soda_datasets.keys())}")

        resource_id = self.soda_datasets[dataset_name]['resource_id']
        url = f"{self.soda_base_url}/{resource_id}.json"

        params = {
            '$limit': limit,
            '$offset': offset,
            '$order': ':id'
        }

        # Add API key if available
        if self.api_key:
            params['$$app_token'] = self.api_key

        # Build where clause
        where_parts = []
        if state_code:
            where_parts.append(f"state='{state_code}'")
        if year:
            where_parts.append(f"year='{year}'")

        if where_parts:
            params['$where'] = ' AND '.join(where_parts)

        all_records = []

        try:
            while True:
                logger.debug(f"Fetching {dataset_name} offset={offset}")

                response = requests.get(url, params=params, timeout=60)
                response.raise_for_status()

                records = response.json()

                if not records:
                    break

                all_records.extend(records)
                logger.debug(f"Retrieved {len(records)} records (total: {len(all_records)})")

                if len(records) < limit:
                    break

                offset += limit
                params['$offset'] = offset
                time.sleep(self.delay)

            logger.info(f"Fetched {len(all_records)} total records from {dataset_name}")
            return all_records

        except Exception as e:
            logger.error(f"Failed to fetch {dataset_name}: {e}")
            return all_records  # Return partial results

    def fetch_multiple_states(
        self,
        states: List[str],
        years: List[int],
        data_source: str = 'crash_api'
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Fetch data for multiple states and years.

        Args:
            states: List of state abbreviations
            years: List of years
            data_source: 'crash_api' or 'soda'

        Returns:
            Dictionary mapping state codes to data records
        """
        results = {}

        for state in states:
            state_key = state.upper()
            results[state_key] = []

            for year in years:
                try:
                    if data_source == 'crash_api':
                        fips = STATE_FIPS.get(state_key)
                        if fips is None:
                            logger.warning(f"Unknown state code: {state_key}")
                            continue
                        records = self.fetch_crash_cases(fips, year)
                    else:
                        records = self.fetch_soda_data('fatalities',
                                                       state_code=state_key,
                                                       year=year)

                    results[state_key].extend(records)

                except Exception as e:
                    logger.error(f"Failed for {state_key} {year}: {e}")

        return results

    def save_data(
        self,
        data: List[Dict[str, Any]],
        output_path: Path,
        format_type: str = 'csv'
    ) -> None:
        """Save fetched data to file.

        Args:
            data: Data records to save
            output_path: Output file path
            format_type: Output format (csv, json)
        """
        if not data:
            logger.warning(f"No data to save to {output_path}")
            return

        output_path.parent.mkdir(parents=True, exist_ok=True)

        if format_type.lower() == 'csv':
            fieldnames = set()
            for record in data:
                fieldnames.update(record.keys())
            fieldnames = sorted(list(fieldnames))

            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(data)

        elif format_type.lower() == 'json':
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, default=str)

        else:
            raise ValueError(f"Unsupported format: {format_type}")

        logger.info(f"Saved {len(data)} records to {output_path}")

    def test_api_connection(self) -> bool:
        """Test FARS API connection.

        Returns:
            True if connection successful
        """
        try:
            # Test CrashAPI with a known query
            test_url = f"{self.crash_api_url}/crashes/GetCaseList"
            params = {
                'StateCase': 48,  # Texas
                'CaseYear': 2021,
                'MaxResults': 1,
                'format': 'json'
            }

            response = requests.get(test_url, params=params, timeout=15)
            response.raise_for_status()

            data = response.json()
            if data:
                logger.info("FARS CrashAPI connection test successful")
                return True
            else:
                logger.error("FARS CrashAPI returned empty response")
                return False

        except Exception as e:
            logger.error(f"FARS CrashAPI connection test failed: {e}")
            return False

    def test_soda_connection(self) -> bool:
        """Test data.transportation.gov SODA API connection.

        Returns:
            True if connection successful
        """
        try:
            resource_id = self.soda_datasets['fatalities']['resource_id']
            url = f"{self.soda_base_url}/{resource_id}.json"
            params = {'$limit': 1}

            if self.api_key:
                params['$$app_token'] = self.api_key

            response = requests.get(url, params=params, timeout=15)
            response.raise_for_status()

            data = response.json()
            if data:
                logger.info("SODA API connection test successful")
                return True
            else:
                logger.error("SODA API returned empty response")
                return False

        except Exception as e:
            logger.error(f"SODA API connection test failed: {e}")
            return False


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch fatal crash data from NHTSA FARS API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch crash data for Texas and California
  python fetch_fars.py --api-key YOUR_KEY --states "TX,CA" --years "2021,2022"

  # Fetch from SODA API with larger datasets
  python fetch_fars.py --api-key YOUR_KEY --source soda --states "FL" --years "2022"

  # Test API connections
  python fetch_fars.py --test-connection

  # List available datasets
  python fetch_fars.py --list-datasets
        """
    )

    parser.add_argument(
        '--api-key',
        type=str,
        help='data.transportation.gov SODA API app token (optional for CrashAPI)'
    )

    parser.add_argument(
        '--states',
        type=str,
        help='Comma-separated state abbreviations (e.g., "TX,CA,FL")'
    )

    parser.add_argument(
        '--years',
        type=str,
        help='Comma-separated years (e.g., "2020,2021,2022")'
    )

    parser.add_argument(
        '--source',
        choices=['crash_api', 'soda'],
        default='crash_api',
        help='Data source: crash_api (FARS CrashAPI) or soda (data.transportation.gov)'
    )

    parser.add_argument(
        '--dataset',
        choices=['fatalities', 'highway_safety', 'bridge_conditions'],
        default='fatalities',
        help='SODA dataset to fetch (when --source soda)'
    )

    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('./fars_data'),
        help='Output directory (default: ./fars_data)'
    )

    parser.add_argument(
        '--format',
        choices=['csv', 'json'],
        default='csv',
        help='Output format (default: csv)'
    )

    parser.add_argument(
        '--delay',
        type=float,
        default=0.3,
        help='Delay between API requests in seconds (default: 0.3)'
    )

    parser.add_argument(
        '--max-results',
        type=int,
        default=5000,
        help='Maximum results per CrashAPI request (default: 5000)'
    )

    parser.add_argument(
        '--test-connection',
        action='store_true',
        help='Test API connections and exit'
    )

    parser.add_argument(
        '--list-datasets',
        action='store_true',
        help='List available datasets and exit'
    )

    parser.add_argument(
        '--list-states',
        action='store_true',
        help='List supported state codes and exit'
    )

    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    parser.add_argument(
        '--quiet',
        action='store_true',
        help='Enable quiet mode (errors only)'
    )

    return parser.parse_args()


def main():
    """Main function."""
    args = parse_arguments()

    if args.quiet:
        logging.getLogger().setLevel(logging.ERROR)
    elif args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    fetcher = FARSDataFetcher(
        api_key=args.api_key,
        delay=args.delay
    )

    try:
        # Utility operations
        if args.test_connection:
            crash_ok = fetcher.test_api_connection()
            soda_ok = fetcher.test_soda_connection()
            print(f"FARS CrashAPI: {'OK' if crash_ok else 'FAILED'}")
            print(f"SODA API: {'OK' if soda_ok else 'FAILED'}")
            sys.exit(0 if (crash_ok or soda_ok) else 1)

        if args.list_datasets:
            print("FARS CrashAPI data types:")
            for name, info in fetcher.data_types.items():
                print(f"  - {name}: {info['description']}")
            print("\nSODA datasets (data.transportation.gov):")
            for name, info in fetcher.soda_datasets.items():
                print(f"  - {name}: {info['description']} (ID: {info['resource_id']})")
            sys.exit(0)

        if args.list_states:
            print("Supported state codes (FIPS):")
            for state, fips in sorted(STATE_FIPS.items()):
                print(f"  {state}: {fips}")
            sys.exit(0)

        # Validate required arguments
        if not args.states:
            logger.error("--states is required for data fetching")
            sys.exit(1)

        if not args.years:
            logger.error("--years is required for data fetching")
            sys.exit(1)

        states = [s.strip().upper() for s in args.states.split(',')]
        years = [int(y.strip()) for y in args.years.split(',')]

        # Validate state codes
        invalid_states = [s for s in states if s not in STATE_FIPS]
        if invalid_states and args.source == 'crash_api':
            logger.error(f"Invalid state codes: {', '.join(invalid_states)}")
            sys.exit(1)

        # Fetch data
        logger.info(f"Source: {args.source}")
        logger.info(f"States: {', '.join(states)}")
        logger.info(f"Years: {', '.join(map(str, years))}")

        results = fetcher.fetch_multiple_states(
            states=states,
            years=years,
            data_source=args.source
        )

        # Save results
        args.output_dir.mkdir(parents=True, exist_ok=True)

        total_records = 0
        for state, records in results.items():
            if records:
                output_file = args.output_dir / f"fars_{state.lower()}.{args.format}"
                fetcher.save_data(records, output_file, args.format)
                total_records += len(records)

        # Save combined
        if total_records > 0:
            all_records = []
            for records in results.values():
                all_records.extend(records)
            combined_file = args.output_dir / f"fars_all_states.{args.format}"
            fetcher.save_data(all_records, combined_file, args.format)

            logger.info(f"Successfully fetched {total_records} total records")
            logger.info(f"Data saved to {args.output_dir}")
        else:
            logger.error("No data was retrieved")
            sys.exit(1)

    except KeyboardInterrupt:
        logger.info("Operation cancelled by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Operation failed: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
