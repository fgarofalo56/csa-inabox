# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: Custom Slot Machine SAS Protocol IoT Simulator
# MAGIC
# MAGIC **This notebook is a PRODUCER, not a consumer.**
# MAGIC It generates realistic slot machine telemetry conforming to the
# MAGIC SAS (Slot Accounting System) protocol and sends it to an Azure
# MAGIC Event Hub or IoT Hub at configurable throughput rates.
# MAGIC
# MAGIC Use this simulator to:
# MAGIC - Load-test downstream Eventstream and Lakehouse pipelines
# MAGIC - Generate realistic data for POC demonstrations
# MAGIC - Validate Bronze ingestion notebooks (07) without physical hardware
# MAGIC
# MAGIC ## SAS Event Types Generated
# MAGIC | Event Type | Description |
# MAGIC |---|---|
# MAGIC | `spin_result` | Reel outcome, coin-in, coin-out, win amount |
# MAGIC | `coin_in` | Bill/coin acceptor — denomination inserted |
# MAGIC | `coin_out` | Hopper/ticket dispenser — credit paid out |
# MAGIC | `jackpot` | Progressive or standalone jackpot hit |
# MAGIC | `door_open` | Cabinet door opened (maintenance/fill) |
# MAGIC | `tilt` | Machine fault — includes tilt code |
# MAGIC | `power_event` | Machine power-up or power-down |
# MAGIC | `meter_read` | Periodic meter snapshot (all accumulators) |
# MAGIC
# MAGIC ## Target
# MAGIC - **Destination:** Azure Event Hub (or IoT Hub device endpoint)
# MAGIC - **Rate:** 50–500 events/second (configurable)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import json
import os
import random
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional

# Event Hub / IoT Hub target — credentials from Key Vault / env vars
EVENTHUB_CONN_STRING = os.getenv("EVENTHUB_CONN_STRING")   # Key Vault secret
EVENTHUB_NAME        = os.getenv("EVENTHUB_NAME", "casino-slot-events")

# Throughput controls
TARGET_EVENTS_PER_SEC = int(os.getenv("TARGET_EVENTS_PER_SEC", "100"))
BATCH_SIZE            = int(os.getenv("BATCH_SIZE", "50"))       # events per send call
SIMULATION_MINUTES    = int(os.getenv("SIMULATION_MINUTES", "5"))
NUM_MACHINES          = int(os.getenv("NUM_MACHINES", "200"))    # virtual slot machines

# SAS protocol weights — realistic event distribution
EVENT_WEIGHTS = {
    "spin_result": 70,
    "coin_in":     10,
    "coin_out":     8,
    "meter_read":   5,
    "door_open":    3,
    "tilt":         2,
    "jackpot":      1,
    "power_event":  1,
}

