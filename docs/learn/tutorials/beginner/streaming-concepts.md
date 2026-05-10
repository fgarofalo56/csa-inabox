# <
 Streaming Data Fundamentals

> __< [Home](../../../README.md)__ | __= [Documentation](../../README.md)__ | __< [Tutorials](../README.md)__ | __< Beginner__ | __<
 Streaming__

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-45--60_minutes-blue)

__Master the fundamentals of streaming data and real-time analytics. Learn core concepts, patterns, and when to use streaming vs batch processing.__

## < Learning Objectives

After completing this tutorial, you will understand:

- Difference between batch and streaming processing
- Core streaming concepts (events, windows, watermarks)
- Common streaming patterns and use cases
- Azure streaming services and when to use each
- Trade-offs between different approaches

## = Batch vs Streaming Processing

### __Batch Processing__

Process large volumes of data at scheduled intervals.

__Characteristics:__

- Processes historical data
- Scheduled execution (hourly, daily, weekly)
- Optimized for throughput
- Higher latency acceptable

__Example:__ Daily sales reports, monthly financial statements, yearly trend analysis

```python
# Batch Processing Example
def daily_sales_report():
    # Process all yesterday's transactions
    yesterday_data = load_data(date="2025-01-08")
    summary = aggregate(yesterday_data)
    save_report(summary)

# Runs once per day at midnight
schedule_job(daily_sales_report, cron="0 0 * * *")
```

### __Streaming Processing__

Process data continuously as it arrives, in real-time or near-real-time.

__Characteristics:__

- Processes data immediately upon arrival
- Continuous execution
- Optimized for low latency
- Handles unbounded data streams

__Example:__ Fraud detection, IoT monitoring, real-time dashboards

```python
# Streaming Processing Example
def process_transaction(transaction):
    # Process each transaction immediately
    if is_fraud(transaction):
        alert_security(transaction)
        block_transaction(transaction)
    save_to_database(transaction)

# Processes events continuously
event_stream.subscribe(process_transaction)
```

### __Comparison Table__

| Aspect | Batch Processing | Streaming Processing |
|--------|------------------|---------------------|
| __Latency__ | Minutes to hours | Milliseconds to seconds |
| __Data Volume__ | Large datasets | Continuous small events |
| __Use Cases__ | Reports, analytics | Monitoring, alerts, real-time |
| __Complexity__ | Lower | Higher |
| __Cost__ | Generally lower | Can be higher |
| __Resource Usage__ | Periodic spikes | Constant utilization |

## = Core Streaming Concepts

### __1. Events__

An event is a record of something that happened.

__Event Structure:__

```json
{
  "event_id": "evt_12345",
  "event_type": "purchase",
  "timestamp": "2025-01-09T10:30:45.123Z",
  "payload": {
    "user_id": "user_789",
    "product_id": "prod_456",
    "amount": 99.99,
    "currency": "USD"
  }
}
```

__Event Properties:__

- __Immutable__: Once created, never changes
- __Timestamped__: When it occurred
- __Ordered__: Sequence matters (within partition)
- __Append-only__: New events added, old ones never modified

### __2. Event Time vs Processing Time__

Understanding time is critical in streaming:

__Event Time:__ When the event actually occurred

```python
event_time = transaction["timestamp"]  # 2025-01-09 10:30:45
```

__Processing Time:__ When the event is processed by your system

```python
processing_time = datetime.utcnow()  # 2025-01-09 10:31:12
```

__Why It Matters:__

- Network delays can cause events to arrive late
- Devices might be offline and send batched events later
- Time zones and clock skew issues

__Example Scenario:__

```
IoT sensor records temperature at 10:00 AM (event time)
Network outage until 11:00 AM
Event arrives at server at 11:15 AM (processing time)
We want to analyze temperature at 10:00 AM, not 11:15 AM!
```

### __3. Windows__

Windows divide continuous streams into bounded chunks for aggregation.

#### __Tumbling Windows__ (Non-Overlapping)

Fixed-size, non-overlapping time intervals.

```
Time:     0    5    10   15   20   25   30
Windows:  [----][----][----][----][----][----]
          Win1  Win2  Win3  Win4  Win5  Win6
```

__Use Case:__ Calculate average every 5 minutes

```python
# Tumbling window example
SELECT
    SYSTEM_TIMESTAMP() AS window_end,
    AVG(temperature) AS avg_temp
FROM sensor_stream
GROUP BY TumblingWindow(minute, 5)
```

#### __Hopping Windows__ (Overlapping)

Fixed-size windows that advance by smaller intervals.

```
Time:     0    5    10   15   20   25   30
Windows:  [--------]
               [--------]
                    [--------]
                         [--------]
```

__Use Case:__ Moving averages, trend detection

