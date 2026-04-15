#!/usr/bin/env python3
"""
Slot Machine Event Hub Producer

Real-time telemetry producer for slot machine events streamed to Azure Event Hub.
Generates and sends slot machine events (spins, bonus triggers, hand pays, jackpots,
tilt events) for real-time analytics dashboards and compliance monitoring.

Architecture:
    Slot Machine → SAS Protocol → This Producer → Event Hub → Stream Analytics → ADX/Cosmos

Usage:
    python slot_event_producer.py --event-hub-connection "$CONN_STR" --event-hub-name "slot-events"
    python slot_event_producer.py --mode simulate --events-per-second 100 --duration 3600
    python slot_event_producer.py --mode file --input events.jsonl
    python slot_event_producer.py --help

Environment Variables:
    EVENT_HUB_CONNECTION_STRING  - Event Hub namespace connection string
    EVENT_HUB_NAME               - Event Hub entity name
    BATCH_SIZE                   - Events per batch (default: 100)
"""

import argparse
import json
import logging
import math
import os
import random
import signal
import sys
import time
import uuid
from datetime import datetime
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - [%(name)s] %(message)s",
)
logger = logging.getLogger("slot-producer")


# ---------------------------------------------------------------------------
# Event schemas
# ---------------------------------------------------------------------------

SLOT_EVENT_SCHEMA = {
    "type": "object",
    "required": ["event_id", "machine_id", "event_timestamp", "event_type"],
    "properties": {
        "event_id": {"type": "string"},
        "machine_id": {"type": "string"},
        "event_timestamp": {"type": "string", "format": "date-time"},
        "event_type": {"type": "string"},
        "denomination": {"type": "number"},
        "credits_wagered": {"type": "number"},
        "credits_won": {"type": "number"},
        "rtp_contribution": {"type": "number"},
        "floor_zone": {"type": "string"},
        "player_id": {"type": "string"},
        "session_id": {"type": "string"},
        "jackpot_amount": {"type": "number"},
        "progressive_pool": {"type": "string"},
        "hand_pay_amount": {"type": "number"},
        "tilt_code": {"type": "string"},
        "currency_inserted": {"type": "number"},
        "ticket_value": {"type": "number"},
    },
}

EVENT_TYPES = [
    ("spin", 0.70),
    ("bonus_trigger", 0.06),
    ("jackpot_contribution", 0.08),
    ("free_spin", 0.05),
    ("feature_game", 0.03),
    ("hand_pay", 0.005),
    ("tilt", 0.003),
    ("door_open", 0.002),
    ("bill_insert", 0.025),
    ("ticket_print", 0.015),
    ("card_insert", 0.008),
    ("card_remove", 0.008),
    ("power_event", 0.001),
    ("progressive_hit", 0.0005),
    ("jackpot_reset", 0.0005),
]

FLOOR_ZONES = [
    "Main Floor A", "Main Floor B", "Main Floor C",
    "High Limit Room", "VIP Salon", "Poker Room",
    "Non-Smoking Section", "Sports Lounge",
    "Entry Plaza", "Resort Wing",
]

DENOMINATIONS = [0.01, 0.05, 0.25, 1.00, 5.00, 25.00, 100.00]

TILT_CODES = [
    "COIN_JAM", "BILL_JAM", "DOOR_AJAR", "HOPPER_EMPTY",
    "PRINTER_ERROR", "COMM_LOST", "RAM_ERROR", "POWER_RESET",
    "REEL_TILT", "LOW_BATTERY",
]

PROGRESSIVE_POOLS = ["Mini", "Minor", "Major", "Grand", "Mega"]


