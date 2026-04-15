#!/usr/bin/env python3
"""
Generate synthetic USPS postal operations data for development and testing
of the CSA-in-a-Box USPS analytics example.

Generates three datasets:
  1. Delivery performance records with realistic routing and timing patterns
  2. Facility operational metrics with utilization and capacity data
  3. Daily mail volume by product class with seasonal patterns

Usage:
    python generate_usps_data.py --records 50000 --facilities 200 --days 365 \
                                 --output-dir ./output --seed 42
"""

import argparse
import csv
import math
import os
import random
import sys
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

US_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
]

# Major metro areas with (city, state, zip_prefix, lat, lon, population_weight)
METRO_AREAS = [
    ("NEW YORK", "NY", "100", 40.71, -74.01, 8.3),
    ("LOS ANGELES", "CA", "900", 34.05, -118.24, 3.9),
    ("CHICAGO", "IL", "606", 41.88, -87.63, 2.7),
    ("HOUSTON", "TX", "770", 29.76, -95.37, 2.3),
    ("PHOENIX", "AZ", "850", 33.45, -112.07, 1.6),
    ("PHILADELPHIA", "PA", "191", 39.95, -75.17, 1.6),
    ("SAN ANTONIO", "TX", "782", 29.42, -98.49, 1.5),
    ("SAN DIEGO", "CA", "921", 32.72, -117.16, 1.4),
    ("DALLAS", "TX", "752", 32.78, -96.80, 1.3),
    ("AUSTIN", "TX", "787", 30.27, -97.74, 1.0),
    ("JACKSONVILLE", "FL", "322", 30.33, -81.66, 0.9),
    ("COLUMBUS", "OH", "432", 39.96, -82.99, 0.9),
    ("CHARLOTTE", "NC", "282", 35.23, -80.84, 0.9),
    ("INDIANAPOLIS", "IN", "462", 39.77, -86.16, 0.9),
    ("SAN FRANCISCO", "CA", "941", 37.77, -122.42, 0.9),
    ("SEATTLE", "WA", "981", 47.61, -122.33, 0.7),
    ("DENVER", "CO", "802", 39.74, -104.99, 0.7),
    ("WASHINGTON", "DC", "200", 38.91, -77.04, 0.7),
    ("NASHVILLE", "TN", "372", 36.16, -86.78, 0.7),
    ("ATLANTA", "GA", "303", 33.75, -84.39, 0.5),
    ("BOSTON", "MA", "021", 42.36, -71.06, 0.7),
    ("PORTLAND", "OR", "972", 45.52, -122.68, 0.6),
    ("MINNEAPOLIS", "MN", "554", 44.98, -93.27, 0.4),
    ("MIAMI", "FL", "331", 25.76, -80.19, 0.4),
    ("DETROIT", "MI", "482", 42.33, -83.05, 0.6),
]

PRODUCT_CLASSES = [
    ("FIRST_CLASS", 0.30, 3),       # (name, volume_weight, service_standard_days)
    ("PRIORITY", 0.08, 2),
    ("PRIORITY_EXPRESS", 0.02, 1),
    ("PARCEL_SELECT", 0.10, 8),
    ("MEDIA_MAIL", 0.03, 8),
    ("MARKETING_MAIL", 0.35, 5),
    ("PERIODICALS", 0.12, 5),
]

MAIL_SHAPES = ["LETTER", "FLAT", "PARCEL", "PACKAGE"]

CARRIER_TYPES = [
    ("CITY", 0.55),
    ("RURAL", 0.30),
    ("HIGHWAY_CONTRACT", 0.10),
    ("PO_BOX", 0.05),
]

DELIVERY_METHODS = ["VEHICLE", "FOOT", "CLUSTER_BOX", "PO_BOX"]

FACILITY_TYPES = [
    ("PROCESSING_DISTRIBUTION_CENTER", 0.15, 500000),
    ("NETWORK_DISTRIBUTION_CENTER", 0.05, 1000000),
    ("POST_OFFICE", 0.55, 15000),
    ("STATION", 0.10, 25000),
    ("BRANCH", 0.08, 10000),
    ("DELIVERY_DISTRIBUTION_CENTER", 0.07, 200000),
]

