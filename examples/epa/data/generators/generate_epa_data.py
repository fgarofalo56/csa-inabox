#!/usr/bin/env python3
"""
EPA Synthetic Data Generator

Generates realistic synthetic data for the EPA Environmental Monitoring
Analytics platform, including air quality index readings, water system
compliance records, and toxic release inventory reports. Data follows
real-world seasonal patterns, geographic distributions, and regulatory
structures.

Usage:
    python generate_epa_data.py --output-dir ../../domains/dbt/seeds
    python generate_epa_data.py --monitors 200 --water-systems 500 --tri-facilities 300
    python generate_epa_data.py --format csv --output-dir ./output
"""

import argparse
import csv
import hashlib
import math
import os
import random
from datetime import datetime, timedelta
from typing import Any


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

US_STATES_EPA = [
    ("AL", "01", 32.8, -86.8),
    ("AK", "02", 64.2, -152.5),
    ("AZ", "04", 34.0, -111.1),
    ("AR", "05", 35.2, -91.8),
    ("CA", "06", 36.8, -119.4),
    ("CO", "08", 39.1, -105.4),
    ("CT", "09", 41.6, -72.7),
    ("DE", "10", 38.9, -75.5),
    ("FL", "12", 27.8, -81.8),
    ("GA", "13", 32.7, -83.5),
    ("HI", "15", 19.9, -155.6),
    ("ID", "16", 44.1, -114.7),
    ("IL", "17", 40.3, -89.0),
    ("IN", "18", 40.3, -86.1),
    ("IA", "19", 42.0, -93.2),
    ("KS", "20", 38.5, -98.8),
    ("KY", "21", 37.7, -84.7),
    ("LA", "22", 31.2, -92.1),
    ("ME", "23", 45.3, -69.4),
    ("MD", "24", 39.0, -76.6),
    ("MA", "25", 42.4, -71.4),
    ("MI", "26", 44.3, -84.5),
    ("MN", "27", 46.7, -94.7),
    ("MS", "28", 32.4, -89.7),
    ("MO", "29", 38.6, -91.8),
    ("MT", "30", 47.0, -109.6),
    ("NE", "31", 41.5, -99.9),
    ("NV", "32", 38.8, -116.4),
    ("NH", "33", 43.2, -71.6),
    ("NJ", "34", 40.1, -74.4),
    ("NM", "35", 34.8, -106.2),
    ("NY", "36", 43.3, -75.0),
    ("NC", "37", 35.6, -79.8),
    ("ND", "38", 47.5, -100.5),
    ("OH", "39", 40.4, -82.9),
    ("OK", "40", 35.0, -97.1),
    ("OR", "41", 44.0, -120.5),
    ("PA", "42", 41.2, -77.2),
    ("RI", "44", 41.6, -71.5),
    ("SC", "45", 34.0, -81.0),
    ("SD", "46", 44.3, -100.4),
    ("TN", "47", 35.5, -86.6),
    ("TX", "48", 31.0, -100.0),
    ("UT", "49", 39.3, -111.1),
    ("VT", "50", 44.6, -72.6),
    ("VA", "51", 37.8, -79.4),
    ("WA", "53", 47.4, -121.5),
    ("WV", "54", 38.6, -80.9),
    ("WI", "55", 43.8, -89.5),
    ("WY", "56", 43.1, -107.6),
]

# AQI pollutants with seasonal patterns
POLLUTANTS = [
    {
        "code": "88101", "name": "PM2.5", "units": "ug/m3",
        "base_concentration": 10.0, "seasonal_amplitude": 5.0,
        "peak_month": 1,  # Winter peak (heating/inversions)
    },
    {
        "code": "44201", "name": "O3", "units": "ppm",
        "base_concentration": 0.040, "seasonal_amplitude": 0.020,
        "peak_month": 7,  # Summer peak (photochemical)
    },
    {
        "code": "42602", "name": "NO2", "units": "ppb",
        "base_concentration": 15.0, "seasonal_amplitude": 8.0,
        "peak_month": 1,  # Winter peak (heating)
    },
    {
        "code": "42101", "name": "CO", "units": "ppm",
        "base_concentration": 0.5, "seasonal_amplitude": 0.3,
        "peak_month": 1,  # Winter peak
    },
]

