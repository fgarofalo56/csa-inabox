"""
Casino Analytics — Synthetic Data Generator

Generates realistic synthetic data for tribal casino analytics including:
- Player profiles and loyalty tiers
- Slot machine telemetry (spins, denominations, RTP)
- Table game sessions (buy-in, avg bet, duration)
- F&B POS transactions (comp vs cash, menu preferences)
- Hotel PMS data (occupancy, ADR, RevPAR)
- Loyalty program activity and redemptions

All data is entirely synthetic. No real casino or player data is used.
"""

from __future__ import annotations

import argparse
import csv
import logging
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Sequence

logger = logging.getLogger(__name__)

# --- Configuration ---

LOYALTY_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"]
SLOT_DENOMINATIONS = [0.01, 0.05, 0.25, 1.00, 5.00, 25.00, 100.00]
TABLE_GAMES = ["Blackjack", "Craps", "Roulette", "Baccarat", "Poker", "PaiGow"]
FOOD_VENUES = [
    "Buffet", "Steakhouse", "Noodle Bar", "Cafe", "Sports Bar",
    "Fine Dining", "Food Court", "Pool Bar",
]
MENU_CATEGORIES = ["Appetizer", "Entree", "Dessert", "Beverage", "Combo"]
ROOM_TYPES = ["Standard", "Deluxe", "Suite", "Premium Suite", "Penthouse"]

# Realistic distributions
AGE_DISTRIBUTION = {
    "21-30": 0.12, "31-40": 0.18, "41-50": 0.22,
    "51-60": 0.25, "61-70": 0.15, "71+": 0.08,
}
VISIT_FREQUENCY = {
    "daily": 0.05, "weekly": 0.15, "biweekly": 0.20,
    "monthly": 0.30, "quarterly": 0.20, "annual": 0.10,
}


@dataclass
class GeneratorConfig:
    """Configuration for the synthetic data generator."""

    num_players: int = 5000
    num_slot_machines: int = 2000
    num_table_positions: int = 200
    days_of_data: int = 90
    start_date: datetime = field(
        default_factory=lambda: datetime(2025, 1, 1)
    )
    output_dir: Path = field(default_factory=lambda: Path("seeds"))
    seed: int = 42


def generate_player_profiles(config: GeneratorConfig) -> list[dict]:
    """Generate synthetic player profiles with loyalty tier distribution."""
    random.seed(config.seed)
    players = []

    tier_weights = [0.40, 0.25, 0.20, 0.10, 0.05]  # Bronze to Diamond
    age_brackets = list(AGE_DISTRIBUTION.keys())
    age_weights = list(AGE_DISTRIBUTION.values())

    for i in range(config.num_players):
        tier = random.choices(LOYALTY_TIERS, weights=tier_weights, k=1)[0]
        age_bracket = random.choices(age_brackets, weights=age_weights, k=1)[0]

        # Higher tiers have higher ADT (Average Daily Theoretical)
        tier_idx = LOYALTY_TIERS.index(tier)
        base_adt = [25, 75, 200, 500, 2000][tier_idx]
        adt = round(base_adt * random.uniform(0.5, 2.0), 2)

        signup_date = config.start_date - timedelta(
            days=random.randint(30, 365 * 5)
        )

        players.append({
            "player_id": f"PLY-{i + 1:06d}",
            "loyalty_tier": tier,
            "loyalty_points": random.randint(0, 500000) * (tier_idx + 1),
            "age_bracket": age_bracket,
            "gender": random.choice(["M", "F", "NB", "U"]),
            "zip_code": f"{random.randint(10000, 99999)}",
            "signup_date": signup_date.strftime("%Y-%m-%d"),
            "avg_daily_theoretical": adt,
            "visit_frequency": random.choices(
                list(VISIT_FREQUENCY.keys()),
                weights=list(VISIT_FREQUENCY.values()),
                k=1,
            )[0],
            "preferred_game_type": random.choice(
                ["slots", "table", "poker", "mixed"]
            ),
            "comp_eligible": tier_idx >= 1,
            "host_assigned": tier_idx >= 3,
            "is_active": random.random() > 0.15,
        })

    return players


