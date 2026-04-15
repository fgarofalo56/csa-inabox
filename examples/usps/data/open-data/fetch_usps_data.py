#!/usr/bin/env python3
"""
USPS Data Fetcher

This script fetches USPS operational data from the USPS Web Tools API
and supplemental ZIP code geography from the US Census TIGER/Line API.

Usage:
    python fetch_usps_data.py --api-key YOUR_USER_ID --zip-codes "10001,60607,90210"
    python fetch_usps_data.py --help
"""

import argparse
import csv
import json
import logging
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class USPSDataFetcher:
    """Fetch data from USPS Web Tools API and Census TIGER/Line."""

    def __init__(self, api_key: str, base_url: str = None, delay: float = 0.3):
        """Initialize the USPS data fetcher.

        Args:
            api_key: USPS Web Tools User ID (register at https://www.usps.com/business/web-tools-apis/)
            base_url: Base URL for USPS Web Tools (optional override)
            delay: Delay between API requests in seconds
        """
        self.api_key = api_key
        self.base_url = base_url or "https://secure.shippingapis.com/ShippingAPI.dll"
        self.census_url = "https://geocoding.geo.census.gov/geocoder"
        self.tiger_url = "https://tigerweb.geo.census.gov/arcgis/rest/services"
        self.delay = delay

        # USPS Web Tools API operations
        self.api_operations = {
            'address_validate': {
                'api': 'Verify',
                'description': 'Standardize and validate mailing addresses'
            },
            'city_state_lookup': {
                'api': 'CityStateLookup',
                'description': 'Look up city and state from ZIP code'
            },
            'zip_code_lookup': {
                'api': 'ZipCodeLookup',
                'description': 'Look up ZIP code from address'
            },
            'track_package': {
                'api': 'TrackV2',
                'description': 'Track package delivery status'
            },
            'rate_calculator': {
                'api': 'RateV4',
                'description': 'Calculate domestic shipping rates'
            }
        }

    def _build_xml_request(self, api: str, xml_body: str) -> str:
        """Build XML request string for USPS API.

        Args:
            api: API operation name
            xml_body: Inner XML content

        Returns:
            Complete XML request string
        """
        return f'<{api}Request USERID="{self.api_key}">{xml_body}</{api}Request>'

    def validate_address(self, addresses: list[dict[str, str]]) -> list[dict[str, Any]]:
        """Validate and standardize mailing addresses.

        Args:
            addresses: List of address dicts with keys:
                       address1, address2, city, state, zip5

        Returns:
            List of validated/standardized address records
        """
        results = []

        # USPS allows up to 5 addresses per request
        for batch_start in range(0, len(addresses), 5):
            batch = addresses[batch_start:batch_start + 5]

            xml_parts = []
            for i, addr in enumerate(batch):
                xml_parts.append(
                    f'<Address ID="{i}">'
                    f'<Address1>{addr.get("address1", "")}</Address1>'
                    f'<Address2>{addr.get("address2", "")}</Address2>'
                    f'<City>{addr.get("city", "")}</City>'
                    f'<State>{addr.get("state", "")}</State>'
                    f'<Zip5>{addr.get("zip5", "")}</Zip5>'
                    f'<Zip4></Zip4>'
                    f'</Address>'
                )

            xml_body = ''.join(xml_parts)
            xml_request = self._build_xml_request('AddressValidate', xml_body)

            try:
                response = requests.get(
                    self.base_url,
                    params={'API': 'Verify', 'XML': xml_request},
                    timeout=30
                )
                response.raise_for_status()

                root = ET.fromstring(response.text)

                for address_elem in root.findall('.//Address'):
                    result = {}
                    for child in address_elem:
                        result[child.tag] = child.text or ''

                    # Check for errors
                    error = address_elem.find('.//Error')
                    if error is not None:
                        result['error'] = error.find('Description').text
                        result['is_valid'] = False
                    else:
                        result['is_valid'] = True

                    results.append(result)

                time.sleep(self.delay)

            except ET.ParseError as e:
                logger.error(f"XML parse error: {e}")
            except Exception as e:
                logger.error(f"Address validation failed: {e}")

        logger.info(f"Validated {len(results)} addresses")
        return results

    def city_state_lookup(self, zip_codes: list[str]) -> list[dict[str, Any]]:
        """Look up city and state for ZIP codes.

        Args:
            zip_codes: List of 5-digit ZIP codes

        Returns:
            List of city/state lookup results
        """
        results = []

        for batch_start in range(0, len(zip_codes), 5):
            batch = zip_codes[batch_start:batch_start + 5]

            xml_parts = []
            for i, zipcode in enumerate(batch):
                xml_parts.append(
                    f'<ZipCode ID="{i}"><Zip5>{zipcode}</Zip5></ZipCode>'
                )

            xml_body = ''.join(xml_parts)
            xml_request = self._build_xml_request('CityStateLookup', xml_body)

            try:
                response = requests.get(
                    self.base_url,
                    params={'API': 'CityStateLookup', 'XML': xml_request},
                    timeout=30
                )
                response.raise_for_status()

                root = ET.fromstring(response.text)

                for zip_elem in root.findall('.//ZipCode'):
                    result = {}
                    for child in zip_elem:
                        result[child.tag] = child.text or ''

                    error = zip_elem.find('.//Error')
                    if error is not None:
                        result['error'] = error.find('Description').text
                    results.append(result)

                time.sleep(self.delay)

            except Exception as e:
                logger.error(f"City/state lookup failed: {e}")

        logger.info(f"Looked up {len(results)} ZIP codes")
        return results

    def track_packages(self, tracking_ids: list[str]) -> list[dict[str, Any]]:
        """Track package delivery status.

        Args:
            tracking_ids: List of USPS tracking numbers

        Returns:
            List of tracking status records
        """
        results = []

        for batch_start in range(0, len(tracking_ids), 10):
            batch = tracking_ids[batch_start:batch_start + 10]

            xml_parts = []
            for _i, track_id in enumerate(batch):
                xml_parts.append(
                    f'<TrackID ID="{track_id}"></TrackID>'
                )

            xml_body = ''.join(xml_parts)
            xml_request = self._build_xml_request('TrackV2', xml_body)

            try:
                response = requests.get(
                    self.base_url,
                    params={'API': 'TrackV2', 'XML': xml_request},
                    timeout=30
                )
                response.raise_for_status()

                root = ET.fromstring(response.text)

                for track_elem in root.findall('.//TrackInfo'):
                    result = {'TrackingNumber': track_elem.get('ID', '')}
                    summary = track_elem.find('TrackSummary')
                    if summary is not None:
                        result['Summary'] = summary.text or ''

                    details = track_elem.findall('TrackDetail')
                    result['DetailCount'] = len(details)
                    if details:
                        result['LatestDetail'] = details[0].text or ''

                    error = track_elem.find('.//Error')
                    if error is not None:
                        result['error'] = error.find('Description').text

                    results.append(result)

                time.sleep(self.delay)

            except Exception as e:
                logger.error(f"Package tracking failed: {e}")

        logger.info(f"Tracked {len(results)} packages")
        return results

    def fetch_census_zip_geography(self, zip_codes: list[str]) -> list[dict[str, Any]]:
        """Fetch ZIP code geographic data from Census TIGER/Line.

        Args:
            zip_codes: List of 5-digit ZIP codes

        Returns:
            List of ZIP code geography records
        """
        results = []
        url = f"{self.tiger_url}/TIGERweb/ZCTA2020/MapServer/0/query"

        for zipcode in zip_codes:
            params = {
                'where': f"ZCTA5CE20='{zipcode}'",
                'outFields': '*',
                'f': 'json',
                'returnGeometry': 'false'
            }

            try:
                response = requests.get(url, params=params, timeout=30)
                response.raise_for_status()

                data = response.json()
                features = data.get('features', [])

                for feature in features:
                    attrs = feature.get('attributes', {})
                    attrs['zip_code'] = zipcode
                    results.append(attrs)

                if not features:
                    results.append({'zip_code': zipcode, 'error': 'ZIP not found'})

                time.sleep(self.delay)

            except Exception as e:
                logger.error(f"Census ZIP lookup failed for {zipcode}: {e}")
                results.append({'zip_code': zipcode, 'error': str(e)})

        logger.info(f"Retrieved geography for {len(results)} ZIP codes")
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

    def test_api_connection(self) -> bool:
        """Test USPS Web Tools API connection.

        Returns:
            True if connection successful
        """
        try:
            test_result = self.city_state_lookup(['20001'])
            if test_result and 'error' not in test_result[0]:
                logger.info("USPS Web Tools API connection test successful")
                return True
            if test_result:
                logger.warning(f"API returned error: {test_result[0].get('error', 'Unknown')}")
                return False
            logger.error("API returned empty response")
            return False
        except Exception as e:
            logger.error(f"USPS API connection test failed: {e}")
            return False


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch USPS operational data from Web Tools API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Validate addresses
  python fetch_usps_data.py --api-key YOUR_ID --operation validate \\
      --addresses '[{"address2":"1600 Pennsylvania Ave","city":"Washington","state":"DC","zip5":"20500"}]'

  # Look up cities for ZIP codes
  python fetch_usps_data.py --api-key YOUR_ID --operation city-lookup --zip-codes "10001,60607,90210"

  # Track packages
  python fetch_usps_data.py --api-key YOUR_ID --operation track --tracking-ids "EJ958083578US,EJ958083579US"

  # Fetch ZIP code geography from Census
  python fetch_usps_data.py --api-key YOUR_ID --operation zip-geography --zip-codes "10001,20001"

  # Test API connection
  python fetch_usps_data.py --api-key YOUR_ID --test-connection
        """
    )

    parser.add_argument(
        '--api-key',
        type=str,
        required=True,
        help='USPS Web Tools User ID (required)'
    )

    parser.add_argument(
        '--operation',
        choices=['validate', 'city-lookup', 'track', 'zip-geography'],
        default='city-lookup',
        help='Operation to perform'
    )

    parser.add_argument(
        '--zip-codes',
        type=str,
        help='Comma-separated ZIP codes'
    )

    parser.add_argument(
        '--tracking-ids',
        type=str,
        help='Comma-separated USPS tracking numbers'
    )

    parser.add_argument(
        '--addresses',
        type=str,
        help='JSON array of address objects'
    )

    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('./usps_data'),
        help='Output directory (default: ./usps_data)'
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
        '--test-connection',
        action='store_true',
        help='Test API connection and exit'
    )

    parser.add_argument(
        '--list-operations',
        action='store_true',
        help='List available API operations and exit'
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

    fetcher = USPSDataFetcher(
        api_key=args.api_key,
        delay=args.delay
    )

    try:
        if args.test_connection:
            success = fetcher.test_api_connection()
            sys.exit(0 if success else 1)

        if args.list_operations:
            print("Available USPS Web Tools operations:")
            for name, info in fetcher.api_operations.items():
                print(f"  - {name}: {info['description']}")
            print("\nAdditional:")
            print("  - zip-geography: Census TIGER/Line ZIP code geography")
            sys.exit(0)

        args.output_dir.mkdir(parents=True, exist_ok=True)

        if args.operation == 'city-lookup':
            if not args.zip_codes:
                logger.error("--zip-codes required for city-lookup operation")
                sys.exit(1)

            zip_codes = [z.strip() for z in args.zip_codes.split(',')]
            data = fetcher.city_state_lookup(zip_codes)
            output_file = args.output_dir / f"usps_city_lookup.{args.format}"
            fetcher.save_data(data, output_file, args.format)

        elif args.operation == 'validate':
            if not args.addresses:
                logger.error("--addresses required for validate operation")
                sys.exit(1)

            addresses = json.loads(args.addresses)
            data = fetcher.validate_address(addresses)
            output_file = args.output_dir / f"usps_validated_addresses.{args.format}"
            fetcher.save_data(data, output_file, args.format)

        elif args.operation == 'track':
            if not args.tracking_ids:
                logger.error("--tracking-ids required for track operation")
                sys.exit(1)

            tracking_ids = [t.strip() for t in args.tracking_ids.split(',')]
            data = fetcher.track_packages(tracking_ids)
            output_file = args.output_dir / f"usps_tracking.{args.format}"
            fetcher.save_data(data, output_file, args.format)

        elif args.operation == 'zip-geography':
            if not args.zip_codes:
                logger.error("--zip-codes required for zip-geography operation")
                sys.exit(1)

            zip_codes = [z.strip() for z in args.zip_codes.split(',')]
            data = fetcher.fetch_census_zip_geography(zip_codes)
            output_file = args.output_dir / f"usps_zip_geography.{args.format}"
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