REGIONS = ["EASTERN", "WESTERN", "SOUTHERN", "PACIFIC"]

DISTRICTS = [
    ("NORTHEAST", "EASTERN"), ("CAPITAL_METRO", "EASTERN"),
    ("GREAT_LAKES", "EASTERN"), ("SOUTHERN", "SOUTHERN"),
    ("GULF_ATLANTIC", "SOUTHERN"), ("SOUTHWEST", "WESTERN"),
    ("WESTERN", "WESTERN"), ("PACIFIC", "PACIFIC"),
]

FEDERAL_HOLIDAYS_2024 = [
    date(2024, 1, 1), date(2024, 1, 15), date(2024, 2, 19),
    date(2024, 5, 27), date(2024, 6, 19), date(2024, 7, 4),
    date(2024, 9, 2), date(2024, 10, 14), date(2024, 11, 11),
    date(2024, 11, 28), date(2024, 12, 25),
]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class DeliveryRecord:
    """A single delivery performance record."""
    tracking_id: str
    carrier_route: str
    delivery_unit: str
    origin_zip: str
    origin_city: str
    origin_state: str
    destination_zip: str
    destination_city: str
    destination_state: str
    district: str
    region: str
    product_class: str
    service_type: str
    mail_shape: str
    weight_oz: float
    acceptance_datetime: str
    acceptance_date: str
    expected_delivery_date: str
    actual_delivery_date: str
    actual_delivery_datetime: str
    delivery_status: str
    delivery_time_days: float
    service_standard_days: int
    delivery_attempt_count: int
    origin_facility_id: str
    destination_facility_id: str
    processing_facility_id: str
    carrier_type: str
    delivery_method: str
    load_time: str


@dataclass
class FacilityRecord:
    """A facility operations daily record."""
    facility_id: str
    facility_name: str
    facility_type: str
    facility_subtype: str
    address: str
    city: str
    state: str
    zip_code: str
    district: str
    area: str
    region: str
    latitude: float
    longitude: float
    report_date: str
    report_year: int
    report_month: int
    max_throughput_daily: int
    actual_throughput_daily: int
    letters_processed: int
    flats_processed: int
    parcels_processed: int
    total_pieces_processed: int
    sorting_machines: int
    sorting_machines_active: int
    delivery_vehicles: int
    delivery_vehicles_active: int
    total_employees: int
    carriers: int
    clerks: int
    supervisors: int
    operating_hours: float
    overtime_hours: float
    operating_cost_daily: float
    revenue_daily: float
    square_footage: int
    year_built: int
    last_renovation_year: int | None
    po_boxes: int
    delivery_routes: int
    load_time: str


@dataclass
class VolumeRecord:
    """A daily mail volume record by facility and product class."""
    facility_id: str
    facility_name: str
    facility_type: str
    district: str
    region: str
    state: str
    product_class: str
    mail_shape: str
    volume_date: str
    volume_year: int
    volume_month: int
    volume_day_of_week: int
    inbound_pieces: int
    outbound_pieces: int
    total_pieces: int
    revenue_pieces: int
    total_weight_lbs: float
    avg_weight_per_piece_oz: float
    postage_revenue: float
    avg_revenue_per_piece: float
    volume_prior_year_same_day: int | None
    volume_prior_week: int | None
    is_holiday: bool
    is_business_day: bool
    load_time: str


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def weighted_choice(options, rng: random.Random):
    """Pick from a list of (value, ..., weight, ...) tuples using second element as weight."""
    if len(options[0]) == 2 or len(options[0]) >= 3:
        values = [o[0] for o in options]
        weights = [o[1] for o in options]
    else:
        values = [o[0] for o in options]
        weights = [1.0 for _ in options]
    return rng.choices(values, weights=weights, k=1)[0]


def pick_metro(rng: random.Random):
    """Select a metro area weighted by population."""
    weights = [m[5] for m in METRO_AREAS]
    return rng.choices(METRO_AREAS, weights=weights, k=1)[0]


def generate_zip(prefix: str, rng: random.Random) -> str:
    """Generate a 5-digit ZIP code with the given 3-digit prefix."""
    suffix = rng.randint(0, 99)
    return f"{prefix}{suffix:02d}"