# TRI chemicals with realistic attributes
TRI_CHEMICALS = [
    ("TOLUENE", "108-88-3", "VOC", False, False, None),
    ("XYLENE", "1330-20-7", "VOC", False, False, None),
    ("METHANOL", "67-56-1", "VOC", False, False, None),
    ("AMMONIA", "7664-41-7", "INORGANIC", False, False, None),
    ("SULFURIC ACID", "7664-93-9", "ACID", False, False, None),
    ("HYDROCHLORIC ACID", "7647-01-0", "ACID", False, False, None),
    ("N-HEXANE", "110-54-3", "VOC", False, False, None),
    ("ETHYLENE", "74-85-1", "VOC", False, False, None),
    ("STYRENE", "100-42-5", "VOC", True, False, None),
    ("FORMALDEHYDE", "50-00-0", "VOC", True, False, None),
    ("BENZENE", "71-43-2", "VOC", True, False, None),
    ("LEAD", "7439-92-1", "METAL", True, False, "LEAD"),
    ("MERCURY", "7439-97-6", "METAL", True, False, "MERCURY"),
    ("CHROMIUM", "7440-47-3", "METAL", True, False, "CHROMIUM"),
    ("ZINC", "7440-66-6", "METAL", False, False, "ZINC"),
    ("COPPER", "7440-50-8", "METAL", False, False, "COPPER"),
    ("NICKEL", "7440-02-0", "METAL", True, False, "NICKEL"),
    ("BARIUM", "7440-39-3", "METAL", False, False, "BARIUM"),
    ("NITRATE COMPOUNDS", "NA", "INORGANIC", False, False, None),
    ("HYDROGEN FLUORIDE", "7664-39-3", "ACID", False, False, None),
]

NAICS_SECTORS = [
    ("324110", "PETROLEUM_REFINING"),
    ("325110", "CHEMICAL_MANUFACTURING"),
    ("325199", "CHEMICAL_MANUFACTURING"),
    ("325211", "PLASTICS_RUBBER"),
    ("331110", "PRIMARY_METALS"),
    ("331210", "PRIMARY_METALS"),
    ("332710", "FABRICATED_METALS"),
    ("336111", "TRANSPORTATION_EQUIPMENT"),
    ("322110", "PAPER_MANUFACTURING"),
    ("311611", "FOOD_BEVERAGE"),
    ("221112", "UTILITIES"),
    ("212210", "MINING"),
    ("562211", "WASTE_MANAGEMENT"),
]

WATER_CONTAMINANTS = [
    ("Lead", "MCL", True),
    ("Copper", "MCL", True),
    ("Arsenic", "MCL", True),
    ("Nitrate", "MCL", True),
    ("Total Coliform", "MCL", True),
    ("E. Coli", "MCL", True),
    ("Total Trihalomethanes", "MCL", False),
    ("Haloacetic Acids", "MCL", False),
    ("Fluoride", "MCL", False),
    ("Turbidity", "TT", False),
    ("Total Organic Carbon", "TT", False),
    ("Surface Water Treatment", "TT", False),
    ("Monitoring Violation", "MON", False),
    ("Public Notice Violation", "PN", False),
]


def _pm25_to_aqi(concentration: float) -> int:
    """Convert PM2.5 concentration (µg/m³) to AQI using EPA breakpoints."""
    breakpoints = [
        (0.0, 12.0, 0, 50),
        (12.1, 35.4, 51, 100),
        (35.5, 55.4, 101, 150),
        (55.5, 150.4, 151, 200),
        (150.5, 250.4, 201, 300),
        (250.5, 500.4, 301, 500),
    ]
    for c_lo, c_hi, i_lo, i_hi in breakpoints:
        if c_lo <= concentration <= c_hi:
            return round(((i_hi - i_lo) / (c_hi - c_lo)) * (concentration - c_lo) + i_lo)
    return min(500, max(0, round(concentration)))


