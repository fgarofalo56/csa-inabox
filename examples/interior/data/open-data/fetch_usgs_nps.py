#!/usr/bin/env python3
"""
USGS & NPS Data Fetcher

Fetches environmental and park data from:
  - USGS Water Services (National Water Information System)
  - USGS Earthquake Hazards Program (ComCat)
  - National Park Service Statistics API

Outputs CSV files aligned with interior bronze dbt models:
  - earthquake_events.csv  (brz_earthquake_events)
  - park_visitors.csv      (brz_park_visitors)
  - water_resources.csv    (brz_water_resources)

Usage:
    python fetch_usgs_nps.py --dataset earthquakes --start-date 2024-01-01 --end-date 2024-03-31
    python fetch_usgs_nps.py --dataset water --sites "09380000,09402500" --parameters "00060,00065"
    python fetch_usgs_nps.py --dataset parks --years "2022,2023"
    python fetch_usgs_nps.py --dataset all --output-dir ./data
    python fetch_usgs_nps.py --help
"""

import argparse
import csv
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Park code lookup (representative subset)
# ---------------------------------------------------------------------------
PARK_CODES = {
    "YELL": {"name": "Yellowstone National Park", "type": "National Park", "state": "WY", "region": "Intermountain"},
    "GRCA": {"name": "Grand Canyon National Park", "type": "National Park", "state": "AZ", "region": "Intermountain"},
    "YOSE": {"name": "Yosemite National Park", "type": "National Park", "state": "CA", "region": "Pacific West"},
    "GRTE": {"name": "Grand Teton National Park", "type": "National Park", "state": "WY", "region": "Intermountain"},
    "OLYM": {"name": "Olympic National Park", "type": "National Park", "state": "WA", "region": "Pacific West"},
    "GLAC": {"name": "Glacier National Park", "type": "National Park", "state": "MT", "region": "Intermountain"},
    "ZION": {"name": "Zion National Park", "type": "National Park", "state": "UT", "region": "Intermountain"},
    "ACAD": {"name": "Acadia National Park", "type": "National Park", "state": "ME", "region": "Northeast"},
    "GRSM": {"name": "Great Smoky Mountains NP", "type": "National Park", "state": "TN", "region": "Southeast"},
    "ROMO": {"name": "Rocky Mountain National Park", "type": "National Park", "state": "CO", "region": "Intermountain"},
    "SHEN": {"name": "Shenandoah National Park", "type": "National Park", "state": "VA", "region": "Northeast"},
    "ARCH": {"name": "Arches National Park", "type": "National Park", "state": "UT", "region": "Intermountain"},
    "JOTR": {"name": "Joshua Tree National Park", "type": "National Park", "state": "CA", "region": "Pacific West"},
    "DENA": {"name": "Denali National Park", "type": "National Park", "state": "AK", "region": "Alaska"},
    "EVER": {"name": "Everglades National Park", "type": "National Park", "state": "FL", "region": "Southeast"},
}

# USGS parameter codes
USGS_PARAMETERS = {
    "00060": {"name": "discharge", "unit": "ft3/s"},
    "00065": {"name": "gage_height", "unit": "ft"},
    "00010": {"name": "water_temperature", "unit": "deg C"},
    "00300": {"name": "dissolved_oxygen", "unit": "mg/L"},
    "00400": {"name": "ph", "unit": "std units"},
    "00095": {"name": "specific_conductance", "unit": "uS/cm"},
}

# Default USGS stream gage sites (major rivers)
DEFAULT_SITES = [
    "09380000",  # Colorado River at Lees Ferry, AZ
    "09402500",  # Colorado River near Grand Canyon, AZ
    "13317000",  # Salmon River at White Bird, ID
    "12340000",  # Clark Fork at Missoula, MT
    "06279500",  # Bighorn River at Kane, WY
    "06191500",  # Yellowstone River at Corwin Springs, MT
    "09180500",  # Colorado River near Cisco, UT
    "10174500",  # Jordan River at Salt Lake City, UT
    "14246900",  # Columbia River at Vancouver, WA
    "11303500",  # San Joaquin River near Vernalis, CA
]


