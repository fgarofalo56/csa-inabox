"""
Tribal Health Data Warehouse — Synthetic Data Generator

Generates clinically realistic but ENTIRELY SYNTHETIC data for tribal health
analytics development and demonstration. No real patient data is used.

Data generated:
- Patient demographics (tribal affiliation, service unit, age/gender distributions)
- Clinical encounters (ICD-10 diagnoses with realistic prevalence distributions)
- IHS/tribal facilities (hospitals, health centers, satellite clinics)

Clinical distributions are based on publicly available IHS aggregate statistics
(IHS Indian Health Disparities Fact Sheet, IHS GPRA reports, CDC WONDER) to
produce statistically plausible data for analytics development.

Usage:
    python generate_tribal_health_data.py --patients 25000 --days 730 --facilities 50
"""

from __future__ import annotations

import argparse
import csv
import logging
import random
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────
# Configuration Constants — Based on IHS Public Statistics
# ──────────────────────────────────────────────────────────────

# IHS Service Units (12 area offices)
SERVICE_UNITS = [
    "Aberdeen", "Albuquerque", "Bemidji", "Billings", "California",
    "Great Plains", "Nashville", "Navajo", "Oklahoma", "Phoenix",
    "Portland", "Tucson",
]

# Synthetic tribal affiliations (representative, not exhaustive)
# Mapped to service units where they are most commonly served
TRIBAL_AFFILIATIONS = {
    "Navajo": ["NAV"],
    "Phoenix": ["GRV", "AKC", "TON", "PIL"],
    "Tucson": ["TOH", "PAS"],
    "Oklahoma": ["CHE", "CHK", "MUS", "SEM", "COM"],
    "Aberdeen": ["OGL", "RSB", "SIS", "CRO"],
    "Great Plains": ["LAK", "YAN", "WIN", "SAN"],
    "Albuquerque": ["ZUN", "JIC", "ISL", "ACO"],
    "Billings": ["CRW", "BLK", "NPC", "FLH"],
    "Bemidji": ["OJI", "ONE", "MEN", "POT"],
    "California": ["YUR", "HOO", "KAR", "POM"],
    "Nashville": ["EBC", "MIS", "POW", "SEM_E"],
    "Portland": ["YAK", "NPI", "COL", "WRM"],
}

# Age distribution matching IHS user population (younger skew than US general)
AGE_GROUPS = [
    ("0-4", 0.08), ("5-9", 0.08), ("10-14", 0.07), ("15-19", 0.08),
    ("20-24", 0.09), ("25-29", 0.09), ("30-34", 0.08), ("35-39", 0.07),
    ("40-44", 0.07), ("45-49", 0.06), ("50-54", 0.06), ("55-59", 0.05),
    ("60-64", 0.04), ("65-69", 0.03), ("70-74", 0.02), ("75-79", 0.02),
    ("80+", 0.01),
]

GENDERS = [("M", 0.48), ("F", 0.50), ("NB", 0.02)]

ELIGIBILITY_STATUSES = [
    ("ACTIVE", 0.82), ("INACTIVE", 0.10), ("PENDING", 0.05),
    ("TERMINATED", 0.03),
]

ENCOUNTER_TYPES = [
    ("OUTPATIENT", 0.65), ("ED", 0.12), ("INPATIENT", 0.08),
    ("TELEHEALTH", 0.15),
]

PROVIDER_TYPES = [
    ("MD", 0.30), ("DO", 0.10), ("NP", 0.25), ("PA", 0.15),
    ("RN", 0.08), ("LCSW", 0.05), ("PhD_PSY", 0.04), ("PharmD", 0.03),
]

DISPOSITIONS = [
    ("DISCHARGED", 0.70), ("FOLLOW_UP", 0.18), ("ADMITTED", 0.05),
    ("TRANSFERRED", 0.03), ("AMA", 0.02), ("DECEASED", 0.002),
    ("OTHER", 0.018),
]

FACILITY_TYPES = [
    ("HOSPITAL", 0.15), ("HEALTH_CENTER", 0.55), ("SATELLITE", 0.30),
]

