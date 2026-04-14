#!/usr/bin/env python3
"""
Generate synthetic Department of Transportation (DOT) data for development
and testing of the CSA-in-a-Box DOT analytics example.

Generates three datasets:
  1. FARS-like crash records with geographic clustering around major corridors
  2. Highway/bridge condition records with realistic deterioration curves
  3. NTD transit performance metrics with seasonal ridership patterns

Usage:
    python generate_dot_data.py --records 10000 --days 90 --output-dir ./output --seed 42
"""

import argparse
import csv
import os
import random
import sys
from dataclasses import dataclass, asdict
from datetime import date, datetime, timedelta
from typing import List, Optional


# ---------------------------------------------------------------------------
# Reference data: US states, major corridors, transit agencies
# ---------------------------------------------------------------------------

US_STATES = [
    ("AL", 1), ("AK", 2), ("AZ", 4), ("AR", 5), ("CA", 6),
    ("CO", 8), ("CT", 9), ("DE", 10), ("FL", 12), ("GA", 13),
    ("HI", 15), ("ID", 16), ("IL", 17), ("IN", 18), ("IA", 19),
    ("KS", 20), ("KY", 21), ("LA", 22), ("ME", 23), ("MD", 24),
    ("MA", 25), ("MI", 26), ("MN", 27), ("MS", 28), ("MO", 29),
    ("MT", 30), ("NE", 31), ("NV", 32), ("NH", 33), ("NJ", 34),
    ("NM", 35), ("NY", 36), ("NC", 37), ("ND", 38), ("OH", 39),
    ("OK", 40), ("OR", 41), ("PA", 42), ("RI", 44), ("SC", 45),
    ("SD", 46), ("TN", 47), ("TX", 48), ("UT", 49), ("VT", 50),
    ("VA", 51), ("WA", 53), ("WV", 54), ("WI", 55), ("WY", 56),
]

# Major crash corridors: (center_lat, center_lon, spread, weight)
# Crashes cluster around these highway corridors
CRASH_CORRIDORS = [
    (33.75, -84.39, 0.8, 3.0),    # Atlanta, GA - I-285/I-85
    (29.76, -95.37, 1.0, 4.0),    # Houston, TX - I-10/I-45
    (34.05, -118.24, 0.9, 4.5),   # Los Angeles, CA
    (25.76, -80.19, 0.7, 3.0),    # Miami, FL - I-95
    (41.88, -87.63, 0.6, 2.5),    # Chicago, IL - I-90/I-94
    (33.45, -112.07, 0.8, 2.0),   # Phoenix, AZ - I-10/I-17
    (32.78, -96.80, 0.7, 2.5),    # Dallas, TX - I-35/I-30
    (40.71, -74.01, 0.5, 3.5),    # New York City metro
    (39.95, -75.17, 0.4, 2.0),    # Philadelphia, PA - I-76/I-95
    (35.23, -80.84, 0.6, 1.5),    # Charlotte, NC - I-85/I-77
    (36.16, -86.78, 0.5, 1.5),    # Nashville, TN - I-40/I-65
    (38.63, -90.20, 0.5, 1.5),    # St. Louis, MO - I-64/I-70
    (47.61, -122.33, 0.4, 1.5),   # Seattle, WA - I-5
    (39.74, -104.99, 0.5, 1.5),   # Denver, CO - I-25/I-70
]

WEATHER_CONDITIONS = [
    (1, "Clear", 0.55),
    (2, "Rain", 0.15),
    (3, "Sleet/Hail", 0.02),
    (4, "Snow", 0.06),
    (5, "Fog/Smoke", 0.04),
    (6, "Crosswinds", 0.02),
    (10, "Cloudy", 0.12),
    (11, "Blowing Snow", 0.02),
    (12, "Freezing Rain", 0.02),
]