def _aqi_category(aqi: int) -> str:
    """Map AQI value to EPA health category."""
    if aqi <= 50:
        return "Good"
    elif aqi <= 100:
        return "Moderate"
    elif aqi <= 150:
        return "Unhealthy for Sensitive Groups"
    elif aqi <= 200:
        return "Unhealthy"
    elif aqi <= 300:
        return "Very Unhealthy"
    else:
        return "Hazardous"


# ---------------------------------------------------------------------------
# Generator functions
# ---------------------------------------------------------------------------

def generate_aqi_readings(
    num_monitors: int = 300,
    num_days: int = 365,
    start_date: datetime | None = None,
) -> list[dict[str, Any]]:
    """
    Generate synthetic AQI monitor readings with realistic seasonal patterns.

    PM2.5 peaks in winter (heating season, inversions); ozone peaks in summer
    (photochemical production). Urban monitors have higher baseline
    concentrations than rural monitors. Weekend/weekday patterns included.

    Args:
        num_monitors: Number of monitoring sites.
        num_days: Number of days per site.
        start_date: First observation date.

    Returns:
        List of AQI observation dicts ready for CSV output.
    """
    if start_date is None:
        start_date = datetime(datetime.now().year - 1, 1, 1)

    rng = random.Random(789)
    records: list[dict[str, Any]] = []

    # Create monitoring sites distributed across states
    monitors = []
    for i in range(num_monitors):
        state = US_STATES_EPA[i % len(US_STATES_EPA)]
        site_number = f"{rng.randint(1, 9999):04d}"
        county_code = f"{rng.randint(1, 200):03d}"
        is_urban = rng.random() < 0.65  # 65% urban monitors

        lat = state[2] + rng.uniform(-1.5, 1.5)
        lon = state[3] + rng.uniform(-2.0, 2.0)

        monitors.append({
            "site_id": f"{state[1]}-{county_code}-{site_number}",
            "state_code": state[1],
            "state_name": state[0],
            "county_code": county_code,
            "county_name": f"{state[0]}_COUNTY_{county_code}",
            "cbsa_name": f"Metro_{state[0]}_{i:03d}" if is_urban else None,
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "datum": "NAD83",
            "is_urban": is_urban,
            "urban_factor": 1.5 if is_urban else 0.7,
            # Assign 1–3 pollutants per monitor
            "pollutants": rng.sample(POLLUTANTS, k=rng.randint(1, min(3, len(POLLUTANTS)))),
        })

    load_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for monitor in monitors:
        for pollutant in monitor["pollutants"]:
            for day_offset in range(num_days):
                obs_date = start_date + timedelta(days=day_offset)
                month = obs_date.month
                dow = obs_date.weekday()

                # Skip some days randomly (3% gaps)
                if rng.random() < 0.03:
                    continue

                # Seasonal pattern
                seasonal_factor = 1.0 + pollutant["seasonal_amplitude"] / pollutant["base_concentration"] * math.cos(
                    2 * math.pi * (month - pollutant["peak_month"]) / 12.0
                )

                # Weekend effect (lower traffic emissions)
                weekend_factor = 0.85 if dow >= 5 else 1.0

                # Random daily variation
                daily_noise = rng.gauss(0, pollutant["base_concentration"] * 0.2)

                # Occasional pollution events (5% chance)
                event_factor = 1.0
                if rng.random() < 0.05:
                    event_factor = rng.uniform(1.5, 3.0)

                concentration = max(0.001,
                    pollutant["base_concentration"]
                    * seasonal_factor
                    * monitor["urban_factor"]
                    * weekend_factor
                    * event_factor
                    + daily_noise
                )
                concentration = round(concentration, 6)

                # Calculate AQI from concentration
                if pollutant["name"] == "PM2.5":
                    aqi = _pm25_to_aqi(concentration)
                elif pollutant["name"] == "O3":
                    # Simplified ozone AQI
                    aqi = min(500, max(0, round(concentration / 0.070 * 50)))
                elif pollutant["name"] == "NO2":
                    aqi = min(500, max(0, round(concentration / 100 * 50)))
                else:
                    aqi = min(500, max(0, round(concentration / pollutant["base_concentration"] * 30)))

                # Observation completeness
                obs_pct = rng.uniform(70, 100) if rng.random() > 0.1 else rng.uniform(40, 70)

                records.append({
                    "source_system": rng.choice(["AQS", "AQS", "AQS", "AIRNOW"]),
                    "site_id": monitor["site_id"],
                    "site_number": monitor["site_id"].split("-")[-1],
                    "state_code": monitor["state_code"],
                    "state_name": monitor["state_name"],
                    "county_code": monitor["county_code"],
                    "county_name": monitor["county_name"],
                    "cbsa_name": monitor["cbsa_name"],
                    "latitude": monitor["latitude"],
                    "longitude": monitor["longitude"],
                    "datum": monitor["datum"],
                    "parameter_code": pollutant["code"],
                    "parameter_name": pollutant["name"],
                    "poc": 1,
                    "sample_duration": "24-HR" if pollutant["name"] in ("PM2.5", "PM10") else "8-HR",
                    "pollutant_standard": f"{pollutant['name']} NAAQS",
                    "units_of_measure": pollutant["units"],
                    "method_code": f"M{rng.randint(100, 999)}",
                    "method_name": f"FRM {pollutant['name']} Method",
                    "date_local": obs_date.strftime("%Y-%m-%d"),
                    "observation_count": rng.randint(18, 24),
                    "observation_percent": round(obs_pct, 1),
                    "arithmetic_mean": concentration,
                    "first_max_value": round(concentration * rng.uniform(1.1, 1.8), 6),
                    "first_max_hour": rng.randint(6, 18),
                    "aqi": aqi,
                    "load_time": load_time,
                })

    return records