# ──────────────────────────────────────────────────────────────
# ICD-10 Diagnosis Distributions
# Based on IHS Indian Health Disparities Fact Sheet and GPRA data.
# AI/AN populations have significantly higher rates of diabetes,
# behavioral health conditions, and unintentional injuries.
# ──────────────────────────────────────────────────────────────

# Diagnosis category weights (probability of each category per encounter)
DIAGNOSIS_CATEGORIES = {
    "DIABETES": 0.12,          # ~14.7% prevalence in AI/AN (2-3x national avg)
    "BEHAVIORAL_SUD": 0.08,    # Substance use disorders
    "BEHAVIORAL_MH": 0.10,     # Mental health (depression, anxiety, PTSD)
    "MATERNAL": 0.06,          # Prenatal, delivery, postpartum
    "PREVENTIVE": 0.15,        # Well-child, immunizations, screening
    "RESPIRATORY": 0.10,       # URI, asthma, pneumonia
    "CARDIOVASCULAR": 0.05,    # Hypertension, heart disease
    "INJURY": 0.06,            # Unintentional injuries (3x national avg)
    "MUSCULOSKELETAL": 0.05,
    "OTHER": 0.23,
}

# ICD-10 code pools by category
ICD10_POOLS: dict[str, list[tuple[str, float]]] = {
    "DIABETES": [
        ("E11.9", 0.35),    # Type 2, without complications
        ("E11.65", 0.15),   # Type 2, hyperglycemia
        ("E11.22", 0.10),   # Type 2, chronic kidney disease
        ("E11.319", 0.08),  # Type 2, unspecified retinopathy
        ("E11.40", 0.08),   # Type 2, neuropathy
        ("E11.51", 0.06),   # Type 2, peripheral angiopathy
        ("E11.621", 0.05),  # Type 2, foot ulcer
        ("E11.69", 0.05),   # Type 2, other complication
        ("E13.9", 0.05),    # Other specified diabetes
        ("E11.10", 0.03),   # Type 2, ketoacidosis
    ],
    "BEHAVIORAL_SUD": [
        ("F10.20", 0.30),   # Alcohol dependence, uncomplicated
        ("F10.10", 0.12),   # Alcohol abuse, uncomplicated
        ("F11.20", 0.10),   # Opioid dependence
        ("F12.20", 0.10),   # Cannabis dependence
        ("F17.210", 0.15),  # Nicotine dependence, cigarettes
        ("F15.20", 0.08),   # Stimulant dependence (methamphetamine)
        ("F19.20", 0.05),   # Other psychoactive substance dependence
        ("F10.239", 0.05),  # Alcohol dependence with withdrawal
        ("F11.10", 0.03),   # Opioid abuse
        ("F13.20", 0.02),   # Sedative dependence
    ],
    "BEHAVIORAL_MH": [
        ("F32.1", 0.25),    # Major depressive disorder, moderate
        ("F41.1", 0.18),    # Generalized anxiety disorder
        ("F43.10", 0.15),   # PTSD, unspecified
        ("F32.0", 0.10),    # Major depressive, mild
        ("F33.1", 0.08),    # Recurrent depressive, moderate
        ("F41.0", 0.06),    # Panic disorder
        ("F31.9", 0.05),    # Bipolar disorder, unspecified
        ("F43.23", 0.05),   # Adjustment disorder, mixed anxiety/depression
        ("F40.10", 0.04),   # Social phobia
        ("F34.1", 0.04),    # Dysthymic disorder
    ],
    "MATERNAL": [
        ("Z34.90", 0.25),   # Supervision of normal pregnancy
        ("Z36.9", 0.15),    # Prenatal screening
        ("O24.410", 0.10),  # Gestational diabetes, diet controlled
        ("O13.9", 0.08),    # Gestational hypertension
        ("Z3A.28", 0.08),   # 28 weeks gestation
        ("O80", 0.10),      # Normal delivery
        ("O60.10", 0.05),   # Preterm labor
        ("O99.810", 0.05),  # Abnormal glucose, pregnancy
        ("O09.90", 0.07),   # Supervision of high-risk pregnancy
        ("O90.89", 0.07),   # Postpartum complication
    ],
    "PREVENTIVE": [
        ("Z00.00", 0.25),   # General adult examination
        ("Z23", 0.20),      # Immunization encounter
        ("Z00.129", 0.15),  # Well-child visit
        ("Z01.419", 0.10),  # Gynecological examination
        ("Z12.11", 0.08),   # Screening for colon malignancy
        ("Z12.31", 0.08),   # Screening for breast malignancy
        ("Z13.1", 0.07),    # Screening for diabetes
        ("Z02.9", 0.04),    # Administrative examination
        ("Z01.10", 0.03),   # Ear examination
    ],
    "RESPIRATORY": [
        ("J06.9", 0.30),    # Acute upper respiratory infection
        ("J20.9", 0.15),    # Acute bronchitis
        ("J45.20", 0.12),   # Mild intermittent asthma
        ("J18.9", 0.10),    # Pneumonia, unspecified
        ("J02.9", 0.10),    # Acute pharyngitis
        ("J30.9", 0.08),    # Allergic rhinitis
        ("J45.40", 0.05),   # Moderate persistent asthma
        ("J44.1", 0.05),    # COPD with acute exacerbation
        ("J40", 0.05),      # Bronchitis NOS
    ],
    "CARDIOVASCULAR": [
        ("I10", 0.40),      # Essential hypertension
        ("I25.10", 0.15),   # Atherosclerotic heart disease
        ("I50.9", 0.10),    # Heart failure, unspecified
        ("I48.91", 0.08),   # Unspecified atrial fibrillation
        ("I63.9", 0.07),    # Cerebral infarction
        ("I21.9", 0.05),    # Acute MI, unspecified
        ("I70.0", 0.05),    # Atherosclerosis of aorta
        ("I42.9", 0.05),    # Cardiomyopathy
        ("I73.9", 0.05),    # Peripheral vascular disease
    ],
    "INJURY": [
        ("S61.419A", 0.15), # Laceration of hand
        ("S93.401A", 0.12), # Sprained ankle
        ("S52.501A", 0.10), # Fracture, forearm
        ("S00.83XA", 0.10), # Contusion of head
        ("S82.001A", 0.08), # Fracture, lower leg
        ("T14.90XA", 0.08), # Injury, unspecified
        ("S09.90XA", 0.07), # Head injury, unspecified
        ("S42.001A", 0.07), # Fracture, clavicle
        ("T30.0", 0.08),    # Burn, unspecified
        ("S72.001A", 0.08), # Fracture, femur
        ("T43.011A", 0.07), # Poisoning (accidental)
    ],
    "MUSCULOSKELETAL": [
        ("M54.5", 0.25),    # Low back pain
        ("M25.50", 0.15),   # Joint pain, unspecified
        ("M79.3", 0.12),    # Panniculitis
        ("M17.11", 0.10),   # Primary osteoarthritis, knee
        ("M54.2", 0.10),    # Cervicalgia
        ("M62.830", 0.08),  # Muscle spasm of back
        ("M75.10", 0.08),   # Rotator cuff tear
        ("M19.90", 0.07),   # Osteoarthritis, unspecified
        ("M79.1", 0.05),    # Myalgia
    ],
    "OTHER": [
        ("K21.0", 0.12),    # GERD
        ("L30.9", 0.10),    # Dermatitis
        ("N39.0", 0.10),    # UTI
        ("R51.9", 0.08),    # Headache
        ("K59.00", 0.07),   # Constipation
        ("R10.9", 0.07),    # Abdominal pain
        ("H10.9", 0.06),    # Conjunctivitis
        ("B34.9", 0.06),    # Viral infection
        ("R05.9", 0.06),    # Cough
        ("H66.90", 0.06),   # Otitis media
        ("K08.109", 0.05),  # Dental caries
        ("E78.5", 0.05),    # Hyperlipidemia
        ("E03.9", 0.04),    # Hypothyroidism
        ("N18.3", 0.04),    # Chronic kidney disease stage 3
        ("D64.9", 0.04),    # Anemia, unspecified
    ],
}

