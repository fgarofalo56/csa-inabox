# Edge and Offline Handling

> **[Home](../../../README.md)** | **[Best Practices](../README.md)** | **[Operational Excellence](README.md)** | **Edge Offline Handling**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Operations-orange?style=flat-square)

Best practices for handling disconnected and edge scenarios in analytics pipelines.

---

## Overview

Edge computing and offline scenarios require special handling to ensure data integrity and eventual consistency when connectivity is intermittent.

---

## Architecture Patterns

### Store and Forward

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Edge       │     │   Gateway   │     │   Cloud     │
│  Device     │────▶│   (Buffer)  │────▶│   Ingest    │
│             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
 Local Store         Queue/Buffer       Event Hubs
```

### Implementation

```python
import sqlite3
import json
from datetime import datetime
from queue import Queue
from threading import Thread

class OfflineDataHandler:
    """Handle data collection during offline periods."""

    def __init__(self, db_path: str = "offline_buffer.db"):
        self.db_path = db_path
        self.online = False
        self.upload_queue = Queue()
        self._init_db()
        self._start_sync_thread()

    def _init_db(self):
        """Initialize local SQLite buffer."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS offline_buffer (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                synced INTEGER DEFAULT 0
            )
        """)
        conn.commit()
        conn.close()

    def store_event(self, event_type: str, payload: dict):
        """Store event locally."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO offline_buffer (timestamp, event_type, payload) VALUES (?, ?, ?)",
            (datetime.utcnow().isoformat(), event_type, json.dumps(payload))
        )
        conn.commit()
        conn.close()

        # If online, queue for immediate upload
        if self.online:
            self.upload_queue.put((event_type, payload))

    def sync_pending(self):
        """Sync all pending events to cloud."""
        conn = sqlite3.connect(self.db_path)
        pending = conn.execute(
            "SELECT id, event_type, payload FROM offline_buffer WHERE synced = 0 ORDER BY id"
        ).fetchall()

        for id, event_type, payload in pending:
            try:
                self._upload_event(event_type, json.loads(payload))
                conn.execute("UPDATE offline_buffer SET synced = 1 WHERE id = ?", (id,))
                conn.commit()
            except Exception as e:
                print(f"Sync failed for event {id}: {e}")
                break

        conn.close()
```

---

## Azure IoT Edge Integration

### Edge Module Configuration

```json
{
    "modulesContent": {
        "$edgeAgent": {
            "properties.desired": {
                "modules": {
                    "DataCollector": {
                        "type": "docker",
                        "settings": {
                            "image": "myregistry.azurecr.io/data-collector:1.0",
                            "createOptions": {
                                "HostConfig": {
                                    "Binds": ["/data:/app/data"]
                                }
                            }
                        },
                        "env": {
                            "BUFFER_PATH": {"value": "/app/data/buffer"},
                            "MAX_BUFFER_SIZE_MB": {"value": "500"},
                            "SYNC_INTERVAL_SECONDS": {"value": "60"}
                        }
                    }
                }
            }
        },
        "$edgeHub": {
            "properties.desired": {
                "routes": {
                    "DataToCloud": "FROM /messages/modules/DataCollector/* INTO $upstream",
                    "DataToLocal": "FROM /messages/modules/DataCollector/* INTO BrokeredEndpoint(\"/modules/LocalStore/inputs/data\")"
                },
                "storeAndForwardConfiguration": {
                    "timeToLiveSecs": 7200
                }
            }
        }
    }
}
```

### Offline Detection

```python
import asyncio
from azure.iot.device.aio import IoTHubModuleClient

class EdgeConnectivityManager:
    """Manage edge connectivity state."""

    def __init__(self):
        self.client = None
        self.is_connected = False
        self.offline_handler = OfflineDataHandler()

    async def connect(self):
        """Initialize IoT Edge module client."""
        self.client = IoTHubModuleClient.create_from_edge_environment()
        self.client.on_connection_state_change = self._on_connection_change
        await self.client.connect()

    def _on_connection_change(self, connected: bool):
        """Handle connectivity state changes."""
        self.is_connected = connected
        if connected:
            print("Connected - syncing pending data")
            asyncio.create_task(self._sync_offline_data())
        else:
            print("Disconnected - switching to offline mode")

    async def send_telemetry(self, data: dict):
        """Send telemetry with offline fallback."""
        if self.is_connected:
            try:
                await self.client.send_message(json.dumps(data))
            except Exception:
                self.offline_handler.store_event("telemetry", data)
        else:
            self.offline_handler.store_event("telemetry", data)
```

---

## Data Integrity

### Idempotent Processing

```python
from hashlib import sha256

class IdempotentEventProcessor:
    """Ensure events are processed exactly once."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.ttl_seconds = 86400 * 7  # 7 days

    def generate_event_id(self, event: dict) -> str:
        """Generate deterministic event ID."""
        # Use business key fields for ID
        key_fields = sorted([
            event.get("device_id", ""),
            event.get("timestamp", ""),
            event.get("event_type", "")
        ])
        return sha256("|".join(key_fields).encode()).hexdigest()

    def should_process(self, event: dict) -> bool:
        """Check if event should be processed."""
        event_id = self.generate_event_id(event)

        # Try to set key with NX (only if not exists)
        result = self.redis.set(
            f"processed:{event_id}",
            "1",
            nx=True,
            ex=self.ttl_seconds
        )

        return result is not None