```python
# Hopping window: 10-min window, 5-min hop
SELECT
    SYSTEM_TIMESTAMP() AS window_end,
    AVG(temperature) AS avg_temp
FROM sensor_stream
GROUP BY HoppingWindow(minute, 10, 5)
```

#### __Sliding Windows__ (Event-Triggered)

Window advances with each new event.

```
Events:   E1   E2      E3         E4
Windows:  [---E1,E2---]
               [---E2,E3---]
                      [---E3,E4---]
```

__Use Case:__ Detect 3 failed logins within 1 minute

```python
# Sliding window example
SELECT
    user_id,
    COUNT(*) AS failed_attempts
FROM login_events
WHERE status = 'failed'
GROUP BY user_id, SlidingWindow(minute, 1)
HAVING COUNT(*) >= 3
```

#### __Session Windows__ (Gap-Based)

Variable-size windows based on periods of inactivity.

```
Events:   E1 E2   (gap)      E3 E4 E5  (gap)   E6
Sessions: [--S1--]           [---S2---]        [S3]
```

__Use Case:__ User session analysis

```python
# Session window: timeout after 10 min inactivity
SELECT
    user_id,
    COUNT(*) AS events_in_session,
    MAX(event_time) - MIN(event_time) AS session_duration
FROM clickstream
GROUP BY user_id, SessionWindow(minute, 10)
```

### __4. Watermarks__

Watermarks track progress in event time and handle late data.

__Problem:__ Events don't always arrive in order

```
Event Time:    10:00  10:01  10:02  10:03  10:04
Arrival Time:  10:01  10:02  10:04  10:03  10:05
                 ^      ^      ^      ^      ^
                 OK     OK    Late!   OK     OK
```

__Watermark Solution:__

```
Watermark: "I've processed all events up to time T"

Example:
- Watermark at 10:03 means:
  "All events with event_time <= 10:03 have been processed"

- If event with time 10:02 arrives after watermark:
  It's late data - handle specially!
```

__Handling Late Data:__

1. __Drop Late Events:__ Ignore events past watermark
2. __Side Output:__ Send late events to separate stream
3. __Allowed Lateness:__ Accept events up to X minutes late
4. __Update Results:__ Recalculate when late data arrives

##  Azure Streaming Services

### __Azure Event Hubs__

![Purpose](https://img.shields.io/badge/Purpose-Ingestion-blue)

__What It Does:__ Receives and buffers streaming events

__Best For:__

- High-throughput event ingestion (millions of events/sec)
- IoT telemetry collection
- Application logging at scale
- Clickstream data capture

__Example:__

```python
# Send events to Event Hub
from azure.eventhub import EventHubProducerClient, EventData

producer = EventHubProducerClient.from_connection_string(conn_str, eventhub_name)
batch = await producer.create_batch()
batch.add(EventData("Temperature: 75F"))
await producer.send_batch(batch)
```

### __Azure Stream Analytics__

![Purpose](https://img.shields.io/badge/Purpose-Processing-green)

__What It Does:__ Processes and analyzes streaming data using SQL

__Best For:__

- Real-time analytics with SQL queries
- Time-windowed aggregations
- Anomaly detection
- Routing/filtering events

__Example:__

```sql
-- Stream Analytics query
SELECT
    System.Timestamp() AS WindowEnd,
    DeviceId,
    AVG(Temperature) AS AvgTemp,
    MAX(Temperature) AS MaxTemp
INTO
    [output-power-bi]
FROM
    [input-eventhub]
GROUP BY
    DeviceId,
    TumblingWindow(minute, 5)
```

## = Best Practices

### __1. Design for Idempotency__

Assume events might be processed multiple times:

```python
# Bad: Not idempotent
def process_purchase(event):
    inventory_count -= event["quantity"]  # Double processing = wrong count!

# Good: Idempotent
def process_purchase(event):
    if not already_processed(event["event_id"]):
        inventory_count -= event["quantity"]
        mark_processed(event["event_id"])
```

### __2. Handle Late Data__

```python
# Configure allowed lateness
stream.window(
    TumblingWindow(minutes=5),
    allowed_lateness=minutes(2)  # Accept events up to 2 min late
)
```

## < Next Steps

### __Practice Exercises__

1. __Build Temperature Monitoring__
   - Ingest sensor data to Event Hubs
   - Calculate rolling averages with windows
   - Alert when temperature exceeds threshold

2. __Clickstream Analytics__
   - Process website clicks
   - Count page views by window
   - Detect user sessions

### __Continue Learning__

- [Event Hubs Quickstart](eventhubs-quickstart.md) - Hands-on with Event Hubs
- [Stream Analytics Tutorial](../stream-analytics/README.md) - Build streaming queries
- [Real-Time Analytics Solution](../../08-solutions/azure-realtime-analytics/README.md) - End-to-end architecture

---

__Ready for hands-on practice?__ Try the [Event Hubs Quickstart](eventhubs-quickstart.md)!

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
