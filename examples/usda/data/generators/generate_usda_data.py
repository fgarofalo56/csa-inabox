#!/usr/bin/env python3
"""
USDA Agricultural Data Generator

This script generates realistic synthetic agricultural data for the USDA analytics platform.
It can also fetch real data from USDA APIs when available and properly configured.

Features:
- Generates crop yield data for major commodities
- Creates SNAP enrollment data with realistic trends
- Generates FSIS food safety inspection records
- Supports multiple output formats (CSV, JSON, Parquet)
- Configurable parameters for states, years, and commodities
- Fallback synthetic generation when APIs are unavailable

Usage:
    python generate_usda_data.py --output-dir ./output --states "IA,IL,IN" --years "2020,2021,2022"
    python generate_usda_data.py --use-real-data --nass-api-key YOUR_KEY
    python generate_usda_data.py --help
"""

import argparse
import csv
import json
import logging
import random
import sys
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Dict, List, Optional
import os
import requests
import pandas as pd
import numpy as np


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class USDADataGenerator:
    """Generate realistic USDA agricultural data for analytics platform."""

    def __init__(
        self,
        nass_api_key: Optional[str] = None,
        datagov_api_key: Optional[str] = None,
        use_real_data: bool = False
    ):
        """Initialize the data generator.

        Args:
            nass_api_key: USDA NASS QuickStats API key
            datagov_api_key: Data.gov API key (optional)
            use_real_data: Whether to attempt fetching real data from APIs
        """
        self.nass_api_key = nass_api_key or os.getenv('NASS_API_KEY')
        self.datagov_api_key = datagov_api_key or os.getenv('DATAGOV_API_KEY')
        self.use_real_data = use_real_data and self.nass_api_key is not None

        # Configuration
        self.states = {
            'IA': 'IOWA', 'IL': 'ILLINOIS', 'IN': 'INDIANA', 'OH': 'OHIO',
            'MN': 'MINNESOTA', 'NE': 'NEBRASKA', 'KS': 'KANSAS',
            'ND': 'NORTH DAKOTA', 'SD': 'SOUTH DAKOTA', 'TX': 'TEXAS',
            'WI': 'WISCONSIN', 'MI': 'MICHIGAN', 'MO': 'MISSOURI'
        }

        self.commodities = {
            'CORN': {'min_yield': 120, 'max_yield': 220, 'unit': 'BU'},
            'SOYBEANS': {'min_yield': 35, 'max_yield': 70, 'unit': 'BU'},
            'WHEAT': {'min_yield': 30, 'max_yield': 60, 'unit': 'BU'},
            'COTTON': {'min_yield': 600, 'max_yield': 1200, 'unit': 'LB'},
            'RICE': {'min_yield': 6000, 'max_yield': 8500, 'unit': 'LB'}
        }

        # Establishment types for food inspections
        self.establishment_types = [
            'SLAUGHTER', 'PROCESSING', 'WHOLESALE', 'RETAIL'
        ]

        self.species_types = [
            'CATTLE', 'SWINE', 'POULTRY', 'SHEEP', 'GOAT', 'MULTI_SPECIES'
        ]

        self.violation_types = [
            'NO_VIOLATION', 'SANITATION', 'TEMPERATURE_CONTROL',
            'HACCP_DEVIATION', 'LABELING', 'PATHOGEN_CONTROL',
            'ANIMAL_WELFARE', 'RECORD_KEEPING', 'WORKER_SAFETY'
        ]

    def fetch_nass_data(
        self,
        states: List[str],
        commodities: List[str],
        years: List[int]
    ) -> Optional[pd.DataFrame]:
        """Fetch real crop yield data from NASS QuickStats API.

        Args:
            states: List of state codes
            commodities: List of commodity names
            years: List of years to fetch

        Returns:
            DataFrame with NASS data or None if fetch fails
        """
        if not self.nass_api_key:
            logger.warning("No NASS API key provided, using synthetic data")
            return None

        logger.info("Fetching real data from NASS QuickStats API...")

        base_url = "https://quickstats.nass.usda.gov/api/api_GET/"

        all_data = []

        for state in states:
            for commodity in commodities:
                for year in years:
                    params = {
                        'key': self.nass_api_key,
                        'source_desc': 'SURVEY',
                        'sector_desc': 'CROPS',
                        'group_desc': 'FIELD CROPS',
                        'commodity_desc': commodity,
                        'statisticcat_desc': 'YIELD',
                        'unit_desc': self.commodities.get(commodity, {}).get('unit', 'BU'),
                        'state_alpha': state,
                        'year': year,
                        'format': 'JSON'
                    }

                    try:
                        response = requests.get(base_url, params=params, timeout=30)
                        response.raise_for_status()

                        data = response.json()
                        if 'data' in data and data['data']:
                            all_data.extend(data['data'])
                            logger.info(f"Fetched {len(data['data'])} records for {state} {commodity} {year}")
                        else:
                            logger.warning(f"No data found for {state} {commodity} {year}")

                    except requests.exceptions.RequestException as e:
                        logger.error(f"Failed to fetch data for {state} {commodity} {year}: {e}")
                        continue
                    except Exception as e:
                        logger.error(f"Error processing response for {state} {commodity} {year}: {e}")
                        continue

        if all_data:
            df = pd.DataFrame(all_data)
            logger.info(f"Successfully fetched {len(df)} total records from NASS")
            return df
        else:
            logger.warning("No real data fetched, falling back to synthetic generation")
            return None

    def generate_crop_yields(
        self,
        states: List[str] = None,
        commodities: List[str] = None,
        years: List[int] = None,
        counties_per_state: int = 3
    ) -> List[Dict]:
        """Generate crop yield data.

        Args:
            states: List of state codes to generate
            commodities: List of commodities to generate
            years: List of years to generate
            counties_per_state: Number of counties per state

        Returns:
            List of crop yield records
        """
        states = states or ['IA', 'IL', 'IN', 'OH', 'MN']
        commodities = commodities or ['CORN', 'SOYBEANS']
        years = years or list(range(2020, 2025))

        # Try to fetch real data first
        if self.use_real_data:
            real_data = self.fetch_nass_data(states, commodities, years)
            if real_data is not None:
                return self._convert_nass_to_standard_format(real_data)

        logger.info("Generating synthetic crop yield data...")

        records = []
        county_counter = 1

        for state in states:
            state_name = self.states.get(state, state)

            for county_idx in range(counties_per_state):
                county_code = f"{county_counter:03d}"
                county_name = f"COUNTY_{county_counter:03d}"
                county_counter += 1

                for commodity in commodities:
                    commodity_config = self.commodities[commodity]

                    # Generate base yield with state/commodity variation
                    base_yield = random.uniform(
                        commodity_config['min_yield'],
                        commodity_config['max_yield']
                    )

                    # Add state-specific adjustments
                    if state in ['IA', 'IL', 'NE']:  # High-yield states
                        base_yield *= random.uniform(1.1, 1.3)
                    elif state in ['KS', 'TX']:  # More variable states
                        base_yield *= random.uniform(0.8, 1.2)

                    for year in years:
                        # Add year-to-year variation (weather, technology trends)
                        year_factor = 1.0 + (year - 2020) * 0.01  # Slight upward trend
                        weather_factor = random.uniform(0.85, 1.15)  # Weather variation

                        yield_per_acre = base_yield * year_factor * weather_factor

                        # Calculate correlated metrics
                        planted_acres = random.randint(5000, 15000)
                        harvest_efficiency = random.uniform(0.90, 0.98)
                        harvested_acres = int(planted_acres * harvest_efficiency)
                        production_amount = int(yield_per_acre * harvested_acres)

                        record = {
                            'state_code': state,
                            'state_name': state_name,
                            'county_code': county_code,
                            'county_name': county_name,
                            'commodity': commodity,
                            'year': year,
                            'yield_per_acre': round(yield_per_acre, 1),
                            'production_amount': production_amount,
                            'planted_acres': planted_acres,
                            'harvested_acres': harvested_acres
                        }
                        records.append(record)

        logger.info(f"Generated {len(records)} crop yield records")
        return records

    def _convert_nass_to_standard_format(self, nass_df: pd.DataFrame) -> List[Dict]:
        """Convert NASS API response to standard format."""
        records = []

        for _, row in nass_df.iterrows():
            try:
                # Extract and clean data
                value_str = str(row.get('Value', '')).replace(',', '').strip()
                if value_str and value_str not in ['(D)', '(Z)', '(L)', '(H)', '(X)', '(S)']:
                    yield_per_acre = float(value_str)
                else:
                    continue  # Skip suppressed or missing values

                record = {
                    'state_code': row.get('state_alpha', ''),
                    'state_name': row.get('state_name', ''),
                    'county_code': row.get('county_code', '999'),
                    'county_name': row.get('county_name', 'STATE LEVEL'),
                    'commodity': row.get('commodity_desc', ''),
                    'year': int(row.get('year', 0)),
                    'yield_per_acre': round(yield_per_acre, 1),
                    'production_amount': None,  # Not always available in yield queries
                    'planted_acres': None,
                    'harvested_acres': None
                }
                records.append(record)

            except (ValueError, TypeError) as e:
                logger.warning(f"Skipping invalid NASS record: {e}")
                continue

        logger.info(f"Converted {len(records)} NASS records to standard format")
        return records

    def generate_snap_enrollment(
        self,
        states: List[str] = None,
        start_year: int = 2022,
        months: int = 24
    ) -> List[Dict]:
        """Generate SNAP enrollment data.

        Args:
            states: List of state codes
            start_year: Starting fiscal year
            months: Number of months to generate

        Returns:
            List of SNAP enrollment records
        """
        states = states or ['AL', 'CA', 'TX', 'NY', 'FL', 'PA', 'OH', 'IL', 'MI', 'GA']

        logger.info("Generating SNAP enrollment data...")

        # Base enrollment by state (approximate real values)
        base_enrollment = {
            'AL': 850000, 'CA': 4200000, 'TX': 3900000, 'NY': 2800000,
            'FL': 3200000, 'PA': 1800000, 'OH': 1500000, 'IL': 1700000,
            'MI': 1300000, 'GA': 1600000
        }

        records = []

        for state in states:
            state_name = self.states.get(state, state)
            base_persons = base_enrollment.get(state, 500000)

            # Generate monthly trend
            current_persons = base_persons

            for month_offset in range(months):
                # Calculate fiscal year and month
                start_date = datetime(start_year, 10, 1)  # FY starts in October
                current_date = start_date + timedelta(days=30 * month_offset)

                fiscal_year = current_date.year if current_date.month >= 10 else current_date.year - 1
                if current_date.month >= 10:
                    fiscal_year = current_date.year + 1
                else:
                    fiscal_year = current_date.year

                month_number = current_date.month
                month_names = [
                    '', 'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
                    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'
                ]
                month_name = month_names[month_number]

                # Add realistic trends and seasonality
                seasonal_factor = 1.0 + 0.05 * np.sin(2 * np.pi * month_offset / 12)  # Winter peaks
                trend_factor = 1.0 + random.uniform(-0.02, 0.03)  # Monthly variation

                current_persons = int(current_persons * trend_factor * seasonal_factor)

                # Calculate correlated metrics
                avg_household_size = random.uniform(2.0, 2.8)
                households = int(current_persons / avg_household_size)

                # Benefits per person varies by state cost of living
                base_benefit = random.uniform(180, 250)
                benefits_dollars = current_persons * base_benefit

                record = {
                    'state_code': state,
                    'state_name': state_name,
                    'fiscal_year': fiscal_year,
                    'month_number': month_number,
                    'month_name': month_name,
                    'persons': current_persons,
                    'households': households,
                    'benefits_dollars': round(benefits_dollars, 2),
                    'program': 'SNAP',
                    'county_fips': None  # State-level data
                }
                records.append(record)

        logger.info(f"Generated {len(records)} SNAP enrollment records")
        return records

    def generate_food_inspections(
        self,
        states: List[str] = None,
        establishments_per_state: int = 15,
        inspections_per_establishment: int = 6
    ) -> List[Dict]:
        """Generate food safety inspection data.

        Args:
            states: List of state codes
            establishments_per_state: Number of establishments per state
            inspections_per_establishment: Average inspections per establishment

        Returns:
            List of food inspection records
        """
        states = states or ['IA', 'IL', 'IN', 'OH', 'MN', 'NE', 'KS', 'ND', 'SD', 'TX']

        logger.info("Generating food safety inspection data...")

        records = []
        establishment_counter = 1

        for state in states:
            for est_idx in range(establishments_per_state):
                establishment_number = f"EST-{establishment_counter:03d}"

                # Generate establishment characteristics
                est_type = random.choice(self.establishment_types)
                species = random.choice(self.species_types)

                # Size affects employee count and inspection frequency
                size_categories = ['VERY_SMALL', 'SMALL', 'MEDIUM', 'LARGE', 'VERY_LARGE']
                size_weights = [0.3, 0.3, 0.25, 0.1, 0.05]  # Most establishments are smaller
                size_category = np.random.choice(size_categories, p=size_weights)

                employee_ranges = {
                    'VERY_SMALL': (1, 15),
                    'SMALL': (16, 50),
                    'MEDIUM': (51, 150),
                    'LARGE': (151, 500),
                    'VERY_LARGE': (501, 2000)
                }
                employee_count = random.randint(*employee_ranges[size_category])

                company_name = f"COMPANY_{establishment_counter:03d} INC"
                establishment_name = f"ESTABLISHMENT_{establishment_counter:03d}"
                city = f"CITY_{establishment_counter:03d}"

                # Generate inspection history
                start_date = date(2023, 1, 1)

                for inspection_idx in range(inspections_per_establishment):
                    # Schedule inspections with some randomness
                    days_offset = inspection_idx * 60 + random.randint(-15, 15)
                    inspection_date = start_date + timedelta(days=days_offset)

                    if inspection_date > date.today():
                        break

                    # Determine inspection type and results
                    inspection_types = ['ROUTINE', 'FOLLOW_UP', 'COMPLAINT', 'VERIFICATION']
                    type_weights = [0.7, 0.15, 0.1, 0.05]
                    inspection_type = np.random.choice(inspection_types, p=type_weights)

                    # Compliance varies by establishment quality
                    establishment_quality = random.uniform(0.7, 0.98)  # Most establishments are decent
                    is_compliant = random.random() < establishment_quality

                    inspection_result = 'COMPLIANT' if is_compliant else 'NON_COMPLIANT'

                    # Generate violations
                    if is_compliant:
                        violation_type = 'NO_VIOLATION'
                        violation_severity = 'NONE'
                        corrective_action = 'N/A'
                    else:
                        violation_type = random.choice(self.violation_types[1:])  # Exclude NO_VIOLATION

                        # Severity distribution (most violations are minor)
                        severity_options = ['MINOR', 'MODERATE', 'CRITICAL']
                        severity_weights = [0.6, 0.3, 0.1]
                        violation_severity = np.random.choice(severity_options, p=severity_weights)

                        corrective_action = f"{violation_type.replace('_', ' ')} CORRECTED"

                    record = {
                        'establishment_number': establishment_number,
                        'establishment_name': establishment_name,
                        'company_name': company_name,
                        'state_code': state,
                        'city': city,
                        'inspection_date': inspection_date.strftime('%Y-%m-%d'),
                        'inspection_type': inspection_type,
                        'inspection_result': inspection_result,
                        'violation_type': violation_type,
                        'violation_severity': violation_severity,
                        'corrective_action': corrective_action,
                        'establishment_type': est_type,
                        'species': species,
                        'employee_count': employee_count
                    }
                    records.append(record)

                establishment_counter += 1

        logger.info(f"Generated {len(records)} food inspection records")
        return records

    def save_data(
        self,
        data: List[Dict],
        output_path: Path,
        format_type: str = 'csv'
    ) -> None:
        """Save generated data to file.

        Args:
            data: Data records to save
            output_path: Output file path
            format_type: Output format ('csv', 'json', 'parquet')
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)

        if format_type.lower() == 'csv':
            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                if data:
                    writer = csv.DictWriter(f, fieldnames=data[0].keys())
                    writer.writeheader()
                    writer.writerows(data)

        elif format_type.lower() == 'json':
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, default=str)

        elif format_type.lower() == 'parquet':
            df = pd.DataFrame(data)
            df.to_parquet(output_path, index=False)

        else:
            raise ValueError(f"Unsupported format: {format_type}")

        logger.info(f"Saved {len(data)} records to {output_path}")


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Generate USDA agricultural data for analytics platform",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate default synthetic data
  python generate_usda_data.py --output-dir ./seeds

  # Generate for specific states and years
  python generate_usda_data.py --states "IA,IL,IN" --years "2020,2021,2022"

  # Use real NASS data with API key
  python generate_usda_data.py --use-real-data --nass-api-key YOUR_API_KEY

  # Generate larger dataset
  python generate_usda_data.py --counties-per-state 5 --establishments-per-state 25
        """
    )

    # Output configuration
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('./seeds'),
        help='Output directory for generated files (default: ./seeds)'
    )

    parser.add_argument(
        '--format',
        choices=['csv', 'json', 'parquet'],
        default='csv',
        help='Output format (default: csv)'
    )

    # Data selection
    parser.add_argument(
        '--states',
        type=str,
        help='Comma-separated state codes (e.g., "IA,IL,IN")'
    )

    parser.add_argument(
        '--commodities',
        type=str,
        help='Comma-separated commodities (e.g., "CORN,SOYBEANS")'
    )

    parser.add_argument(
        '--years',
        type=str,
        help='Comma-separated years (e.g., "2020,2021,2022")'
    )

    # Generation parameters
    parser.add_argument(
        '--counties-per-state',
        type=int,
        default=3,
        help='Number of counties per state for crop data (default: 3)'
    )

    parser.add_argument(
        '--establishments-per-state',
        type=int,
        default=15,
        help='Number of food establishments per state (default: 15)'
    )

    parser.add_argument(
        '--snap-months',
        type=int,
        default=24,
        help='Number of months of SNAP data (default: 24)'
    )

    # API configuration
    parser.add_argument(
        '--use-real-data',
        action='store_true',
        help='Attempt to fetch real data from APIs'
    )

    parser.add_argument(
        '--nass-api-key',
        type=str,
        help='USDA NASS QuickStats API key'
    )

    parser.add_argument(
        '--datagov-api-key',
        type=str,
        help='Data.gov API key (optional)'
    )

    # Control what to generate
    parser.add_argument(
        '--skip-crop-yields',
        action='store_true',
        help='Skip generating crop yield data'
    )

    parser.add_argument(
        '--skip-snap',
        action='store_true',
        help='Skip generating SNAP enrollment data'
    )

    parser.add_argument(
        '--skip-inspections',
        action='store_true',
        help='Skip generating food inspection data'
    )

    # Utility options
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )

    return parser.parse_args()