LIGHT_CONDITIONS = [
    (1, "Daylight", 0.45),
    (2, "Dark-Not Lighted", 0.18),
    (3, "Dark-Lighted", 0.22),
    (4, "Dawn", 0.05),
    (5, "Dusk", 0.07),
    (6, "Dark-Unknown Lighting", 0.03),
]

COLLISION_TYPES = [
    (0, "Not Collision With Vehicle", 0.30),
    (1, "Front-to-Rear", 0.15),
    (2, "Front-to-Front", 0.10),
    (6, "Angle", 0.25),
    (7, "Sideswipe-Same Direction", 0.10),
    (8, "Sideswipe-Opposite Direction", 0.05),
    (9, "Rear-to-Side", 0.05),
]

FUNCTIONAL_SYSTEMS = [
    (1, "Interstate", 0.20),
    (2, "Principal Arterial-Freeway", 0.10),
    (3, "Principal Arterial-Other", 0.15),
    (4, "Minor Arterial", 0.20),
    (5, "Major Collector", 0.15),
    (6, "Minor Collector", 0.10),
    (7, "Local", 0.10),
]

TRANSIT_MODES = [
    ("MB", "Bus", 0.45),
    ("HR", "Heavy Rail", 0.15),
    ("LR", "Light Rail", 0.10),
    ("CR", "Commuter Rail", 0.08),
    ("DR", "Demand Response", 0.12),
    ("VP", "Vanpool", 0.05),
    ("FB", "Ferryboat", 0.02),
    ("RB", "Bus Rapid Transit", 0.03),
]

TRANSIT_AGENCIES = [
    ("5001", "MTA New York City Transit", "New York", "NY", 8300000),
    ("2008", "Los Angeles County MTA", "Los Angeles", "CA", 3900000),
    ("6008", "Chicago Transit Authority", "Chicago", "IL", 2700000),
    ("3034", "WMATA", "Washington", "DC", 620000),
    ("5015", "MBTA", "Boston", "MA", 690000),
    ("9015", "SEPTA", "Philadelphia", "PA", 580000),
    ("4034", "MARTA", "Atlanta", "GA", 500000),
    ("6019", "Metro Transit", "Minneapolis", "MN", 380000),
    ("5066", "NJ Transit", "Newark", "NJ", 940000),
    ("0008", "King County Metro", "Seattle", "WA", 740000),
    ("9001", "SFMTA", "San Francisco", "CA", 870000),
    ("3030", "DART", "Dallas", "TX", 540000),
    ("5017", "RTD", "Denver", "CO", 320000),
    ("4022", "Miami-Dade Transit", "Miami", "FL", 270000),
    ("1003", "TriMet", "Portland", "OR", 310000),
    ("4035", "LYNX", "Orlando", "FL", 250000),
    ("0029", "Valley Metro", "Phoenix", "AZ", 180000),
    ("5050", "GCRTA", "Cleveland", "OH", 200000),
    ("3019", "METRORail", "Houston", "TX", 230000),
    ("6011", "IndyGo", "Indianapolis", "IN", 160000),
]

STRUCTURE_TYPES = [
    "Steel Beam", "Concrete Beam", "Prestressed Concrete",
    "Steel Truss", "Concrete Arch", "Steel Girder",
    "Timber Beam", "Concrete Slab", "Steel Box Beam",
    "Concrete Box Beam",
]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class CrashRecord:
    """A single FARS-like crash record."""
    st_case: str
    state: int
    state_alpha: str
    county: int
    city: int
    year: int
    month: int
    day: int
    day_week: int
    hour: int
    minute: int
    fatals: int
    drunk_dr: int
    persons: int
    ve_total: int
    peds: int
    weather: int
    lgt_cond: int
    man_coll: int
    func_sys: int
    rur_urb: int
    sp_limit: int
    latitude: float
    longitude: float
    sch_bus: int
    nhs: int
    load_time: str


