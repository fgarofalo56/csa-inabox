-- =============================================================================
-- CSA-in-a-Box: Stream Analytics Query
--
-- Processes events from Event Hub with two windowing strategies:
--   1. Tumbling window (5 min): event counts per type/region
--   2. Sliding window (15 min): anomaly detection (spike > 3 std dev)
--
-- Outputs:
--   - EventMetrics: Cosmos DB (low-latency dashboard queries)
--   - EventArchive: ADLS Gen2 (batch archival for offline analytics)
-- =============================================================================

-- Input: Event Hub events
-- The Stream Analytics job reads from the Event Hub input defined in
-- the Bicep module (streamanalytics.bicep).

-- Output 1: 5-minute tumbling window event metrics → Cosmos DB
SELECT
    System.Timestamp() AS window_end,
    type AS event_type,
    data.region AS region,
    COUNT(*) AS event_count,
    COUNT(DISTINCT data.session_id) AS unique_sessions,
    COUNT(DISTINCT data.customer_id) AS unique_customers,
    AVG(CAST(data.load_time_ms AS float)) AS avg_load_time_ms,
    SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END) AS error_count,
    SUM(CASE WHEN type = 'purchase_complete' THEN CAST(data.amount AS float) ELSE 0 END) AS revenue
INTO
    [CosmosOutput]
FROM
    [EventHubInput] TIMESTAMP BY [timestamp]
GROUP BY
    type,
    data.region,
    TumblingWindow(minute, 5)

-- Output 2: Raw event archival → ADLS Gen2 (Parquet, hourly partitions)
SELECT
    id,
    source,
    type,
    [timestamp],
    data,
    System.Timestamp() AS processed_at
INTO
    [ADLSArchiveOutput]
FROM
    [EventHubInput] TIMESTAMP BY [timestamp]

-- Output 3: Anomaly alerts → Cosmos DB (separate container)
-- Detects when any event type's 15-minute count exceeds 3x the
-- average of the previous hour's 15-minute windows.
SELECT
    System.Timestamp() AS alert_time,
    type AS event_type,
    COUNT(*) AS current_count,
    AVG(COUNT(*)) OVER (
        PARTITION BY type
        LIMIT DURATION(hour, 1)
    ) AS baseline_avg,
    'ANOMALY_SPIKE' AS alert_type,
    CONCAT('Event type [', type, '] spiked to ',
           CAST(COUNT(*) AS nvarchar(max)),
           ' events (baseline: ',
           CAST(AVG(COUNT(*)) OVER (PARTITION BY type LIMIT DURATION(hour, 1)) AS nvarchar(max)),
           ')') AS alert_message
INTO
    [AnomalyAlertOutput]
FROM
    [EventHubInput] TIMESTAMP BY [timestamp]
GROUP BY
    type,
    SlidingWindow(minute, 15)
HAVING
    COUNT(*) > 3 * AVG(COUNT(*)) OVER (
        PARTITION BY type
        LIMIT DURATION(hour, 1)
    )
    AND COUNT(*) > 10  -- Minimum threshold to avoid noise
