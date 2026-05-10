# Reliability Patterns

> **[Home](../../../README.md)** | **[Best Practices](../README.md)** | **[Operational Excellence](README.md)** | **Reliability**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Operations-orange?style=flat-square)

Reliability patterns and practices for Azure analytics platforms.

---

## Overview

Building reliable data platforms requires designing for failure, implementing redundancy, and establishing recovery procedures.

---

## Reliability Principles

### Design Principles

| Principle | Implementation |
|-----------|----------------|
| Assume failure | Build retry logic, circuit breakers |
| Design for scale | Use auto-scaling, partitioning |
| Eliminate single points | Redundancy at every layer |
| Test failure modes | Chaos engineering, DR drills |
| Automate recovery | Self-healing, automated failover |

---

## Retry Patterns

### Exponential Backoff

```python
import time
import random
from functools import wraps

def retry_with_backoff(
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    exponential_base: float = 2.0,
    jitter: bool = True
):
    """Decorator for retry with exponential backoff."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            retries = 0
            while True:
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    retries += 1
                    if retries > max_retries:
                        raise

                    delay = min(base_delay * (exponential_base ** retries), max_delay)
                    if jitter:
                        delay = delay * (0.5 + random.random())

                    print(f"Retry {retries}/{max_retries} after {delay:.2f}s: {e}")
                    time.sleep(delay)
        return wrapper
    return decorator

@retry_with_backoff(max_retries=5)
def call_external_api(url: str) -> dict:
    """Call external API with retry."""
    response = requests.get(url)
    response.raise_for_status()
    return response.json()
```

### Circuit Breaker

```python
from datetime import datetime, timedelta
from enum import Enum
from threading import Lock

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

class CircuitBreaker:
    """Circuit breaker pattern implementation."""

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: int = 30,
        expected_exception: type = Exception
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception

        self.state = CircuitState.CLOSED
        self.failures = 0
        self.last_failure_time = None
        self.lock = Lock()

    def call(self, func, *args, **kwargs):
        """Execute function with circuit breaker protection."""
        with self.lock:
            if self.state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    self.state = CircuitState.HALF_OPEN
                else:
                    raise CircuitOpenError("Circuit is open")

        try:
            result = func(*args, **kwargs)
            self._on_success()
            return result
        except self.expected_exception as e:
            self._on_failure()
            raise

    def _on_success(self):
        """Handle successful call."""
        with self.lock:
            self.failures = 0
            self.state = CircuitState.CLOSED

    def _on_failure(self):
        """Handle failed call."""
        with self.lock:
            self.failures += 1
            self.last_failure_time = datetime.utcnow()

            if self.failures >= self.failure_threshold:
                self.state = CircuitState.OPEN

    def _should_attempt_reset(self) -> bool:
        """Check if enough time has passed to attempt reset."""
        if self.last_failure_time is None:
            return True
        return datetime.utcnow() > self.last_failure_time + timedelta(seconds=self.recovery_timeout)
```

---

## Redundancy Patterns

### Active-Passive

```bicep
// Primary Synapse workspace
resource primaryWorkspace 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: 'syn-primary-eastus'
  location: 'eastus'
  properties: {
    defaultDataLakeStorage: {
      resourceId: primaryStorageAccount.id
      accountUrl: 'https://${primaryStorageAccount.name}.dfs.core.windows.net'
      filesystem: 'synapse'
    }
  }
}

// Secondary Synapse workspace (standby)
resource secondaryWorkspace 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: 'syn-secondary-westus'
  location: 'westus'
  properties: {
    defaultDataLakeStorage: {
      resourceId: secondaryStorageAccount.id
      accountUrl: 'https://${secondaryStorageAccount.name}.dfs.core.windows.net'
      filesystem: 'synapse'
    }
  }
}
```

### Data Replication

```python
from azure.storage.blob import BlobServiceClient
import asyncio

class DataReplicator:
    """Replicate data between storage accounts."""

    def __init__(self, source_conn: str, target_conn: str):
        self.source_client = BlobServiceClient.from_connection_string(source_conn)
        self.target_client = BlobServiceClient.from_connection_string(target_conn)

    async def replicate_container(self, container_name: str, prefix: str = ""):
        """Replicate all blobs in a container."""
        source_container = self.source_client.get_container_client(container_name)
        target_container = self.target_client.get_container_client(container_name)

        # Ensure target container exists
        try:
            await target_container.create_container()
        except:
            pass

        # Copy blobs
        async for blob in source_container.list_blobs(name_starts_with=prefix):
            source_blob = source_container.get_blob_client(blob.name)
            target_blob = target_container.get_blob_client(blob.name)

            # Start async copy
            await target_blob.start_copy_from_url(source_blob.url)
```

---

## Health Checks

