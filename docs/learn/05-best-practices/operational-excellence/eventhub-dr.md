# Event Hubs Disaster Recovery

> **[Home](../../../README.md)** | **[Best Practices](../README.md)** | **[Operational Excellence](README.md)** | **Event Hubs DR**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Operations-orange?style=flat-square)

Disaster recovery strategies for Azure Event Hubs in analytics platforms.

---

## Overview

Event Hubs disaster recovery ensures business continuity for streaming workloads. This guide covers geo-redundancy, failover strategies, and recovery procedures.

---

## DR Options

### Comparison

| Option | RTO | RPO | Cost | Complexity |
|--------|-----|-----|------|------------|
| Geo-DR (paired) | Minutes | ~0 | High | Low |
| Active-Active | ~0 | ~0 | Very High | High |
| Active-Passive | Hours | Minutes | Medium | Medium |
| Backup/Restore | Hours | Hours | Low | Medium |

---

## Geo-Disaster Recovery

### Configuration

```bicep
// Primary namespace
resource primaryNamespace 'Microsoft.EventHub/namespaces@2022-10-01-preview' = {
  name: 'eh-ns-primary-eastus'
  location: 'eastus'
  sku: {
    name: 'Premium'
    tier: 'Premium'
    capacity: 4
  }
  properties: {
    zoneRedundant: true
  }
}

// Secondary namespace (different region)
resource secondaryNamespace 'Microsoft.EventHub/namespaces@2022-10-01-preview' = {
  name: 'eh-ns-secondary-westus'
  location: 'westus'
  sku: {
    name: 'Premium'
    tier: 'Premium'
    capacity: 4
  }
  properties: {
    zoneRedundant: true
  }
}

// Geo-DR pairing
resource geoDRPairing 'Microsoft.EventHub/namespaces/disasterRecoveryConfigs@2022-10-01-preview' = {
  parent: primaryNamespace
  name: 'geodr-alias'
  properties: {
    partnerNamespace: secondaryNamespace.id
  }
}
```

### Alias Connection String

```python
# Use the alias for automatic failover
from azure.eventhub import EventHubProducerClient

# Alias automatically routes to active namespace
alias_connection = "Endpoint=sb://geodr-alias.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=xxx"

producer = EventHubProducerClient.from_connection_string(
    conn_str=alias_connection,
    eventhub_name="telemetry"
)
```

---

## Failover Procedures

### Automated Failover Detection

```python
from azure.mgmt.eventhub import EventHubManagementClient
from azure.identity import DefaultAzureCredential

class EventHubDRManager:
    """Manage Event Hub disaster recovery operations."""

    def __init__(self, subscription_id: str):
        self.credential = DefaultAzureCredential()
        self.client = EventHubManagementClient(self.credential, subscription_id)

    def check_namespace_health(self, resource_group: str, namespace: str) -> dict:
        """Check health of Event Hub namespace."""
        try:
            ns = self.client.namespaces.get(resource_group, namespace)
            return {
                "status": ns.status,
                "provisioning_state": ns.provisioning_state,
                "healthy": ns.status == "Active"
            }
        except Exception as e:
            return {"status": "Unknown", "healthy": False, "error": str(e)}

    def initiate_failover(self, resource_group: str, namespace: str, alias: str):
        """Initiate failover to secondary namespace."""
        print(f"Initiating failover for {alias}...")

        # This is a destructive operation - pairing is broken
        self.client.disaster_recovery_configs.fail_over(
            resource_group_name=resource_group,
            namespace_name=namespace,
            alias=alias
        )

        print("Failover initiated. Monitor for completion.")
```

### Manual Failover Steps

```powershell
# 1. Check current DR status
az eventhubs namespace show \
    --resource-group rg-eventhub \
    --name eh-ns-primary-eastus \
    --query "status"

# 2. Initiate failover (breaks pairing)
az eventhubs georecovery-alias fail-over \
    --resource-group rg-eventhub \
    --namespace-name eh-ns-secondary-westus \
    --alias geodr-alias

# 3. Verify failover complete
az eventhubs georecovery-alias show \
    --resource-group rg-eventhub \
    --namespace-name eh-ns-secondary-westus \
    --alias geodr-alias

# 4. Update DNS/connections if not using alias
```

---

## Active-Active Pattern

### Dual Write Implementation