def seasonal_volume_factor(d: date) -> float:
    """Return a multiplicative seasonal factor for mail volume."""
    month = d.month
    day = d.day

    # Holiday peak (Nov 20 - Dec 24): up to 2x
    if (month == 11 and day >= 20) or (month == 12 and day <= 24):
        return 1.5 + 0.5 * math.sin(math.pi * (day if month == 12 else day + 10) / 24)

    # Tax season (late March - mid April): ~1.3x
    if (month == 3 and day >= 20) or (month == 4 and day <= 15):
        return 1.25

    # Post-holiday January lull
    if month == 1:
        return 0.75

    # Summer dip
    if month in (6, 7, 8):
        return 0.85

    # Election season (October of even years — simplified)
    if month == 10:
        return 1.15

    return 1.0


def is_business_day(d: date) -> bool:
    """Check if a date is a USPS business day."""
    if d.weekday() >= 6:  # Sunday
        return False
    return d not in FEDERAL_HOLIDAYS_2024


# ---------------------------------------------------------------------------
# Generator functions
# ---------------------------------------------------------------------------

def generate_delivery_records(n: int, rng: random.Random) -> list[DeliveryRecord]:
    """
    Generate n synthetic delivery performance records.

    Features realistic:
      - Geographic distribution weighted by metro population
      - Product class mix reflecting actual USPS volume shares
      - Delivery time distributions per product class
      - Seasonal acceptance patterns
      - Re-delivery attempt rates
    """
    records = []
    end_date = date(2024, 3, 31)
    start_date = end_date - timedelta(days=180)

    for i in range(n):
        # Pick origin and destination metros
        origin_metro = pick_metro(rng)
        dest_metro = pick_metro(rng)

        origin_zip = generate_zip(origin_metro[2], rng)
        dest_zip = generate_zip(dest_metro[2], rng)

        # Product class selection
        pc_name = weighted_choice(
            [(p[0], p[1]) for p in PRODUCT_CLASSES], rng
        )
        standard = next(p[2] for p in PRODUCT_CLASSES if p[0] == pc_name)

        # Acceptance date with seasonal weighting
        days_offset = rng.randint(0, (end_date - start_date).days)
        accept_date = start_date + timedelta(days=days_offset)
        accept_hour = rng.choices(
            list(range(6, 22)),
            weights=[2, 5, 8, 10, 10, 9, 8, 8, 7, 6, 5, 4, 3, 2, 1, 1],
            k=1
        )[0]
        accept_minute = rng.randint(0, 59)
        accept_dt = datetime(accept_date.year, accept_date.month, accept_date.day,
                             accept_hour, accept_minute)

        # Expected delivery date
        expected_date = accept_date + timedelta(days=standard)

        # Actual delivery: most on time, some late, rare failures
        delivery_delay = 0
        if rng.random() < 0.88:  # 88% on time
            delivery_delay = rng.randint(0, standard)
        elif rng.random() < 0.90:  # ~10.8% slightly late
            delivery_delay = standard + rng.randint(1, 3)
        else:  # ~1.2% significantly late
            delivery_delay = standard + rng.randint(4, 10)

        actual_date = accept_date + timedelta(days=delivery_delay)
        actual_hour = rng.choices(
            list(range(8, 20)),
            weights=[3, 5, 7, 9, 10, 10, 9, 8, 6, 4, 2, 1],
            k=1
        )[0]
        actual_dt = datetime(actual_date.year, actual_date.month, actual_date.day,
                             actual_hour, rng.randint(0, 59))

        # Delivery status
        status = "DELIVERED"
        attempts = 1
        if rng.random() < 0.05:  # 5% need multiple attempts
            attempts = rng.choices([2, 3, 4], weights=[70, 25, 5], k=1)[0]

        # Mail shape based on product class
        if pc_name in ("PARCEL_SELECT", "PRIORITY", "PRIORITY_EXPRESS"):
            shape = rng.choices(MAIL_SHAPES, weights=[5, 10, 50, 35], k=1)[0]
        elif pc_name == "MARKETING_MAIL":
            shape = rng.choices(MAIL_SHAPES, weights=[60, 35, 3, 2], k=1)[0]
        else:
            shape = rng.choices(MAIL_SHAPES, weights=[55, 30, 10, 5], k=1)[0]

        # Weight based on shape
        if shape == "LETTER":
            weight = round(rng.uniform(0.5, 3.5), 1)
        elif shape == "FLAT":
            weight = round(rng.uniform(2, 12), 1)
        elif shape == "PARCEL":
            weight = round(rng.uniform(8, 64), 1)
        else:
            weight = round(rng.uniform(16, 320), 1)

        # Carrier type
        carrier = weighted_choice(CARRIER_TYPES, rng)
        method = rng.choice(DELIVERY_METHODS)

        # District and region
        dist_info = rng.choice(DISTRICTS)

        # Route and facility IDs
        route = f"{carrier[0]}{dest_zip[:3]}{rng.randint(1, 99):02d}"
        del_unit = f"DU-{dest_zip[:3]}-{rng.randint(1, 20):02d}"
        origin_fac = f"FAC-{origin_zip[:3]}-001"
        dest_fac = f"FAC-{dest_zip[:3]}-001"
        proc_fac = f"PDC-{origin_zip[:3]}-001"

        records.append(DeliveryRecord(
            tracking_id=f"9400{rng.randint(1000000000, 9999999999)}{i:06d}",
            carrier_route=route,
            delivery_unit=del_unit,
            origin_zip=origin_zip,
            origin_city=origin_metro[0],
            origin_state=origin_metro[1],
            destination_zip=dest_zip,
            destination_city=dest_metro[0],
            destination_state=dest_metro[1],
            district=dist_info[0],
            region=dist_info[1],
            product_class=pc_name,
            service_type=pc_name.replace("_", " ").title(),
            mail_shape=shape,
            weight_oz=weight,
            acceptance_datetime=accept_dt.isoformat(),
            acceptance_date=accept_date.isoformat(),
            expected_delivery_date=expected_date.isoformat(),
            actual_delivery_date=actual_date.isoformat(),
            actual_delivery_datetime=actual_dt.isoformat(),
            delivery_status=status,
            delivery_time_days=delivery_delay,
            service_standard_days=standard,
            delivery_attempt_count=attempts,
            origin_facility_id=origin_fac,
            destination_facility_id=dest_fac,
            processing_facility_id=proc_fac,
            carrier_type=carrier,
            delivery_method=method,
            load_time=datetime.now().isoformat(),
        ))

    return records