# ---------------------------------------------------------------------------
# Event generator (simulation mode)
# ---------------------------------------------------------------------------
class SlotEventSimulator:
    """Generate realistic slot machine event streams."""

    def __init__(
        self,
        num_machines: int = 1500,
        num_players: int = 400,
        seed: int = 42,
    ):
        self.rng = random.Random(seed)
        self.num_machines = num_machines
        self.num_players = num_players
        self.machines = self._init_machines()
        self.active_sessions: dict[str, dict[str, Any]] = {}

    def _init_machines(self) -> dict[str, dict[str, Any]]:
        """Initialize synthetic machine fleet."""
        machines = {}
        for i in range(self.num_machines):
            mid = f"SLT-{i + 1:05d}"
            machines[mid] = {
                "denomination": self.rng.choice(DENOMINATIONS),
                "floor_zone": self.rng.choice(FLOOR_ZONES),
                "target_rtp": self.rng.uniform(0.88, 0.96),
                "game_type": self.rng.choice(["Video Slots", "Reel Slots", "Video Poker"]),
            }
        return machines

    def _weighted_choice(self, options: list[tuple[Any, float]]) -> Any:
        items = [o[0] for o in options]
        weights = [o[1] for o in options]
        return self.rng.choices(items, weights=weights, k=1)[0]

    def generate_event(self) -> dict[str, Any]:
        """Generate a single slot machine event."""
        machine_id = self.rng.choice(list(self.machines.keys()))
        machine = self.machines[machine_id]
        event_type = self._weighted_choice(EVENT_TYPES)

        now = datetime.utcnow()
        event = {
            "event_id": str(uuid.uuid4()),
            "machine_id": machine_id,
            "event_timestamp": now.isoformat() + "Z",
            "event_type": event_type,
            "denomination": machine["denomination"],
            "floor_zone": machine["floor_zone"],
        }

        # Add player context (most events have a player)
        if self.rng.random() > 0.1:
            player_id = f"PLR-{self.rng.randint(100000, 100000 + self.num_players)}"
            session_id = self.active_sessions.get(player_id, {}).get("session_id", f"SES-{self.rng.randint(10000000, 99999999)}")
            event["player_id"] = player_id
            event["session_id"] = session_id
            self.active_sessions[player_id] = {"session_id": session_id, "machine_id": machine_id}
        else:
            event["player_id"] = ""
            event["session_id"] = ""

        # Event-type-specific payload
        denom = machine["denomination"]
        if event_type == "spin":
            credits = self.rng.choice([1, 2, 3, 5, 10, 20, 50]) * denom
            rtp = max(0, self.rng.gauss(machine["target_rtp"], 0.15))
            won = round(credits * rtp, 2)
            event["credits_wagered"] = credits
            event["credits_won"] = won
            event["rtp_contribution"] = round(won / credits, 4) if credits > 0 else 0

        elif event_type == "bonus_trigger":
            event["credits_wagered"] = 0
            event["credits_won"] = round(self.rng.lognormvariate(math.log(denom * 100), 0.8), 2)

        elif event_type == "hand_pay":
            amount = round(self.rng.uniform(1200, 50000), 2)
            event["hand_pay_amount"] = amount
            event["credits_wagered"] = 0
            event["credits_won"] = amount
            # Title 31: amounts >= $10,000 trigger CTR
            if amount >= 10000:
                event["ctr_trigger"] = True

        elif event_type == "progressive_hit":
            pool = self.rng.choice(PROGRESSIVE_POOLS)
            amounts = {"Mini": (100, 500), "Minor": (500, 2500), "Major": (2500, 25000),
                       "Grand": (25000, 100000), "Mega": (100000, 1000000)}
            amount_range = amounts.get(pool, (100, 500))
            event["jackpot_amount"] = round(self.rng.uniform(*amount_range), 2)
            event["progressive_pool"] = pool
            event["credits_wagered"] = 0
            event["credits_won"] = event["jackpot_amount"]

        elif event_type == "tilt":
            event["tilt_code"] = self.rng.choice(TILT_CODES)
            event["credits_wagered"] = 0
            event["credits_won"] = 0

        elif event_type == "bill_insert":
            bill_values = [1, 5, 10, 20, 50, 100]
            event["currency_inserted"] = self.rng.choice(bill_values)
            event["credits_wagered"] = 0
            event["credits_won"] = 0

        elif event_type == "ticket_print":
            event["ticket_value"] = round(self.rng.uniform(0.25, 5000), 2)
            event["credits_wagered"] = 0
            event["credits_won"] = 0

        else:
            event["credits_wagered"] = 0
            event["credits_won"] = 0

        return event

    def generate_batch(self, batch_size: int = 100) -> list[dict[str, Any]]:
        """Generate a batch of events."""
        return [self.generate_event() for _ in range(batch_size)]