@dataclass
class HighwayCondition:
    """A bridge/highway condition inspection record."""
    structure_number: str
    route_number: str
    route_prefix: str
    facility_carried: str
    features_intersected: str
    state_code: str
    state_name: str
    county_code: str
    county_name: str
    year: int
    year_built: int
    year_reconstructed: Optional[int]
    inspection_date: str
    deck_cond: int
    superstructure_cond: int
    substructure_cond: int
    channel_cond: int
    culvert_cond: Optional[int]
    structure_type: str
    structure_len: float
    deck_width: float
    max_span: float
    num_spans_main: int
    adt: int
    adt_year: int
    truck_pct: float
    iri: Optional[float]
    psr: Optional[float]
    rutting: Optional[float]
    cracking_pct: Optional[float]
    lanes: int
    sufficiency_rating: float
    status: str
    latitude: float
    longitude: float
    load_time: str


@dataclass
class TransitMetric:
    """An NTD-like transit performance record."""
    ntd_id: str
    agency_name: str
    city: str
    state: str
    uza_name: str
    uza_population: int
    mode: str
    mode_name: str
    tos: str
    route_id: str
    route_name: str
    service_date: str
    report_year: int
    report_month: int
    scheduled_trips: int
    actual_trips: int
    on_time_trips: int
    missed_trips: int
    unlinked_passenger_trips: int
    passenger_miles: int
    vehicle_revenue_hours: float
    vehicle_revenue_miles: float
    vehicles_operated: int
    vehicles_available: int
    avg_vehicle_age: float
    incidents: int
    fatalities: int
    injuries: int
    operating_expense: float
    fare_revenue: float
    load_time: str


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def weighted_choice(options, rng: random.Random):
    """Pick from a list of (value, ..., weight) tuples."""
    values = [o[:-1] if len(o) > 2 else (o[0],) for o in options]
    weights = [o[-1] for o in options]
    return rng.choices(values, weights=weights, k=1)[0]


def pick_corridor(rng: random.Random):
    """Select a crash corridor weighted by volume, return jittered lat/lon."""
    weights = [c[3] for c in CRASH_CORRIDORS]
    corridor = rng.choices(CRASH_CORRIDORS, weights=weights, k=1)[0]
    lat = corridor[0] + rng.gauss(0, corridor[2])
    lon = corridor[1] + rng.gauss(0, corridor[2])
    return round(lat, 6), round(lon, 6)


def seasonal_weight(month: int) -> float:
    """Crash frequency seasonal factor — higher in summer and holidays."""
    factors = {
        1: 0.85, 2: 0.80, 3: 0.90, 4: 0.95,
        5: 1.05, 6: 1.10, 7: 1.15, 8: 1.12,
        9: 1.05, 10: 1.10, 11: 1.05, 12: 0.88,
    }
    return factors.get(month, 1.0)


def hour_distribution(rng: random.Random) -> int:
    """Generate crash hour with realistic time-of-day distribution."""
    # Bimodal: peaks during rush hours and late night
    weights = [
        3, 2, 2, 2, 2, 3,     # 0-5:  overnight low
        5, 7, 8, 6, 5, 5,     # 6-11: morning rush
        5, 5, 5, 6, 7, 8,     # 12-17: afternoon build
        8, 7, 6, 5, 4, 3,     # 18-23: evening peak then decline
    ]
    return rng.choices(range(24), weights=weights, k=1)[0]


# ---------------------------------------------------------------------------
# Generator functions
# ---------------------------------------------------------------------------