def main():
    """Main function."""
    args = parse_arguments()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Parse comma-separated lists
    states = args.states.split(',') if args.states else None
    commodities = args.commodities.split(',') if args.commodities else None
    years = [int(y) for y in args.years.split(',')] if args.years else None

    # Initialize generator
    generator = USDADataGenerator(
        nass_api_key=args.nass_api_key,
        datagov_api_key=args.datagov_api_key,
        use_real_data=args.use_real_data
    )

    # Generate and save data
    try:
        if not args.skip_crop_yields:
            logger.info("Generating crop yields data...")
            crop_data = generator.generate_crop_yields(
                states=states,
                commodities=commodities,
                years=years,
                counties_per_state=args.counties_per_state
            )

            output_path = args.output_dir / f"crop_yields.{args.format}"
            generator.save_data(crop_data, output_path, args.format)

        if not args.skip_snap:
            logger.info("Generating SNAP enrollment data...")
            snap_data = generator.generate_snap_enrollment(
                states=states,
                months=args.snap_months
            )

            output_path = args.output_dir / f"snap_enrollment.{args.format}"
            generator.save_data(snap_data, output_path, args.format)

        if not args.skip_inspections:
            logger.info("Generating food inspection data...")
            inspection_data = generator.generate_food_inspections(
                states=states,
                establishments_per_state=args.establishments_per_state
            )

            output_path = args.output_dir / f"food_inspections.{args.format}"
            generator.save_data(inspection_data, output_path, args.format)

        logger.info("Data generation completed successfully!")

    except Exception as e:
        logger.error(f"Data generation failed: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
