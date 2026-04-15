#!/usr/bin/env python3
"""
Synthetic Gaming Data Generator (Casino Analytics)

Generates ENTIRELY SYNTHETIC gaming operations data for tribal casino analytics.
Includes player sessions, slot machine telemetry, and F&B transactions with
realistic behavioral models and regulatory compliance thresholds.

Outputs CSV files aligned with casino-analytics bronze dbt models:
  - player_sessions.csv    (brz_player_sessions)
  - slot_events.csv        (brz_slot_events)
  - fnb_transactions.csv   (brz_fnb_transactions)

Usage:
    python generate_synthetic_gaming.py --sessions 1000 --events 5000 --fnb 2000
    python generate_synthetic_gaming.py --dataset sessions --count 500 --seed 42
    python generate_synthetic_gaming.py --dataset slot-events --count 3000
    python generate_synthetic_gaming.py --dataset fnb --count 1000
    python generate_synthetic_gaming.py --dataset all --output-dir ./data
    python generate_synthetic_gaming.py --help

IMPORTANT: ALL data is ENTIRELY SYNTHETIC. No real gaming patron data,
machine performance data, or proprietary casino metrics are used.
Designed for development, testing, and demonstration purposes only.

REGULATORY NOTE: This generator includes Title 31 BSA/AML-relevant
thresholds (CTR at $10,000) in synthetic data for testing compliance
monitoring pipelines. No actual suspicious activity is modeled.
"""

import argparse
import csv
import json
import logging
import math
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

GAME_TYPES = [
    ("Video Slots", 0.45),
    ("Reel Slots", 0.15),
    ("Video Poker", 0.12),
    ("Blackjack", 0.08),
    ("Roulette", 0.05),
    ("Craps", 0.04),
    ("Baccarat", 0.03),
    ("Poker", 0.04),
    ("Keno", 0.02),
    ("Progressive Slots", 0.02),
]

DENOMINATIONS = [
    (0.01, 0.20),   # Penny slots
    (0.05, 0.15),   # Nickel
    (0.25, 0.25),   # Quarter
    (1.00, 0.20),   # Dollar
    (5.00, 0.10),   # Five dollar
    (25.00, 0.05),  # High limit
    (100.00, 0.03), # VIP
    (500.00, 0.02), # Ultra-high limit
]

FLOOR_ZONES = [
    "Main Floor A", "Main Floor B", "Main Floor C",
    "High Limit Room", "VIP Salon", "Poker Room",
    "Non-Smoking Section", "Sports Lounge",
    "Entry Plaza", "Resort Wing",
]

# RTP (Return to Player) ranges by game type
RTP_RANGES = {
    "Video Slots": (0.88, 0.96),
    "Reel Slots": (0.85, 0.94),
    "Video Poker": (0.95, 0.9976),
    "Blackjack": (0.95, 0.9950),
    "Roulette": (0.9474, 0.9474),
    "Craps": (0.9860, 0.9860),
    "Baccarat": (0.9856, 0.9894),
    "Poker": (0.95, 0.98),
    "Keno": (0.75, 0.90),
    "Progressive Slots": (0.85, 0.93),
}

SLOT_EVENT_TYPES = [
    ("spin", 0.75),
    ("bonus_trigger", 0.05),
    ("jackpot_contribution", 0.08),
    ("free_spin", 0.06),
    ("feature_game", 0.03),
    ("hand_pay", 0.005),
    ("tilt", 0.002),
    ("door_open", 0.001),
    ("bill_insert", 0.02),
    ("ticket_print", 0.015),
    ("card_insert", 0.008),
]

FNB_VENUES = [
    ("Buffet", 0.25),
    ("Steakhouse", 0.10),
    ("Sports Bar", 0.15),
    ("Cafe", 0.20),
    ("Food Court", 0.15),
    ("Lounge", 0.08),
    ("Room Service", 0.05),
    ("Pool Bar", 0.02),
]

MEAL_PERIODS = [
    ("Breakfast", 0.15),
    ("Lunch", 0.25),
    ("Dinner", 0.35),
    ("Late Night", 0.15),
    ("Brunch", 0.10),
]

PAYMENT_TYPES = [
    ("Players Club", 0.30),
    ("Cash", 0.25),
    ("Credit Card", 0.20),
    ("Comp", 0.15),
    ("Room Charge", 0.10),
]