# ---------------------------------------------------------------------------
# Event Hub producer
# ---------------------------------------------------------------------------
class EventHubProducer:
    """Send events to Azure Event Hub."""

    def __init__(
        self,
        connection_string: str,
        event_hub_name: str,
        batch_size: int = 100,
    ):
        self.connection_string = connection_string
        self.event_hub_name = event_hub_name
        self.batch_size = batch_size
        self.producer = None
        self.total_sent = 0
        self.total_errors = 0

    def connect(self):
        """Initialize Event Hub producer client."""
        try:
            from azure.eventhub import EventData, EventHubProducerClient
            self.EventData = EventData
            self.producer = EventHubProducerClient.from_connection_string(
                conn_str=self.connection_string,
                eventhub_name=self.event_hub_name,
            )
            logger.info("Connected to Event Hub: %s", self.event_hub_name)
        except ImportError:
            logger.error(
                "azure-eventhub package not installed. "
                "Install with: pip install azure-eventhub"
            )
            raise

    def send_batch(self, events: list[dict[str, Any]]) -> int:
        """Send a batch of events to Event Hub.

        Args:
            events: List of event dicts.

        Returns:
            Number of events sent successfully.
        """
        if self.producer is None:
            raise RuntimeError("Producer not connected. Call connect() first.")

        try:
            event_data_batch = self.producer.create_batch()
            sent_count = 0

            for event in events:
                try:
                    event_data = self.EventData(json.dumps(event))
                    event_data.properties = {
                        "event_type": event.get("event_type", "unknown"),
                        "machine_id": event.get("machine_id", ""),
                        "floor_zone": event.get("floor_zone", ""),
                    }
                    if event.get("ctr_trigger"):
                        event_data.properties["compliance_flag"] = "CTR"

                    event_data_batch.add(event_data)
                    sent_count += 1
                except ValueError:
                    # Batch is full, send and create new
                    self.producer.send_batch(event_data_batch)
                    self.total_sent += sent_count
                    event_data_batch = self.producer.create_batch()
                    event_data_batch.add(self.EventData(json.dumps(event)))
                    sent_count = 1

            if sent_count > 0:
                self.producer.send_batch(event_data_batch)
                self.total_sent += sent_count

            return sent_count

        except Exception as exc:
            self.total_errors += 1
            logger.error("Failed to send batch: %s", exc)
            return 0

    def close(self):
        """Close the producer connection."""
        if self.producer:
            self.producer.close()
            logger.info("Producer closed. Total sent: %d, Errors: %d",
                        self.total_sent, self.total_errors)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Slot machine event producer for Azure Event Hub.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Simulate events to Event Hub
  python slot_event_producer.py --mode simulate \\
      --event-hub-connection "$CONN_STR" \\
      --event-hub-name "slot-events" \\
      --events-per-second 100 --duration 3600

  # Dry run (print events to stdout)
  python slot_event_producer.py --mode simulate --dry-run --events-per-second 10 --duration 10

  # Send events from JSONL file
  python slot_event_producer.py --mode file --input events.jsonl
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["simulate", "file"],
        default="simulate",
        help="Operation mode",
    )
    parser.add_argument(
        "--event-hub-connection",
        default=os.environ.get("EVENT_HUB_CONNECTION_STRING", ""),
        help="Event Hub connection string (or set EVENT_HUB_CONNECTION_STRING)",
    )
    parser.add_argument(
        "--event-hub-name",
        default=os.environ.get("EVENT_HUB_NAME", "slot-events"),
        help="Event Hub name",
    )
    parser.add_argument(
        "--events-per-second",
        type=int,
        default=100,
        help="Target events per second in simulate mode (default: 100)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=int(os.environ.get("BATCH_SIZE", "100")),
        help="Events per batch (default: 100)",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=0,
        help="Duration in seconds (0 = infinite, default: 0)",
    )
    parser.add_argument(
        "--num-machines",
        type=int,
        default=1500,
        help="Number of simulated machines (default: 1500)",
    )
    parser.add_argument(
        "--input",
        default=None,
        help="Input JSONL file for file mode",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print events to stdout instead of sending to Event Hub",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    running = True

    def signal_handler(signum, frame):
        nonlocal running
        logger.info("Shutdown signal received, finishing current batch...")
        running = False

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # ---- Simulate mode ----
    if args.mode == "simulate":
        simulator = SlotEventSimulator(
            num_machines=args.num_machines,
            seed=args.seed,
        )

        producer = None
        if not args.dry_run:
            if not args.event_hub_connection:
                logger.error("Event Hub connection string required. Use --event-hub-connection or set EVENT_HUB_CONNECTION_STRING")
                return 1
            producer = EventHubProducer(
                connection_string=args.event_hub_connection,
                event_hub_name=args.event_hub_name,
                batch_size=args.batch_size,
            )
            producer.connect()

        start_time = time.time()
        total_events = 0
        batch_interval = args.batch_size / max(args.events_per_second, 1)

        logger.info("Starting simulation: %d events/sec, batch_size=%d",
                     args.events_per_second, args.batch_size)

        try:
            while running:
                if args.duration > 0 and (time.time() - start_time) >= args.duration:
                    break

                batch = simulator.generate_batch(args.batch_size)

                if args.dry_run:
                    for event in batch:
                        print(json.dumps(event))
                    total_events += len(batch)
                else:
                    sent = producer.send_batch(batch)
                    total_events += sent

                elapsed = time.time() - start_time
                if total_events % (args.batch_size * 10) == 0 and total_events > 0:
                    rate = total_events / elapsed if elapsed > 0 else 0
                    logger.info("Progress: %d events sent (%.1f events/sec)", total_events, rate)

                # Throttle to target rate
                sleep_time = batch_interval - (time.time() - start_time - (total_events / max(args.events_per_second, 1)))
                if sleep_time > 0:
                    time.sleep(sleep_time)

        finally:
            if producer:
                producer.close()

        elapsed = time.time() - start_time
        logger.info("Simulation complete: %d events in %.1fs (%.1f events/sec)",
                     total_events, elapsed, total_events / elapsed if elapsed > 0 else 0)

    # ---- File mode ----
    elif args.mode == "file":
        if not args.input:
            logger.error("--input file required for file mode")
            return 1

        if not args.dry_run and not args.event_hub_connection:
            logger.error("Event Hub connection string required")
            return 1

        producer = None
        if not args.dry_run:
            producer = EventHubProducer(
                connection_string=args.event_hub_connection,
                event_hub_name=args.event_hub_name,
                batch_size=args.batch_size,
            )
            producer.connect()

        try:
            batch = []
            total = 0
            with open(args.input) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    event = json.loads(line)
                    batch.append(event)

                    if len(batch) >= args.batch_size:
                        if args.dry_run:
                            for e in batch:
                                print(json.dumps(e))
                        else:
                            producer.send_batch(batch)
                        total += len(batch)
                        batch = []

            if batch:
                if args.dry_run:
                    for e in batch:
                        print(json.dumps(e))
                else:
                    producer.send_batch(batch)
                total += len(batch)

            logger.info("File mode complete: %d events processed", total)

        finally:
            if producer:
                producer.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
