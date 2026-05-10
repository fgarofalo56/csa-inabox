# ⚡ Azure Event Hubs Quickstart

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-30--45_minutes-blue)

__Get started with Azure Event Hubs in under an hour. Learn to send and receive streaming events using this fully managed, real-time data ingestion service.__

## 🎯 Learning Objectives

After completing this quickstart, you will be able to:

- Understand what Azure Event Hubs is and when to use it
- Create an Event Hubs namespace and event hub
- Send events to an event hub using Python
- Receive and process events from an event hub
- Monitor event hub metrics in Azure Portal

## 📋 Prerequisites

Before starting, ensure you have:

- [ ] __Azure subscription__ - [Create free account](https://azure.microsoft.com/free/)
- [ ] __Python 3.7+__ - [Download Python](https://python.org/downloads/)
- [ ] __Azure CLI__ - [Install Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [ ] __Code editor__ - VS Code recommended
- [ ] __Basic Python knowledge__ - Understanding of variables, loops, functions

## 🔍 What is Azure Event Hubs?

Azure Event Hubs is a big data streaming platform and event ingestion service capable of receiving and processing millions of events per second.

### __Key Concepts__

- __Namespace__: Container for one or more event hubs
- __Event Hub__: The actual endpoint where events are sent
- __Partition__: Ordered sequence of events (enables parallel processing)
- __Consumer Group__: View of the event hub for different consumers
- __Throughput Units__: Pre-purchased capacity units

### __When to Use Event Hubs__

✅ __Good For:__

- Real-time telemetry and event streaming
- IoT device data ingestion
- Application logging and metrics
- High-throughput event processing
- Clickstream data capture

❌ __Not Ideal For:__

- Request-response patterns (use Service Bus)
- Small message volumes (use Queue Storage)
- Long-term storage (use Blob Storage)

## 🚀 Step 1: Create Event Hubs Namespace

### __Option A: Azure Portal__

1. __Navigate to Azure Portal__
   - Go to [portal.azure.com](https://portal.azure.com)
   - Search for "Event Hubs"
   - Click "Create"

2. __Configure Namespace__
   - __Subscription__: Select your subscription
   - __Resource Group__: Create new "rg-eventhub-quickstart"
   - __Namespace Name__: "ehns-quickstart-[yourname]" (must be globally unique)
   - __Location__: Choose nearest region
   - __Pricing Tier__: Standard (required for consumer groups)
   - __Throughput Units__: 1 (auto-inflate off)

3. __Review and Create__
   - Click "Review + create"
   - Click "Create"
   - Wait 2-3 minutes for deployment

### __Option B: Azure CLI__ (Faster)

```bash
# Set variables
RESOURCE_GROUP="rg-eventhub-quickstart"
LOCATION="eastus"
NAMESPACE_NAME="ehns-quickstart-$RANDOM"
EVENTHUB_NAME="events"

# Create resource group
az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create Event Hubs namespace
az eventhubs namespace create \
  --name $NAMESPACE_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --sku Standard \
  --capacity 1

# Create event hub
az eventhubs eventhub create \
  --name $EVENTHUB_NAME \
  --namespace-name $NAMESPACE_NAME \
  --resource-group $RESOURCE_GROUP \
  --partition-count 4 \
  --message-retention 1

echo "Namespace: $NAMESPACE_NAME"
echo "Event Hub: $EVENTHUB_NAME"
```

## 🔐 Step 2: Get Connection String

You need a connection string to send/receive events.

### __Using Azure Portal__

1. Navigate to your Event Hubs namespace
2. Click "Shared access policies" (left menu)
3. Click "RootManageSharedAccessKey"
4. Copy "Connection string–primary key"
5. Save securely (DO NOT commit to Git!)

### __Using Azure CLI__

```bash
# Get connection string
CONNECTION_STRING=$(az eventhubs namespace authorization-rule keys list \
  --resource-group $RESOURCE_GROUP \
  --namespace-name $NAMESPACE_NAME \
  --name RootManageSharedAccessKey \
  --query primaryConnectionString \
  --output tsv)

echo $CONNECTION_STRING
```

## 📤 Step 3: Send Events

Let's send events to Event Hubs using Python.

### __Install Azure SDK__

```bash
# Create project directory
mkdir eventhub-quickstart
cd eventhub-quickstart

# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Install Event Hubs SDK
pip install azure-eventhub
```

### __Create Event Producer__ (`producer.py`)

```python
"""
Event Hubs Producer - Sends sample events
"""
import asyncio
from azure.eventhub.aio import EventHubProducerClient
from azure.eventhub import EventData
import json
from datetime import datetime

# Configuration
CONNECTION_STRING = "YOUR_CONNECTION_STRING"  # Replace with your connection string
EVENTHUB_NAME = "events"  # Replace with your event hub name

async def send_events():
    """Send sample telemetry events to Event Hub"""

    # Create producer client
    producer = EventHubProducerClient.from_connection_string(
        conn_str=CONNECTION_STRING,
        eventhub_name=EVENTHUB_NAME
    )

    async with producer:
        # Create batch of events
        batch = await producer.create_batch()

        # Generate 10 sample events
        for i in range(10):
            event_data = {
                "device_id": f"device_{(i % 3) + 1}",  # 3 devices
                "temperature": 20 + (i * 2),
                "humidity": 60 + i,
                "timestamp": datetime.utcnow().isoformat()
            }

            # Add event to batch
            batch.add(EventData(json.dumps(event_data)))
            print(f"Added event {i+1}: {event_data}")

        # Send batch
        await producer.send_batch(batch)
        print(f"\n✅ Successfully sent {len(batch)} events to Event Hub!")

if __name__ == "__main__":
    # Run async function
    asyncio.run(send_events())
```

### __Run Producer__

```bash
# Update CONNECTION_STRING in producer.py, then run:
python producer.py
```

__Expected Output:__

```
Added event 1: {'device_id': 'device_1', 'temperature': 20, 'humidity': 60, ...}
Added event 2: {'device_id': 'device_2', 'temperature': 22, 'humidity': 61, ...}
...
✅ Successfully sent 10 events to Event Hub!
```

## 📥 Step 4: Receive Events

Now let's consume and process events.

### __Create Event Consumer__ (`consumer.py`)

```python
"""
Event Hubs Consumer - Receives and processes events
"""
import asyncio
from azure.eventhub.aio import EventHubConsumerClient
import json

# Configuration
CONNECTION_STRING = "YOUR_CONNECTION_STRING"  # Replace with your connection string
EVENTHUB_NAME = "events"  # Replace with your event hub name
CONSUMER_GROUP = "$Default"  # Default consumer group

async def on_event(partition_context, event):
    """
    Process received event

    Args:
        partition_context: Context for the partition
        event: Received event
    """
    # Decode event body
    event_data = json.loads(event.body_as_str())

    print(f"\n📨 Received event from partition {partition_context.partition_id}:")
    print(f"   Device: {event_data['device_id']}")
    print(f"   Temperature: {event_data['temperature']}°C")
    print(f"   Humidity: {event_data['humidity']}%")
    print(f"   Timestamp: {event_data['timestamp']}")

    # Update checkpoint (marks event as processed)
    await partition_context.update_checkpoint(event)

async def receive_events():
    """Receive events from Event Hub"""

    # Create consumer client
    consumer = EventHubConsumerClient.from_connection_string(
        conn_str=CONNECTION_STRING,
        consumer_group=CONSUMER_GROUP,
        eventhub_name=EVENTHUB_NAME
    )

    async with consumer:
        # Receive events
        # starting_position="-1" means start from beginning
        await consumer.receive(
            on_event=on_event,
            starting_position="-1"
        )

if __name__ == "__main__":
    try:
        print("🎧 Listening for events... (Press Ctrl+C to stop)")
        asyncio.run(receive_events())
    except KeyboardInterrupt:
        print("\n\n👋 Stopped receiving events")
```

### __Run Consumer__

```bash
# In a new terminal, activate venv and run:
python consumer.py
```

__Expected Output:__

```
🎧 Listening for events... (Press Ctrl+C to stop)

📨 Received event from partition 0:
   Device: device_1
   Temperature: 20°C
   Humidity: 60%
   Timestamp: 2025-01-09T10:30:45.123456

📨 Received event from partition 2:
   Device: device_2
   Temperature: 22°C
   Humidity: 61%
   ...
```

## 📊 Step 5: Monitor in Azure Portal

1. __Navigate to Event Hub__
   - Go to Azure Portal
   - Open your Event Hubs namespace
   - Click on your event hub

2. __View Metrics__
   - Incoming Messages: Total events sent
   - Outgoing Messages: Total events consumed
   - Throttled Requests: If you exceed throughput

3. __Check Consumer Groups__
   - Click "Consumer groups"
   - See "$Default" consumer group
   - Create additional groups for multiple consumers

## 💡 Key Concepts Explained

### __Partitions__

Think of partitions like checkout lanes at a grocery store:

- Each lane (partition) processes events independently
- Multiple lanes = parallel processing = higher throughput
- Events with same partition key go to same partition (ordering guaranteed within partition)

```python
# Send to specific partition
batch.add(EventData(data, partition_key="device_1"))  # Always goes to same partition
```

### __Consumer Groups__

Different applications can read the same events independently:

```python
# Consumer group for real-time dashboard
consumer_realtime = EventHubConsumerClient(..., consumer_group="realtime")

# Consumer group for analytics pipeline
consumer_analytics = EventHubConsumerClient(..., consumer_group="analytics")
```

### __Checkpointing__

Marks events as "processed" so you don't re-process on restart:

```python
await partition_context.update_checkpoint(event)  # Save progress
```

## 🔧 Troubleshooting

### __Common Issues__

__Error: "Namespace not found"__

- ✅ Check namespace name spelling
- ✅ Ensure deployment completed
- ✅ Verify you're in correct subscription

__Error: "Unauthorized"__

- ✅ Verify connection string is correct
- ✅ Check shared access policy permissions
- ✅ Ensure no extra spaces in connection string

__No Events Received__

- ✅ Verify events were sent successfully
- ✅ Check consumer group name
- ✅ Try starting position "-1" (from beginning)
- ✅ Check for firewall/network issues

__Throttling Errors__

- ✅ You exceeded throughput units (1 TU = 1MB/s ingress, 2MB/s egress)
- ✅ Solution: Enable auto-inflate or increase TUs

## 🎓 Next Steps

### __Beginner Practice__

- [ ] Send 1000 events and verify all received
- [ ] Create second consumer group
- [ ] Add event filtering (only process certain devices)
- [ ] Implement error handling and retries

### __Intermediate Challenges__

- [ ] Stream events to Azure Blob Storage
- [ ] Process events with Azure Stream Analytics
- [ ] Implement partitioning strategy
- [ ] Set up monitoring alerts

### __Advanced Topics__

- [ ] Kafka protocol support
- [ ] Schema Registry integration
- [ ] Capture events to Data Lake
- [ ] Build real-time analytics dashboard

## 📚 Additional Resources

### __Documentation__

- [Event Hubs Overview](https://learn.microsoft.com/azure/event-hubs/event-hubs-about)
- [Python SDK Reference](https://learn.microsoft.com/python/api/overview/azure/eventhub-readme)
- [Best Practices](https://learn.microsoft.com/azure/event-hubs/event-hubs-best-practices)

### __Next Tutorials__

- [Streaming Concepts](streaming-concepts.md) - Understand streaming fundamentals
- [Stream Analytics Tutorial](../stream-analytics/README.md) - Process events in real-time
- [Real-Time Analytics Solution](../../08-solutions/azure-realtime-analytics/README.md)

### __Related Learning Paths__

- [Data Engineer Path](../learning-paths/data-engineer-path.md)
- [Streaming Architecture Patterns](../../architecture/README.md)

## 🧹 Cleanup

To avoid Azure charges, delete resources when done:

```bash
# Delete resource group (deletes everything)
az group delete --name $RESOURCE_GROUP --yes --no-wait
```

Or use Azure Portal:

1. Navigate to Resource Groups
2. Select "rg-eventhub-quickstart"
3. Click "Delete resource group"
4. Type resource group name to confirm
5. Click "Delete"

## 🎉 Congratulations!

You've successfully:

✅ Created an Event Hubs namespace and event hub
✅ Sent events using Python
✅ Received and processed events
✅ Monitored metrics in Azure Portal

You're ready to build real-time streaming solutions with Azure Event Hubs!

---

__Next Recommended Tutorial:__ [Streaming Concepts](streaming-concepts.md) to deepen your understanding

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
*Tested with: Python 3.11, azure-eventhub 5.11.0*
