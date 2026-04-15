#!/usr/bin/env python3
"""
Census Bureau & BEA Data Fetcher

Fetches economic data from:
  - Census Bureau American Community Survey (ACS) 5-Year Estimates
  - Bureau of Economic Analysis (BEA) Regional GDP & Trade Data

Outputs CSV files aligned with commerce bronze dbt models:
  - census_demographics.csv (brz_census_demographics)
  - gdp_data.csv           (brz_gdp_data)
  - trade_data.csv          (brz_trade_data)

Usage:
    python fetch_census_bea.py --census-key YOUR_KEY --bea-key YOUR_KEY --years "2020,2021,2022"
    python fetch_census_bea.py --dataset census --states "06,36,48" --output-dir ./data
    python fetch_census_bea.py --dataset bea-gdp --years "2020,2021"
    python fetch_census_bea.py --dataset trade --years "2023" --months "01,02,03"
    python fetch_census_bea.py --help
"""

import argparse
import csv
import json
import logging
import os
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# State FIPS lookup
# ---------------------------------------------------------------------------
STATE_FIPS = {
    "01": "Alabama", "02": "Alaska", "04": "Arizona", "05": "Arkansas",
    "06": "California", "08": "Colorado", "09": "Connecticut",
    "10": "Delaware", "11": "District of Columbia", "12": "Florida",
    "13": "Georgia", "15": "Hawaii", "16": "Idaho", "17": "Illinois",
    "18": "Indiana", "19": "Iowa", "20": "Kansas", "21": "Kentucky",
    "22": "Louisiana", "23": "Maine", "24": "Maryland",
    "25": "Massachusetts", "26": "Michigan", "27": "Minnesota",
    "28": "Mississippi", "29": "Missouri", "30": "Montana",
    "31": "Nebraska", "32": "Nevada", "33": "New Hampshire",
    "34": "New Jersey", "35": "New Mexico", "36": "New York",
    "37": "North Carolina", "38": "North Dakota", "39": "Ohio",
    "40": "Oklahoma", "41": "Oregon", "42": "Pennsylvania",
    "44": "Rhode Island", "45": "South Carolina", "46": "South Dakota",
    "47": "Tennessee", "48": "Texas", "49": "Utah", "50": "Vermont",
    "51": "Virginia", "53": "Washington", "54": "West Virginia",
    "55": "Wisconsin", "56": "Wyoming",
}


# ---------------------------------------------------------------------------
# Census ACS Variables
# ---------------------------------------------------------------------------
ACS_VARIABLES = {
    "B01001_001E": {"name": "total_population", "concept": "Sex By Age"},
    "B01002_001E": {"name": "median_age", "concept": "Median Age By Sex"},
    "B19013_001E": {"name": "median_household_income", "concept": "Median Household Income"},
    "B19301_001E": {"name": "per_capita_income", "concept": "Per Capita Income"},
    "B17001_001E": {"name": "total_poverty_status", "concept": "Poverty Status"},
    "B17001_002E": {"name": "below_poverty_level", "concept": "Poverty Status"},
    "B23025_002E": {"name": "labor_force", "concept": "Employment Status"},
    "B23025_005E": {"name": "unemployed", "concept": "Employment Status"},
    "B15003_022E": {"name": "bachelors_degree", "concept": "Educational Attainment"},
    "B15003_023E": {"name": "masters_degree", "concept": "Educational Attainment"},
    "B25077_001E": {"name": "median_home_value", "concept": "Median Value"},
    "B25064_001E": {"name": "median_gross_rent", "concept": "Median Gross Rent"},
}