print(f"Target EH    : {EVENTHUB_NAME}")
print(f"Rate (evt/s) : {TARGET_EVENTS_PER_SEC}")
print(f"Batch size   : {BATCH_SIZE}")
print(f"Duration     : {SIMULATION_MINUTES} minutes")
print(f"Machines     : {NUM_MACHINES}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## SAS Protocol Field Definitions
# MAGIC
# MAGIC All meter fields accumulate from machine power-up (never reset by operator).
# MAGIC Differences between consecutive meter reads represent activity in the interval.
# MAGIC
# MAGIC | Field | Type | Description |
# MAGIC |---|---|---|
# MAGIC | `machine_number` | str | Physical asset tag (1–NUM_MACHINES) |
# MAGIC | `denomination` | float | Bet unit: 0.01, 0.02, 0.05, 0.25, 1.00, 5.00 |
# MAGIC | `game_id` | str | Game theme identifier (e.g. WOLF_RUN_3) |
# MAGIC | `coin_in_meter` | int | Cumulative credits wagered (in units of $0.01) |
# MAGIC | `coin_out_meter` | int | Cumulative credits paid out |
# MAGIC | `games_played_meter` | int | Cumulative spins |
# MAGIC | `jackpot_meter` | int | Cumulative jackpot amount paid |
# MAGIC | `bill_in_meter` | int | Cumulative bills accepted (dollar value × 100) |
# MAGIC | `handpay_amount` | int | Amount requiring attendant handpay ($0.01 units) |
# MAGIC | `progressive_amount` | int | Current progressive jackpot level ($0.01 units) |

# COMMAND ----------

# MAGIC %md
# MAGIC ## Machine State Model

# COMMAND ----------

DENOMINATIONS   = [0.01, 0.02, 0.05, 0.25, 1.00, 5.00]
GAME_IDS        = ["WOLF_RUN_3","BUFFALO_GOLD","LIGHTNING_LINK",
                   "DRAGON_LINK","DANCING_DRUMS","GOLDEN_CENTURY",
                   "5_DRAGONS","GOLDEN_GODDESS","MYSTICAL_MERMAID"]
TILT_CODES      = ["51","52","53","55","61","62","70","71","FF"]  # SAS fault codes
LOCATIONS       = [f"ZONE_{z}" for z in ["A","B","C","D","E"]]
ZONES           = LOCATIONS

@dataclass
class SlotMachineState:
    """Mutable state for a single virtual slot machine."""
    machine_number:      str
    denomination:        float
    game_id:             str
    location_id:         str
    zone:                str
    firmware_ver:        str = "SAS_6.03"
    coin_in_meter:       int = 0
    coin_out_meter:      int = 0
    games_played_meter:  int = 0
    jackpot_meter:       int = 0
    bill_in_meter:       int = 0
    progressive_amount:  int = field(default_factory=lambda: random.randint(100_000, 5_000_000))
    is_door_open:        bool = False
    is_powered:          bool = True

def init_machines(n: int) -> list[SlotMachineState]:
    machines = []
    for i in range(1, n + 1):
        denom = random.choice(DENOMINATIONS)
        zone  = random.choice(ZONES)
        machines.append(SlotMachineState(
            machine_number=f"SLT{i:04d}",
            denomination=denom,
            game_id=random.choice(GAME_IDS),
            location_id=f"LOC_{i:04d}",
            zone=zone,
            coin_in_meter=random.randint(0, 10_000_000),
            coin_out_meter=random.randint(0, 9_000_000),
            games_played_meter=random.randint(0, 500_000),
        ))
    return machines

machines = init_machines(NUM_MACHINES)
print(f"Initialized {len(machines)} virtual slot machines.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Event Generators

# COMMAND ----------

def base_envelope(m: SlotMachineState, event_type: str) -> dict:
    return {
        "event_id":     str(uuid.uuid4()),
        "device_id":    m.machine_number,
        "device_type":  "slot_machine",
        "event_type":   event_type,
        "event_ts":     datetime.utcnow().isoformat() + "Z",
        "machine_number": m.machine_number,
        "denomination": m.denomination,
        "game_id":      m.game_id,
        "location_id":  m.location_id,
        "zone":         m.zone,
        "firmware_ver": m.firmware_ver,
    }

def generate_spin_result(m: SlotMachineState) -> dict:
    bet     = max(1, int(random.gauss(3, 1)))          # lines × bet multiplier
    coin_in = int(m.denomination * 100 * bet)
    win_mul = random.choices([0, 1, 2, 5, 10, 50, 100],
                              weights=[55, 20, 12, 7, 4, 1.5, 0.5])[0]
    coin_out = coin_in * win_mul
    m.coin_in_meter     += coin_in
    m.coin_out_meter    += coin_out
    m.games_played_meter += 1
    ev = base_envelope(m, "spin_result")
    ev.update({"bet_credits": bet, "win_credits": win_mul * bet,
                "coin_in": coin_in, "coin_out": coin_out,
                "coin_in_meter": m.coin_in_meter,
                "coin_out_meter": m.coin_out_meter,
                "games_played_meter": m.games_played_meter})
    return ev

def generate_jackpot(m: SlotMachineState) -> dict:
    amount = random.choice([
        random.randint(1200, 5000),    # minor
        random.randint(5001, 25000),   # major
        m.progressive_amount,          # progressive
    ])
    requires_handpay = amount >= 120_000   # $1,200 W-2G threshold × 100
    m.jackpot_meter     += amount
    m.coin_out_meter    += amount
    m.progressive_amount = random.randint(100_000, 5_000_000)   # reset
    ev = base_envelope(m, "jackpot")
    ev.update({"jackpot_amount": amount,
                "requires_handpay": requires_handpay,
                "handpay_amount": amount if requires_handpay else 0,
                "jackpot_meter": m.jackpot_meter,
                "progressive_amount": m.progressive_amount})
    return ev

def generate_coin_in(m: SlotMachineState) -> dict:
    bills = [100, 200, 500, 1000, 2000, 5000, 10000]  # $1–$100 in cents
    bill_val = random.choice(bills)
    m.bill_in_meter += bill_val
    ev = base_envelope(m, "coin_in")
    ev.update({"bill_denomination": bill_val,
                "bill_in_meter": m.bill_in_meter})
    return ev

def generate_coin_out(m: SlotMachineState) -> dict:
    tito_amount = random.randint(100, 50000)  # TITO ticket value in cents
    m.coin_out_meter += tito_amount
    ev = base_envelope(m, "coin_out")
    ev.update({"tito_amount": tito_amount, "coin_out_meter": m.coin_out_meter})
    return ev

def generate_door_event(m: SlotMachineState) -> dict:
    m.is_door_open = not m.is_door_open
    ev = base_envelope(m, "door_open")
    ev.update({"door_state": "open" if m.is_door_open else "closed",
                "door_type": random.choice(["main_door","bill_validator_door","drop_door"]),
                "badge_id": f"EMP{random.randint(1000,9999)}"})
    return ev

def generate_tilt(m: SlotMachineState) -> dict:
    ev = base_envelope(m, "tilt")
    ev.update({"tilt_code": random.choice(TILT_CODES),
                "tilt_description": "SAS fault detected",
                "auto_recoverable": random.random() > 0.3})
    return ev

def generate_power_event(m: SlotMachineState) -> dict:
    ev = base_envelope(m, "power_event")
    ev.update({"power_state": "up" if m.is_powered else "down",
                "reset_type": random.choice(["normal","watchdog","power_fail"])})
    return ev

def generate_meter_read(m: SlotMachineState) -> dict:
    ev = base_envelope(m, "meter_read")
    ev.update({
        "coin_in_meter":       m.coin_in_meter,
        "coin_out_meter":      m.coin_out_meter,
        "games_played_meter":  m.games_played_meter,
        "jackpot_meter":       m.jackpot_meter,
        "bill_in_meter":       m.bill_in_meter,
        "progressive_amount":  m.progressive_amount,
        "meter_read_reason":   random.choice(["scheduled","door_close","power_up"]),
    })
    return ev

EVENT_GENERATORS = {
    "spin_result":  generate_spin_result,
    "coin_in":      generate_coin_in,
    "coin_out":     generate_coin_out,
    "jackpot":      generate_jackpot,
    "door_open":    generate_door_event,
    "tilt":         generate_tilt,
    "power_event":  generate_power_event,
    "meter_read":   generate_meter_read,
}

EVENT_TYPES = list(EVENT_WEIGHTS.keys())
EVENT_WVALS = [EVENT_WEIGHTS[e] for e in EVENT_TYPES]

def next_event(machine: SlotMachineState) -> dict:
    event_type = random.choices(EVENT_TYPES, weights=EVENT_WVALS)[0]
    return EVENT_GENERATORS[event_type](machine)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Send to Event Hub — Batch Optimization

# COMMAND ----------

# NOTE: Install azure-eventhub on the Fabric cluster:
#   %pip install azure-eventhub
# Or add to the environment via Workspace Settings → Libraries.

from azure.eventhub import EventData, EventHubProducerClient
from azure.eventhub.exceptions import EventHubError


def create_producer() -> EventHubProducerClient:
    return EventHubProducerClient.from_connection_string(
        conn_str=EVENTHUB_CONN_STRING,
        eventhub_name=EVENTHUB_NAME,
    )

def send_batch(producer: EventHubProducerClient,
               events: list[dict]) -> int:
    """Pack events into an EventDataBatch (respects 1 MB limit) and send."""
    event_data_batch = producer.create_batch()
    overflow = []
    for ev in events:
        try:
            event_data_batch.add(EventData(json.dumps(ev, default=str)))
        except ValueError:          # batch full — start a new one
            producer.send_batch(event_data_batch)
            event_data_batch = producer.create_batch()
            event_data_batch.add(EventData(json.dumps(ev, default=str)))
    if len(event_data_batch) > 0:
        producer.send_batch(event_data_batch)
    return len(events)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configurable Throughput with Rate Limiting and Back-Pressure

# COMMAND ----------

# Stats accumulator (thread-safe via GIL for simple int ops)
stats = {"sent": 0, "errors": 0, "batches": 0}
_stop_event = threading.Event()

def run_simulator():
    """Main simulation loop — runs until SIMULATION_MINUTES elapses or stop()."""
    producer = create_producer()
    end_time = time.monotonic() + SIMULATION_MINUTES * 60
    interval = BATCH_SIZE / TARGET_EVENTS_PER_SEC   # seconds between batch sends

    print(f"Simulation started. Target: {TARGET_EVENTS_PER_SEC} evt/s "
          f"| Batch: {BATCH_SIZE} | Duration: {SIMULATION_MINUTES} min")

    try:
        while not _stop_event.is_set() and time.monotonic() < end_time:
            t0 = time.monotonic()

            # Generate one batch
            batch_machines = random.choices(machines, k=BATCH_SIZE)
            batch_events   = [next_event(m) for m in batch_machines]

            try:
                sent = send_batch(producer, batch_events)
                stats["sent"]    += sent
                stats["batches"] += 1
            except EventHubError as exc:
                stats["errors"] += 1
                # Back-pressure: wait 2 s on transient errors, then retry
                print(f"[WARN] EventHub error ({exc}); backing off 2 s")
                time.sleep(2)
                continue

            # Rate limiting: sleep for the remainder of the interval
            elapsed = time.monotonic() - t0
            sleep_s = max(0.0, interval - elapsed)
            if sleep_s > 0:
                time.sleep(sleep_s)

    finally:
        producer.close()
        print(f"\nSimulation complete. "
              f"Sent: {stats['sent']:,} | "
              f"Batches: {stats['batches']:,} | "
              f"Errors: {stats['errors']}")

def stop_simulator():
    """Graceful shutdown — call from a separate cell or interrupt."""
    _stop_event.set()
    print("Stop signal sent. Simulator will finish current batch and exit.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Start Simulation

# COMMAND ----------

# Run in a background thread so the notebook cell returns immediately
# and allows the monitoring cell below to execute concurrently.
sim_thread = threading.Thread(target=run_simulator, daemon=True)
sim_thread.start()
print("Simulator running in background thread. "
      "Run the next cell to monitor, or call stop_simulator() to halt.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Statistics and Monitoring

# COMMAND ----------

import time as _time

# Poll stats every 10 seconds for 60 seconds
for i in range(6):
    _time.sleep(10)
    elapsed_s = (i + 1) * 10
    rate = stats["sent"] / elapsed_s if elapsed_s > 0 else 0
    print(f"[{elapsed_s:3d}s] Sent: {stats['sent']:7,} | "
          f"Rate: {rate:6.1f} evt/s | "
          f"Batches: {stats['batches']:5,} | "
          f"Errors: {stats['errors']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Graceful Shutdown

# COMMAND ----------

# Uncomment to stop the simulator before SIMULATION_MINUTES elapses:
# stop_simulator()
# sim_thread.join(timeout=10)
# print("Simulator stopped.")

# NOTE: If running in a Fabric scheduled pipeline, set SIMULATION_MINUTES
# to match the pipeline trigger interval (e.g. 60 for hourly load tests).
# The simulator will exit cleanly when the time window expires.
