#!/usr/bin/env python3
"""
Generate synthetic Commerce Department data for the CSA-in-a-Box platform.

Produces realistic Census ACS demographics, BEA GDP data, and international
trade transaction records suitable for developing and testing the medallion
architecture pipeline.

Usage:
    python generate_commerce_data.py --records 5000 --output-dir ../domains/dbt/seeds --seed 42
    python generate_commerce_data.py --census-tracts 5000 --gdp-states 50 --gdp-quarters 40
"""

import argparse
import csv
import hashlib
import math
import os
import random
from datetime import datetime
from typing import Any

# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

STATE_INFO: list[dict[str, Any]] = [
    {"fips": "01", "code": "AL", "name": "Alabama", "pop": 5024279, "income": 52035},
    {"fips": "02", "code": "AK", "name": "Alaska", "pop": 733391, "income": 77640},
    {"fips": "04", "code": "AZ", "name": "Arizona", "pop": 7151502, "income": 62055},
    {"fips": "05", "code": "AR", "name": "Arkansas", "pop": 3011524, "income": 49475},
    {"fips": "06", "code": "CA", "name": "California", "pop": 39538223, "income": 78672},
    {"fips": "08", "code": "CO", "name": "Colorado", "pop": 5773714, "income": 77127},
    {"fips": "09", "code": "CT", "name": "Connecticut", "pop": 3605944, "income": 78444},
    {"fips": "10", "code": "DE", "name": "Delaware", "pop": 989948, "income": 69110},
    {"fips": "11", "code": "DC", "name": "District of Columbia", "pop": 689545, "income": 90842},
    {"fips": "12", "code": "FL", "name": "Florida", "pop": 21538187, "income": 57703},
    {"fips": "13", "code": "GA", "name": "Georgia", "pop": 10711908, "income": 58700},
    {"fips": "15", "code": "HI", "name": "Hawaii", "pop": 1455271, "income": 83102},
    {"fips": "16", "code": "ID", "name": "Idaho", "pop": 1839106, "income": 58915},
    {"fips": "17", "code": "IL", "name": "Illinois", "pop": 12812508, "income": 68428},
    {"fips": "18", "code": "IN", "name": "Indiana", "pop": 6732219, "income": 57603},
    {"fips": "19", "code": "IA", "name": "Iowa", "pop": 3190369, "income": 61836},
    {"fips": "20", "code": "KS", "name": "Kansas", "pop": 2937880, "income": 61091},
    {"fips": "21", "code": "KY", "name": "Kentucky", "pop": 4505836, "income": 52238},
    {"fips": "22", "code": "LA", "name": "Louisiana", "pop": 4657757, "income": 49469},
    {"fips": "23", "code": "ME", "name": "Maine", "pop": 1362359, "income": 57918},
    {"fips": "24", "code": "MD", "name": "Maryland", "pop": 6177224, "income": 87063},
    {"fips": "25", "code": "MA", "name": "Massachusetts", "pop": 7029917, "income": 84385},
    {"fips": "26", "code": "MI", "name": "Michigan", "pop": 10077331, "income": 57144},
    {"fips": "27", "code": "MN", "name": "Minnesota", "pop": 5706494, "income": 73382},
    {"fips": "28", "code": "MS", "name": "Mississippi", "pop": 2961279, "income": 45081},
    {"fips": "29", "code": "MO", "name": "Missouri", "pop": 6154913, "income": 57290},
    {"fips": "30", "code": "MT", "name": "Montana", "pop": 1084225, "income": 54970},
    {"fips": "31", "code": "NE", "name": "Nebraska", "pop": 1961504, "income": 63229},
    {"fips": "32", "code": "NV", "name": "Nevada", "pop": 3104614, "income": 60365},
    {"fips": "33", "code": "NH", "name": "New Hampshire", "pop": 1377529, "income": 77933},
    {"fips": "34", "code": "NJ", "name": "New Jersey", "pop": 9288994, "income": 85751},
    {"fips": "35", "code": "NM", "name": "New Mexico", "pop": 2117522, "income": 51243},
    {"fips": "36", "code": "NY", "name": "New York", "pop": 20201249, "income": 68486},
    {"fips": "37", "code": "NC", "name": "North Carolina", "pop": 10439388, "income": 56642},
    {"fips": "38", "code": "ND", "name": "North Dakota", "pop": 779094, "income": 64577},
    {"fips": "39", "code": "OH", "name": "Ohio", "pop": 11799448, "income": 56602},
    {"fips": "40", "code": "OK", "name": "Oklahoma", "pop": 3959353, "income": 53840},
    {"fips": "41", "code": "OR", "name": "Oregon", "pop": 4237256, "income": 65667},
    {"fips": "42", "code": "PA", "name": "Pennsylvania", "pop": 13002700, "income": 63627},
    {"fips": "44", "code": "RI", "name": "Rhode Island", "pop": 1097379, "income": 67167},
    {"fips": "45", "code": "SC", "name": "South Carolina", "pop": 5118425, "income": 54864},
    {"fips": "46", "code": "SD", "name": "South Dakota", "pop": 886667, "income": 59533},
    {"fips": "47", "code": "TN", "name": "Tennessee", "pop": 6910840, "income": 54833},
    {"fips": "48", "code": "TX", "name": "Texas", "pop": 29145505, "income": 63826},
    {"fips": "49", "code": "UT", "name": "Utah", "pop": 3271616, "income": 74197},
    {"fips": "50", "code": "VT", "name": "Vermont", "pop": 643077, "income": 61973},
    {"fips": "51", "code": "VA", "name": "Virginia", "pop": 8631393, "income": 76398},
    {"fips": "53", "code": "WA", "name": "Washington", "pop": 7614893, "income": 77006},
    {"fips": "54", "code": "WV", "name": "West Virginia", "pop": 1793716, "income": 46711},
    {"fips": "55", "code": "WI", "name": "Wisconsin", "pop": 5893718, "income": 63293},
    {"fips": "56", "code": "WY", "name": "Wyoming", "pop": 576851, "income": 65003},
]