def generate_slot_sessions(
    config: GeneratorConfig,
    players: Sequence[dict],
) -> list[dict]:
    """Generate slot machine session data."""
    random.seed(config.seed + 1)
    sessions = []
    active_players = [p for p in players if p["is_active"]]

    for day_offset in range(config.days_of_data):
        date = config.start_date + timedelta(days=day_offset)
        # More players on weekends
        day_of_week = date.weekday()
        daily_multiplier = 1.4 if day_of_week >= 5 else 1.0

        num_sessions = int(
            len(active_players) * 0.15 * daily_multiplier
        )
        day_players = random.sample(
            active_players, min(num_sessions, len(active_players))
        )

        for player in day_players:
            tier_idx = LOYALTY_TIERS.index(player["loyalty_tier"])
            denomination = random.choices(
                SLOT_DENOMINATIONS,
                weights=[0.05, 0.10, 0.25, 0.30, 0.15, 0.10, 0.05],
                k=1,
            )[0]

            # Session duration correlates with tier
            avg_minutes = [30, 45, 60, 90, 120][tier_idx]
            duration = max(5, int(random.gauss(avg_minutes, avg_minutes * 0.4)))

            # Spins per minute depends on denomination
            spins_per_min = max(3, int(random.gauss(8, 2)))
            total_spins = spins_per_min * duration

            coin_in = round(total_spins * denomination * random.uniform(1, 3), 2)
            # House edge varies by denomination (higher denom = lower edge)
            house_edge = random.uniform(0.02, 0.15)
            theoretical_win = round(coin_in * house_edge, 2)
            actual_win = round(
                theoretical_win * random.gauss(1.0, 0.5), 2
            )

            start_hour = random.choices(
                range(24),
                weights=[
                    1, 1, 1, 1, 1, 1,  # 00-05: low
                    2, 3, 4, 5, 6, 7,  # 06-11: morning ramp
                    7, 7, 8, 8, 9, 9,  # 12-17: afternoon peak
                    10, 10, 9, 8, 5, 3, # 18-23: evening peak then decline
                ],
                k=1,
            )[0]

            session_start = date.replace(
                hour=start_hour,
                minute=random.randint(0, 59),
            )

            machine_id = f"SLT-{random.randint(1, config.num_slot_machines):04d}"

            sessions.append({
                "session_id": str(uuid.uuid4())[:8],
                "player_id": player["player_id"],
                "machine_id": machine_id,
                "session_date": date.strftime("%Y-%m-%d"),
                "session_start": session_start.strftime("%Y-%m-%d %H:%M"),
                "duration_minutes": duration,
                "denomination": denomination,
                "total_spins": total_spins,
                "coin_in": coin_in,
                "coin_out": round(coin_in - actual_win, 2),
                "theoretical_win": theoretical_win,
                "actual_win": actual_win,
                "jackpot_hit": random.random() < 0.001,
                "bonus_rounds": random.randint(0, max(1, duration // 15)),
                "floor_zone": random.choice(
                    ["A1", "A2", "B1", "B2", "C1", "C2", "D1", "VIP"]
                ),
            })

    return sessions


def generate_table_sessions(
    config: GeneratorConfig,
    players: Sequence[dict],
) -> list[dict]:
    """Generate table game session data."""
    random.seed(config.seed + 2)
    sessions = []
    table_players = [
        p for p in players
        if p["is_active"] and p["preferred_game_type"] in ("table", "mixed")
    ]

    for day_offset in range(config.days_of_data):
        date = config.start_date + timedelta(days=day_offset)
        num_sessions = int(len(table_players) * 0.08)
        day_players = random.sample(
            table_players, min(num_sessions, len(table_players))
        )

        for player in day_players:
            tier_idx = LOYALTY_TIERS.index(player["loyalty_tier"])
            game = random.choice(TABLE_GAMES)

            # Buy-in correlates with tier
            base_buyin = [25, 100, 300, 1000, 5000][tier_idx]
            buy_in = round(base_buyin * random.uniform(0.5, 3.0), 2)
            avg_bet = round(buy_in * random.uniform(0.02, 0.10), 2)
            duration = max(15, int(random.gauss(90, 40)))
            hands_played = int(duration * random.uniform(0.5, 1.5))

            # Win/loss based on house edge for game type
            house_edges = {
                "Blackjack": 0.005, "Craps": 0.014, "Roulette": 0.053,
                "Baccarat": 0.011, "Poker": 0.025, "PaiGow": 0.026,
            }
            theoretical = round(
                avg_bet * hands_played * house_edges.get(game, 0.03), 2
            )
            actual_result = round(
                buy_in * random.gauss(0, 0.3), 2
            )

            sessions.append({
                "session_id": str(uuid.uuid4())[:8],
                "player_id": player["player_id"],
                "game_type": game,
                "table_id": f"TBL-{random.randint(1, config.num_table_positions):03d}",
                "session_date": date.strftime("%Y-%m-%d"),
                "duration_minutes": duration,
                "buy_in": buy_in,
                "cash_out": round(buy_in - actual_result, 2),
                "avg_bet": avg_bet,
                "hands_played": hands_played,
                "theoretical_win": theoretical,
                "actual_win_loss": actual_result,
                "dealer_id": f"DLR-{random.randint(1, 50):03d}",
                "pit_zone": random.choice(["Main", "High Limit", "VIP", "Poker Room"]),
            })

    return sessions


def generate_fnb_transactions(
    config: GeneratorConfig,
    players: Sequence[dict],
) -> list[dict]:
    """Generate F&B point-of-sale transaction data."""
    random.seed(config.seed + 3)
    transactions = []
    active_players = [p for p in players if p["is_active"]]

    for day_offset in range(config.days_of_data):
        date = config.start_date + timedelta(days=day_offset)
        num_txns = int(len(active_players) * 0.10)
        day_players = random.sample(
            active_players, min(num_txns, len(active_players))
        )

        for player in day_players:
            tier_idx = LOYALTY_TIERS.index(player["loyalty_tier"])
            venue = random.choice(FOOD_VENUES)
            is_comp = tier_idx >= 1 and random.random() < (0.2 + tier_idx * 0.15)

            base_amount = {
                "Buffet": 35, "Steakhouse": 85, "Noodle Bar": 18,
                "Cafe": 12, "Sports Bar": 25, "Fine Dining": 120,
                "Food Court": 15, "Pool Bar": 20,
            }.get(venue, 25)

            amount = round(base_amount * random.uniform(0.7, 1.8), 2)
            items = random.randint(1, 5)

            transactions.append({
                "transaction_id": str(uuid.uuid4())[:8],
                "player_id": player["player_id"],
                "venue": venue,
                "transaction_date": date.strftime("%Y-%m-%d"),
                "meal_period": random.choice(
                    ["Breakfast", "Lunch", "Dinner", "Late Night"]
                ),
                "items_count": items,
                "subtotal": amount,
                "tax": round(amount * 0.085, 2),
                "total": round(amount * 1.085, 2),
                "payment_type": "comp" if is_comp else random.choice(
                    ["cash", "credit", "debit", "points"]
                ),
                "comp_value": round(amount * 1.085, 2) if is_comp else 0,
                "tip_amount": round(amount * random.uniform(0.15, 0.25), 2),
                "party_size": random.randint(1, 4),
                "satisfaction_score": (
                    random.randint(3, 5) if random.random() > 0.3 else None
                ),
            })

    return transactions


def generate_hotel_stays(
    config: GeneratorConfig,
    players: Sequence[dict],
) -> list[dict]:
    """Generate hotel PMS (Property Management System) data."""
    random.seed(config.seed + 4)
    stays = []
    eligible_players = [
        p for p in players
        if p["is_active"]
        and LOYALTY_TIERS.index(p["loyalty_tier"]) >= 1
    ]

    for day_offset in range(0, config.days_of_data, 3):
        date = config.start_date + timedelta(days=day_offset)
        num_checkins = int(len(eligible_players) * 0.02)
        guests = random.sample(
            eligible_players, min(num_checkins, len(eligible_players))
        )

        for player in guests:
            tier_idx = LOYALTY_TIERS.index(player["loyalty_tier"])
            room_type = random.choices(
                ROOM_TYPES,
                weights=[
                    max(0.01, 0.4 - tier_idx * 0.08),
                    0.25,
                    0.15 + tier_idx * 0.05,
                    0.10 + tier_idx * 0.05,
                    max(0.01, tier_idx * 0.05),
                ],
                k=1,
            )[0]

            base_rate = {
                "Standard": 89, "Deluxe": 139, "Suite": 249,
                "Premium Suite": 449, "Penthouse": 899,
            }[room_type]

            nights = random.choices(
                [1, 2, 3, 4, 5, 7], weights=[0.3, 0.35, 0.15, 0.10, 0.05, 0.05], k=1
            )[0]
            is_comp = tier_idx >= 2 and random.random() < 0.4
            rate = 0 if is_comp else round(base_rate * random.uniform(0.8, 1.2), 2)

            stays.append({
                "stay_id": str(uuid.uuid4())[:8],
                "player_id": player["player_id"],
                "check_in": date.strftime("%Y-%m-%d"),
                "check_out": (date + timedelta(days=nights)).strftime("%Y-%m-%d"),
                "nights": nights,
                "room_type": room_type,
                "room_number": f"{random.randint(2, 20):02d}{random.randint(1, 50):02d}",
                "rate_per_night": rate,
                "total_room_charge": round(rate * nights, 2),
                "is_comp": is_comp,
                "resort_fee": 35.00,
                "incidentals": round(random.uniform(0, 200), 2),
                "booking_source": random.choice(
                    ["direct", "host_invite", "website", "phone", "app"]
                ),
                "satisfaction_score": random.randint(3, 5) if random.random() > 0.2 else None,
            })

    return stays


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

    logger.info(f"Wrote {len(data)} rows to {filepath}")


def main() -> None:
    """Generate all casino analytics synthetic data."""
    parser = argparse.ArgumentParser(
        description="Generate synthetic casino analytics data"
    )
    parser.add_argument(
        "--players", type=int, default=5000,
        help="Number of player profiles (default: 5000)",
    )
    parser.add_argument(
        "--days", type=int, default=90,
        help="Days of transaction data (default: 90)",
    )
    parser.add_argument(
        "--output", type=Path, default=Path("examples/casino-analytics/domains/dbt/seeds"),
        help="Output directory for CSV files",
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    parser.add_argument(
        "--small", action="store_true",
        help="Generate small dataset (500 players, 30 days) for testing",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.small:
        args.players = 500
        args.days = 30

    config = GeneratorConfig(
        num_players=args.players,
        days_of_data=args.days,
        output_dir=args.output,
        seed=args.seed,
    )

    logger.info(f"Generating casino data: {config.num_players} players, {config.days_of_data} days")

    # Generate in dependency order
    players = generate_player_profiles(config)
    write_csv(players, config.output_dir / "players.csv")

    slots = generate_slot_sessions(config, players)
    write_csv(slots, config.output_dir / "slot_sessions.csv")

    tables = generate_table_sessions(config, players)
    write_csv(tables, config.output_dir / "table_sessions.csv")

    fnb = generate_fnb_transactions(config, players)
    write_csv(fnb, config.output_dir / "fnb_transactions.csv")

    hotel = generate_hotel_stays(config, players)
    write_csv(hotel, config.output_dir / "hotel_stays.csv")

    logger.info(
        f"\nGeneration complete:"
        f"\n  Players:          {len(players):,}"
        f"\n  Slot sessions:    {len(slots):,}"
        f"\n  Table sessions:   {len(tables):,}"
        f"\n  F&B transactions: {len(fnb):,}"
        f"\n  Hotel stays:      {len(hotel):,}"
        f"\n  Total records:    {sum(len(d) for d in [players, slots, tables, fnb, hotel]):,}"
        f"\n  Output:           {config.output_dir}"
    )


if __name__ == "__main__":
    main()