# Services commonly offered by IHS/tribal facilities
FACILITY_SERVICES = [
    "PRIMARY_CARE", "DENTAL", "PHARMACY", "BEHAVIORAL_HEALTH",
    "OBSTETRICS", "EMERGENCY", "TELEHEALTH", "RADIOLOGY",
    "LABORATORY", "OPTOMETRY", "PHYSICAL_THERAPY", "NUTRITION",
    "COMMUNITY_HEALTH", "SUBSTANCE_ABUSE_TREATMENT",
]

# State mapping for service units
SERVICE_UNIT_STATES = {
    "Aberdeen": ["SD", "ND", "NE", "IA"],
    "Albuquerque": ["NM", "CO", "TX"],
    "Bemidji": ["MN", "WI", "MI", "IN"],
    "Billings": ["MT", "WY"],
    "California": ["CA"],
    "Great Plains": ["SD", "ND", "NE"],
    "Nashville": ["NC", "MS", "FL", "LA", "TN", "AL"],
    "Navajo": ["AZ", "NM", "UT"],
    "Oklahoma": ["OK", "KS", "TX"],
    "Phoenix": ["AZ", "NV", "UT"],
    "Portland": ["OR", "WA", "ID"],
    "Tucson": ["AZ"],
}


@dataclass
class GeneratorConfig:
    """Configuration for the synthetic data generator."""
    num_patients: int = 25000
    num_facilities: int = 50
    days_of_data: int = 730
    start_date: datetime = field(
        default_factory=lambda: datetime(2023, 1, 1)
    )
    output_dir: Path = field(
        default_factory=lambda: Path("seeds")
    )
    seed: int = 42