# ---------------------------------------------------------------------------
# CensusBEADataFetcher
# ---------------------------------------------------------------------------
class CensusBEADataFetcher:
    """Fetch and transform data from Census Bureau ACS and BEA APIs."""

    CENSUS_BASE_URL = "https://api.census.gov/data"
    BEA_BASE_URL = "https://apps.bea.gov/api/data"
    TRADE_BASE_URL = "https://api.census.gov/data/timeseries/intltrade"

    def __init__(
        self,
        census_api_key: str = "",
        bea_api_key: str = "",
        delay: float = 0.25,
    ):
        """Initialize data fetcher.

        Args:
            census_api_key: Census Bureau API key.
            bea_api_key: BEA API key.
            delay: Seconds between API requests (rate limiting).
        """
        self.census_api_key = census_api_key
        self.bea_api_key = bea_api_key
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "csa-inabox/1.0 Commerce Fetcher"})

    # ----- helpers ----
    def _get(self, url: str, params: dict[str, Any], label: str) -> Any:
        """Execute GET with retry logic and rate limiting."""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                logger.debug("GET %s  params=%s", url, params)
                resp = self.session.get(url, params=params, timeout=30)
                resp.raise_for_status()
                time.sleep(self.delay)
                return resp.json()
            except requests.exceptions.HTTPError as exc:
                if resp.status_code == 429:
                    wait = 2 ** (attempt + 1)
                    logger.warning("Rate limited on %s, retrying in %ds", label, wait)
                    time.sleep(wait)
                elif resp.status_code >= 500:
                    wait = 2 ** (attempt + 1)
                    logger.warning("Server error %d on %s, retrying in %ds", resp.status_code, label, wait)
                    time.sleep(wait)
                else:
                    logger.error("HTTP %d on %s: %s", resp.status_code, label, exc)
                    return None
            except requests.exceptions.RequestException as exc:
                logger.error("Request failed for %s: %s", label, exc)
                if attempt < max_retries - 1:
                    time.sleep(2 ** (attempt + 1))
                else:
                    return None
        return None

    # ===================================================================
    # Census ACS
    # ===================================================================
    def fetch_census_demographics(
        self,
        states: list[str],
        years: list[int],
        dataset: str = "acs/acs5",
    ) -> list[dict[str, Any]]:
        """Fetch ACS 5-Year demographic estimates.

        Args:
            states: FIPS state codes (e.g. ["06","36"]).
            years: Calendar years.
            dataset: ACS dataset path.

        Returns:
            List of dicts matching brz_census_demographics columns.
        """
        var_codes = list(ACS_VARIABLES.keys())
        var_string = ",".join(var_codes)
        records: list[dict[str, Any]] = []

        for year in years:
            for state_fips in states:
                state_name = STATE_FIPS.get(state_fips, state_fips)
                url = f"{self.CENSUS_BASE_URL}/{year}/{dataset}"
                params = {
                    "get": f"NAME,{var_string}",
                    "for": "county:*",
                    "in": f"state:{state_fips}",
                    "key": self.census_api_key,
                }

                label = f"Census ACS {year} state={state_fips}"
                data = self._get(url, params, label)

                if data is None or len(data) < 2:
                    logger.warning("No data for %s", label)
                    continue

                headers = data[0]
                for row in data[1:]:
                    row_dict = dict(zip(headers, row))
                    county_fips = row_dict.get("county", "")
                    county_name = row_dict.get("NAME", "")
                    geo_id = f"{state_fips}{county_fips}"

                    for var_code in var_codes:
                        var_info = ACS_VARIABLES[var_code]
                        raw_val = row_dict.get(var_code)
                        try:
                            estimate = float(raw_val) if raw_val and raw_val not in ("-", "N") else None
                        except (ValueError, TypeError):
                            estimate = None

                        records.append({
                            "geo_id": geo_id,
                            "state_name": state_name,
                            "county_name": county_name,
                            "year": year,
                            "dataset": dataset.replace("/", "_"),
                            "variable_code": var_code,
                            "variable_name": var_info["name"],
                            "variable_concept": var_info["concept"],
                            "estimate": estimate,
                            "margin_of_error": None,
                            "load_time": datetime.utcnow().isoformat(),
                        })

                logger.info("Census ACS: %s → %d variable-rows", label, len(records))

        logger.info("Census ACS total: %d records across %d states × %d years", len(records), len(states), len(years))
        return records

    # ===================================================================
    # BEA Regional GDP
    # ===================================================================
    def fetch_gdp_data(
        self,
        years: list[int],
        table_name: str = "SQGDP2",
        line_codes: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch BEA Regional GDP data.

        Args:
            years: Calendar years.
            table_name: BEA table (SQGDP2=GDP by industry).
            line_codes: Line code filters (default: all industries).

        Returns:
            List of dicts matching brz_gdp_data columns.
        """
        records: list[dict[str, Any]] = []
        if line_codes is None:
            line_codes = ["1", "2", "3", "6", "10", "34", "50", "59", "68", "75", "82"]

        year_str = ",".join(str(y) for y in years)

        for line_code in line_codes:
            params = {
                "UserID": self.bea_api_key,
                "method": "GetData",
                "datasetname": "Regional",
                "TableName": table_name,
                "LineCode": line_code,
                "GeoFips": "STATE",
                "Year": year_str,
                "ResultFormat": "JSON",
            }

            label = f"BEA GDP table={table_name} line={line_code}"
            raw = self._get(self.BEA_BASE_URL, params, label)

            if raw is None:
                continue

            try:
                result_data = raw.get("BEAAPI", {}).get("Results", {}).get("Data", [])
            except (AttributeError, KeyError):
                logger.warning("Unexpected BEA response for %s", label)
                continue

            for item in result_data:
                state_fips = item.get("GeoFips", "")[:2]
                state_name = STATE_FIPS.get(state_fips, item.get("GeoName", ""))
                raw_value = item.get("DataValue", "")
                try:
                    gdp_val = float(raw_value.replace(",", "")) if raw_value and raw_value != "(NA)" else None
                except (ValueError, TypeError):
                    gdp_val = None

                record_year = int(item.get("TimePeriod", "0")[:4])
                quarter_str = item.get("TimePeriod", "")
                quarter = int(quarter_str[-1]) if len(quarter_str) > 4 and quarter_str[-1].isdigit() else None

                records.append({
                    "state_fips": state_fips,
                    "state_name": state_name,
                    "region_code": "",
                    "region_name": "",
                    "year": record_year,
                    "quarter": quarter,
                    "naics_sector": item.get("IndustryClassification", ""),
                    "industry_name": item.get("Description", ""),
                    "industry_description": item.get("Description", ""),
                    "gdp_current_dollars": gdp_val,
                    "gdp_chained_dollars": None,
                    "personal_income": None,
                    "compensation": None,
                    "taxes_on_production": None,
                    "subsidies": None,
                    "gross_operating_surplus": None,
                    "price_index": None,
                    "quantity_index": None,
                    "table_name": table_name,
                    "line_code": line_code,
                    "unit_of_measure": item.get("UNIT_MULT_Description", "Millions of dollars"),
                    "scale_factor": item.get("UNIT_MULT", "6"),
                    "is_seasonally_adjusted": "N",
                    "estimate_type": "final",
                    "load_time": datetime.utcnow().isoformat(),
                })

            logger.info("BEA GDP line=%s: %d records", line_code, len(result_data))

        logger.info("BEA GDP total: %d records", len(records))
        return records

    # ===================================================================
    # Census International Trade
    # ===================================================================
    def fetch_trade_data(
        self,
        years: list[int],
        months: list[str] | None = None,
        flow_type: str = "imports",
    ) -> list[dict[str, Any]]:
        """Fetch international trade data from Census Bureau.

        Args:
            years: Calendar years.
            months: Months to fetch (e.g. ["01","02"]).
            flow_type: 'imports' or 'exports'.

        Returns:
            List of dicts matching brz_trade_data columns.
        """
        records: list[dict[str, Any]] = []
        endpoint = "imports/hs" if flow_type == "imports" else "exports/hs"
        url = f"{self.TRADE_BASE_URL}/{endpoint}"

        if months is None:
            months = [f"{m:02d}" for m in range(1, 13)]

        for year in years:
            for month in months:
                params = {
                    "get": "CTY_CODE,CTY_NAME,I_COMMODITY,I_COMMODITY_SDESC,GEN_VAL_MO,CON_QY1_MO,UNIT_QY1,DIST,DIST_NAME",
                    "time": f"{year}-{month}",
                    "key": self.census_api_key,
                    "COMM_LVL": "HS6",
                }
                if flow_type == "exports":
                    params["get"] = "CTY_CODE,CTY_NAME,E_COMMODITY,E_COMMODITY_SDESC,ALL_VAL_MO,QTY_1_MO,UNIT_QY1,DIST,DIST_NAME"

                label = f"Trade {flow_type} {year}-{month}"
                data = self._get(url, params, label)

                if data is None or len(data) < 2:
                    logger.warning("No data for %s", label)
                    continue

                headers = data[0]
                for row in data[1:]:
                    row_dict = dict(zip(headers, row))
                    val_key = "GEN_VAL_MO" if flow_type == "imports" else "ALL_VAL_MO"
                    qty_key = "CON_QY1_MO" if flow_type == "imports" else "QTY_1_MO"
                    hs_key = "I_COMMODITY" if flow_type == "imports" else "E_COMMODITY"
                    desc_key = "I_COMMODITY_SDESC" if flow_type == "imports" else "E_COMMODITY_SDESC"

                    try:
                        trade_val = float(row_dict.get(val_key, 0))
                    except (ValueError, TypeError):
                        trade_val = 0.0

                    try:
                        quantity = float(row_dict.get(qty_key, 0))
                    except (ValueError, TypeError):
                        quantity = 0.0

                    records.append({
                        "trade_id": str(uuid.uuid4()),
                        "flow_type": flow_type.upper(),
                        "partner_country_code": row_dict.get("CTY_CODE", ""),
                        "partner_country_name": row_dict.get("CTY_NAME", ""),
                        "partner_region": "",
                        "partner_income_group": "",
                        "hs_code": row_dict.get(hs_key, ""),
                        "commodity_description": row_dict.get(desc_key, ""),
                        "commodity_section": row_dict.get(hs_key, "")[:2] if row_dict.get(hs_key) else "",
                        "year": year,
                        "month": int(month),
                        "trade_value_usd": trade_val,
                        "quantity": quantity,
                        "quantity_unit": row_dict.get("UNIT_QY1", ""),
                        "district_code": row_dict.get("DIST", ""),
                        "district_name": row_dict.get("DIST_NAME", ""),
                        "transport_method": "",
                        "customs_value_usd": trade_val,
                        "duty_collected_usd": 0.0,
                        "shipping_weight_kg": 0.0,
                        "load_time": datetime.utcnow().isoformat(),
                    })

                logger.info("Trade %s %d-%s: %d records", flow_type, year, month, len(data) - 1)

        logger.info("Trade total: %d records", len(records))
        return records

    # ===================================================================
    # Output
    # ===================================================================
    def write_csv(
        self,
        records: list[dict[str, Any]],
        output_path: str,
    ) -> str:
        """Write records to CSV file.

        Args:
            records: List of dicts with consistent keys.
            output_path: Path to output CSV.

        Returns:
            Absolute path to written file.
        """
        if not records:
            logger.warning("No records to write for %s", output_path)
            return output_path

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        fieldnames = list(records[0].keys())
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(records)

        logger.info("Wrote %d records to %s", len(records), path)
        return str(path.resolve())

    def write_json(
        self,
        records: list[dict[str, Any]],
        output_path: str,
    ) -> str:
        """Write records to JSON file.

        Args:
            records: List of dicts.
            output_path: Path to output JSON.

        Returns:
            Absolute path to written file.
        """
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=2, default=str)

        logger.info("Wrote %d records to %s", len(records), path)
        return str(path.resolve())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch Census Bureau ACS & BEA economic data for the Commerce vertical.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch Census demographics for CA, NY, TX
  python fetch_census_bea.py --dataset census --census-key $KEY --states "06,36,48" --years "2021,2022"

  # Fetch BEA GDP data
  python fetch_census_bea.py --dataset bea-gdp --bea-key $KEY --years "2020,2021,2022"

  # Fetch international trade imports
  python fetch_census_bea.py --dataset trade --census-key $KEY --years "2023" --flow-type imports

  # Fetch all datasets
  python fetch_census_bea.py --dataset all --census-key $KEY --bea-key $KEY --years "2022"
        """,
    )

    parser.add_argument(
        "--dataset",
        choices=["census", "bea-gdp", "trade", "all"],
        default="all",
        help="Which dataset to fetch (default: all)",
    )
    parser.add_argument(
        "--census-key",
        default=os.environ.get("CENSUS_API_KEY", ""),
        help="Census Bureau API key (or set CENSUS_API_KEY env var)",
    )
    parser.add_argument(
        "--bea-key",
        default=os.environ.get("BEA_API_KEY", ""),
        help="BEA API key (or set BEA_API_KEY env var)",
    )
    parser.add_argument(
        "--states",
        default="06,17,36,48,12",
        help="Comma-separated FIPS state codes (default: CA,IL,NY,TX,FL)",
    )
    parser.add_argument(
        "--years",
        default="2021,2022",
        help="Comma-separated years to fetch",
    )
    parser.add_argument(
        "--months",
        default=None,
        help="Comma-separated months for trade data (default: all 12)",
    )
    parser.add_argument(
        "--flow-type",
        choices=["imports", "exports"],
        default="imports",
        help="Trade flow type (default: imports)",
    )
    parser.add_argument(
        "--output-dir",
        default="./output",
        help="Output directory for CSV/JSON files",
    )
    parser.add_argument(
        "--output-format",
        choices=["csv", "json", "both"],
        default="csv",
        help="Output format (default: csv)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.25,
        help="Seconds between API requests (default: 0.25)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Log level",
    )
    parser.add_argument(
        "--acs-dataset",
        default="acs/acs5",
        help="ACS dataset path (default: acs/acs5 for 5-Year)",
    )
    parser.add_argument(
        "--bea-table",
        default="SQGDP2",
        help="BEA table name (default: SQGDP2 for GDP by industry)",
    )

    return parser.parse_args()