NAICS_SECTORS = [
    ("11", "Agriculture, Forestry, Fishing"),
    ("21", "Mining, Quarrying, Oil/Gas"),
    ("22", "Utilities"),
    ("23", "Construction"),
    ("31-33", "Manufacturing"),
    ("42", "Wholesale Trade"),
    ("44-45", "Retail Trade"),
    ("48-49", "Transportation & Warehousing"),
    ("51", "Information"),
    ("52", "Finance & Insurance"),
    ("53", "Real Estate"),
    ("54", "Professional & Technical Services"),
    ("55", "Management of Companies"),
    ("56", "Administrative & Waste Services"),
    ("61", "Educational Services"),
    ("62", "Health Care & Social Assistance"),
    ("71", "Arts, Entertainment, Recreation"),
    ("72", "Accommodation & Food Services"),
    ("81", "Other Services"),
    ("92", "Government"),
]

TRADE_PARTNERS = [
    ("CAN", "Canada", "North America", "High income"),
    ("MEX", "Mexico", "North America", "Upper middle income"),
    ("CHN", "China", "East Asia & Pacific", "Upper middle income"),
    ("JPN", "Japan", "East Asia & Pacific", "High income"),
    ("DEU", "Germany", "Europe & Central Asia", "High income"),
    ("KOR", "Korea, Rep.", "East Asia & Pacific", "High income"),
    ("GBR", "United Kingdom", "Europe & Central Asia", "High income"),
    ("IND", "India", "South Asia", "Lower middle income"),
    ("FRA", "France", "Europe & Central Asia", "High income"),
    ("TWN", "Taiwan", "East Asia & Pacific", "High income"),
    ("BRA", "Brazil", "Latin America & Caribbean", "Upper middle income"),
    ("ITA", "Italy", "Europe & Central Asia", "High income"),
    ("NLD", "Netherlands", "Europe & Central Asia", "High income"),
    ("IRL", "Ireland", "Europe & Central Asia", "High income"),
    ("VNM", "Vietnam", "East Asia & Pacific", "Lower middle income"),
    ("CHE", "Switzerland", "Europe & Central Asia", "High income"),
    ("SGP", "Singapore", "East Asia & Pacific", "High income"),
    ("THA", "Thailand", "East Asia & Pacific", "Upper middle income"),
    ("MYS", "Malaysia", "East Asia & Pacific", "Upper middle income"),
    ("SAU", "Saudi Arabia", "Middle East & North Africa", "High income"),
    ("IDN", "Indonesia", "East Asia & Pacific", "Lower middle income"),
    ("AUS", "Australia", "East Asia & Pacific", "High income"),
    ("ISR", "Israel", "Middle East & North Africa", "High income"),
    ("COL", "Colombia", "Latin America & Caribbean", "Upper middle income"),
    ("CHL", "Chile", "Latin America & Caribbean", "High income"),
    ("ARE", "United Arab Emirates", "Middle East & North Africa", "High income"),
    ("BEL", "Belgium", "Europe & Central Asia", "High income"),
    ("ESP", "Spain", "Europe & Central Asia", "High income"),
    ("PHL", "Philippines", "East Asia & Pacific", "Lower middle income"),
    ("NGA", "Nigeria", "Sub-Saharan Africa", "Lower middle income"),
]