def generate_crash_records(n: int, rng: random.Random) -> List[CrashRecord]:
    """
    Generate n synthetic FARS-like crash records.

    Features realistic:
      - Geographic clustering around known high-crash corridors
      - Seasonal patterns (more crashes in summer)
      - Time-of-day distributions (rush hour peaks)
      - Correlated weather/light/collision characteristics
    """
    records = []
    base_year = 2024
    years = [base_year - i for i in range(5)]

    for i in range(n):
        year = rng.choice(years)
        month = rng.choices(range(1, 13), weights=[seasonal_weight(m) for m in range(1, 13)], k=1)[0]
        day = rng.randint(1, 28)  # Safe for all months
        dow = date(year, month, day).isoweekday()  # 1=Mon, 7=Sun
        hour = hour_distribution(rng)
        minute = rng.randint(0, 59)

        state_alpha, state_code = rng.choice(US_STATES)
        county = rng.randint(1, 200)
        city = rng.randint(0, 9999)

        lat, lon = pick_corridor(rng)

        # Fatalities: mostly 1, occasionally more
        fatals = rng.choices([1, 2, 3, 4, 5], weights=[70, 18, 7, 3, 2], k=1)[0]
        persons = fatals + rng.randint(0, 6)
        vehicles = rng.choices([1, 2, 3, 4, 5], weights=[35, 40, 15, 7, 3], k=1)[0]
        peds = rng.choices([0, 1, 2], weights=[80, 17, 3], k=1)[0]

        # Alcohol involvement correlates with nighttime
        drunk_prob = 0.35 if hour >= 21 or hour <= 4 else 0.12
        drunk = 1 if rng.random() < drunk_prob else 0

        weather = weighted_choice(WEATHER_CONDITIONS, rng)[0]
        light = weighted_choice(LIGHT_CONDITIONS, rng)[0]
        collision = weighted_choice(COLLISION_TYPES, rng)[0]
        func_sys = weighted_choice(FUNCTIONAL_SYSTEMS, rng)[0]

        rural_urban = 2 if rng.random() < 0.55 else 1  # Slight urban bias
        speed = rng.choices([25, 35, 45, 55, 65, 70, 75],
                            weights=[10, 15, 20, 20, 20, 10, 5], k=1)[0]
        school_bus = 1 if rng.random() < 0.02 else 0
        nhs = 1 if func_sys in (1, 2) else (1 if rng.random() < 0.3 else 0)

        case_id = f"{year}{state_code:02d}{i:06d}"

        records.append(CrashRecord(
            st_case=case_id,
            state=state_code,
            state_alpha=state_alpha,
            county=county,
            city=city,
            year=year,
            month=month,
            day=day,
            day_week=dow,
            hour=hour,
            minute=minute,
            fatals=fatals,
            drunk_dr=drunk,
            persons=persons,
            ve_total=vehicles,
            peds=peds,
            weather=weather,
            lgt_cond=light,
            man_coll=collision,
            func_sys=func_sys,
            rur_urb=rural_urban,
            sp_limit=speed,
            latitude=lat,
            longitude=lon,
            sch_bus=school_bus,
            nhs=nhs,
            load_time=datetime.now().isoformat(),
        ))

    return records