def main() -> int:
    """Entry point."""
    args = parse_args()
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    states = [s.strip() for s in args.states.split(",")]
    years = [int(y.strip()) for y in args.years.split(",")]
    months = [m.strip() for m in args.months.split(",")] if args.months else None

    fetcher = CensusBEADataFetcher(
        census_api_key=args.census_key,
        bea_api_key=args.bea_key,
        delay=args.delay,
    )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, int] = {}

    # ---- Census Demographics ----
    if args.dataset in ("census", "all"):
        if not args.census_key:
            logger.error("Census API key required. Set --census-key or CENSUS_API_KEY env var.")
            return 1

        logger.info("=== Fetching Census ACS Demographics ===")
        census_records = fetcher.fetch_census_demographics(
            states=states,
            years=years,
            dataset=args.acs_dataset,
        )
        if census_records:
            if args.output_format in ("csv", "both"):
                fetcher.write_csv(census_records, str(output_dir / "census_demographics.csv"))
            if args.output_format in ("json", "both"):
                fetcher.write_json(census_records, str(output_dir / "census_demographics.json"))
        results["census"] = len(census_records)

    # ---- BEA GDP ----
    if args.dataset in ("bea-gdp", "all"):
        if not args.bea_key:
            logger.error("BEA API key required. Set --bea-key or BEA_API_KEY env var.")
            return 1

        logger.info("=== Fetching BEA Regional GDP ===")
        gdp_records = fetcher.fetch_gdp_data(
            years=years,
            table_name=args.bea_table,
        )
        if gdp_records:
            if args.output_format in ("csv", "both"):
                fetcher.write_csv(gdp_records, str(output_dir / "gdp_data.csv"))
            if args.output_format in ("json", "both"):
                fetcher.write_json(gdp_records, str(output_dir / "gdp_data.json"))
        results["bea-gdp"] = len(gdp_records)

    # ---- Trade Data ----
    if args.dataset in ("trade", "all"):
        if not args.census_key:
            logger.error("Census API key required for trade data.")
            return 1

        logger.info("=== Fetching International Trade Data ===")
        trade_records = fetcher.fetch_trade_data(
            years=years,
            months=months,
            flow_type=args.flow_type,
        )
        if trade_records:
            if args.output_format in ("csv", "both"):
                fetcher.write_csv(trade_records, str(output_dir / "trade_data.csv"))
            if args.output_format in ("json", "both"):
                fetcher.write_json(trade_records, str(output_dir / "trade_data.json"))
        results["trade"] = len(trade_records)

    # ---- Summary ----
    logger.info("=" * 60)
    logger.info("Fetch Summary:")
    for dataset_name, count in results.items():
        logger.info("  %-12s  %d records", dataset_name, count)
    logger.info("Output directory: %s", output_dir.resolve())
    logger.info("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