def generate_facility_data(n: int, rng: random.Random) -> list[FacilityRecord]:
    """
    Generate n synthetic facility operational records.

    Features realistic:
      - Facility types with appropriate capacity ranges
      - Utilization rates with day-of-week patterns
      - Equipment and staffing correlated with facility size
      - Geographic distribution across USPS regions
    """
    facilities = []

    for i in range(n):
        # Pick facility type
        fac_type_info = rng.choices(
            FACILITY_TYPES,
            weights=[f[1] for f in FACILITY_TYPES],
            k=1
        )[0]
        fac_type = fac_type_info[0]
        max_capacity = fac_type_info[2]

        # Location
        metro = pick_metro(rng)
        dist_info = rng.choice(DISTRICTS)
        zip_code = generate_zip(metro[2], rng)

        # Facility characteristics
        year_built = rng.randint(1960, 2020)
        reno_year = year_built + rng.randint(10, 40) if rng.random() < 0.4 else None
        if reno_year and reno_year > 2024:
            reno_year = None

        sqft = int(max_capacity * rng.uniform(0.3, 1.5))
        po_boxes = rng.randint(0, 2000) if fac_type in ("POST_OFFICE", "STATION", "BRANCH") else 0
        routes = rng.randint(5, 100) if fac_type != "NETWORK_DISTRIBUTION_CENTER" else 0

        # Equipment
        if fac_type in ("PROCESSING_DISTRIBUTION_CENTER", "NETWORK_DISTRIBUTION_CENTER"):
            machines = rng.randint(10, 60)
            vehicles = rng.randint(20, 200)
        elif fac_type == "DELIVERY_DISTRIBUTION_CENTER":
            machines = rng.randint(3, 15)
            vehicles = rng.randint(30, 150)
        else:
            machines = rng.randint(0, 5)
            vehicles = rng.randint(2, 40)

        # Staffing correlated with capacity
        if fac_type in ("PROCESSING_DISTRIBUTION_CENTER", "NETWORK_DISTRIBUTION_CENTER"):
            employees = rng.randint(200, 1500)
        elif fac_type == "DELIVERY_DISTRIBUTION_CENTER":
            employees = rng.randint(50, 300)
        else:
            employees = rng.randint(3, 60)

        carriers_count = int(employees * rng.uniform(0.3, 0.6))
        clerks_count = int(employees * rng.uniform(0.2, 0.4))
        supervisors_count = max(1, int(employees * rng.uniform(0.03, 0.08)))

        # Daily capacity with noise
        max_daily = int(max_capacity * rng.uniform(0.7, 1.3))

        # Utilization rate (varies by day)
        base_utilization = rng.uniform(0.35, 0.92)
        actual = int(max_daily * base_utilization * rng.uniform(0.85, 1.15))
        actual = max(0, min(actual, int(max_daily * 1.2)))

        # Volume breakdown
        letters_pct = rng.uniform(0.30, 0.60)
        flats_pct = rng.uniform(0.15, 0.30)
        parcels_pct = 1.0 - letters_pct - flats_pct
        letters = int(actual * letters_pct)
        flats = int(actual * flats_pct)
        parcels = int(actual * parcels_pct)

        # Operating metrics
        hours = round(rng.uniform(8, 24), 1)
        overtime = round(max(0, rng.gauss(hours * 0.1, hours * 0.05)), 1)
        cost = round(employees * rng.uniform(200, 450) + actual * rng.uniform(0.02, 0.08), 2)
        revenue = round(actual * rng.uniform(0.03, 0.15), 2)

        # Use current date as report_date
        report_date = date(2024, 3, 15)
        lat = round(metro[3] + rng.gauss(0, 0.3), 6)
        lon = round(metro[4] + rng.gauss(0, 0.3), 6)

        fac_id = f"FAC-{metro[2]}-{i:04d}"

        facilities.append(FacilityRecord(
            facility_id=fac_id,
            facility_name=f"{metro[0]} {fac_type.replace('_', ' ').title()} #{i:03d}",
            facility_type=fac_type,
            facility_subtype=fac_type,
            address=f"{rng.randint(100, 9999)} Main St",
            city=metro[0],
            state=metro[1],
            zip_code=zip_code,
            district=dist_info[0],
            area=dist_info[0],
            region=dist_info[1],
            latitude=lat,
            longitude=lon,
            report_date=report_date.isoformat(),
            report_year=report_date.year,
            report_month=report_date.month,
            max_throughput_daily=max_daily,
            actual_throughput_daily=actual,
            letters_processed=letters,
            flats_processed=flats,
            parcels_processed=parcels,
            total_pieces_processed=actual,
            sorting_machines=machines,
            sorting_machines_active=max(1, int(machines * rng.uniform(0.6, 1.0))),
            delivery_vehicles=vehicles,
            delivery_vehicles_active=max(1, int(vehicles * rng.uniform(0.7, 0.95))),
            total_employees=employees,
            carriers=carriers_count,
            clerks=clerks_count,
            supervisors=supervisors_count,
            operating_hours=hours,
            overtime_hours=overtime,
            operating_cost_daily=cost,
            revenue_daily=revenue,
            square_footage=sqft,
            year_built=year_built,
            last_renovation_year=reno_year,
            po_boxes=po_boxes,
            delivery_routes=routes,
            load_time=datetime.now().isoformat(),
        ))

    return facilities