def generate_highway_conditions(n: int, rng: random.Random) -> List[HighwayCondition]:
    """
    Generate n synthetic bridge/highway condition records.

    Features realistic:
      - Bridge ages from 1920s to 2020s with appropriate condition curves
      - Condition ratings that degrade over time (older = worse, on average)
      - Traffic volumes correlated with road functional class
      - Pavement IRI values with realistic distributions
    """
    records = []
    current_year = 2024
    route_prefixes = ["I", "US", "SR", "CR"]

    for i in range(n):
        state_alpha, state_code_int = rng.choice(US_STATES)
        state_fips = f"{state_code_int:02d}"
        county_code = f"{rng.randint(1, 200):03d}"

        year_built = rng.choices(
            list(range(1920, 2024, 5)),
            weights=[1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 9, 8, 7, 6, 5, 4, 3, 2, 1],
            k=1
        )[0]
        age = current_year - year_built

        # Reconstruction: ~25% of older bridges
        year_reconstructed = None
        if age > 30 and rng.random() < 0.25:
            year_reconstructed = year_built + rng.randint(20, min(age, 50))

        effective_age = current_year - (year_reconstructed or year_built)

        # Condition ratings degrade with effective age + noise
        def condition_for_age(eff_age):
            base = max(1, min(9, int(9 - eff_age * 0.07 + rng.gauss(0, 1.2))))
            return max(0, min(9, base))

        deck = condition_for_age(effective_age)
        superstructure = condition_for_age(effective_age + rng.randint(-5, 5))
        substructure = condition_for_age(effective_age + rng.randint(-3, 7))
        channel = condition_for_age(effective_age + rng.randint(-10, 3))
        culvert = condition_for_age(effective_age) if rng.random() < 0.3 else None

        prefix = rng.choices(route_prefixes, weights=[20, 25, 40, 15], k=1)[0]
        route_num = f"{prefix}-{rng.randint(1, 999)}"

        # Traffic correlated with prefix
        if prefix == "I":
            adt = int(rng.gauss(45000, 25000))
        elif prefix == "US":
            adt = int(rng.gauss(15000, 10000))
        elif prefix == "SR":
            adt = int(rng.gauss(5000, 4000))
        else:
            adt = int(rng.gauss(1500, 1000))
        adt = max(50, adt)

        truck_pct = round(rng.uniform(2, 25), 1)
        struct_type = rng.choice(STRUCTURE_TYPES)
        length = round(rng.uniform(10, 800), 1)
        width = round(rng.uniform(6, 30), 1)
        max_span = round(rng.uniform(5, min(length, 200)), 1)
        main_spans = rng.randint(1, max(1, int(length / max_span)))

        # Sufficiency rating correlates with condition
        min_cond = min(deck, superstructure, substructure)
        sufficiency = round(max(0, min(100, min_cond * 11 + rng.gauss(0, 8))), 1)

        lat, lon = pick_corridor(rng)
        lat = round(lat + rng.gauss(0, 1.5), 6)
        lon = round(lon + rng.gauss(0, 1.5), 6)

        # Pavement data (available for ~60% of records)
        iri = round(max(40, rng.gauss(120, 50)), 1) if rng.random() < 0.6 else None
        psr = round(max(0, min(5, rng.gauss(3.2, 0.8))), 1) if iri else None
        rutting = round(max(0, rng.gauss(3, 2)), 1) if iri else None
        cracking = round(max(0, min(100, rng.gauss(15, 12))), 1) if iri else None
        lanes = rng.choices([2, 4, 6, 8], weights=[45, 35, 15, 5], k=1)[0]

        bridge_id = f"{state_fips}{county_code}{i:05d}"

        records.append(HighwayCondition(
            structure_number=bridge_id,
            route_number=route_num,
            route_prefix=prefix,
            facility_carried=f"{prefix} {rng.randint(1, 999)}",
            features_intersected=rng.choice([
                "Creek", "River", "Railroad", "US Highway", "State Route",
                "County Road", "Stream", "Interstate", "Canal",
            ]),
            state_code=state_fips,
            state_name=state_alpha,
            county_code=county_code,
            county_name=f"County {county_code}",
            year=current_year,
            year_built=year_built,
            year_reconstructed=year_reconstructed,
            inspection_date=f"{current_year}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
            deck_cond=deck,
            superstructure_cond=superstructure,
            substructure_cond=substructure,
            channel_cond=channel,
            culvert_cond=culvert,
            structure_type=struct_type,
            structure_len=length,
            deck_width=width,
            max_span=max_span,
            num_spans_main=main_spans,
            adt=adt,
            adt_year=current_year - rng.randint(0, 3),
            truck_pct=truck_pct,
            iri=iri,
            psr=psr,
            rutting=rutting,
            cracking_pct=cracking,
            lanes=lanes,
            sufficiency_rating=sufficiency,
            status="Open" if sufficiency > 10 else "Posted",
            latitude=lat,
            longitude=lon,
            load_time=datetime.now().isoformat(),
        ))

    return records