HS_CHAPTERS = [
    ("27", "Mineral fuels, oils, distillation products"),
    ("84", "Machinery, nuclear reactors, boilers"),
    ("85", "Electrical, electronic equipment"),
    ("87", "Vehicles other than railway, tramway"),
    ("30", "Pharmaceutical products"),
    ("90", "Optical, photo, technical, medical apparatus"),
    ("39", "Plastics and articles thereof"),
    ("71", "Precious stones, metals, coins"),
    ("29", "Organic chemicals"),
    ("73", "Articles of iron or steel"),
    ("88", "Aircraft, spacecraft, and parts"),
    ("72", "Iron and steel"),
    ("94", "Furniture, lighting, signs, prefab buildings"),
    ("61", "Knitted or crocheted apparel"),
    ("62", "Woven apparel"),
    ("44", "Wood and articles of wood"),
    ("48", "Paper and paperboard"),
    ("22", "Beverages, spirits, vinegar"),
    ("03", "Fish, crustaceans, mollusks"),
    ("10", "Cereals"),
]

TRANSPORT_METHODS = ["VESSEL", "AIR", "TRUCK", "RAIL", "PIPELINE", "OTHER"]


# ---------------------------------------------------------------------------
# Census data generator
# ---------------------------------------------------------------------------

def generate_census_data(rng: random.Random, tracts: int = 5000) -> list[dict]:
    """Generate synthetic Census ACS demographic records by census tract."""
    records = []
    now = datetime.now().isoformat()

    # Census variable codes we will produce
    variables = [
        ("B01001_001E", "Total Population", "SEX BY AGE"),
        ("B01002_001E", "Median Age", "MEDIAN AGE BY SEX"),
        ("B19013_001E", "Median Household Income", "MEDIAN HOUSEHOLD INCOME"),
        ("B19301_001E", "Per Capita Income", "PER CAPITA INCOME"),
        ("B17001_001E", "Poverty Universe", "POVERTY STATUS"),
        ("B17001_002E", "Population in Poverty", "POVERTY STATUS"),
        ("B23025_002E", "Population 16+", "EMPLOYMENT STATUS"),
        ("B23025_003E", "Civilian Labor Force", "EMPLOYMENT STATUS"),
        ("B23025_004E", "Employed Population", "EMPLOYMENT STATUS"),
        ("B23025_005E", "Unemployed Population", "EMPLOYMENT STATUS"),
        ("B15003_001E", "Population 25+", "EDUCATIONAL ATTAINMENT"),
        ("B15003_017E", "High School Diploma", "EDUCATIONAL ATTAINMENT"),
        ("B15003_022E", "Bachelor's Degree", "EDUCATIONAL ATTAINMENT"),
        ("B15003_023E", "Master's Degree", "EDUCATIONAL ATTAINMENT"),
        ("B15003_024E", "Professional Degree", "EDUCATIONAL ATTAINMENT"),
        ("B15003_025E", "Doctorate Degree", "EDUCATIONAL ATTAINMENT"),
        ("B25001_001E", "Total Housing Units", "HOUSING UNITS"),
    ]

    tracts_per_state = max(1, tracts // len(STATE_INFO))

    for state in STATE_INFO:
        base_pop = state["pop"] // (tracts_per_state * 10)
        base_income = state["income"]

        for _t in range(tracts_per_state):
            county_fips = f"{rng.randint(1, 200):03d}"
            tract_fips = f"{rng.randint(100, 999999):06d}"
            geo_id = f"{state['fips']}{county_fips}{tract_fips}"

            for yr in range(2018, 2024):
                # Tract-level population with realistic variation
                tract_pop = max(100, int(base_pop * rng.gauss(1.0, 0.3)))
                year_growth = 1 + (yr - 2018) * rng.uniform(0.001, 0.015)
                tract_pop = int(tract_pop * year_growth)

                # Income variation by tract
                tract_income = max(15000, int(base_income * rng.gauss(1.0, 0.4)))
                pci = int(tract_income * rng.uniform(0.45, 0.65))

                # Employment
                pop_16_plus = int(tract_pop * rng.uniform(0.72, 0.82))
                lfpr = rng.gauss(0.63, 0.08)
                lfpr = max(0.35, min(0.85, lfpr))
                labor_force = int(pop_16_plus * lfpr)
                unemp_rate = max(0.01, rng.gauss(0.05, 0.03))
                unemployed = int(labor_force * unemp_rate)
                employed = labor_force - unemployed

                # Poverty
                pov_rate = max(0.02, rng.gauss(0.13, 0.08))
                pov_universe = int(tract_pop * 0.95)
                in_poverty = int(pov_universe * pov_rate)

                # Education
                pop_25_plus = int(tract_pop * rng.uniform(0.60, 0.72))
                hs_rate = rng.gauss(0.88, 0.05)
                bach_rate = rng.gauss(0.32, 0.12)
                bach_rate = max(0.05, min(0.75, bach_rate))
                hs_diploma = int(pop_25_plus * max(0.1, hs_rate - bach_rate))
                bachelors = int(pop_25_plus * bach_rate * 0.55)
                masters = int(pop_25_plus * bach_rate * 0.28)
                professional = int(pop_25_plus * bach_rate * 0.08)
                doctorate = int(pop_25_plus * bach_rate * 0.04)

                # Housing
                housing = int(tract_pop * rng.uniform(0.38, 0.48))

                # Median age
                median_age = round(rng.gauss(38.5, 5.0), 1)
                median_age = max(20.0, min(65.0, median_age))

                var_values = {
                    "B01001_001E": tract_pop,
                    "B01002_001E": median_age,
                    "B19013_001E": tract_income,
                    "B19301_001E": pci,
                    "B17001_001E": pov_universe,
                    "B17001_002E": in_poverty,
                    "B23025_002E": pop_16_plus,
                    "B23025_003E": labor_force,
                    "B23025_004E": employed,
                    "B23025_005E": unemployed,
                    "B15003_001E": pop_25_plus,
                    "B15003_017E": hs_diploma,
                    "B15003_022E": bachelors,
                    "B15003_023E": masters,
                    "B15003_024E": professional,
                    "B15003_025E": doctorate,
                    "B25001_001E": housing,
                }

                for var_code, var_name, var_concept in variables:
                    estimate = var_values[var_code]
                    moe = abs(int(estimate * rng.uniform(0.05, 0.25))) if estimate else 0
                    records.append({
                        "geo_id": geo_id,
                        "state_name": state["name"],
                        "county_name": f"County {county_fips}",
                        "year": yr,
                        "dataset": "acs5",
                        "variable_code": var_code,
                        "variable_name": var_name,
                        "variable_concept": var_concept,
                        "estimate": estimate,
                        "margin_of_error": moe,
                        "load_time": now,
                    })

    return records


# ---------------------------------------------------------------------------
# GDP data generator
# ---------------------------------------------------------------------------

def generate_gdp_data(
    rng: random.Random, states: int = 50, quarters: int = 40
) -> list[dict]:
    """Generate synthetic BEA GDP data by state, industry, and quarter."""
    records = []
    now = datetime.now().isoformat()

    selected_states = STATE_INFO[:states]
    # Quarters: 40 = 10 years of quarterly data
    start_year = 2024 - (quarters // 4)

    for state in selected_states:
        # State-level GDP baseline (rough approximation from population)
        state_gdp_base = state["pop"] / 1_000_000 * rng.uniform(40_000, 70_000)

        # Distribute GDP across industries
        industry_weights = {}
        remaining = 1.0
        for i, (naics, _name) in enumerate(NAICS_SECTORS):
            if i == len(NAICS_SECTORS) - 1:
                industry_weights[naics] = remaining
            else:
                w = rng.uniform(0.02, 0.12)
                w = min(w, remaining - 0.01 * (len(NAICS_SECTORS) - i - 1))
                industry_weights[naics] = w
                remaining -= w

        for q_idx in range(quarters):
            yr = start_year + q_idx // 4
            qtr = (q_idx % 4) + 1

            # GDP growth trend with some randomness
            growth_factor = 1 + q_idx * 0.005 + rng.gauss(0, 0.01)
            # Simulate recession in 2020
            if yr == 2020 and qtr <= 2:
                growth_factor *= rng.uniform(0.88, 0.95)

            price_index = 100 + (yr - 2017) * 2.1 + rng.gauss(0, 0.5)

            for naics, industry_name in NAICS_SECTORS:
                sector_gdp = state_gdp_base * industry_weights[naics] * growth_factor
                sector_gdp *= rng.gauss(1.0, 0.03)  # quarterly noise
                sector_gdp = max(0.1, sector_gdp)

                gdp_current = round(sector_gdp * (price_index / 100), 2)
                gdp_chained = round(sector_gdp, 2)

                records.append({
                    "state_fips": state["fips"],
                    "state_name": state["name"],
                    "region_code": None,
                    "region_name": None,
                    "year": yr,
                    "quarter": qtr,
                    "naics_sector": naics,
                    "industry_name": industry_name,
                    "industry_description": industry_name,
                    "gdp_current_dollars": gdp_current,
                    "gdp_chained_dollars": gdp_chained,
                    "personal_income": round(gdp_current * rng.uniform(0.5, 0.7), 2),
                    "compensation": round(gdp_current * rng.uniform(0.4, 0.55), 2),
                    "taxes_on_production": round(gdp_current * rng.uniform(0.05, 0.10), 2),
                    "subsidies": round(gdp_current * rng.uniform(0.01, 0.03), 2),
                    "gross_operating_surplus": round(gdp_current * rng.uniform(0.25, 0.40), 2),
                    "price_index": round(price_index, 4),
                    "quantity_index": round(100 + (yr - 2017) * 1.8 + rng.gauss(0, 0.3), 4),
                    "table_name": "SQGDP2",
                    "line_code": naics,
                    "unit_of_measure": "Millions of dollars",
                    "scale_factor": "Millions",
                    "is_seasonally_adjusted": True,
                    "estimate_type": rng.choice(["FINAL", "THIRD", "SECOND"]),
                    "load_time": now,
                })

            # Also produce ALL-industry total
            total_gdp = state_gdp_base * growth_factor
            total_current = round(total_gdp * (price_index / 100), 2)
            records.append({
                "state_fips": state["fips"],
                "state_name": state["name"],
                "region_code": None,
                "region_name": None,
                "year": yr,
                "quarter": qtr,
                "naics_sector": "ALL",
                "industry_name": "All Industries",
                "industry_description": "All Industries",
                "gdp_current_dollars": total_current,
                "gdp_chained_dollars": round(total_gdp, 2),
                "personal_income": round(total_current * 0.60, 2),
                "compensation": round(total_current * 0.48, 2),
                "taxes_on_production": round(total_current * 0.07, 2),
                "subsidies": round(total_current * 0.02, 2),
                "gross_operating_surplus": round(total_current * 0.32, 2),
                "price_index": round(price_index, 4),
                "quantity_index": round(100 + (yr - 2017) * 1.8, 4),
                "table_name": "SQGDP2",
                "line_code": "ALL",
                "unit_of_measure": "Millions of dollars",
                "scale_factor": "Millions",
                "is_seasonally_adjusted": True,
                "estimate_type": "FINAL",
                "load_time": now,
            })

    return records


# ---------------------------------------------------------------------------
# Trade data generator
# ---------------------------------------------------------------------------

def generate_trade_data(rng: random.Random, n: int = 20000) -> list[dict]:
    """Generate synthetic international trade transactions.

    Produces export and import records with realistic partner country
    distributions, HS commodity codes, and seasonal variation.
    """
    records = []
    now = datetime.now().isoformat()

    # Weight distribution for partners (top partners get more transactions)
    partner_weights = [max(0.5, 10 - i * 0.3) for i in range(len(TRADE_PARTNERS))]
    total_weight = sum(partner_weights)
    partner_weights = [w / total_weight for w in partner_weights]

    # Trade value distributions by partner (billions USD annual)
    # Top partners like Canada, China, Mexico have higher values
    partner_base_values = {
        "CAN": 350e9, "CHN": 300e9, "MEX": 320e9, "JPN": 100e9,
        "DEU": 90e9, "KOR": 80e9, "GBR": 70e9, "IND": 50e9,
    }

    districts = [
        ("01", "Portland, ME"), ("10", "New York, NY"), ("13", "Philadelphia, PA"),
        ("14", "Norfolk, VA"), ("18", "Charleston, SC"), ("20", "Savannah, GA"),
        ("25", "New Orleans, LA"), ("30", "Houston, TX"), ("31", "Laredo, TX"),
        ("33", "Los Angeles, CA"), ("35", "San Francisco, CA"), ("36", "Seattle, WA"),
        ("40", "Detroit, MI"), ("41", "Chicago, IL"), ("52", "Miami, FL"),
    ]

    for i in range(n):
        # Pick partner with weighted distribution
        partner_idx = rng.choices(range(len(TRADE_PARTNERS)), weights=partner_weights, k=1)[0]
        partner = TRADE_PARTNERS[partner_idx]

        # Pick commodity
        hs_ch_idx = rng.randint(0, len(HS_CHAPTERS) - 1)
        hs_chapter_code, hs_desc = HS_CHAPTERS[hs_ch_idx]
        hs_heading = f"{hs_chapter_code}{rng.randint(10, 99):02d}"
        hs_subheading = f"{hs_heading}{rng.randint(10, 99):02d}"
        hs_full = f"{hs_subheading}{rng.randint(10, 99):02d}"

        flow = rng.choice(["EXPORT", "IMPORT"])

        yr = rng.randint(2015, 2024)
        month = rng.randint(1, 12)

        # Trade value: log-normal distribution for realistic skew
        base_val = partner_base_values.get(partner[0], 20e9)
        mean_val = base_val / (12 * len(HS_CHAPTERS))  # per-month per-commodity
        trade_value = max(1000, rng.lognormvariate(math.log(mean_val), 1.2))

        # Seasonal adjustment
        seasonal_factor = 1.0 + 0.15 * math.sin(2 * math.pi * (month - 3) / 12)
        trade_value *= seasonal_factor

        # Quantity
        quantity = max(1, trade_value / rng.uniform(50, 5000))
        weight_kg = quantity * rng.uniform(0.1, 100)

        # Tariff (imports only)
        duty = 0.0
        if flow == "IMPORT":
            tariff_rate = rng.uniform(0, 0.15)
            if partner[0] in ("CAN", "MEX"):  # USMCA preferential
                tariff_rate *= 0.1
            duty = trade_value * tariff_rate

        district = rng.choice(districts)
        transport = rng.choices(
            TRANSPORT_METHODS,
            weights=[35, 25, 20, 10, 8, 2],
            k=1
        )[0]

        trade_id = hashlib.md5(
            f"{partner[0]}|{hs_full}|{flow}|{yr}|{month}|{i}".encode()
        ).hexdigest()

        records.append({
            "trade_id": trade_id,
            "flow_type": flow,
            "partner_country_code": partner[0],
            "partner_country_name": partner[1],
            "partner_region": partner[2],
            "partner_income_group": partner[3],
            "hs_code": hs_full,
            "commodity_description": hs_desc,
            "commodity_section": None,
            "year": yr,
            "month": month,
            "trade_value_usd": round(trade_value, 2),
            "quantity": round(quantity, 4),
            "quantity_unit": rng.choice(["KG", "NO", "LTR", "M2", "PCS"]),
            "district_code": district[0],
            "district_name": district[1],
            "transport_method": transport,
            "customs_value_usd": round(trade_value * rng.uniform(0.95, 1.05), 2),
            "duty_collected_usd": round(duty, 2),
            "shipping_weight_kg": round(weight_kg, 4),
            "load_time": now,
        })

    return records


# ---------------------------------------------------------------------------
# File writing
# ---------------------------------------------------------------------------

def write_csv(rows: list[dict], filepath: str) -> None:
    """Write a list of dicts to a CSV file."""
    if not rows:
        return
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    fieldnames = list(rows[0].keys())
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Wrote {len(rows):,} rows to {filepath}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate synthetic Commerce Department data for CSA-in-a-Box"
    )
    parser.add_argument(
        "--records",
        type=int,
        default=5000,
        help="Base record count (used for census tracts and trade records)",
    )
    parser.add_argument(
        "--census-tracts",
        type=int,
        default=None,
        help="Number of census tracts to generate (default: --records value)",
    )
    parser.add_argument(
        "--gdp-states",
        type=int,
        default=50,
        help="Number of states to generate GDP data for (default: 50)",
    )
    parser.add_argument(
        "--gdp-quarters",
        type=int,
        default=40,
        help="Number of quarters of GDP data (default: 40 = 10 years)",
    )
    parser.add_argument(
        "--trade-records",
        type=int,
        default=None,
        help="Number of trade transactions (default: --records value)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="output",
        help="Output directory for CSV files (default: output)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )

    args = parser.parse_args()

    census_tracts = args.census_tracts or args.records
    trade_records = args.trade_records or args.records

    rng = random.Random(args.seed)

    print("=" * 60)
    print("Commerce Department Synthetic Data Generator")
    print("=" * 60)
    print(f"  Census tracts:   {census_tracts:,}")
    print(f"  GDP states:      {args.gdp_states}")
    print(f"  GDP quarters:    {args.gdp_quarters}")
    print(f"  Trade records:   {trade_records:,}")
    print(f"  Output dir:      {args.output_dir}")
    print(f"  Random seed:     {args.seed}")
    print()

    print("[1/3] Generating Census ACS demographic data...")
    census = generate_census_data(rng, tracts=census_tracts)
    write_csv(census, os.path.join(args.output_dir, "census_demographics.csv"))
    print()

    print("[2/3] Generating BEA GDP data...")
    gdp = generate_gdp_data(rng, states=args.gdp_states, quarters=args.gdp_quarters)
    write_csv(gdp, os.path.join(args.output_dir, "bea_gdp.csv"))
    print()

    print("[3/3] Generating international trade data...")
    trade = generate_trade_data(rng, n=trade_records)
    write_csv(trade, os.path.join(args.output_dir, "trade_transactions.csv"))
    print()

    print("=" * 60)
    total = len(census) + len(gdp) + len(trade)
    print(f"Done! Generated {total:,} total records.")
    print(f"Files saved to: {os.path.abspath(args.output_dir)}")
    print("=" * 60)


if __name__ == "__main__":
    main()
