#!/usr/bin/env python3
"""
NASS QuickStats Data Fetcher

This script fetches agricultural data from the USDA National Agricultural
Statistics Service (NASS) QuickStats API. It provides a simple interface
to retrieve crop yield, production, and acreage data for analysis.

Usage:
    python fetch_nass.py --api-key YOUR_API_KEY --states "IA,IL,IN" --years "2020,2021,2022"
    python fetch_nass.py --help
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


class NASSDataFetcher:
    """Fetch data from USDA NASS QuickStats API."""

    def __init__(self, api_key: str, base_url: str = None, delay: float = 0.2):
        """Initialize the NASS data fetcher.

        Args:
            api_key: USDA NASS QuickStats API key
            base_url: Base URL for the API (optional)
            delay: Delay between API requests to respect rate limits
        """
        self.api_key = api_key
        self.base_url = base_url or "https://quickstats.nass.usda.gov/api/api_GET/"
        self.delay = delay  # Rate limiting

        # Standard parameters for crop yield queries
        self.default_params = {
            'key': self.api_key,
            'source_desc': 'SURVEY',
            'sector_desc': 'CROPS',
            'group_desc': 'FIELD CROPS',
            'format': 'JSON'
        }

        # Commodity configurations
        self.commodities = {
            'CORN': {
                'commodity_desc': 'CORN',
                'data_items': [
                    'CORN, GRAIN - YIELD, MEASURED IN BU / ACRE',
                    'CORN, GRAIN - PRODUCTION, MEASURED IN BU',
                    'CORN, GRAIN - ACRES PLANTED',
                    'CORN, GRAIN - ACRES HARVESTED'
                ]
            },
            'SOYBEANS': {
                'commodity_desc': 'SOYBEANS',
                'data_items': [
                    'SOYBEANS - YIELD, MEASURED IN BU / ACRE',
                    'SOYBEANS - PRODUCTION, MEASURED IN BU',
                    'SOYBEANS - ACRES PLANTED',
                    'SOYBEANS - ACRES HARVESTED'
                ]
            },
            'WHEAT': {
                'commodity_desc': 'WHEAT',
                'data_items': [
                    'WHEAT - YIELD, MEASURED IN BU / ACRE',
                    'WHEAT - PRODUCTION, MEASURED IN BU',
                    'WHEAT - ACRES PLANTED',
                    'WHEAT - ACRES HARVESTED'
                ]
            },
            'COTTON': {
                'commodity_desc': 'COTTON',
                'data_items': [
                    'COTTON - YIELD, MEASURED IN LB / ACRE',
                    'COTTON - PRODUCTION, MEASURED IN BALES',
                    'COTTON - ACRES PLANTED',
                    'COTTON - ACRES HARVESTED'
                ]
            },
            'RICE': {
                'commodity_desc': 'RICE',
                'data_items': [
                    'RICE - YIELD, MEASURED IN LB / ACRE',
                    'RICE - PRODUCTION, MEASURED IN LB',
                    'RICE - ACRES PLANTED',
                    'RICE - ACRES HARVESTED'
                ]
            }
        }

    def fetch_commodity_data(
        self,
        commodity: str,
        states: list[str],
        years: list[int],
        geographic_level: str = 'STATE'
    ) -> list[dict[str, Any]]:
        """Fetch data for a specific commodity.

        Args:
            commodity: Commodity name (CORN, SOYBEANS, etc.)
            states: List of state abbreviations
            years: List of years to fetch
            geographic_level: Geographic level (STATE, COUNTY)

        Returns:
            List of data records from the API
        """
        if commodity not in self.commodities:
            raise ValueError(f"Unsupported commodity: {commodity}")

        commodity_config = self.commodities[commodity]
        all_records = []

        logger.info(f"Fetching {commodity} data for {len(states)} states and {len(years)} years")

        for state in states:
            for year in years:
                for data_item in commodity_config['data_items']:

                    params = {
                        **self.default_params,
                        'commodity_desc': commodity_config['commodity_desc'],
                        'data_item': data_item,
                        'state_alpha': state,
                        'year': year,
                        'agg_level_desc': geographic_level
                    }

                    try:
                        logger.debug(f"Requesting {commodity} {data_item} for {state} {year}")

                        response = requests.get(
                            self.base_url,
                            params=params,
                            timeout=30
                        )
                        response.raise_for_status()

                        data = response.json()

                        if data.get('data'):
                            records = data['data']
                            all_records.extend(records)
                            logger.debug(f"Retrieved {len(records)} records")
                        else:
                            logger.warning(f"No data returned for {commodity} {data_item} {state} {year}")

                        # Rate limiting
                        time.sleep(self.delay)

                    except requests.exceptions.HTTPError as e:
                        if response.status_code == 413:
                            logger.error(f"Request too large for {commodity} {state} {year}")
                        else:
                            logger.error(f"HTTP error {response.status_code} for {commodity} {state} {year}: {e}")

                    except requests.exceptions.RequestException as e:
                        logger.error(f"Request failed for {commodity} {state} {year}: {e}")

                    except Exception as e:
                        logger.error(f"Unexpected error for {commodity} {state} {year}: {e}")

        logger.info(f"Fetched {len(all_records)} total {commodity} records")
        return all_records

    def fetch_multiple_commodities(
        self,
        commodities: list[str],
        states: list[str],
        years: list[int],
        geographic_level: str = 'STATE'
    ) -> dict[str, list[dict[str, Any]]]:
        """Fetch data for multiple commodities.

        Args:
            commodities: List of commodity names
            states: List of state abbreviations
            years: List of years to fetch
            geographic_level: Geographic level (STATE, COUNTY)

        Returns:
            Dictionary mapping commodity names to their data records
        """
        results = {}

        for commodity in commodities:
            try:
                records = self.fetch_commodity_data(
                    commodity=commodity,
                    states=states,
                    years=years,
                    geographic_level=geographic_level
                )
                results[commodity] = records

            except Exception as e:
                logger.error(f"Failed to fetch {commodity} data: {e}")
                results[commodity] = []

        return results

    def save_data(
        self,
        data: list[dict[str, Any]],
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
            # Get all unique field names
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

        else:
            raise ValueError(f"Unsupported format: {format_type}")

        logger.info(f"Saved {len(data)} records to {output_path}")

    def get_available_data_items(self, commodity: str, state: str = None) -> list[str]:
        """Get available data items for a commodity.

        Args:
            commodity: Commodity name
            state: Optional state filter

        Returns:
            List of available data item descriptions
        """
        params = {
            **self.default_params,
            'commodity_desc': commodity,
            'param': 'data_item'
        }

        if state:
            params['state_alpha'] = state

        try:
            response = requests.get(self.base_url, params=params, timeout=30)
            response.raise_for_status()

            data = response.json()
            if data.get('data'):
                return [item['data_item'] for item in data['data']]

        except Exception as e:
            logger.error(f"Failed to get data items for {commodity}: {e}")

        return []

    def test_api_connection(self) -> bool:
        """Test API connection and key validity.

        Returns:
            True if connection successful, False otherwise
        """
        test_params = {
            'key': self.api_key,
            'param': 'state_alpha',
            'format': 'JSON'
        }

        try:
            response = requests.get(self.base_url, params=test_params, timeout=10)
            response.raise_for_status()

            data = response.json()
            if data.get('data'):
                logger.info("API connection test successful")
                return True
            logger.error("API connection test failed: no data returned")
            return False

        except Exception as e:
            logger.error(f"API connection test failed: {e}")
            return False


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch agricultural data from USDA NASS QuickStats API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch corn and soybean data for corn belt states
  python fetch_nass.py --api-key YOUR_KEY --commodities "CORN,SOYBEANS" --states "IA,IL,IN" --years "2020,2021,2022"

  # Fetch all supported commodities for Texas
  python fetch_nass.py --api-key YOUR_KEY --states "TX" --years "2023"

  # Test API connection
  python fetch_nass.py --api-key YOUR_KEY --test-connection

  # Get available data items for wheat
  python fetch_nass.py --api-key YOUR_KEY --list-data-items WHEAT
        """
    )

    # Required arguments
    parser.add_argument(
        '--api-key',
        type=str,
        required=True,
        help='USDA NASS QuickStats API key (required)'
    )

    # Data selection
    parser.add_argument(
        '--commodities',
        type=str,
        help='Comma-separated commodity names (CORN,SOYBEANS,WHEAT,COTTON,RICE)'
    )

    parser.add_argument(
        '--states',
        type=str,
        help='Comma-separated state abbreviations (e.g., "IA,IL,IN")'
    )

    parser.add_argument(
        '--years',
        type=str,
        help='Comma-separated years (e.g., "2020,2021,2022")'
    )

    parser.add_argument(
        '--geographic-level',
        choices=['STATE', 'COUNTY'],
        default='STATE',
        help='Geographic aggregation level (default: STATE)'
    )

    # Output configuration
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('./nass_data'),
        help='Output directory (default: ./nass_data)'
    )

    parser.add_argument(
        '--format',
        choices=['csv', 'json'],
        default='csv',
        help='Output format (default: csv)'
    )

    # API configuration
    parser.add_argument(
        '--delay',
        type=float,
        default=0.2,
        help='Delay between API requests in seconds (default: 0.2)'
    )

    parser.add_argument(
        '--base-url',
        type=str,
        help='Custom base URL for NASS API'
    )

    # Utility operations
    parser.add_argument(
        '--test-connection',
        action='store_true',
        help='Test API connection and exit'
    )

    parser.add_argument(
        '--list-data-items',
        type=str,
        help='List available data items for a commodity and exit'
    )

    parser.add_argument(
        '--list-commodities',
        action='store_true',
        help='List supported commodities and exit'
    )

    # Logging
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

    # Configure logging level
    if args.quiet:
        logging.getLogger().setLevel(logging.ERROR)
    elif args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Initialize fetcher
    fetcher = NASSDataFetcher(
        api_key=args.api_key,
        base_url=args.base_url,
        delay=args.delay
    )

    try:
        # Handle utility operations
        if args.test_connection:
            success = fetcher.test_api_connection()
            sys.exit(0 if success else 1)

        if args.list_commodities:
            print("Supported commodities:")
            for commodity in fetcher.commodities:
                print(f"  - {commodity}")
            sys.exit(0)

        if args.list_data_items:
            commodity = args.list_data_items.upper()
            if commodity not in fetcher.commodities:
                logger.error(f"Unsupported commodity: {commodity}")
                sys.exit(1)

            print(f"Available data items for {commodity}:")
            data_items = fetcher.get_available_data_items(commodity)
            for item in data_items:
                print(f"  - {item}")
            sys.exit(0)

        # Validate required arguments for data fetching
        if not args.commodities:
            commodities = list(fetcher.commodities.keys())
            logger.info(f"No commodities specified, using all: {', '.join(commodities)}")
        else:
            commodities = [c.strip().upper() for c in args.commodities.split(',')]

        if not args.states:
            logger.error("States must be specified for data fetching")
            sys.exit(1)

        if not args.years:
            logger.error("Years must be specified for data fetching")
            sys.exit(1)

        # Parse arguments
        states = [s.strip().upper() for s in args.states.split(',')]
        years = [int(y.strip()) for y in args.years.split(',')]

        # Validate commodities
        invalid_commodities = [c for c in commodities if c not in fetcher.commodities]
        if invalid_commodities:
            logger.error(f"Invalid commodities: {', '.join(invalid_commodities)}")
            logger.error(f"Supported commodities: {', '.join(fetcher.commodities.keys())}")
            sys.exit(1)

        # Test connection first
        if not fetcher.test_api_connection():
            logger.error("API connection failed. Please check your API key.")
            sys.exit(1)

        # Fetch data
        logger.info(f"Fetching data for commodities: {', '.join(commodities)}")
        logger.info(f"States: {', '.join(states)}")
        logger.info(f"Years: {', '.join(map(str, years))}")

        results = fetcher.fetch_multiple_commodities(
            commodities=commodities,
            states=states,
            years=years,
            geographic_level=args.geographic_level
        )

        # Save results
        args.output_dir.mkdir(parents=True, exist_ok=True)

        total_records = 0
        for commodity, records in results.items():
            if records:
                output_file = args.output_dir / f"nass_{commodity.lower()}.{args.format}"
                fetcher.save_data(records, output_file, args.format)
                total_records += len(records)
            else:
                logger.warning(f"No data retrieved for {commodity}")

        # Save combined data
        if total_records > 0:
            all_records = []
            for records in results.values():
                all_records.extend(records)

            combined_file = args.output_dir / f"nass_all_commodities.{args.format}"
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