```python
import asyncio
from azure.eventhub.aio import EventHubProducerClient

class DualWriteProducer:
    """Write events to multiple Event Hub namespaces."""

    def __init__(self, primary_conn: str, secondary_conn: str, eventhub_name: str):
        self.producers = [
            EventHubProducerClient.from_connection_string(primary_conn, eventhub_name=eventhub_name),
            EventHubProducerClient.from_connection_string(secondary_conn, eventhub_name=eventhub_name)
        ]

    async def send_events(self, events: list):
        """Send events to both namespaces."""
        async def send_to_producer(producer, events):
            batch = await producer.create_batch()
            for event in events:
                batch.add(event)
            await producer.send_batch(batch)

        # Send to both concurrently
        results = await asyncio.gather(
            send_to_producer(self.producers[0], events),
            send_to_producer(self.producers[1], events),
            return_exceptions=True
        )

        # Check for failures
        failures = [r for r in results if isinstance(r, Exception)]
        if len(failures) == len(self.producers):
            raise Exception("All producers failed")

        return {"success": True, "failures": len(failures)}
```

### Consumer Deduplication

```python
class DeduplicatingConsumer:
    """Consume from multiple namespaces with deduplication."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.dedup_ttl = 86400  # 24 hours

    async def process_event(self, event) -> bool:
        """Process event with deduplication."""
        # Use event properties for deduplication key
        event_id = event.properties.get(b"event-id", b"").decode()

        if not event_id:
            # Generate from content hash
            event_id = hashlib.sha256(event.body_as_str().encode()).hexdigest()

        # Check if already processed
        key = f"eventhub:processed:{event_id}"
        if self.redis.get(key):
            return False  # Already processed

        # Process the event
        await self._process(event)

        # Mark as processed
        self.redis.setex(key, self.dedup_ttl, "1")
        return True
```

---

## Consumer Group Recovery

### Checkpoint Recovery

```python
from azure.eventhub import EventHubConsumerClient
from azure.eventhub.extensions.checkpointstoreblob import BlobCheckpointStore

class ResilientConsumer:
    """Consumer with checkpoint store for recovery."""

    def __init__(self, eventhub_conn: str, storage_conn: str, eventhub_name: str):
        self.checkpoint_store = BlobCheckpointStore.from_connection_string(
            storage_conn,
            container_name="eventhub-checkpoints"
        )
        self.client = EventHubConsumerClient.from_connection_string(
            eventhub_conn,
            consumer_group="$Default",
            eventhub_name=eventhub_name,
            checkpoint_store=self.checkpoint_store
        )

    async def process_events(self, events, partition_context):
        """Process events with checkpointing."""
        for event in events:
            try:
                await self._process_event(event)
            except Exception as e:
                # Don't checkpoint failed events
                print(f"Failed to process event: {e}")
                raise

        # Checkpoint after successful processing
        await partition_context.update_checkpoint()

    def get_checkpoint_info(self) -> dict:
        """Get current checkpoint positions."""
        checkpoints = {}
        # Implementation to read checkpoint blob
        return checkpoints
```

---

## Monitoring

### DR Health Metrics

```kql
// Monitor Event Hub health across regions
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.EVENTHUB"
| where OperationName in ("Send", "Receive")
| summarize
    SuccessCount = countif(ResultType == "Success"),
    FailureCount = countif(ResultType == "Failure"),
    AvgLatency = avg(DurationMs)
    by bin(TimeGenerated, 5m), Resource, Location = _ResourceId
| extend SuccessRate = round(100.0 * SuccessCount / (SuccessCount + FailureCount), 2)
| order by TimeGenerated desc
```

### Alerting

```json
{
    "type": "Microsoft.Insights/metricAlerts",
    "properties": {
        "severity": 1,
        "criteria": {
            "allOf": [
                {
                    "name": "RegionalOutage",
                    "metricName": "IncomingRequests",
                    "operator": "LessThan",
                    "threshold": 1,
                    "timeAggregation": "Total",
                    "dimensions": []
                }
            ]
        },
        "windowSize": "PT5M",
        "evaluationFrequency": "PT1M"
    }
}
```

---

## Recovery Runbook

### Failover Checklist

1. **Detection**
   - [ ] Verify primary region outage (not transient)
   - [ ] Check Azure status page
   - [ ] Validate monitoring alerts

2. **Decision**
   - [ ] Confirm RTO/RPO requirements
   - [ ] Notify stakeholders
   - [ ] Get approval for failover

3. **Execution**
   - [ ] Initiate Geo-DR failover
   - [ ] Update consumer checkpoints if needed
   - [ ] Redirect producers to secondary

4. **Validation**
   - [ ] Verify events flowing to secondary
   - [ ] Check consumer lag
   - [ ] Validate downstream systems

5. **Recovery**
   - [ ] Plan re-pairing after primary recovery
   - [ ] Conduct post-incident review

---

## Related Documentation

- [Event Hubs Overview](../../../02-services/streaming-services/azure-event-hubs/README.md)
- [Capture Optimization](../cross-cutting-concerns/storage/capture-optimization.md)
- [Reliability Patterns](reliability.md)

---

*Last Updated: January 2025*