### Endpoint Health

```python
from fastapi import FastAPI, Response
from datetime import datetime

app = FastAPI()

class HealthChecker:
    """Check health of dependencies."""

    async def check_storage(self) -> dict:
        """Check storage account connectivity."""
        try:
            # Attempt to list containers
            containers = list(blob_client.list_containers(max_results=1))
            return {"status": "healthy"}
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}

    async def check_database(self) -> dict:
        """Check database connectivity."""
        try:
            spark.sql("SELECT 1").collect()
            return {"status": "healthy"}
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}

health_checker = HealthChecker()

@app.get("/health")
async def health_check():
    """Comprehensive health check endpoint."""
    checks = {
        "storage": await health_checker.check_storage(),
        "database": await health_checker.check_database(),
        "timestamp": datetime.utcnow().isoformat()
    }

    overall_healthy = all(c["status"] == "healthy" for c in checks.values() if isinstance(c, dict))

    status_code = 200 if overall_healthy else 503
    return Response(content=json.dumps(checks), status_code=status_code)
```

### Pipeline Health

```python
def check_pipeline_health(pipeline_name: str, lookback_hours: int = 24) -> dict:
    """Check pipeline execution health."""
    runs = get_recent_pipeline_runs(pipeline_name, lookback_hours)

    if not runs:
        return {"status": "unknown", "message": "No recent runs"}

    success_count = sum(1 for r in runs if r.status == "Succeeded")
    failure_count = sum(1 for r in runs if r.status == "Failed")
    success_rate = success_count / len(runs) if runs else 0

    if success_rate >= 0.95:
        status = "healthy"
    elif success_rate >= 0.80:
        status = "degraded"
    else:
        status = "unhealthy"

    return {
        "status": status,
        "success_rate": round(success_rate * 100, 2),
        "total_runs": len(runs),
        "failures": failure_count
    }
```

---

## Self-Healing

### Auto-Recovery Pipeline

```python
class SelfHealingPipeline:
    """Pipeline with automatic recovery capabilities."""

    def __init__(self, pipeline_name: str):
        self.pipeline_name = pipeline_name
        self.max_auto_retries = 3
        self.retry_count = 0

    async def run_with_recovery(self, parameters: dict):
        """Run pipeline with automatic recovery on failure."""
        while self.retry_count < self.max_auto_retries:
            try:
                result = await self._execute_pipeline(parameters)

                if result.status == "Succeeded":
                    self.retry_count = 0
                    return result

                # Analyze failure and attempt recovery
                recovery_action = self._analyze_failure(result)
                await self._apply_recovery(recovery_action)

            except Exception as e:
                self.retry_count += 1
                if self.retry_count >= self.max_auto_retries:
                    await self._escalate_failure(e)
                    raise

                await asyncio.sleep(60 * self.retry_count)  # Increasing delay

    def _analyze_failure(self, result) -> str:
        """Analyze failure and determine recovery action."""
        error_message = result.error_message or ""

        if "OutOfMemory" in error_message:
            return "scale_up"
        elif "Timeout" in error_message:
            return "increase_timeout"
        elif "ConnectionRefused" in error_message:
            return "retry_later"
        else:
            return "manual_review"

    async def _apply_recovery(self, action: str):
        """Apply recovery action."""
        if action == "scale_up":
            await self._scale_compute_resources()
        elif action == "increase_timeout":
            self.parameters["timeout"] = self.parameters.get("timeout", 3600) * 2
        elif action == "retry_later":
            await asyncio.sleep(300)
```

---

## SLA Management

### SLA Definitions

| Tier | Availability | RTO | RPO |
|------|--------------|-----|-----|
| Platinum | 99.99% | 15 min | 0 |
| Gold | 99.9% | 1 hour | 15 min |
| Silver | 99.5% | 4 hours | 1 hour |
| Bronze | 99% | 24 hours | 4 hours |

### SLA Tracking

```kql
// Calculate SLA compliance
let sla_target = 99.9;
HealthCheckLogs
| where TimeGenerated > ago(30d)
| summarize
    HealthyMinutes = countif(Status == "healthy"),
    TotalMinutes = count()
    by bin(TimeGenerated, 1d)
| extend
    UptimePercent = round(100.0 * HealthyMinutes / TotalMinutes, 4),
    SLAMet = iff(100.0 * HealthyMinutes / TotalMinutes >= sla_target, true, false)
| summarize
    AvgUptime = avg(UptimePercent),
    DaysMeetingSLA = countif(SLAMet),
    TotalDays = count()
```

---

## Related Documentation

- [Monitoring Best Practices](monitoring.md)
- [Event Hubs DR](eventhub-dr.md)
- [Alert Strategies](alert-strategies.md)

---

*Last Updated: January 2025*