class USGSNPSDataFetcher:
    """Fetch data from USGS Water Services, Earthquake Hazards, and NPS Stats."""

    EARTHQUAKE_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
    WATER_URL = "https://waterservices.usgs.gov/nwis"
    NPS_STATS_URL = "https://irmaservices.nps.gov/v3/rest/stats"

    def __init__(self, nps_api_key: str = "", delay: float = 0.3):
        """Initialize data fetcher.

        Args:
            nps_api_key: NPS API key (optional for stats endpoint).
            delay: Seconds between API requests.
        """
        self.nps_api_key = nps_api_key
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "csa-inabox/1.0 Interior Fetcher",
            "Accept": "application/json",
        })

    def _get(self, url: str, params: dict[str, Any], label: str) -> Any:
        """Execute GET with retry and rate limiting."""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                logger.debug("GET %s  params=%s", url, params)
                resp = self.session.get(url, params=params, timeout=60)
                resp.raise_for_status()
                time.sleep(self.delay)
                return resp
            except requests.exceptions.HTTPError as exc:
                if resp.status_code == 429:
                    wait = 2 ** (attempt + 1)
                    logger.warning("Rate limited on %s, retrying in %ds", label, wait)
                    time.sleep(wait)
                elif resp.status_code >= 500:
                    wait = 2 ** (attempt + 1)
                    logger.warning("Server error %d on %s, retry in %ds", resp.status_code, label, wait)
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
    # USGS Earthquakes (ComCat)
    # ===================================================================
    def fetch_earthquakes(
        self,
        start_date: str,
        end_date: str,
        min_magnitude: float = 2.5,
        max_magnitude: float = 10.0,
        limit: int = 5000,
    ) -> list[dict[str, Any]]:
        """Fetch earthquake events from USGS ComCat.

        Args:
            start_date: ISO date string (YYYY-MM-DD).
            end_date: ISO date string (YYYY-MM-DD).
            min_magnitude: Minimum magnitude filter.
            max_magnitude: Maximum magnitude filter.
            limit: Maximum records per request.

        Returns:
            List of dicts matching brz_earthquake_events columns.
        """
        params = {
            "format": "geojson",
            "starttime": start_date,
            "endtime": end_date,
            "minmagnitude": min_magnitude,
            "maxmagnitude": max_magnitude,
            "limit": limit,
            "orderby": "time",
        }

        label = f"Earthquakes {start_date} to {end_date}"
        resp = self._get(self.EARTHQUAKE_URL, params, label)

        if resp is None:
            return []

        data = resp.json()
        features = data.get("features", [])
        records: list[dict[str, Any]] = []

        for feat in features:
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            coords = geom.get("coordinates", [0, 0, 0])

            event_time_ms = props.get("time")
            updated_ms = props.get("updated")
            event_time = datetime.utcfromtimestamp(event_time_ms / 1000).isoformat() if event_time_ms else None
            updated_time = datetime.utcfromtimestamp(updated_ms / 1000).isoformat() if updated_ms else None

            records.append({
                "event_id": feat.get("id", ""),
                "event_time": event_time,
                "updated_time": updated_time,
                "latitude": coords[1] if len(coords) > 1 else None,
                "longitude": coords[0] if len(coords) > 0 else None,
                "depth_km": coords[2] if len(coords) > 2 else None,
                "magnitude": props.get("mag"),
                "magnitude_type": props.get("magType", ""),
                "place_description": props.get("place", ""),
                "event_type": props.get("type", ""),
                "status": props.get("status", ""),
                "tsunami_flag": 1 if props.get("tsunami", 0) else 0,
                "felt_reports": props.get("felt"),
                "cdi": props.get("cdi"),
                "mmi": props.get("mmi"),
                "alert_level": props.get("alert", ""),
                "num_stations": props.get("nst"),
                "azimuthal_gap": props.get("gap"),
                "distance_to_nearest_station": props.get("dmin"),
                "rms": props.get("rms"),
                "horizontal_error": props.get("horizontalError"),
                "depth_error": props.get("depthError"),
                "magnitude_error": props.get("magError"),
                "network": props.get("net", ""),
                "sources": props.get("sources", ""),
                "types": props.get("types", ""),
                "sig": props.get("sig"),
                "_source": "USGS ComCat",
                "load_time": datetime.utcnow().isoformat(),
            })

        logger.info("Earthquakes: %d events from %s to %s", len(records), start_date, end_date)
        return records

    # ===================================================================
    # USGS Water Services (NWIS)
    # ===================================================================
    def fetch_water_resources(
        self,
        sites: list[str],
        parameter_codes: list[str],
        start_date: str,
        end_date: str,
    ) -> list[dict[str, Any]]:
        """Fetch daily water resource data from USGS NWIS.

        Args:
            sites: USGS site numbers.
            parameter_codes: USGS parameter codes (e.g. ["00060","00065"]).
            start_date: Start date YYYY-MM-DD.
            end_date: End date YYYY-MM-DD.

        Returns:
            List of dicts matching brz_water_resources columns.
        """
        records: list[dict[str, Any]] = []
        sites_str = ",".join(sites)
        params_str = ",".join(parameter_codes)

        url = f"{self.WATER_URL}/dv/"
        params = {
            "format": "json",
            "sites": sites_str,
            "parameterCd": params_str,
            "startDT": start_date,
            "endDT": end_date,
            "siteStatus": "all",
        }

        label = f"NWIS daily values {start_date} to {end_date}"
        resp = self._get(url, params, label)

        if resp is None:
            return []

        data = resp.json()
        time_series_list = data.get("value", {}).get("timeSeries", [])

        for ts in time_series_list:
            source_info = ts.get("sourceInfo", {})
            variable_info = ts.get("variable", {})
            site_code = source_info.get("siteCode", [{}])[0].get("value", "")
            site_name = source_info.get("siteName", "")
            geo = source_info.get("geoLocation", {}).get("geogLocation", {})
            site_lat = geo.get("latitude")
            site_lon = geo.get("longitude")
            site_property = source_info.get("siteProperty", [])
            site_type_val = ""
            huc_val = ""
            for prop in site_property:
                if prop.get("name") == "siteTypeCd":
                    site_type_val = prop.get("value", "")
                elif prop.get("name") == "hucCd":
                    huc_val = prop.get("value", "")

            param_code = variable_info.get("variableCode", [{}])[0].get("value", "")
            param_name = variable_info.get("variableName", "")
            param_unit = variable_info.get("unit", {}).get("unitCode", "")

            values_list = ts.get("values", [{}])[0].get("value", [])

            for val_entry in values_list:
                raw_val = val_entry.get("value")
                try:
                    value = float(raw_val) if raw_val and raw_val != "" else None
                except (ValueError, TypeError):
                    value = None

                date_str = val_entry.get("dateTime", "")[:10]

                records.append({
                    "site_id": site_code,
                    "site_name": site_name,
                    "site_latitude": site_lat,
                    "site_longitude": site_lon,
                    "site_type": site_type_val,
                    "state_code": site_code[:2] if len(site_code) >= 2 else "",
                    "county_code": "",
                    "huc_code": huc_val,
                    "drainage_area_sq_mi": None,
                    "measurement_date": date_str,
                    "measurement_datetime": val_entry.get("dateTime", ""),
                    "parameter_code": param_code,
                    "parameter_name": param_name,
                    "parameter_unit": param_unit,
                    "value": value,
                    "daily_mean": value,
                    "daily_min": None,
                    "daily_max": None,
                    "qualification_code": val_entry.get("qualifiers", [""])[0] if val_entry.get("qualifiers") else "",
                    "action_stage_ft": None,
                    "flood_stage_ft": None,
                    "moderate_flood_stage_ft": None,
                    "major_flood_stage_ft": None,
                    "percentile_10": None,
                    "percentile_25": None,
                    "percentile_50": None,
                    "percentile_75": None,
                    "percentile_90": None,
                    "_source": "USGS NWIS",
                    "load_time": datetime.utcnow().isoformat(),
                })

        logger.info("Water resources: %d measurements from %d time series", len(records), len(time_series_list))
        return records

    # ===================================================================
    # NPS Visitor Statistics
    # ===================================================================
    def fetch_park_visitors(
        self,
        park_codes: list[str] | None = None,
        years: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch NPS visitation statistics.

        Args:
            park_codes: List of 4-letter NPS unit codes.
            years: Calendar years.

        Returns:
            List of dicts matching brz_park_visitors columns.
        """
        if park_codes is None:
            park_codes = list(PARK_CODES.keys())
        if years is None:
            years = [2022, 2023]

        records: list[dict[str, Any]] = []

        for park_code in park_codes:
            park_info = PARK_CODES.get(park_code, {
                "name": park_code,
                "type": "Unknown",
                "state": "",
                "region": "",
            })

            for year in years:
                url = f"{self.NPS_STATS_URL}/visitation"
                params = {
                    "unitCodes": park_code,
                    "startMonth": f"{year}01",
                    "endMonth": f"{year}12",
                }
                if self.nps_api_key:
                    params["api_key"] = self.nps_api_key

                label = f"NPS {park_code} {year}"
                resp = self._get(url, params, label)

                if resp is None:
                    logger.warning("No data for %s", label)
                    continue

                try:
                    data = resp.json()
                except Exception:
                    logger.warning("Invalid JSON response for %s", label)
                    continue

                if isinstance(data, list):
                    monthly_data = data
                elif isinstance(data, dict):
                    monthly_data = data.get("data", data.get("results", []))
                else:
                    monthly_data = []

                if not monthly_data:
                    logger.warning("Empty results for %s", label)
                    continue

                for entry in monthly_data:
                    month = entry.get("Month", entry.get("month", 0))
                    rec_visits = entry.get("RecreationVisits", entry.get("recreation_visits", 0))
                    non_rec_visits = entry.get("NonRecreationVisits", entry.get("non_recreation_visits", 0))
                    rec_hours = entry.get("RecreationHours", entry.get("recreation_hours", 0))
                    conc_lodging = entry.get("ConcessionerLodging", entry.get("concessioner_lodging", 0))
                    conc_camping = entry.get("ConcessionerCamping", entry.get("concessioner_camping", 0))
                    tent = entry.get("TentCampers", entry.get("tent_campers", 0))
                    rv = entry.get("RVCampers", entry.get("rv_campers", 0))
                    backcountry = entry.get("BackcountryCampers", entry.get("backcountry_campers", 0))

                    records.append({
                        "park_code": park_code,
                        "park_name": park_info["name"],
                        "park_type": park_info["type"],
                        "state": park_info["state"],
                        "region": park_info["region"],
                        "year": year,
                        "month": month,
                        "recreation_visits": rec_visits,
                        "non_recreation_visits": non_rec_visits,
                        "recreation_hours": rec_hours,
                        "concessioner_lodging": conc_lodging,
                        "concessioner_camping": conc_camping,
                        "tent_campers": tent,
                        "rv_campers": rv,
                        "backcountry_campers": backcountry,
                        "park_acres": None,
                        "trail_miles": None,
                        "campground_capacity": None,
                        "parking_spaces": None,
                        "load_time": datetime.utcnow().isoformat(),
                    })

                logger.info("NPS %s %d: %d monthly records", park_code, year, len(monthly_data))

        logger.info("NPS total: %d records", len(records))
        return records

    # ===================================================================
    # Output
    # ===================================================================
    def write_csv(self, records: list[dict[str, Any]], output_path: str) -> str:
        """Write records to CSV."""
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

    def write_json(self, records: list[dict[str, Any]], output_path: str) -> str:
        """Write records to JSON."""
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
        description="Fetch USGS earthquake/water data and NPS visitation stats for the Interior vertical.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch earthquakes for Q1 2024
  python fetch_usgs_nps.py --dataset earthquakes --start-date 2024-01-01 --end-date 2024-03-31

  # Fetch water data for specific sites
  python fetch_usgs_nps.py --dataset water --sites "09380000,09402500" --start-date 2024-01-01

  # Fetch NPS visitor stats
  python fetch_usgs_nps.py --dataset parks --park-codes "YELL,GRCA,YOSE" --years "2022,2023"

  # Fetch everything
  python fetch_usgs_nps.py --dataset all --output-dir ./data
        """,
    )

    parser.add_argument(
        "--dataset",
        choices=["earthquakes", "water", "parks", "all"],
        default="all",
        help="Which dataset to fetch (default: all)",
    )
    parser.add_argument(
        "--nps-key",
        default=os.environ.get("NPS_API_KEY", ""),
        help="NPS API key (or set NPS_API_KEY env var)",
    )
    parser.add_argument(
        "--start-date",
        default=(datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d"),
        help="Start date YYYY-MM-DD (default: 90 days ago)",
    )
    parser.add_argument(
        "--end-date",
        default=datetime.now().strftime("%Y-%m-%d"),
        help="End date YYYY-MM-DD (default: today)",
    )
    parser.add_argument(
        "--min-magnitude",
        type=float,
        default=2.5,
        help="Minimum earthquake magnitude (default: 2.5)",
    )
    parser.add_argument(
        "--sites",
        default=",".join(DEFAULT_SITES),
        help="Comma-separated USGS site numbers",
    )
    parser.add_argument(
        "--parameters",
        default="00060,00065",
        help="Comma-separated USGS parameter codes",
    )
    parser.add_argument(
        "--park-codes",
        default=",".join(list(PARK_CODES.keys())[:10]),
        help="Comma-separated NPS park codes",
    )
    parser.add_argument(
        "--years",
        default="2022,2023",
        help="Comma-separated years for NPS data",
    )
    parser.add_argument(
        "--output-dir",
        default="./output",
        help="Output directory",
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
        default=0.3,
        help="Seconds between API requests",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
    )

    return parser.parse_args()


def main() -> int:
    """Entry point."""
    args = parse_args()
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    fetcher = USGSNPSDataFetcher(
        nps_api_key=args.nps_key,
        delay=args.delay,
    )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, int] = {}

    # ---- Earthquakes ----
    if args.dataset in ("earthquakes", "all"):
        logger.info("=== Fetching USGS Earthquake Data ===")
        eq_records = fetcher.fetch_earthquakes(
            start_date=args.start_date,
            end_date=args.end_date,
            min_magnitude=args.min_magnitude,
        )
        if eq_records:
            if args.output_format in ("csv", "both"):
                fetcher.write_csv(eq_records, str(output_dir / "earthquake_events.csv"))
            if args.output_format in ("json", "both"):
                fetcher.write_json(eq_records, str(output_dir / "earthquake_events.json"))
        results["earthquakes"] = len(eq_records)

    # ---- Water Resources ----
    if args.dataset in ("water", "all"):
        logger.info("=== Fetching USGS Water Resources ===")
        sites = [s.strip() for s in args.sites.split(",")]
        parameters = [p.strip() for p in args.parameters.split(",")]
        water_records = fetcher.fetch_water_resources(
            sites=sites,
            parameter_codes=parameters,
            start_date=args.start_date,
            end_date=args.end_date,
        )
        if water_records:
            if args.output_format in ("csv", "both"):
                fetcher.write_csv(water_records, str(output_dir / "water_resources.csv"))
            if args.output_format in ("json", "both"):
                fetcher.write_json(water_records, str(output_dir / "water_resources.json"))
        results["water"] = len(water_records)

    # ---- Park Visitors ----
    if args.dataset in ("parks", "all"):
        logger.info("=== Fetching NPS Visitor Statistics ===")
        park_list = [p.strip() for p in args.park_codes.split(",")]
        year_list = [int(y.strip()) for y in args.years.split(",")]
        park_records = fetcher.fetch_park_visitors(
            park_codes=park_list,
            years=year_list,
        )
        if park_records:
            if args.output_format in ("csv", "both"):
                fetcher.write_csv(park_records, str(output_dir / "park_visitors.csv"))
            if args.output_format in ("json", "both"):
                fetcher.write_json(park_records, str(output_dir / "park_visitors.json"))
        results["parks"] = len(park_records)

    # ---- Summary ----
    logger.info("=" * 60)
    logger.info("Fetch Summary:")
    for dataset_name, count in results.items():
        logger.info("  %-14s  %d records", dataset_name, count)
    logger.info("Output directory: %s", output_dir.resolve())
    logger.info("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