def generate_water_system_data(
    num_systems: int = 1000,
) -> list[dict[str, Any]]:
    """
    Generate synthetic SDWIS water system compliance records.

    Creates water systems with realistic characteristics (type, source,
    population) and generates violation records following EPA patterns:
    small systems have higher violation rates, health-based violations
    are less common than monitoring violations.

    Args:
        num_systems: Number of water systems to generate.

    Returns:
        List of water system/violation dicts ready for CSV output.
    """
    rng = random.Random(321)
    records: list[dict[str, Any]] = []

    load_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for i in range(num_systems):
        state = US_STATES_EPA[i % len(US_STATES_EPA)]
        pwsid = f"{state[1]}{rng.randint(10000, 99999):05d}"

        # System type distribution
        pws_type = rng.choices(
            ["CWS", "NTNCWS", "TNCWS"],
            weights=[70, 15, 15],
            k=1
        )[0]

        # Population: log-normal distribution
        if pws_type == "CWS":
            population = max(25, int(rng.lognormvariate(7, 2)))
        else:
            population = max(25, int(rng.lognormvariate(5, 1.5)))
        population = min(population, 5000000)

        source_type = rng.choices(
            ["GW", "SW", "GU", "SWP"],
            weights=[55, 25, 10, 10],
            k=1
        )[0]

        lat = state[2] + rng.uniform(-1.5, 1.5)
        lon = state[3] + rng.uniform(-2.0, 2.0)

        # Generate violations for this system
        # Small systems (< 500 pop) have higher violation rates
        base_violation_rate = 0.3 if population < 500 else 0.15 if population < 10000 else 0.08
        num_violations = rng.choices(
            [0, 1, 2, 3, 4, 5, 10],
            weights=[60, 15, 10, 5, 4, 3, 3],
            k=1
        )[0]

        if rng.random() > base_violation_rate:
            num_violations = 0

        if num_violations == 0:
            # Record with no violations (system inventory only)
            records.append({
                "pwsid": pwsid,
                "pws_name": f"Water System {state[0]}_{i:04d}",
                "pws_type_code": pws_type,
                "primary_source_code": source_type,
                "population_served_count": population,
                "service_connections_count": max(10, population // 3),
                "state_code": state[0],
                "county_name": f"{state[0]}_COUNTY_{rng.randint(1, 30):03d}",
                "county_fips": f"{rng.randint(1, 200):03d}",
                "city_name": f"City_{state[0]}_{rng.randint(1, 50):03d}",
                "zip_code": f"{rng.randint(10000, 99999)}",
                "latitude": round(lat, 6),
                "longitude": round(lon, 6),
                "violation_id": None,
                "contaminant_code": None,
                "contaminant_name": None,
                "violation_type_code": None,
                "violation_type_name": None,
                "compliance_begin_date": None,
                "compliance_end_date": None,
                "violation_status": None,
                "severity_ind": None,
                "enforcement_id": None,
                "enforcement_action_type": None,
                "enforcement_date": None,
                "load_time": load_time,
            })
        else:
            for v in range(num_violations):
                contaminant = rng.choice(WATER_CONTAMINANTS)
                begin_year = rng.randint(2018, 2024)
                begin_month = rng.randint(1, 12)
                begin_date = datetime(begin_year, begin_month, rng.randint(1, 28))

                # Duration: most violations resolved within a year
                duration_days = int(rng.lognormvariate(4, 1.5))
                end_date = begin_date + timedelta(days=duration_days)
                is_resolved = rng.random() < 0.7
                if not is_resolved:
                    end_date = None

                # Enforcement: more common for health-based violations
                has_enforcement = rng.random() < (0.3 if contaminant[1] == "MCL" else 0.1)

                records.append({
                    "pwsid": pwsid,
                    "pws_name": f"Water System {state[0]}_{i:04d}",
                    "pws_type_code": pws_type,
                    "primary_source_code": source_type,
                    "population_served_count": population,
                    "service_connections_count": max(10, population // 3),
                    "state_code": state[0],
                    "county_name": f"{state[0]}_COUNTY_{rng.randint(1, 30):03d}",
                    "county_fips": f"{rng.randint(1, 200):03d}",
                    "city_name": f"City_{state[0]}_{rng.randint(1, 50):03d}",
                    "zip_code": f"{rng.randint(10000, 99999)}",
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "violation_id": f"V{100000 + i * 10 + v}",
                    "contaminant_code": f"C{rng.randint(1000, 9999)}",
                    "contaminant_name": contaminant[0],
                    "violation_type_code": contaminant[1],
                    "violation_type_name": f"{contaminant[1]} Violation - {contaminant[0]}",
                    "compliance_begin_date": begin_date.strftime("%Y-%m-%d"),
                    "compliance_end_date": end_date.strftime("%Y-%m-%d") if end_date else None,
                    "violation_status": "Resolved" if is_resolved else "Open",
                    "severity_ind": "S" if contaminant[2] else None,
                    "enforcement_id": f"E{rng.randint(100000, 999999)}" if has_enforcement else None,
                    "enforcement_action_type": rng.choice([
                        "Administrative Order", "Formal Notice", "State Court Order",
                        "Compliance Schedule", "Civil Penalty"
                    ]) if has_enforcement else None,
                    "enforcement_date": (begin_date + timedelta(days=rng.randint(30, 180))).strftime(
                        "%Y-%m-%d") if has_enforcement else None,
                    "load_time": load_time,
                })

    return records


def generate_tri_reports(
    num_facilities: int = 500,
) -> list[dict[str, Any]]:
    """
    Generate synthetic TRI (Toxics Release Inventory) reports.

    Creates facilities with realistic industry sector assignments and
    generates multi-year chemical release reports with quantities that
    follow log-normal distributions and show year-over-year trends
    (generally decreasing, per historical TRI patterns).

    Args:
        num_facilities: Number of reporting facilities.

    Returns:
        List of TRI report dicts ready for CSV output.
    """
    rng = random.Random(654)
    records: list[dict[str, Any]] = []

    load_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for i in range(num_facilities):
        state = US_STATES_EPA[i % len(US_STATES_EPA)]
        naics = rng.choice(NAICS_SECTORS)

        trifid = f"{state[1]}{rng.randint(10000, 99999):05d}SYNTH"
        lat = state[2] + rng.uniform(-1.5, 1.5)
        lon = state[3] + rng.uniform(-2.0, 2.0)
        employees = max(10, int(rng.lognormvariate(5, 1.2)))

        # Each facility reports 1–5 chemicals across multiple years
        num_chemicals = rng.randint(1, 5)
        chemicals = rng.sample(TRI_CHEMICALS, k=min(num_chemicals, len(TRI_CHEMICALS)))

        # Report for 3–7 years
        start_year = rng.randint(2018, 2022)
        num_years = rng.randint(3, 7)

        for chemical in chemicals:
            # Base release amount (log-normal, varies by industry)
            if naics[1] == "PETROLEUM_REFINING":
                base_release = rng.lognormvariate(11, 2)
            elif naics[1] == "CHEMICAL_MANUFACTURING":
                base_release = rng.lognormvariate(10, 2)
            elif naics[1] in ("PRIMARY_METALS", "FABRICATED_METALS"):
                base_release = rng.lognormvariate(9, 2)
            else:
                base_release = rng.lognormvariate(8, 2)

            for year_offset in range(num_years):
                year = start_year + year_offset

                # Year-over-year trend: generally decreasing (TRI historical pattern)
                trend_factor = 1.0 - year_offset * rng.uniform(0.01, 0.05)
                annual_noise = rng.gauss(1.0, 0.15)
                total_release = max(0, base_release * trend_factor * annual_noise)

                # Split releases across media
                air_pct = rng.uniform(0.3, 0.7)
                water_pct = rng.uniform(0, 0.2)
                land_pct = rng.uniform(0, 0.15)
                injection_pct = rng.uniform(0, 0.1) if naics[1] in ("PETROLEUM_REFINING", "CHEMICAL_MANUFACTURING") else 0
                offsite_pct = max(0, 1.0 - air_pct - water_pct - land_pct - injection_pct)

                fugitive_air = total_release * air_pct * rng.uniform(0.2, 0.5)
                stack_air = total_release * air_pct - fugitive_air

                # Waste management quantities
                recycled = total_release * rng.uniform(0.1, 0.5)
                energy_recovery = total_release * rng.uniform(0, 0.2)
                treated = total_release * rng.uniform(0.1, 0.4)

                records.append({
                    "trifid": trifid,
                    "facility_name": f"Facility_{state[0]}_{i:04d}",
                    "street_address": f"{rng.randint(100, 9999)} Industrial Blvd",
                    "city": f"City_{state[0]}_{rng.randint(1, 50):03d}",
                    "state": state[0],
                    "zip_code": f"{rng.randint(10000, 99999)}",
                    "county_fips": f"{state[1]}{rng.randint(1, 200):03d}",
                    "county_name": f"{state[0]}_COUNTY_{rng.randint(1, 30):03d}",
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "primary_naics": naics[0],
                    "industry_sector": naics[1],
                    "number_of_employees": employees,
                    "parent_company": f"ParentCo_{rng.randint(1, 100):03d}" if rng.random() < 0.6 else None,
                    "federal_facility": rng.random() < 0.05,
                    "reporting_year": year,
                    "chemical_id": hashlib.md5(
                        f"{trifid}_{chemical[0]}_{year}".encode()
                    ).hexdigest()[:12],
                    "chemical_name": chemical[0],
                    "cas_number": chemical[1],
                    "chemical_classification": chemical[2],
                    "carcinogen": chemical[3],
                    "pfas_chemical": chemical[4],
                    "metal_category": chemical[5],
                    "fugitive_air": round(max(0, fugitive_air), 2),
                    "stack_air": round(max(0, stack_air), 2),
                    "water_discharge": round(max(0, total_release * water_pct), 2),
                    "underground_injection": round(max(0, total_release * injection_pct), 2),
                    "land_disposal": round(max(0, total_release * land_pct), 2),
                    "offsite_transfer": round(max(0, total_release * offsite_pct), 2),
                    "total_releases": round(max(0, total_release), 2),
                    "onsite_recycled": round(max(0, recycled), 2),
                    "onsite_energy_recovery": round(max(0, energy_recovery), 2),
                    "onsite_treated": round(max(0, treated), 2),
                    "source_reduction_activity": rng.choice([
                        "Process modification", "Raw material substitution",
                        "Product reformulation", "Inventory management",
                        None, None,
                    ]),
                    "production_ratio": round(rng.uniform(0.8, 1.2), 4),
                    "load_time": load_time,
                })

    return records


def _write_csv(records: list[dict], filepath: str) -> None:
    """Write a list of dicts to CSV."""
    if not records:
        print(f"  Warning: No records to write for {filepath}")
        return
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=records[0].keys())
        writer.writeheader()
        writer.writerows(records)
    print(f"  Wrote {len(records):,} records to {filepath}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate synthetic EPA environmental monitoring data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --output-dir ../../domains/dbt/seeds
  %(prog)s --monitors 200 --water-systems 500 --tri-facilities 300
  %(prog)s --start-date 2022-01-01 --days 730
        """,
    )
    parser.add_argument(
        "--output-dir", "-o",
        default="./output",
        help="Output directory for generated CSV files (default: ./output)",
    )
    parser.add_argument(
        "--monitors", type=int, default=300,
        help="Number of AQI monitoring sites (default: 300)",
    )
    parser.add_argument(
        "--days", type=int, default=365,
        help="Number of days of AQI data per monitor (default: 365)",
    )
    parser.add_argument(
        "--water-systems", type=int, default=1000,
        help="Number of water systems (default: 1000)",
    )
    parser.add_argument(
        "--tri-facilities", type=int, default=500,
        help="Number of TRI reporting facilities (default: 500)",
    )
    parser.add_argument(
        "--start-date",
        type=lambda s: datetime.strptime(s, "%Y-%m-%d"),
        default=None,
        help="Start date for AQI observations (YYYY-MM-DD). Default: Jan 1 of previous year.",
    )
    parser.add_argument(
        "--format", choices=["csv", "parquet"], default="csv",
        help="Output format (default: csv). Parquet requires pyarrow.",
    )

    args = parser.parse_args()

    print("=" * 60)
    print("EPA Synthetic Data Generator")
    print("=" * 60)

    # AQI readings
    print(f"\nGenerating AQI readings ({args.monitors} monitors x {args.days} days)...")
    aqi = generate_aqi_readings(
        num_monitors=args.monitors,
        num_days=args.days,
        start_date=args.start_date,
    )
    _write_csv(aqi, os.path.join(args.output_dir, "aqs_air_quality.csv"))

    # Water system data
    print(f"\nGenerating water system data ({args.water_systems} systems)...")
    water = generate_water_system_data(num_systems=args.water_systems)
    _write_csv(water, os.path.join(args.output_dir, "sdwis_water_systems.csv"))

    # TRI reports
    print(f"\nGenerating TRI reports ({args.tri_facilities} facilities)...")
    tri = generate_tri_reports(num_facilities=args.tri_facilities)
    _write_csv(tri, os.path.join(args.output_dir, "tri_releases.csv"))

    print(f"\nData generation complete! Files in: {os.path.abspath(args.output_dir)}")
    print(f"   Total records: {len(aqi) + len(water) + len(tri):,}")


if __name__ == "__main__":
    main()