# ---------------------------------------------------------------------------
# Player behavior models
# ---------------------------------------------------------------------------
class PlayerProfile:
    """Synthetic player behavioral model."""

    SEGMENTS: ClassVar[dict[str, Any]] = {
        "VIP": {
            "weight": 0.05,
            "avg_sessions_month": 12,
            "avg_duration_min": 180,
            "avg_coin_in": 5000.0,
            "denomination_bias": [0.02, 0.03, 0.10, 0.20, 0.25, 0.20, 0.15, 0.05],
            "fnb_spend_mult": 3.0,
        },
        "Regular": {
            "weight": 0.25,
            "avg_sessions_month": 6,
            "avg_duration_min": 120,
            "avg_coin_in": 500.0,
            "denomination_bias": [0.10, 0.15, 0.30, 0.25, 0.12, 0.05, 0.02, 0.01],
            "fnb_spend_mult": 1.5,
        },
        "Casual": {
            "weight": 0.45,
            "avg_sessions_month": 2,
            "avg_duration_min": 60,
            "avg_coin_in": 100.0,
            "denomination_bias": [0.30, 0.25, 0.25, 0.12, 0.05, 0.02, 0.01, 0.00],
            "fnb_spend_mult": 1.0,
        },
        "Tourist": {
            "weight": 0.20,
            "avg_sessions_month": 1,
            "avg_duration_min": 90,
            "avg_coin_in": 200.0,
            "denomination_bias": [0.20, 0.20, 0.30, 0.15, 0.08, 0.04, 0.02, 0.01],
            "fnb_spend_mult": 2.0,
        },
        "Problem": {
            "weight": 0.05,
            "avg_sessions_month": 20,
            "avg_duration_min": 300,
            "avg_coin_in": 2000.0,
            "denomination_bias": [0.05, 0.10, 0.20, 0.25, 0.20, 0.10, 0.07, 0.03],
            "fnb_spend_mult": 0.5,
        },
    }


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------
class SyntheticGamingGenerator:
    """Generate synthetic gaming operations data."""

    def __init__(self, seed: int = 51, num_machines: int = 1500):
        """Initialize with reproducible random seed.

        Args:
            seed: Random seed for reproducibility.
            num_machines: Number of synthetic slot machines on the floor.
        """
        self.rng = random.Random(seed)
        self.num_machines = num_machines
        self._player_cache: dict[str, dict[str, Any]] = {}
        self._machine_cache: dict[str, dict[str, Any]] = {}
        self._init_machines()

    def _weighted_choice(self, options: list[tuple[Any, float]]) -> Any:
        """Select from weighted options."""
        items = [o[0] for o in options]
        weights = [o[1] for o in options]
        return self.rng.choices(items, weights=weights, k=1)[0]

    def _random_datetime(self, start: datetime, end: datetime) -> datetime:
        """Generate random datetime."""
        delta = end - start
        random_seconds = self.rng.randint(0, max(int(delta.total_seconds()), 1))
        return start + timedelta(seconds=random_seconds)

    def _init_machines(self):
        """Create synthetic machine fleet."""
        for i in range(self.num_machines):
            machine_id = f"SLT-{i + 1:05d}"
            game_type = self._weighted_choice(GAME_TYPES)
            denom = self._weighted_choice(DENOMINATIONS)
            zone = self.rng.choice(FLOOR_ZONES)
            rtp_range = RTP_RANGES.get(game_type, (0.88, 0.96))
            target_rtp = self.rng.uniform(*rtp_range)

            self._machine_cache[machine_id] = {
                "game_type": game_type,
                "denomination": denom,
                "floor_zone": zone,
                "target_rtp": target_rtp,
            }

    def _get_or_create_player(self, player_id: str) -> dict[str, Any]:
        """Get or create a player profile."""
        if player_id not in self._player_cache:
            segments = list(PlayerProfile.SEGMENTS.keys())
            weights = [PlayerProfile.SEGMENTS[s]["weight"] for s in segments]
            segment = self.rng.choices(segments, weights=weights, k=1)[0]
            self._player_cache[player_id] = {
                "segment": segment,
                **PlayerProfile.SEGMENTS[segment],
            }
        return self._player_cache[player_id]

    # ===================================================================
    # Player Sessions
    # ===================================================================
    def generate_sessions(
        self,
        count: int = 200,
        start_date: str = "2024-01-01",
        end_date: str = "2024-12-31",
        num_players: int = 500,
    ) -> list[dict[str, Any]]:
        """Generate synthetic player session records.

        Args:
            count: Number of session records.
            start_date: Start date YYYY-MM-DD.
            end_date: End date YYYY-MM-DD.
            num_players: Size of synthetic player pool.

        Returns:
            List of dicts matching brz_player_sessions columns.
        """
        records: list[dict[str, Any]] = []
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")

        player_ids = [f"PLR-{self.rng.randint(100000, 999999)}" for _ in range(num_players)]
        machine_ids = list(self._machine_cache.keys())

        for _ in range(count):
            session_id = f"SES-{self.rng.randint(10000000, 99999999)}"
            player_id = self.rng.choice(player_ids)
            profile = self._get_or_create_player(player_id)

            machine_id = self.rng.choice(machine_ids)
            machine = self._machine_cache[machine_id]

            session_start = self._random_datetime(start_dt, end_dt)
            session_date = session_start.strftime("%Y-%m-%d")
            session_start_str = session_start.strftime("%Y-%m-%d %H:%M:%S")

            # Duration follows log-normal distribution
            avg_dur = profile["avg_duration_min"]
            duration = max(5, int(self.rng.lognormvariate(math.log(avg_dur), 0.5)))
            duration = min(duration, 720)  # Cap at 12 hours

            # Coin-in based on duration and denomination
            avg_coin_in = profile["avg_coin_in"]
            coin_in = max(
                machine["denomination"],
                round(self.rng.lognormvariate(math.log(avg_coin_in), 0.6), 2),
            )

            # Coin-out based on target RTP with variance
            actual_rtp = max(0.0, min(2.0, self.rng.gauss(machine["target_rtp"], 0.15)))
            coin_out = round(coin_in * actual_rtp, 2)

            theoretical_win = round(coin_in * (1 - machine["target_rtp"]), 2)
            actual_win = round(coin_in - coin_out, 2)

            records.append({
                "session_id": session_id,
                "player_id": player_id,
                "machine_id": machine_id,
                "session_date": session_date,
                "session_start": session_start_str,
                "duration_minutes": duration,
                "game_type": machine["game_type"],
                "coin_in": coin_in,
                "coin_out": coin_out,
                "theoretical_win": theoretical_win,
                "actual_win": actual_win,
                "denomination": machine["denomination"],
                "floor_zone": machine["floor_zone"],
            })

        logger.info("Generated %d synthetic player session records", len(records))
        return records

    # ===================================================================
    # Slot Events
    # ===================================================================
    def generate_slot_events(
        self,
        count: int = 200,
        start_date: str = "2024-01-01",
        end_date: str = "2024-12-31",
    ) -> list[dict[str, Any]]:
        """Generate synthetic slot machine event records.

        Args:
            count: Number of event records.
            start_date: Start date.
            end_date: End date.

        Returns:
            List of dicts matching brz_slot_events columns.
        """
        records: list[dict[str, Any]] = []
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")

        machine_ids = list(self._machine_cache.keys())
        player_ids = list(self._player_cache.keys()) or [
            f"PLR-{self.rng.randint(100000, 999999)}" for _ in range(200)
        ]

        for _ in range(count):
            event_id = f"EVT-{self.rng.randint(100000000, 999999999)}"
            machine_id = self.rng.choice(machine_ids)
            machine = self._machine_cache[machine_id]

            event_ts = self._random_datetime(start_dt, end_dt)
            event_type = self._weighted_choice(SLOT_EVENT_TYPES)

            denom = machine["denomination"]

            if event_type == "spin":
                credits_wagered = self.rng.choice([1, 2, 3, 5, 10, 20, 50]) * denom
                rtp = self.rng.gauss(machine["target_rtp"], 0.2)
                rtp = max(0.0, min(5.0, rtp))  # Allow for big wins
                credits_won = round(credits_wagered * rtp, 2)
            elif event_type in ("bonus_trigger", "feature_game", "free_spin"):
                credits_wagered = 0.0
                credits_won = round(self.rng.lognormvariate(math.log(denom * 50), 1.0), 2)
            elif event_type == "hand_pay":
                credits_wagered = 0.0
                credits_won = round(self.rng.uniform(1200, 25000), 2)
            elif event_type == "jackpot_contribution":
                credits_wagered = round(denom * self.rng.randint(1, 5), 2)
                credits_won = 0.0
            else:
                credits_wagered = 0.0
                credits_won = 0.0

            rtp_contribution = round(credits_won / credits_wagered, 4) if credits_wagered > 0 else 0.0

            player_id = self.rng.choice(player_ids) if self.rng.random() > 0.1 else ""
            session_id = f"SES-{self.rng.randint(10000000, 99999999)}" if player_id else ""

            records.append({
                "event_id": event_id,
                "machine_id": machine_id,
                "event_timestamp": event_ts.strftime("%Y-%m-%d %H:%M:%S.%f"),
                "event_type": event_type,
                "denomination": denom,
                "credits_wagered": credits_wagered,
                "credits_won": credits_won,
                "rtp_contribution": rtp_contribution,
                "floor_zone": machine["floor_zone"],
                "player_id": player_id,
                "session_id": session_id,
            })

        logger.info("Generated %d synthetic slot event records", len(records))
        return records

    # ===================================================================
    # F&B Transactions
    # ===================================================================
    def generate_fnb_transactions(
        self,
        count: int = 200,
        start_date: str = "2024-01-01",
        end_date: str = "2024-12-31",
    ) -> list[dict[str, Any]]:
        """Generate synthetic F&B transaction records.

        Args:
            count: Number of transaction records.
            start_date: Start date.
            end_date: End date.

        Returns:
            List of dicts matching brz_fnb_transactions columns.
        """
        records: list[dict[str, Any]] = []
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")

        player_ids = list(self._player_cache.keys()) or [
            f"PLR-{self.rng.randint(100000, 999999)}" for _ in range(200)
        ]

        # Base prices by venue
        venue_base_prices = {
            "Buffet": (18.0, 45.0),
            "Steakhouse": (35.0, 120.0),
            "Sports Bar": (12.0, 40.0),
            "Cafe": (8.0, 25.0),
            "Food Court": (6.0, 18.0),
            "Lounge": (10.0, 35.0),
            "Room Service": (20.0, 80.0),
            "Pool Bar": (8.0, 30.0),
        }

        for _ in range(count):
            transaction_id = f"TXN-{self.rng.randint(10000000, 99999999)}"
            player_id = self.rng.choice(player_ids) if self.rng.random() > 0.2 else ""
            venue = self._weighted_choice(FNB_VENUES)
            meal_period = self._weighted_choice(MEAL_PERIODS)

            txn_dt = self._random_datetime(start_dt, end_dt)
            transaction_date = txn_dt.strftime("%Y-%m-%d")

            price_range = venue_base_prices.get(venue, (10.0, 40.0))
            party_size = self.rng.choices([1, 2, 3, 4, 5, 6], weights=[0.20, 0.35, 0.20, 0.15, 0.05, 0.05], k=1)[0]
            items_count = max(1, int(self.rng.gauss(party_size * 1.5, 1.0)))

            subtotal = round(
                sum(self.rng.uniform(*price_range) for _ in range(items_count)),
                2,
            )

            # Comp value for players club members
            comp_value = 0.0
            if player_id:
                profile = self._get_or_create_player(player_id)
                if profile["segment"] in ("VIP", "Regular") and self.rng.random() > 0.4:
                    comp_pct = self.rng.uniform(0.25, 1.0) if profile["segment"] == "VIP" else self.rng.uniform(0.1, 0.5)
                    comp_value = round(subtotal * comp_pct, 2)

            paid_subtotal = max(0, round(subtotal - comp_value, 2))
            tax_rate = 0.0825
            tax = round(paid_subtotal * tax_rate, 2)
            total = round(paid_subtotal + tax, 2)

            payment_type = self._weighted_choice(PAYMENT_TYPES)
            if comp_value >= subtotal:
                payment_type = "Comp"

            tip_pct = max(0, self.rng.gauss(0.18, 0.06))
            tip_amount = round(paid_subtotal * tip_pct, 2)

            satisfaction = None
            if self.rng.random() > 0.6:
                satisfaction = self.rng.choices([1, 2, 3, 4, 5], weights=[0.02, 0.05, 0.15, 0.40, 0.38], k=1)[0]

            records.append({
                "transaction_id": transaction_id,
                "player_id": player_id,
                "venue": venue,
                "transaction_date": transaction_date,
                "meal_period": meal_period,
                "items_count": items_count,
                "subtotal": subtotal,
                "tax": tax,
                "total": total,
                "payment_type": payment_type,
                "comp_value": comp_value,
                "tip_amount": tip_amount,
                "party_size": party_size,
                "satisfaction_score": satisfaction,
            })

        logger.info("Generated %d synthetic F&B transaction records", len(records))
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
        description=(
            "Generate synthetic gaming operations data for casino analytics.\n\n"
            "IMPORTANT: ALL generated data is ENTIRELY SYNTHETIC.\n"
            "No real patron data, machine performance, or proprietary metrics are used."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate all datasets
  python generate_synthetic_gaming.py --dataset all --output-dir ./data

  # Generate 1000 sessions with specific seed
  python generate_synthetic_gaming.py --dataset sessions --count 1000 --seed 51

  # Generate 5000 slot events
  python generate_synthetic_gaming.py --dataset slot-events --count 5000

  # Generate 2000 F&B transactions
  python generate_synthetic_gaming.py --dataset fnb --count 2000

  # Generate with date range
  python generate_synthetic_gaming.py --dataset all --start-date 2024-06-01 --end-date 2024-12-31

DISCLAIMER: This tool generates ENTIRELY SYNTHETIC data for development
and testing. No real gaming data is used or referenced.

REGULATORY NOTE: Synthetic data may include amounts above Title 31 BSA/AML
thresholds ($10,000 CTR) for testing compliance monitoring pipelines.
        """,
    )

    parser.add_argument(
        "--dataset",
        choices=["sessions", "slot-events", "fnb", "all"],
        default="all",
        help="Which dataset to generate (default: all)",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=None,
        help="Number of records (overrides individual defaults)",
    )
    parser.add_argument(
        "--sessions",
        type=int,
        default=200,
        help="Number of session records when --dataset=all (default: 200)",
    )
    parser.add_argument(
        "--events",
        type=int,
        default=200,
        help="Number of slot event records when --dataset=all (default: 200)",
    )
    parser.add_argument(
        "--fnb-count",
        type=int,
        default=200,
        help="Number of F&B records when --dataset=all (default: 200)",
    )
    parser.add_argument(
        "--num-players",
        type=int,
        default=500,
        help="Size of synthetic player pool (default: 500)",
    )
    parser.add_argument(
        "--num-machines",
        type=int,
        default=1500,
        help="Number of synthetic slot machines (default: 1500)",
    )
    parser.add_argument(
        "--start-date",
        default="2024-01-01",
        help="Start date YYYY-MM-DD",
    )
    parser.add_argument(
        "--end-date",
        default="2024-12-31",
        help="End date YYYY-MM-DD",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=51,
        help="Random seed for reproducibility (default: 51)",
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
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
    )

    return parser.parse_args()


def main() -> int:
    """Entry point."""
    args = parse_args()
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    logger.info("=" * 60)
    logger.info("SYNTHETIC GAMING DATA GENERATOR")
    logger.info("ALL DATA IS ENTIRELY SYNTHETIC - NO REAL PATRON DATA")
    logger.info("=" * 60)

    generator = SyntheticGamingGenerator(
        seed=args.seed,
        num_machines=args.num_machines,
    )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, int] = {}

    # ---- Player Sessions ----
    if args.dataset in ("sessions", "all"):
        count = args.count if args.count and args.dataset == "sessions" else args.sessions
        logger.info("=== Generating Synthetic Player Sessions ===")
        sessions = generator.generate_sessions(
            count=count,
            start_date=args.start_date,
            end_date=args.end_date,
            num_players=args.num_players,
        )
        if args.output_format in ("csv", "both"):
            generator.write_csv(sessions, str(output_dir / "player_sessions.csv"))
        if args.output_format in ("json", "both"):
            generator.write_json(sessions, str(output_dir / "player_sessions.json"))
        results["sessions"] = len(sessions)

    # ---- Slot Events ----
    if args.dataset in ("slot-events", "all"):
        count = args.count if args.count and args.dataset == "slot-events" else args.events
        logger.info("=== Generating Synthetic Slot Events ===")
        events = generator.generate_slot_events(
            count=count,
            start_date=args.start_date,
            end_date=args.end_date,
        )
        if args.output_format in ("csv", "both"):
            generator.write_csv(events, str(output_dir / "slot_events.csv"))
        if args.output_format in ("json", "both"):
            generator.write_json(events, str(output_dir / "slot_events.json"))
        results["slot-events"] = len(events)

    # ---- F&B Transactions ----
    if args.dataset in ("fnb", "all"):
        count = args.count if args.count and args.dataset == "fnb" else args.fnb_count
        logger.info("=== Generating Synthetic F&B Transactions ===")
        fnb = generator.generate_fnb_transactions(
            count=count,
            start_date=args.start_date,
            end_date=args.end_date,
        )
        if args.output_format in ("csv", "both"):
            generator.write_csv(fnb, str(output_dir / "fnb_transactions.csv"))
        if args.output_format in ("json", "both"):
            generator.write_json(fnb, str(output_dir / "fnb_transactions.json"))
        results["fnb"] = len(fnb)

    # ---- Summary ----
    logger.info("=" * 60)
    logger.info("Generation Summary (ALL DATA IS SYNTHETIC):")
    for dataset_name, count in results.items():
        logger.info("  %-14s  %d records", dataset_name, count)
    logger.info("Output directory: %s", output_dir.resolve())
    logger.info("Seed: %d", args.seed)
    logger.info("Player pool: %d | Machine fleet: %d", args.num_players, args.num_machines)
    logger.info("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