def _weighted_choice(items: list[tuple], rng: random.Random) -> str:
    """Select from a list of (value, weight) tuples."""
    values, weights = zip(*items)
    return rng.choices(values, weights=weights, k=1)[0]


def generate_patient_demographics(config: GeneratorConfig) -> list[dict]:
    """
    Generate synthetic patient demographics across 12 IHS service units.

    Demographics reflect IHS user population characteristics:
    - Younger age distribution than US general population
    - Geographic distribution across service units
    - Realistic tribal affiliation assignments
    - Enrollment status mix
    """
    rng = random.Random(config.seed)
    patients = []

    # Distribute patients across service units (weighted by actual IHS user pop)
    su_weights = {
        "Navajo": 0.14, "Oklahoma": 0.16, "Phoenix": 0.10,
        "Aberdeen": 0.07, "Great Plains": 0.07, "Albuquerque": 0.08,
        "Bemidji": 0.08, "Billings": 0.06, "California": 0.08,
        "Nashville": 0.05, "Portland": 0.07, "Tucson": 0.04,
    }

    for i in range(config.num_patients):
        # Assign service unit
        service_unit = rng.choices(
            list(su_weights.keys()),
            weights=list(su_weights.values()),
            k=1,
        )[0]

        # Assign tribal affiliation based on service unit
        affiliations = TRIBAL_AFFILIATIONS.get(service_unit, ["UNK"])
        tribal_affiliation = rng.choice(affiliations)

        # Demographics
        age_group = _weighted_choice(AGE_GROUPS, rng)
        gender = _weighted_choice(GENDERS, rng)

        # Enrollment date (1-10 years ago)
        enrollment_offset = rng.randint(365, 365 * 10)
        enrollment_date = config.start_date - timedelta(days=enrollment_offset)

        # Eligibility
        eligibility = _weighted_choice(ELIGIBILITY_STATUSES, rng)

        # ZIP code (synthetic, based on service unit state)
        states = SERVICE_UNIT_STATES.get(service_unit, ["XX"])
        state = rng.choice(states)
        # Generate a plausible ZIP prefix based on state
        zip_prefixes = {
            "AZ": range(85000, 86600), "NM": range(87000, 88500),
            "OK": range(73000, 74999), "SD": range(57000, 57800),
            "ND": range(58000, 58900), "MT": range(59000, 59999),
            "MN": range(55000, 56800), "WI": range(53000, 54999),
            "OR": range(97000, 97999), "WA": range(98000, 99499),
            "CA": range(90000, 96199), "NE": range(68000, 69999),
            "NC": range(27000, 28999), "UT": range(84000, 84999),
            "WY": range(82000, 83199), "CO": range(80000, 81699),
            "MI": range(48000, 49999), "ID": range(83200, 83899),
            "TX": range(75000, 79999), "MS": range(38600, 39799),
            "FL": range(32000, 34999), "LA": range(70000, 71499),
            "TN": range(37000, 38599), "AL": range(35000, 36999),
            "KS": range(66000, 67999), "NV": range(89000, 89899),
            "IA": range(50000, 52899), "IN": range(46000, 47999),
        }
        zip_range = zip_prefixes.get(state, range(10000, 99999))
        zip_code = str(rng.choice(list(zip_range)))

        patients.append({
            "patient_id": f"PTH-{i + 1:06d}",
            "tribal_affiliation": tribal_affiliation,
            "service_unit": service_unit,
            "age_group": age_group,
            "gender": gender,
            "zip_code": zip_code,
            "enrollment_date": enrollment_date.strftime("%Y-%m-%d"),
            "eligibility_status": eligibility,
        })

    logger.info(f"Generated {len(patients)} patient demographics")
    return patients