def generate_mail_volume(
    days: int, facilities: int, rng: random.Random
) -> list[VolumeRecord]:
    """
    Generate daily mail volume records for multiple facilities.

    Features realistic:
      - Seasonal patterns (holiday peak, tax season, summer lull)
      - Day-of-week patterns (lower Saturday, no Sunday)
      - Product class volume proportions matching USPS actuals
      - Year-over-year decline in letter mail, growth in parcels
    """
    records = []
    end_date = date(2024, 3, 31)
    start_date = end_date - timedelta(days=days)

    # Generate a stable set of facility identifiers
    facility_list = []
    for f_idx in range(min(facilities, len(METRO_AREAS))):
        metro = METRO_AREAS[f_idx % len(METRO_AREAS)]
        dist_info = DISTRICTS[f_idx % len(DISTRICTS)]
        fac_type = FACILITY_TYPES[f_idx % len(FACILITY_TYPES)]
        facility_list.append({
            "facility_id": f"FAC-{metro[2]}-{f_idx:04d}",
            "facility_name": f"{metro[0]} {fac_type[0].replace('_', ' ').title()}",
            "facility_type": fac_type[0],
            "district": dist_info[0],
            "region": dist_info[1],
            "state": metro[1],
            "base_volume": int(fac_type[2] * rng.uniform(0.3, 0.8)),
        })

    # Add more facilities cycling through metros
    while len(facility_list) < facilities:
        f_idx = len(facility_list)
        metro = METRO_AREAS[f_idx % len(METRO_AREAS)]
        dist_info = DISTRICTS[f_idx % len(DISTRICTS)]
        fac_type = FACILITY_TYPES[f_idx % len(FACILITY_TYPES)]
        facility_list.append({
            "facility_id": f"FAC-{metro[2]}-{f_idx:04d}",
            "facility_name": f"{metro[0]} {fac_type[0].replace('_', ' ').title()} #{f_idx}",
            "facility_type": fac_type[0],
            "district": dist_info[0],
            "region": dist_info[1],
            "state": metro[1],
            "base_volume": int(fac_type[2] * rng.uniform(0.2, 0.6)),
        })

    for fac in facility_list:
        current_date = start_date

        while current_date <= end_date:
            dow = current_date.isoweekday()  # 1=Mon, 7=Sun

            # Skip Sundays (no delivery)
            if dow == 7:
                current_date += timedelta(days=1)
                continue

            biz_day = is_business_day(current_date)
            holiday = current_date in FEDERAL_HOLIDAYS_2024

            # Day-of-week volume factor
            dow_factor = {1: 1.0, 2: 1.05, 3: 1.02, 4: 0.98, 5: 0.95, 6: 0.50}
            daily_factor = dow_factor.get(dow, 0.5)

            # Seasonal factor
            season_factor = seasonal_volume_factor(current_date)

            # Holiday reduction
            if holiday:
                daily_factor *= 0.15

            # Generate volume for each product class
            for pc_name, pc_weight, _ in PRODUCT_CLASSES:
                base = int(fac["base_volume"] * pc_weight)
                daily_vol = max(0, int(base * daily_factor * season_factor * rng.uniform(0.8, 1.2)))

                inbound = int(daily_vol * rng.uniform(0.4, 0.6))
                outbound = daily_vol - inbound

                # Weight per piece varies by product class
                if pc_name in ("PARCEL_SELECT", "PRIORITY", "PRIORITY_EXPRESS"):
                    avg_weight = rng.uniform(16, 48)  # ounces
                elif pc_name == "MEDIA_MAIL":
                    avg_weight = rng.uniform(12, 32)
                else:
                    avg_weight = rng.uniform(1, 6)

                total_weight = round(daily_vol * avg_weight / 16, 2)  # to pounds

                # Revenue per piece
                if pc_name == "PRIORITY_EXPRESS":
                    rev_per = round(rng.uniform(20, 40), 4)
                elif pc_name == "PRIORITY":
                    rev_per = round(rng.uniform(5, 15), 4)
                elif pc_name == "FIRST_CLASS":
                    rev_per = round(rng.uniform(0.50, 1.20), 4)
                elif pc_name == "PARCEL_SELECT":
                    rev_per = round(rng.uniform(3, 10), 4)
                elif pc_name == "MARKETING_MAIL":
                    rev_per = round(rng.uniform(0.15, 0.35), 4)
                else:
                    rev_per = round(rng.uniform(0.20, 0.60), 4)

                postage = round(daily_vol * rev_per, 2)

                # Prior year (assume slight decline for letters, growth for parcels)
                if pc_name in ("PARCEL_SELECT", "PRIORITY", "PRIORITY_EXPRESS"):
                    prior_factor = rng.uniform(0.85, 0.95)  # parcels growing
                else:
                    prior_factor = rng.uniform(1.02, 1.10)  # letters declining
                prior_year = int(daily_vol * prior_factor)

                # Shape assignment
                if pc_name in ("PARCEL_SELECT", "PRIORITY", "PRIORITY_EXPRESS"):
                    shape = rng.choices(MAIL_SHAPES, weights=[5, 10, 50, 35], k=1)[0]
                elif pc_name == "MARKETING_MAIL":
                    shape = rng.choices(MAIL_SHAPES, weights=[60, 35, 3, 2], k=1)[0]
                else:
                    shape = rng.choices(MAIL_SHAPES, weights=[55, 30, 10, 5], k=1)[0]

                records.append(VolumeRecord(
                    facility_id=fac["facility_id"],
                    facility_name=fac["facility_name"],
                    facility_type=fac["facility_type"],
                    district=fac["district"],
                    region=fac["region"],
                    state=fac["state"],
                    product_class=pc_name,
                    mail_shape=shape,
                    volume_date=current_date.isoformat(),
                    volume_year=current_date.year,
                    volume_month=current_date.month,
                    volume_day_of_week=dow,
                    inbound_pieces=inbound,
                    outbound_pieces=outbound,
                    total_pieces=daily_vol,
                    revenue_pieces=int(daily_vol * rng.uniform(0.85, 1.0)),
                    total_weight_lbs=total_weight,
                    avg_weight_per_piece_oz=round(avg_weight, 2),
                    postage_revenue=postage,
                    avg_revenue_per_piece=rev_per,
                    volume_prior_year_same_day=prior_year,
                    volume_prior_week=int(daily_vol * rng.uniform(0.9, 1.1)),
                    is_holiday=holiday,
                    is_business_day=biz_day,
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
        print(f"  Warning: No records to write for {filepath}")
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
        description="Generate synthetic USPS postal operations data for CSA-in-a-Box"
    )
    parser.add_argument(
        "--records", type=int, default=50000,
        help="Number of delivery records to generate (default: 50000)"
    )
    parser.add_argument(
        "--facilities", type=int, default=200,
        help="Number of facilities to generate (default: 200)"
    )
    parser.add_argument(
        "--days", type=int, default=365,
        help="Number of days for volume data (default: 365)"
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

    print(f"Generating USPS postal operations data (seed={args.seed})...")
    print(f"  Delivery records: {args.records:,}")
    print(f"  Facility records: {args.facilities:,}")
    print(f"  Volume days: {args.days}")
    print()

    # Generate datasets
    deliveries = generate_delivery_records(args.records, rng)
    facilities_data = generate_facility_data(args.facilities, rng)
    # Use a smaller facility count for volume to keep file size manageable
    volume_facilities = min(args.facilities, 50)
    volumes = generate_mail_volume(args.days, volume_facilities, rng)

    # Write CSVs
    write_csv(deliveries, os.path.join(args.output_dir, "delivery_performance.csv"))
    write_csv(facilities_data, os.path.join(args.output_dir, "facility_operations.csv"))
    write_csv(volumes, os.path.join(args.output_dir, "mail_volume.csv"))

    # Optional validation
    if args.validate:
        print("\nValidating generated data...")
        errors = 0

        # Delivery validation
        for d in deliveries:
            if len(d.origin_zip) < 5:
                print(f"  ERROR: Invalid origin ZIP {d.origin_zip}")
                errors += 1
            if len(d.destination_zip) < 5:
                print(f"  ERROR: Invalid dest ZIP {d.destination_zip}")
                errors += 1
            if d.delivery_time_days < 0:
                print(f"  ERROR: Negative delivery time {d.tracking_id}")
                errors += 1

        # Facility validation
        for f in facilities_data:
            if f.actual_throughput_daily < 0:
                print(f"  ERROR: Negative throughput at {f.facility_id}")
                errors += 1
            if f.max_throughput_daily > 0 and \
               f.actual_throughput_daily > f.max_throughput_daily * 1.5:
                print(f"  ERROR: Throughput > 150% capacity at {f.facility_id}")
                errors += 1

        # Volume validation
        for v in volumes:
            if v.total_pieces < 0:
                print(f"  ERROR: Negative volume at {v.facility_id} on {v.volume_date}")
                errors += 1

        if errors == 0:
            print("  All validation checks passed!")
        else:
            print(f"  {errors} validation errors found.")
            sys.exit(1)

    print("\nDone!")


if __name__ == "__main__":
    main()