```

### Conflict Resolution

```python
class ConflictResolver:
    """Resolve conflicts in offline data sync."""

    STRATEGIES = {
        "last_write_wins": lambda old, new: new,
        "first_write_wins": lambda old, new: old,
        "merge": lambda old, new: {**old, **new},
        "version_check": None  # Custom logic
    }

    def resolve(self, old_record: dict, new_record: dict, strategy: str = "last_write_wins"):
        """Resolve conflict between records."""
        if strategy == "version_check":
            return self._version_based_resolution(old_record, new_record)

        resolver = self.STRATEGIES.get(strategy, self.STRATEGIES["last_write_wins"])
        return resolver(old_record, new_record)

    def _version_based_resolution(self, old: dict, new: dict) -> dict:
        """Resolve based on version vectors."""
        old_version = old.get("_version", 0)
        new_version = new.get("_version", 0)

        if new_version > old_version:
            return new
        elif new_version < old_version:
            return old
        else:
            # Same version - use timestamp
            if new.get("_modified", "") > old.get("_modified", ""):
                return new
            return old
```

---

## Buffering Strategies

### Memory-Efficient Buffer

```python
from collections import deque
import os

class HybridBuffer:
    """Memory buffer with disk overflow."""

    def __init__(self, memory_limit: int = 1000, disk_path: str = "/tmp/buffer"):
        self.memory_limit = memory_limit
        self.disk_path = disk_path
        self.memory_buffer = deque(maxlen=memory_limit)
        self.disk_overflow = False
        os.makedirs(disk_path, exist_ok=True)

    def append(self, item: dict):
        """Add item to buffer."""
        if len(self.memory_buffer) >= self.memory_limit:
            self._overflow_to_disk()

        self.memory_buffer.append(item)

    def _overflow_to_disk(self):
        """Move oldest items to disk."""
        overflow_count = len(self.memory_buffer) // 2
        overflow_items = [self.memory_buffer.popleft() for _ in range(overflow_count)]

        filename = f"{self.disk_path}/overflow_{datetime.utcnow().timestamp()}.json"
        with open(filename, 'w') as f:
            json.dump(overflow_items, f)

        self.disk_overflow = True

    def flush(self):
        """Get all buffered items."""
        items = list(self.memory_buffer)
        self.memory_buffer.clear()

        # Include disk overflow
        if self.disk_overflow:
            for filename in sorted(os.listdir(self.disk_path)):
                filepath = os.path.join(self.disk_path, filename)
                with open(filepath, 'r') as f:
                    items.extend(json.load(f))
                os.remove(filepath)
            self.disk_overflow = False

        return items
```

---

## Monitoring

### Offline Metrics

```kql
// Monitor offline duration and data loss
OfflineEvents
| where EventType == "connectivity_change"
| extend PreviousState = prev(ConnectionState, 1)
| where ConnectionState == "online" and PreviousState == "offline"
| extend OfflineDuration = datetime_diff('minute', Timestamp, prev(Timestamp, 1))
| summarize
    OfflineCount = count(),
    AvgOfflineMinutes = avg(OfflineDuration),
    MaxOfflineMinutes = max(OfflineDuration),
    TotalOfflineMinutes = sum(OfflineDuration)
    by DeviceId, bin(Timestamp, 1d)
```

---

## Related Documentation

- [Event Hubs DR](eventhub-dr.md)
- [Reliability Patterns](reliability.md)
- [IoT Hub Integration](../../../02-services/streaming-services/azure-iot-hub/README.md)

---

*Last Updated: January 2025*