def generate_encounters(
    config: GeneratorConfig,
    patients: Sequence[dict],
) -> list[dict]:
    """
    Generate synthetic clinical encounters with realistic diagnosis distributions.

    Encounter distributions reflect IHS statistics:
    - High diabetes prevalence (~14.7% vs 7.5% national)
    - Elevated behavioral health encounters (SUD, depression, PTSD)
    - Higher injury rates (unintentional injuries 3x national avg)
    - Seasonal variation in respiratory and injury encounters
    - Age-appropriate diagnosis assignment (maternal only for females 15-44,
      pediatric preventive for children, etc.)
    """
    rng = random.Random(config.seed + 1)
    encounters = []

    # Only active patients have encounters
    active_patients = [p for p in patients if p["eligibility_status"] in ("ACTIVE", "PENDING")]

    # Assign facilities to service units
    facilities_by_su = {}
    for su in SERVICE_UNITS:
        facilities_by_su[su] = [f"FAC-{su[:3].upper()}-{j:03d}" for j in range(1, 6)]

    for day_offset in range(config.days_of_data):
        current_date = config.start_date + timedelta(days=day_offset)
        day_of_week = current_date.weekday()
        month = current_date.month

        # Seasonal multiplier (more respiratory in winter, more injuries in summer)
        seasonal_mult = 1.0
        if month in (12, 1, 2):
            seasonal_mult = 1.15  # Winter: more respiratory
        elif month in (6, 7, 8):
            seasonal_mult = 1.08  # Summer: more injuries

        # Weekend reduction
        if day_of_week >= 5:
            seasonal_mult *= 0.4  # Fewer encounters on weekends

        # Daily encounter rate: ~3-5% of active population per day
        daily_rate = 0.04 * seasonal_mult
        num_encounters = int(len(active_patients) * daily_rate)
        day_patients = rng.sample(
            active_patients, min(num_encounters, len(active_patients))
        )

        for patient in day_patients:
            age_group = patient["age_group"]
            gender = patient["gender"]
            service_unit = patient["service_unit"]

            # Adjust diagnosis category weights based on patient demographics
            dx_weights = dict(DIAGNOSIS_CATEGORIES)

            # Age-appropriate adjustments
            age_num = _age_group_to_midpoint(age_group)
            if age_num < 15:
                # Children: more preventive, respiratory; no maternal
                dx_weights["PREVENTIVE"] = 0.30
                dx_weights["RESPIRATORY"] = 0.20
                dx_weights["MATERNAL"] = 0.0
                dx_weights["DIABETES"] = 0.02
                dx_weights["CARDIOVASCULAR"] = 0.01
                dx_weights["BEHAVIORAL_SUD"] = 0.0
                dx_weights["BEHAVIORAL_MH"] = 0.04
            elif age_num >= 65:
                # Elders: more chronic disease, less maternal
                dx_weights["DIABETES"] = 0.20
                dx_weights["CARDIOVASCULAR"] = 0.15
                dx_weights["MATERNAL"] = 0.0
                dx_weights["PREVENTIVE"] = 0.10
                dx_weights["INJURY"] = 0.04
            elif 15 <= age_num <= 44 and gender == "F":
                # Women of reproductive age: maternal possible
                dx_weights["MATERNAL"] = 0.08
            else:
                dx_weights["MATERNAL"] = 0.0

            # Winter boost for respiratory
            if month in (12, 1, 2):
                dx_weights["RESPIRATORY"] = dx_weights.get("RESPIRATORY", 0.10) * 1.5

            # Normalize weights
            total = sum(dx_weights.values())
            dx_weights = {k: v / total for k, v in dx_weights.items()}

            # Select diagnosis category
            dx_category = rng.choices(
                list(dx_weights.keys()),
                weights=list(dx_weights.values()),
                k=1,
            )[0]

            # Select specific ICD-10 code from category pool
            icd10_pool = ICD10_POOLS.get(dx_category, ICD10_POOLS["OTHER"])
            primary_dx = _weighted_choice(icd10_pool, rng)

            # Generate 0-2 secondary diagnoses
            num_secondary = rng.choices([0, 1, 2], weights=[0.5, 0.35, 0.15], k=1)[0]
            secondary_codes = []
            if num_secondary > 0:
                # Add common co-morbidities
                if dx_category == "DIABETES":
                    comorbid_pool = ICD10_POOLS["CARDIOVASCULAR"] + [("E78.5", 0.2)]
                elif dx_category in ("BEHAVIORAL_SUD", "BEHAVIORAL_MH"):
                    comorbid_pool = ICD10_POOLS["BEHAVIORAL_MH"] + ICD10_POOLS["BEHAVIORAL_SUD"]
                else:
                    comorbid_pool = ICD10_POOLS["OTHER"]
                for _ in range(num_secondary):
                    secondary_codes.append(_weighted_choice(comorbid_pool, rng))

            # Encounter type (adjusted by diagnosis)
            enc_type_weights = list(ENCOUNTER_TYPES)
            if dx_category == "INJURY":
                enc_type_weights = [
                    ("OUTPATIENT", 0.30), ("ED", 0.50),
                    ("INPATIENT", 0.15), ("TELEHEALTH", 0.05),
                ]
            elif dx_category in ("BEHAVIORAL_SUD", "BEHAVIORAL_MH"):
                enc_type_weights = [
                    ("OUTPATIENT", 0.60), ("ED", 0.10),
                    ("INPATIENT", 0.10), ("TELEHEALTH", 0.20),
                ]
            elif dx_category == "MATERNAL":
                enc_type_weights = [
                    ("OUTPATIENT", 0.75), ("ED", 0.05),
                    ("INPATIENT", 0.15), ("TELEHEALTH", 0.05),
                ]
            elif dx_category == "PREVENTIVE":
                enc_type_weights = [
                    ("OUTPATIENT", 0.80), ("ED", 0.0),
                    ("INPATIENT", 0.0), ("TELEHEALTH", 0.20),
                ]

            encounter_type = _weighted_choice(enc_type_weights, rng)

            # Provider type
            if dx_category in ("BEHAVIORAL_SUD", "BEHAVIORAL_MH"):
                prov_weights = [
                    ("LCSW", 0.30), ("PhD_PSY", 0.20), ("MD", 0.20),
                    ("NP", 0.15), ("PA", 0.10), ("RN", 0.05),
                ]
            else:
                prov_weights = PROVIDER_TYPES

            provider_type = _weighted_choice(prov_weights, rng)

            # Disposition
            disposition = _weighted_choice(DISPOSITIONS, rng)
            if encounter_type == "ED" and dx_category == "INJURY":
                disposition = rng.choices(
                    ["DISCHARGED", "ADMITTED", "TRANSFERRED"],
                    weights=[0.70, 0.20, 0.10], k=1
                )[0]

            # Facility
            su_facilities = facilities_by_su.get(service_unit, ["FAC-UNK-001"])
            facility_id = rng.choice(su_facilities)

            encounters.append({
                "encounter_id": f"ENC-{uuid.uuid4().hex[:10].upper()}",
                "patient_id": patient["patient_id"],
                "facility_id": facility_id,
                "encounter_date": current_date.strftime("%Y-%m-%d"),
                "encounter_type": encounter_type,
                "primary_dx_icd10": primary_dx,
                "secondary_dx_codes": "|".join(secondary_codes) if secondary_codes else "",
                "provider_type": provider_type,
                "disposition": disposition,
            })

    logger.info(f"Generated {len(encounters)} encounter records over {config.days_of_data} days")
    return encounters