def generate_transit_metrics(
    days: int, agencies: int, rng: random.Random
) -> List[TransitMetric]:
    """
    Generate synthetic NTD-like transit performance metrics.

    Features realistic:
      - Ridership with day-of-week and seasonal patterns
      - Weekend/holiday ridership drops
      - Mode-specific performance characteristics
      - Financial metrics correlated with ridership
    """
    records = []
    selected_agencies = TRANSIT_AGENCIES[:min(agencies, len(TRANSIT_AGENCIES))]
    end_date = date(2024, 3, 31)
    start_date = end_date - timedelta(days=days)

    for agency in selected_agencies:
        ntd_id, name, city, state, uza_pop = agency

        # Each agency has 1-4 modes
        agency_modes = rng.sample(
            TRANSIT_MODES,
            k=min(rng.randint(1, 4), len(TRANSIT_MODES))
        )

        for mode_code, mode_name, _ in agency_modes:
            # Number of routes per mode
            if mode_code in ("HR", "CR", "LR"):
                num_routes = rng.randint(1, 6)
            elif mode_code == "MB":
                num_routes = rng.randint(5, 40)
            else:
                num_routes = rng.randint(1, 10)

            for route_idx in range(num_routes):
                route_id = f"{mode_code}-{route_idx + 1:03d}"
                route_name = f"Route {route_id}"

                # Base metrics for this route (varies by mode and agency size)
                base_ridership = int(uza_pop * rng.uniform(0.0001, 0.002))
                if mode_code in ("HR", "CR"):
                    base_ridership *= 3
                elif mode_code in ("DR", "VP"):
                    base_ridership = max(10, base_ridership // 10)

                base_trips = rng.randint(20, 200)
                vehicles = rng.randint(2, 30)

                current_date = start_date
                while current_date <= end_date:
                    dow = current_date.isoweekday()
                    month = current_date.month

                    # Day-of-week factor
                    if dow <= 5:  # Weekday
                        dow_factor = 1.0
                    elif dow == 6:  # Saturday
                        dow_factor = 0.55
                    else:  # Sunday
                        dow_factor = 0.35

                    # Seasonal factor
                    seasonal = 1.0
                    if month in (6, 7, 8):
                        seasonal = 0.85  # Summer dip
                    elif month in (11, 12):
                        seasonal = 1.10  # Holiday shopping
                    elif month in (1, 2):
                        seasonal = 0.90  # Winter dip

                    # Calculate daily metrics
                    daily_ridership = max(
                        1,
                        int(base_ridership * dow_factor * seasonal * rng.uniform(0.8, 1.2))
                    )
                    scheduled = max(1, int(base_trips * dow_factor))
                    actual = max(1, int(scheduled * rng.uniform(0.90, 1.0)))
                    on_time = max(0, int(actual * rng.uniform(0.70, 0.98)))
                    missed = max(0, scheduled - actual)

                    veh_hours = round(vehicles * rng.uniform(8, 16) * dow_factor, 1)
                    veh_miles = round(veh_hours * rng.uniform(10, 25), 1)
                    pax_miles = daily_ridership * rng.uniform(2, 12)

                    # Financials
                    op_expense = round(veh_hours * rng.uniform(100, 250), 2)
                    fare_rev = round(daily_ridership * rng.uniform(1.0, 3.5), 2)

                    # Safety (rare events)
                    incidents = 1 if rng.random() < 0.005 else 0
                    fatalities = 1 if incidents and rng.random() < 0.05 else 0
                    inj = rng.randint(0, 3) if incidents else 0

                    records.append(TransitMetric(
                        ntd_id=ntd_id,
                        agency_name=name,
                        city=city,
                        state=state,
                        uza_name=f"{city} Urbanized Area",
                        uza_population=uza_pop,
                        mode=mode_code,
                        mode_name=mode_name,
                        tos="DO" if mode_code in ("DR", "VP") else "MB",
                        route_id=route_id,
                        route_name=route_name,
                        service_date=current_date.isoformat(),
                        report_year=current_date.year,
                        report_month=current_date.month,
                        scheduled_trips=scheduled,
                        actual_trips=actual,
                        on_time_trips=on_time,
                        missed_trips=missed,
                        unlinked_passenger_trips=daily_ridership,
                        passenger_miles=int(pax_miles),
                        vehicle_revenue_hours=veh_hours,
                        vehicle_revenue_miles=veh_miles,
                        vehicles_operated=vehicles,
                        vehicles_available=vehicles + rng.randint(1, 5),
                        avg_vehicle_age=round(rng.uniform(3, 18), 1),
                        incidents=incidents,
                        fatalities=fatalities,
                        injuries=inj,
                        operating_expense=op_expense,
                        fare_revenue=fare_rev,
                        load_time=datetime.now().isoformat(),
                    ))

                    current_date += timedelta(days=1)

    return records


# ---------------------------------------------------------------------------
# CSV writing
# ---------------------------------------------------------------------------

def write_csv(records, filepath: str):
    """Write a list of dataclass instances to CSV."""
    if not records:
        print(f"  ⚠ No records to write for {filepath}")
        return

    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    fieldnames = list(asdict(records[0]).keys())

    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            writer.writerow(asdict(record))

    print(f"  Wrote {len(records):,} records to {filepath}")


# ---------------------------------------------------------------------------
# Main CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Generate synthetic DOT transportation data for CSA-in-a-Box"
    )
    parser.add_argument(
        "--records", type=int, default=10000,
        help="Number of crash and highway records to generate (default: 10000)"
    )
    parser.add_argument(
        "--days", type=int, default=90,
        help="Number of days of transit metrics to generate (default: 90)"
    )
    parser.add_argument(
        "--agencies", type=int, default=20,
        help="Number of transit agencies (default: 20, max: 20)"
    )
    parser.add_argument(
        "--output-dir", type=str, default="./output",
        help="Output directory for CSV files (default: ./output)"
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)"
    )
    parser.add_argument(
        "--validate", action="store_true",
        help="Run basic validation on generated data"
    )

    args = parser.parse_args()
    rng = random.Random(args.seed)

    print(f"Generating DOT transportation data (seed={args.seed})...")
    print(f"  Crash records: {args.records:,}")
    print(f"  Highway condition records: {args.records // 2:,}")
    print(f"  Transit days: {args.days}, agencies: {args.agencies}")
    print()

    # Generate datasets
    crashes = generate_crash_records(args.records, rng)
    highway = generate_highway_conditions(args.records // 2, rng)
    transit = generate_transit_metrics(args.days, args.agencies, rng)

    # Write CSVs
    write_csv(crashes, os.path.join(args.output_dir, "fars_crash_data.csv"))
    write_csv(highway, os.path.join(args.output_dir, "highway_conditions.csv"))
    write_csv(transit, os.path.join(args.output_dir, "ntd_transit_performance.csv"))

    # Optional validation
    if args.validate:
        print("\nValidating generated data...")
        errors = 0

        # Crash validation
        for c in crashes:
            if c.fatals < 1:
                print(f"  ERROR: Crash {c.st_case} has {c.fatals} fatalities")
                errors += 1
            if c.latitude < 18 or c.latitude > 72:
                print(f"  ERROR: Crash {c.st_case} lat {c.latitude} out of range")
                errors += 1

        # Highway validation
        for h in highway:
            for rating_name, rating in [
                ("deck", h.deck_cond),
                ("superstructure", h.superstructure_cond),
                ("substructure", h.substructure_cond),
            ]:
                if rating < 0 or rating > 9:
                    print(f"  ERROR: Bridge {h.structure_number} {rating_name}={rating}")
                    errors += 1

        # Transit validation
        for t in transit:
            if t.on_time_trips > t.actual_trips:
                print(f"  ERROR: Agency {t.ntd_id} on_time > actual trips")
                errors += 1

        if errors == 0:
            print("  All validation checks passed!")
        else:
            print(f"  {errors} validation errors found.")
            sys.exit(1)

    print("\nDone!")


if __name__ == "__main__":
    main()
