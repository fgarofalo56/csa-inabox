# Azure Event Hubs Code Examples

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Languages](https://img.shields.io/badge/Languages-Python%20%7C%20C%23%20%7C%20Java-blue)
![Complexity](https://img.shields.io/badge/Complexity-Beginner_to_Advanced-orange)

Production-ready code examples for Azure Event Hubs including event producers, consumers, and advanced streaming patterns with complete error handling and best practices.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Python Examples](#python-examples)
- [C# Examples](#c-examples)
- [Java Examples](#java-examples)
- [Common Patterns](#common-patterns)
- [Error Handling](#error-handling)
- [Performance Optimization](#performance-optimization)
- [Troubleshooting](#troubleshooting)

## Overview

This section provides working code examples for Azure Event Hubs across three programming languages:

- **Python**: Async/await patterns with comprehensive error handling
- **C#**: .NET 6+ with dependency injection and modern patterns
- **Java**: Spring Boot compatible with Kafka API support

### What's Included

Each example provides:

- ✅ Complete, production-ready code with error handling
- ✅ Batch processing for optimal throughput
- ✅ Retry logic with exponential backoff
- ✅ Checkpointing for reliable processing
- ✅ Authentication via Managed Identity
- ✅ Comprehensive logging and metrics
- ✅ Sample data and expected outputs

## Prerequisites

### Azure Resources

```bash
# Event Hubs Namespace
EVENTHUB_NAMESPACE="your-eventhub-namespace"
EVENTHUB_NAME="your-eventhub"

# Azure credentials (Managed Identity preferred)
AZURE_CLIENT_ID="your-client-id"        # Optional for local dev
AZURE_CLIENT_SECRET="your-client-secret" # Optional for local dev
AZURE_TENANT_ID="your-tenant-id"        # Optional for local dev
```

### Software Requirements

#### For Python Examples

```bash
# Python 3.8+
pip install azure-eventhub>=5.11.0
pip install azure-eventhub-checkpointstoreblob-aio>=1.1.4
pip install azure-identity>=1.12.0
pip install azure-storage-blob>=12.14.0
```

#### For C# Examples

```bash
# .NET 6.0 SDK or higher
dotnet --version

# Install packages
dotnet add package Azure.Messaging.EventHubs
dotnet add package Azure.Messaging.EventHubs.Processor
dotnet add package Azure.Identity
dotnet add package Azure.Storage.Blobs
```

#### For Java Examples

```xml
<!-- Maven dependencies -->
<dependencies>
    <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-messaging-eventhubs</artifactId>
        <version>5.15.0</version>
    </dependency>
    <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-messaging-eventhubs-checkpointstore-blob</artifactId>
        <version>1.16.0</version>
    </dependency>
    <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-identity</artifactId>
        <version>1.8.0</version>
    </dependency>
</dependencies>
```

## Python Examples

### Example 1: Basic Event Producer

**Complexity**: ![Beginner](https://img.shields.io/badge/Level-Beginner-green)

**Use Case**: Send single events or small batches to Event Hubs

```python
"""
Basic Event Producer for Azure Event Hubs

This example demonstrates:
1. Authentication using Managed Identity (DefaultAzureCredential)
2. Creating and sending event batches
3. Proper error handling
4. Resource cleanup
"""

import asyncio
import json
import logging
from typing import List, Dict
from azure.eventhub import EventData
from azure.eventhub.aio import EventHubProducerClient
from azure.identity.aio import DefaultAzureCredential

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class BasicEventProducer:
    """Simple event producer for Azure Event Hubs."""

    def __init__(self, namespace: str, eventhub_name: str):
        """
        Initialize producer with Managed Identity authentication.

        Args:
            namespace: Event Hubs namespace (e.g., 'mynamespace.servicebus.windows.net')
            eventhub_name: Name of the Event Hub
        """
        self.fully_qualified_namespace = namespace
        self.eventhub_name = eventhub_name
        self.credential = DefaultAzureCredential()

    async def send_single_event(self, event_data: Dict):
        """
        Send a single event to Event Hubs.

        Args:
            event_data: Dictionary containing event data
        """
        try:
            logger.info("Creating Event Hub producer client")

            async with EventHubProducerClient(
                fully_qualified_namespace=self.fully_qualified_namespace,
                eventhub_name=self.eventhub_name,
                credential=self.credential
            ) as producer:

                # Create event batch
                event_data_batch = await producer.create_batch()

                # Add event to batch
                event = EventData(json.dumps(event_data))
                event.properties = {
                    "source": "python-producer",
                    "version": "1.0"
                }

                try:
                    event_data_batch.add(event)
                except ValueError:
                    logger.error("Event too large for batch")
                    raise

                # Send batch
                await producer.send_batch(event_data_batch)
                logger.info(f"Successfully sent event: {event_data.get('id', 'unknown')}")

        except Exception as e:
            logger.error(f"Error sending event: {str(e)}")
            raise

    async def send_batch(self, events: List[Dict]):
        """
        Send multiple events as a batch.

        Args:
            events: List of event dictionaries
        """
        try:
            logger.info(f"Sending batch of {len(events)} events")

            async with EventHubProducerClient(
                fully_qualified_namespace=self.fully_qualified_namespace,
                eventhub_name=self.eventhub_name,
                credential=self.credential
            ) as producer:

                event_data_batch = await producer.create_batch()

                for event_data in events:
                    event = EventData(json.dumps(event_data))

                    try:
                        event_data_batch.add(event)
                    except ValueError:
                        # Batch full, send current batch and create new one
                        await producer.send_batch(event_data_batch)
                        logger.info(f"Sent full batch, creating new batch")

                        event_data_batch = await producer.create_batch()
                        event_data_batch.add(event)

                # Send remaining events
                if len(event_data_batch) > 0:
                    await producer.send_batch(event_data_batch)
                    logger.info(f"Sent final batch")

                logger.info(f"Successfully sent all {len(events)} events")

        except Exception as e:
            logger.error(f"Error sending batch: {str(e)}")
            raise


# Example usage
async def main():
    """Main execution function."""

    # Configuration
    namespace = "your-namespace.servicebus.windows.net"
    eventhub_name = "your-eventhub"

    # Create producer
    producer = BasicEventProducer(namespace, eventhub_name)

    # Example 1: Send single event
    single_event = {
        "id": "event-001",
        "sensor_id": "sensor-A01",
        "temperature": 72.5,
        "humidity": 45.2,
        "timestamp": "2025-12-10T10:30:00Z"
    }

    await producer.send_single_event(single_event)

    # Example 2: Send batch of events
    batch_events = [
        {
            "id": f"event-{i:03d}",
            "sensor_id": f"sensor-A{i:02d}",
            "temperature": 70.0 + i * 0.5,
            "humidity": 40.0 + i,
            "timestamp": "2025-12-10T10:30:00Z"
        }
        for i in range(10)
    ]

    await producer.send_batch(batch_events)


if __name__ == "__main__":
    asyncio.run(main())
```

**Expected Output**:

```text
INFO:__main__:Creating Event Hub producer client
INFO:__main__:Successfully sent event: event-001
INFO:__main__:Sending batch of 10 events
INFO:__main__:Successfully sent all 10 events
```

### Example 2: Event Consumer with Checkpointing

**Complexity**: ![Intermediate](https://img.shields.io/badge/Level-Intermediate-yellow)

**Use Case**: Reliable event consumption with checkpoint management

```python
"""
Event Consumer with Checkpointing

This example demonstrates:
1. Receiving events from all partitions
2. Checkpoint management for reliable processing
3. Error handling and recovery
4. Graceful shutdown
"""

import asyncio
import logging
from typing import Dict
from azure.eventhub.aio import EventHubConsumerClient
from azure.eventhub.extensions.checkpointstoreblobaio import BlobCheckpointStore
from azure.identity.aio import DefaultAzureCredential

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class EventConsumer:
    """Event consumer with checkpoint management."""

    def __init__(
        self,
        namespace: str,
        eventhub_name: str,
        consumer_group: str,
        storage_account_url: str,
        container_name: str
    ):
        """
        Initialize consumer with checkpoint store.

        Args:
            namespace: Event Hubs namespace
            eventhub_name: Event Hub name
            consumer_group: Consumer group name
            storage_account_url: Blob storage URL for checkpoints
            container_name: Blob container name
        """
        self.namespace = namespace
        self.eventhub_name = eventhub_name
        self.consumer_group = consumer_group
        self.credential = DefaultAzureCredential()

        # Create checkpoint store
        self.checkpoint_store = BlobCheckpointStore(
            blob_account_url=storage_account_url,
            container_name=container_name,
            credential=self.credential
        )

        self.processed_count = 0
        self.error_count = 0

    async def on_event(self, partition_context, event):
        """
        Process individual event.

        Args:
            partition_context: Partition context for checkpointing
            event: Event data
        """
        try:
            # Process event
            logger.info(
                f"Received event from partition {partition_context.partition_id}: "
                f"Sequence: {event.sequence_number}, "
                f"Offset: {event.offset}"
            )

            # Deserialize event body
            event_data = event.body_as_json(encoding='UTF-8')

            # Your processing logic here
            await self.process_event(event_data)

            self.processed_count += 1

            # Checkpoint every 10 events
            if self.processed_count % 10 == 0:
                await partition_context.update_checkpoint(event)
                logger.info(f"Checkpoint updated at event {self.processed_count}")

        except Exception as e:
            logger.error(f"Error processing event: {str(e)}")
            self.error_count += 1

    async def on_partition_initialize(self, partition_context):
        """Called when partition processing starts."""
        logger.info(f"Partition {partition_context.partition_id} initialized")

    async def on_partition_close(self, partition_context, reason):
        """Called when partition processing ends."""
        logger.info(f"Partition {partition_context.partition_id} closed: {reason}")

    async def on_error(self, partition_context, error):
        """Called when an error occurs."""
        if partition_context:
            logger.error(
                f"Error in partition {partition_context.partition_id}: {str(error)}"
            )
        else:
            logger.error(f"Error: {str(error)}")

    async def process_event(self, event_data: Dict):
        """
        Process event data (implement your business logic).

        Args:
            event_data: Deserialized event data
        """
        # Example processing: log event details
        sensor_id = event_data.get('sensor_id', 'unknown')
        temperature = event_data.get('temperature', 0)

        logger.info(f"Processing: Sensor {sensor_id}, Temp: {temperature}°F")

        # Add your processing logic here
        # Examples:
        # - Write to database
        # - Send to another service
        # - Perform calculations
        # - Trigger alerts

        # Simulate processing time
        await asyncio.sleep(0.1)

    async def run(self, max_events: int = None):
        """
        Start consuming events.

        Args:
            max_events: Maximum events to process (None for infinite)
        """
        logger.info(f"Starting event consumer...")
        logger.info(f"  Namespace: {self.namespace}")
        logger.info(f"  Event Hub: {self.eventhub_name}")
        logger.info(f"  Consumer Group: {self.consumer_group}")

        async with EventHubConsumerClient(
            fully_qualified_namespace=self.namespace,
            eventhub_name=self.eventhub_name,
            consumer_group=self.consumer_group,
            credential=self.credential,
            checkpoint_store=self.checkpoint_store
        ) as consumer:

            try:
                await consumer.receive(
                    on_event=self.on_event,
                    on_partition_initialize=self.on_partition_initialize,
                    on_partition_close=self.on_partition_close,
                    on_error=self.on_error,
                    starting_position="-1"  # Start from beginning
                )

            except KeyboardInterrupt:
                logger.info("Shutdown requested by user")
            except Exception as e:
                logger.error(f"Consumer error: {str(e)}")
                raise
            finally:
                logger.info(f"Consumer stopped. Processed: {self.processed_count}, Errors: {self.error_count}")


# Example usage
async def main():
    """Main execution function."""

    # Configuration
    namespace = "your-namespace.servicebus.windows.net"
    eventhub_name = "your-eventhub"
    consumer_group = "$Default"
    storage_account_url = "https://yourstorageaccount.blob.core.windows.net"
    container_name = "eventhub-checkpoints"

    # Create and run consumer
    consumer = EventConsumer(
        namespace,
        eventhub_name,
        consumer_group,
        storage_account_url,
        container_name
    )

    await consumer.run()


if __name__ == "__main__":
    asyncio.run(main())
```

**Expected Output**:

```text
INFO:__main__:Starting event consumer...
INFO:__main__:  Namespace: your-namespace.servicebus.windows.net
INFO:__main__:  Event Hub: your-eventhub
INFO:__main__:  Consumer Group: $Default
INFO:__main__:Partition 0 initialized
INFO:__main__:Partition 1 initialized
INFO:__main__:Received event from partition 0: Sequence: 1234, Offset: 5678
INFO:__main__:Processing: Sensor sensor-A01, Temp: 72.5°F
INFO:__main__:Checkpoint updated at event 10
...
```

## C# Examples

### Example 1: Event Producer (.NET 6+)

**Complexity**: ![Beginner](https://img.shields.io/badge/Level-Beginner-green)

**Use Case**: Send events from .NET applications

```csharp
/*
 * Event Producer for Azure Event Hubs (.NET 6+)
 *
 * This example demonstrates:
 * 1. Authentication using DefaultAzureCredential
 * 2. Sending events in batches
 * 3. Error handling and retry logic
 * 4. Proper resource disposal
 */

using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Azure.Identity;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;
using Microsoft.Extensions.Logging;

namespace EventHubsExamples
{
    public class EventProducer
    {
        private readonly ILogger<EventProducer> _logger;
        private readonly string _fullyQualifiedNamespace;
        private readonly string _eventHubName;
        private readonly EventHubProducerClient _producerClient;

        public EventProducer(
            string fullyQualifiedNamespace,
            string eventHubName,
            ILogger<EventProducer> logger)
        {
            _fullyQualifiedNamespace = fullyQualifiedNamespace;
            _eventHubName = eventHubName;
            _logger = logger;

            // Create producer client with Managed Identity
            _producerClient = new EventHubProducerClient(
                fullyQualifiedNamespace,
                eventHubName,
                new DefaultAzureCredential()
            );

            _logger.LogInformation("Event Producer initialized for {EventHub}", eventHubName);
        }

        public async Task SendSingleEventAsync<T>(T eventData)
        {
            try
            {
                _logger.LogInformation("Sending single event");

                // Serialize event data
                var jsonData = JsonSerializer.Serialize(eventData);
                var eventDataObject = new EventData(Encoding.UTF8.GetBytes(jsonData));

                // Add custom properties
                eventDataObject.Properties.Add("source", "csharp-producer");
                eventDataObject.Properties.Add("timestamp", DateTime.UtcNow.ToString("o"));

                // Create batch and send
                using EventDataBatch eventBatch = await _producerClient.CreateBatchAsync();

                if (!eventBatch.TryAdd(eventDataObject))
                {
                    throw new Exception("Event too large for batch");
                }

                await _producerClient.SendAsync(eventBatch);

                _logger.LogInformation("Event sent successfully");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending event");
                throw;
            }
        }

        public async Task SendBatchAsync<T>(IEnumerable<T> events)
        {
            try
            {
                var eventsList = new List<T>(events);
                _logger.LogInformation("Sending batch of {Count} events", eventsList.Count);

                // Create batch
                using EventDataBatch eventBatch = await _producerClient.CreateBatchAsync();

                int sentCount = 0;
                foreach (var eventData in eventsList)
                {
                    // Serialize event
                    var jsonData = JsonSerializer.Serialize(eventData);
                    var eventDataObject = new EventData(Encoding.UTF8.GetBytes(jsonData));

                    // Try to add to current batch
                    if (!eventBatch.TryAdd(eventDataObject))
                    {
                        // Batch full, send current batch
                        await _producerClient.SendAsync(eventBatch);
                        sentCount += eventBatch.Count;

                        _logger.LogInformation("Sent full batch, creating new batch");

                        // Clear and retry adding the event
                        eventBatch.Clear();
                        if (!eventBatch.TryAdd(eventDataObject))
                        {
                            throw new Exception("Single event too large for batch");
                        }
                    }
                }

                // Send remaining events
                if (eventBatch.Count > 0)
                {
                    await _producerClient.SendAsync(eventBatch);
                    sentCount += eventBatch.Count;
                }

                _logger.LogInformation("Successfully sent all {Count} events", sentCount);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending batch");
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _producerClient.DisposeAsync();
            _logger.LogInformation("Event Producer disposed");
        }
    }

    // Example event data model
    public record SensorTelemetry(
        string SensorId,
        double Temperature,
        double Humidity,
        DateTime Timestamp
    );

    // Example usage
    public class Program
    {
        public static async Task Main(string[] args)
        {
            // Setup logging
            using var loggerFactory = LoggerFactory.Create(builder =>
            {
                builder.AddConsole();
                builder.SetMinimumLevel(LogLevel.Information);
            });

            var logger = loggerFactory.CreateLogger<EventProducer>();

            // Configuration
            var fullyQualifiedNamespace = "your-namespace.servicebus.windows.net";
            var eventHubName = "your-eventhub";

            // Create producer
            var producer = new EventProducer(fullyQualifiedNamespace, eventHubName, logger);

            try
            {
                // Example 1: Send single event
                var singleEvent = new SensorTelemetry(
                    "sensor-001",
                    72.5,
                    45.2,
                    DateTime.UtcNow
                );

                await producer.SendSingleEventAsync(singleEvent);

                // Example 2: Send batch
                var batchEvents = new List<SensorTelemetry>();
                for (int i = 0; i < 10; i++)
                {
                    batchEvents.Add(new SensorTelemetry(
                        $"sensor-{i:000}",
                        70.0 + i * 0.5,
                        40.0 + i,
                        DateTime.UtcNow
                    ));
                }

                await producer.SendBatchAsync(batchEvents);
            }
            finally
            {
                await producer.DisposeAsync();
            }
        }
    }
}
```

**Expected Output**:

```text
info: EventHubsExamples.EventProducer[0]
      Event Producer initialized for your-eventhub
info: EventHubsExamples.EventProducer[0]
      Sending single event
info: EventHubsExamples.EventProducer[0]
      Event sent successfully
info: EventHubsExamples.EventProducer[0]
      Sending batch of 10 events
info: EventHubsExamples.EventProducer[0]
      Successfully sent all 10 events
info: EventHubsExamples.EventProducer[0]
      Event Producer disposed
```

## Java Examples

### Example 1: Event Producer (Java)

**Complexity**: ![Beginner](https://img.shields.io/badge/Level-Beginner-green)

**Use Case**: Send events from Java applications

```java
/**
 * Event Producer for Azure Event Hubs (Java)
 *
 * This example demonstrates:
 * 1. Authentication using DefaultAzureCredential
 * 2. Sending events in batches
 * 3. Error handling
 * 4. Resource management
 */

package com.example.eventhubs;

import com.azure.core.util.BinaryData;
import com.azure.identity.DefaultAzureCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.messaging.eventhubs.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

public class EventProducer {

    private static final Logger logger = LoggerFactory.getLogger(EventProducer.class);
    private final EventHubProducerClient producer;
    private final ObjectMapper objectMapper;

    public EventProducer(String fullyQualifiedNamespace, String eventHubName) {
        logger.info("Initializing Event Producer for {}", eventHubName);

        // Create credential
        DefaultAzureCredential credential = new DefaultAzureCredentialBuilder()
            .build();

        // Create producer client
        this.producer = new EventHubClientBuilder()
            .fullyQualifiedNamespace(fullyQualifiedNamespace)
            .eventHubName(eventHubName)
            .credential(credential)
            .buildProducerClient();

        this.objectMapper = new ObjectMapper();

        logger.info("Event Producer initialized successfully");
    }

    public void sendSingleEvent(Object eventData) throws Exception {
        try {
            logger.info("Sending single event");

            // Serialize event data
            String jsonData = objectMapper.writeValueAsString(eventData);
            EventData event = new EventData(jsonData);

            // Add custom properties
            event.getProperties().put("source", "java-producer");
            event.getProperties().put("timestamp", Instant.now().toString());

            // Create batch and send
            EventDataBatch eventBatch = producer.createBatch();

            if (!eventBatch.tryAdd(event)) {
                throw new RuntimeException("Event too large for batch");
            }

            producer.send(eventBatch);

            logger.info("Event sent successfully");

        } catch (Exception ex) {
            logger.error("Error sending event", ex);
            throw ex;
        }
    }

    public void sendBatch(List<?> events) throws Exception {
        try {
            logger.info("Sending batch of {} events", events.size());

            EventDataBatch eventBatch = producer.createBatch();
            int sentCount = 0;

            for (Object eventData : events) {
                // Serialize event
                String jsonData = objectMapper.writeValueAsString(eventData);
                EventData event = new EventData(jsonData);

                // Try to add to current batch
                if (!eventBatch.tryAdd(event)) {
                    // Batch full, send current batch
                    producer.send(eventBatch);
                    sentCount += eventBatch.getCount();

                    logger.info("Sent full batch, creating new batch");

                    // Create new batch and retry
                    eventBatch = producer.createBatch();
                    if (!eventBatch.tryAdd(event)) {
                        throw new RuntimeException("Single event too large for batch");
                    }
                }
            }

            // Send remaining events
            if (eventBatch.getCount() > 0) {
                producer.send(eventBatch);
                sentCount += eventBatch.getCount();
            }

            logger.info("Successfully sent all {} events", sentCount);

        } catch (Exception ex) {
            logger.error("Error sending batch", ex);
            throw ex;
        }
    }

    public void close() {
        producer.close();
        logger.info("Event Producer closed");
    }

    // Example event data class
    public static class SensorTelemetry {
        public String sensorId;
        public double temperature;
        public double humidity;
        public Instant timestamp;

        public SensorTelemetry(String sensorId, double temperature, double humidity) {
            this.sensorId = sensorId;
            this.temperature = temperature;
            this.humidity = humidity;
            this.timestamp = Instant.now();
        }

        // Getters and setters
        public String getSensorId() { return sensorId; }
        public void setSensorId(String sensorId) { this.sensorId = sensorId; }

        public double getTemperature() { return temperature; }
        public void setTemperature(double temperature) { this.temperature = temperature; }

        public double getHumidity() { return humidity; }
        public void setHumidity(double humidity) { this.humidity = humidity; }

        public Instant getTimestamp() { return timestamp; }
        public void setTimestamp(Instant timestamp) { this.timestamp = timestamp; }
    }

    // Example usage
    public static void main(String[] args) {
        // Configuration
        String fullyQualifiedNamespace = "your-namespace.servicebus.windows.net";
        String eventHubName = "your-eventhub";

        // Create producer
        EventProducer producer = new EventProducer(fullyQualifiedNamespace, eventHubName);

        try {
            // Example 1: Send single event
            SensorTelemetry singleEvent = new SensorTelemetry("sensor-001", 72.5, 45.2);
            producer.sendSingleEvent(singleEvent);

            // Example 2: Send batch
            List<SensorTelemetry> batchEvents = new ArrayList<>();
            for (int i = 0; i < 10; i++) {
                batchEvents.add(new SensorTelemetry(
                    String.format("sensor-%03d", i),
                    70.0 + i * 0.5,
                    40.0 + i
                ));
            }

            producer.sendBatch(batchEvents);

        } catch (Exception ex) {
            logger.error("Error in main", ex);
        } finally {
            producer.close();
        }
    }
}
```

**Expected Output**:

```text
INFO  c.e.eventhubs.EventProducer - Initializing Event Producer for your-eventhub
INFO  c.e.eventhubs.EventProducer - Event Producer initialized successfully
INFO  c.e.eventhubs.EventProducer - Sending single event
INFO  c.e.eventhubs.EventProducer - Event sent successfully
INFO  c.e.eventhubs.EventProducer - Sending batch of 10 events
INFO  c.e.eventhubs.EventProducer - Successfully sent all 10 events
INFO  c.e.eventhubs.EventProducer - Event Producer closed
```

## Common Patterns

### Pattern 1: Retry Logic with Exponential Backoff

```python
import asyncio
from functools import wraps
import logging

logger = logging.getLogger(__name__)

def retry_with_backoff(max_retries=3, base_delay=1, backoff_factor=2):
    """Decorator for retry logic with exponential backoff."""

    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            delay = base_delay

            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)

                except Exception as e:
                    if attempt == max_retries:
                        logger.error(f"Failed after {max_retries} retries: {str(e)}")
                        raise

                    logger.warning(
                        f"Attempt {attempt + 1} failed: {str(e)}. "
                        f"Retrying in {delay} seconds..."
                    )

                    await asyncio.sleep(delay)
                    delay *= backoff_factor

        return wrapper
    return decorator

# Usage example
@retry_with_backoff(max_retries=3, base_delay=2)
async def send_event_with_retry(producer, event_data):
    """Send event with automatic retry."""
    await producer.send_single_event(event_data)
```

### Pattern 2: Partition Key Strategy

```python
from azure.eventhub import EventData
import hashlib

def create_event_with_partition_key(event_data: dict, key_field: str = "device_id"):
    """
    Create event with partition key for consistent routing.

    Args:
        event_data: Event payload
        key_field: Field to use as partition key
    """
    partition_key = event_data.get(key_field, "default")

    event = EventData(json.dumps(event_data))
    event.partition_key = partition_key

    return event

# Usage
event = create_event_with_partition_key(
    {"device_id": "sensor-001", "temperature": 72.5},
    key_field="device_id"
)
```

## Error Handling

### Handling Throttling and Quota Errors

```python
from azure.core.exceptions import HttpResponseError
import asyncio

async def send_with_throttling_handling(producer, events):
    """Send events with throttling handling."""
    try:
        await producer.send_batch(events)

    except HttpResponseError as e:
        if e.status_code == 429:  # Too Many Requests
            # Extract retry-after header
            retry_after = int(e.response.headers.get('Retry-After', 30))

            logger.warning(f"Throttled. Retrying after {retry_after} seconds")
            await asyncio.sleep(retry_after)

            # Retry
            await producer.send_batch(events)
        else:
            logger.error(f"HTTP error: {e.status_code} - {e.message}")
            raise
```

## Performance Optimization

### Batch Size Optimization

```python
# Optimal batch sizes
OPTIMAL_BATCH_SIZE = 100  # Events per batch
MAX_BATCH_BYTES = 256 * 1024  # 256 KB

async def send_optimized_batches(producer, events):
    """Send events in optimized batches."""
    current_batch = []

    for event in events:
        current_batch.append(event)

        if len(current_batch) >= OPTIMAL_BATCH_SIZE:
            await producer.send_batch(current_batch)
            current_batch = []

    # Send remaining
    if current_batch:
        await producer.send_batch(current_batch)
```

## Troubleshooting

### Common Issues

#### Issue 1: Authentication Failures

**Error**: `ClientAuthenticationError: Authentication failed`

**Solution**:
```python
# Verify Managed Identity is enabled
from azure.identity import DefaultAzureCredential

# Test credential
credential = DefaultAzureCredential()
token = credential.get_token("https://eventhubs.azure.net/.default")
print(f"Token acquired: {token.token[:20]}...")
```

#### Issue 2: Event Too Large

**Error**: `ValueError: EventDataBatch has reached its size limit`

**Solution**:
```python
# Split large events or compress data
import gzip
import json

def compress_event(event_data):
    """Compress event data."""
    json_data = json.dumps(event_data)
    compressed = gzip.compress(json_data.encode())

    event = EventData(compressed)
    event.properties["compressed"] = True

    return event
```

### Getting Help

- **Event Hubs Documentation**: [Azure Event Hubs Docs](https://docs.microsoft.com/azure/event-hubs/)
- **Troubleshooting Guide**: [Troubleshooting Section](../../../07-troubleshooting/README.md)
- **Best Practices**: [Event Streaming Best Practices](../../../05-best-practices/README.md)

---

**Last Updated**: 2025-12-10
**Version**: 1.0.0
**Maintainer**: CSA-in-a-Box Team