def generate_facilities(config: GeneratorConfig) -> list[dict]:
    """
    Generate IHS and tribal facility reference data.

    Facilities reflect the IHS system structure:
    - ~25 IHS hospitals
    - ~300+ health centers
    - Satellite clinics and health stations
    - Realistic bed counts and staffing levels
    """
    rng = random.Random(config.seed + 2)
    facilities = []

    facility_names = {
        "HOSPITAL": [
            "{tribe} Indian Hospital", "{su} Service Unit Hospital",
            "{tribe} Memorial Hospital", "{su} Area Medical Center",
        ],
        "HEALTH_CENTER": [
            "{tribe} Health Center", "{su} Community Health Center",
            "{tribe} Indian Health Center", "{su} Family Health Center",
            "{tribe} Wellness Center",
        ],
        "SATELLITE": [
            "{tribe} Health Station", "{su} Satellite Clinic",
            "{tribe} Outreach Clinic", "{su} Community Clinic",
        ],
    }

    for i in range(config.num_facilities):
        # Assign to service unit
        service_unit = rng.choice(SERVICE_UNITS)
        affiliations = TRIBAL_AFFILIATIONS.get(service_unit, ["UNK"])
        tribal_affiliation = rng.choice(affiliations)
        states = SERVICE_UNIT_STATES.get(service_unit, ["XX"])
        state = rng.choice(states)

        # Facility type
        facility_type = _weighted_choice(FACILITY_TYPES, rng)

        # Generate name
        name_templates = facility_names[facility_type]
        name_template = rng.choice(name_templates)
        facility_name = name_template.format(
            tribe=tribal_affiliation,
            su=service_unit,
        )

        # Capacity based on facility type
        if facility_type == "HOSPITAL":
            bed_count = rng.randint(20, 150)
            provider_count = rng.randint(15, 80)
            num_services = rng.randint(8, 14)
        elif facility_type == "HEALTH_CENTER":
            bed_count = rng.randint(0, 10)
            provider_count = rng.randint(5, 30)
            num_services = rng.randint(5, 10)
        else:  # SATELLITE
            bed_count = 0
            provider_count = rng.randint(2, 8)
            num_services = rng.randint(2, 5)

        # Services offered
        if facility_type == "HOSPITAL":
            # Hospitals always have core services
            services = ["PRIMARY_CARE", "PHARMACY", "EMERGENCY", "LABORATORY", "RADIOLOGY"]
            remaining = [s for s in FACILITY_SERVICES if s not in services]
            services.extend(rng.sample(remaining, min(num_services - len(services), len(remaining))))
        elif facility_type == "HEALTH_CENTER":
            services = ["PRIMARY_CARE", "PHARMACY"]
            remaining = [s for s in FACILITY_SERVICES if s not in services and s != "EMERGENCY"]
            services.extend(rng.sample(remaining, min(num_services - len(services), len(remaining))))
        else:
            services = ["PRIMARY_CARE"]
            remaining = [s for s in FACILITY_SERVICES if s not in services and s not in ("EMERGENCY", "RADIOLOGY")]
            services.extend(rng.sample(remaining, min(num_services - len(services), len(remaining))))

        facilities.append({
            "facility_id": f"FAC-{service_unit[:3].upper()}-{i + 1:03d}",
            "facility_name": facility_name,
            "facility_type": facility_type,
            "service_unit": service_unit,
            "tribal_affiliation": tribal_affiliation,
            "state": state,
            "bed_count": bed_count,
            "provider_count": provider_count,
            "services_offered": "|".join(sorted(services)),
        })

    logger.info(f"Generated {len(facilities)} facility records")
    return facilities


def _age_group_to_midpoint(age_group: str) -> int:
    """Convert age group string to approximate midpoint age."""
    if age_group == "80+":
        return 85
    parts = age_group.split("-")
    if len(parts) == 2:
        return (int(parts[0]) + int(parts[1])) // 2
    return 30  # fallback


def write_csv(data: list[dict], filepath: Path) -> None:
    """Write data to CSV file."""
    if not data:
        logger.warning(f"No data to write for {filepath}")
        return

    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=data[0].keys())
        writer.writeheader()
        writer.writerows(data)

    logger.info(f"Wrote {len(data):,} rows to {filepath}")


def main() -> None:
    """Generate all tribal health synthetic data."""
    parser = argparse.ArgumentParser(
        description="Generate synthetic tribal health data for analytics development"
    )
    parser.add_argument(
        "--patients", type=int, default=25000,
        help="Number of patient demographics to generate (default: 25000)",
    )
    parser.add_argument(
        "--days", type=int, default=730,
        help="Days of encounter data to generate (default: 730 = 2 years)",
    )
    parser.add_argument(
        "--facilities", type=int, default=50,
        help="Number of facilities to generate (default: 50)",
    )
    parser.add_argument(
        "--output-dir", type=Path,
        default=Path("examples/tribal-health/domains/dbt/seeds"),
        help="Output directory for CSV files",
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    config = GeneratorConfig(
        num_patients=args.patients,
        num_facilities=args.facilities,
        days_of_data=args.days,
        output_dir=args.output_dir,
        seed=args.seed,
    )

    logger.info(
        f"Generating tribal health data:\n"
        f"  Patients:    {config.num_patients:,}\n"
        f"  Days:        {config.days_of_data}\n"
        f"  Facilities:  {config.num_facilities}\n"
        f"  Seed:        {config.seed}\n"
        f"  Output:      {config.output_dir}\n"
    )

    # Generate in dependency order
    logger.info("── Generating patient demographics ──")
    patients = generate_patient_demographics(config)
    write_csv(patients, config.output_dir / "patient_demographics.csv")

    logger.info("── Generating clinical encounters ──")
    encounters = generate_encounters(config, patients)
    write_csv(encounters, config.output_dir / "encounters.csv")

    logger.info("── Generating facility reference data ──")
    facilities = generate_facilities(config)
    write_csv(facilities, config.output_dir / "facilities.csv")

    # Summary statistics
    dx_counts: dict[str, int] = {}
    for enc in encounters:
        code = enc["primary_dx_icd10"][:3]
        dx_counts[code] = dx_counts.get(code, 0) + 1

    top_dx = sorted(dx_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    logger.info(
        f"\n{'='*50}\n"
        f"Generation complete!\n"
        f"{'='*50}\n"
        f"  Patients:            {len(patients):>10,}\n"
        f"  Encounters:          {len(encounters):>10,}\n"
        f"  Facilities:          {len(facilities):>10,}\n"
        f"  Total CSV records:   {sum(len(d) for d in [patients, encounters, facilities]):>10,}\n"
        f"  Output directory:    {config.output_dir}\n"
        f"\n  Top 10 diagnosis prefixes:\n"
        + "\n".join(f"    {code}: {count:,}" for code, count in top_dx)
        + "\n\n  WARNING: ALL DATA IS SYNTHETIC -- no real patient data.\n"
    )


if __name__ == "__main__":
    main()
