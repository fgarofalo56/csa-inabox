# 📊 Data Flow Architecture

## Table of Contents
- [Overview](#overview)
- [Real-Time Streaming Flow](#real-time-streaming-flow)
- [Batch Processing Flow](#batch-processing-flow)
- [Lambda Architecture](#lambda-architecture)
- [Data Processing Layers](#data-processing-layers)
- [AI Enrichment Pipeline](#ai-enrichment-pipeline)
- [Performance Optimization](#performance-optimization)

## Overview

The data flow architecture implements a modern **Lambda Architecture** pattern, combining real-time streaming and batch processing to deliver both low-latency insights and comprehensive historical analysis.

### Key Design Principles

1. **Stream-First Architecture**: Real-time processing as primary path
2. **Exactly-Once Processing**: Guaranteed data consistency
3. **Schema Evolution**: Forward/backward compatibility
4. **Fault Tolerance**: Automatic recovery and replay
5. **AI-Powered Enrichment**: Intelligent data enhancement

## Real-Time Streaming Flow

### Processing Stages

#### 1. **Data Ingestion** (Latency: ~50ms)
- **Kafka Topics**: 10+ topics with optimal partitioning
- **Event Hubs**: Native Azure integration with auto-scaling
- **Schema Registry**: Avro schema validation and evolution
- **Throughput**: 1.2M events/second sustained

```python
# Example: Kafka to Event Hubs ingestion
from azure.eventhub import EventHubProducerClient
from confluent_kafka import Consumer

def stream_kafka_to_eventhubs():
    producer = EventHubProducerClient.from_connection_string(
        conn_str="Endpoint=...", eventhub_name="analytics-events"
    )
    
    consumer = Consumer({
        'bootstrap.servers': 'pkc-xxxx.confluent.cloud:9092',
        'group.id': 'azure-ingestion',
        'auto.offset.reset': 'earliest'
    })
    
    while True:
        msg = consumer.poll(timeout=1.0)
        if msg:
            producer.send_batch([EventData(msg.value())])
```

#### 2. **Stream Processing** (Latency: ~200ms)
- **Structured Streaming**: Databricks native streaming
- **Micro-batching**: 10-second processing intervals
- **Watermarking**: 1-minute late data tolerance
- **Checkpointing**: RocksDB state management

```python
# Structured Streaming job
from pyspark.sql import SparkSession
from pyspark.sql.functions import *

spark = SparkSession.builder.appName("RealTimeAnalytics").getOrCreate()

# Read from Event Hubs
df = spark.readStream.format("eventhubs").options(**eventhubs_conf).load()

# Process streaming data
processed_df = df \
    .withWatermark("timestamp", "1 minute") \
    .groupBy(
        window(col("timestamp"), "1 minute"),
        col("event_type")
    ) \
    .agg(
        count("*").alias("event_count"),
        avg("processing_time").alias("avg_latency")
    )

# Write to Delta Lake
query = processed_df \
    .writeStream \
    .format("delta") \
    .option("checkpointLocation", "/delta/checkpoints/") \
    .trigger(processingTime="10 seconds") \
    .start("/delta/bronze/events/")
```

#### 3. **Data Validation** (Latency: ~100ms)
- **Schema Enforcement**: Automatic validation
- **Data Quality**: Great Expectations integration
- **Anomaly Detection**: Statistical outlier identification
- **Error Handling**: Dead letter queue for invalid data

#### 4. **Deduplication** (Latency: ~150ms)
- **Window-based**: 5-minute deduplication window
- **Key Strategy**: Composite keys (event_id + timestamp)
- **State Store**: RocksDB for duplicate detection

### Real-Time Performance

| Stage | Latency | Throughput | Resource Usage |
|-------|---------|------------|----------------|
| **Ingestion** | ~50ms | 1.2M events/sec | Event Hubs: 20 TUs |
| **Stream Processing** | ~200ms | 850K events/sec | 5-node cluster |
| **Validation** | ~100ms | 800K events/sec | CPU: 60% |
| **Deduplication** | ~150ms | 750K events/sec | Memory: 4GB state |
| **Bronze Write** | ~200ms | 700K events/sec | ADLS Gen2: 10GB/s |
| **AI Enrichment** | ~2s | 15K docs/min | Cognitive Services |
| **Gold Aggregation** | ~1s | 500K records/sec | Delta optimization |

## Batch Processing Flow

### Scheduled Processing

```
Hourly Jobs (5-10 min)     Daily Jobs (30-60 min)    Weekly Jobs (2-4 hrs)
├─ Aggregation Jobs        ├─ Full Reprocessing       ├─ Data Archival
├─ Data Quality Checks     ├─ ML Model Training       ├─ Performance Tuning
└─ ML Feature Updates      └─ Business Reports        └─ Security Scans
```

### Batch Processing Stages

#### 1. **Hourly Aggregations** (5-10 minutes)
```python
# Hourly aggregation job
def hourly_aggregation():
    df = spark.read.format("delta").load("/delta/silver/events/")
    
    hourly_metrics = df \
        .filter(col("timestamp") >= current_timestamp() - expr("INTERVAL 1 HOUR")) \
        .groupBy(
            window(col("timestamp"), "1 hour"),
            col("event_type"),
            col("region")
        ) \
        .agg(
            count("*").alias("total_events"),
            avg("processing_time").alias("avg_latency"),
            percentile_approx("response_time", 0.95).alias("p95_response"),
            sum("revenue").alias("total_revenue")
        )
    
    hourly_metrics \
        .write \
        .format("delta") \
        .mode("append") \
        .save("/delta/gold/hourly_metrics/")
```

#### 2. **Daily Processing** (30-60 minutes)
- **Purpose**: Complex transformations and ML training
- **Resources**: Large clusters with reserved capacity
- **Schedule**: 2 AM UTC (low-traffic period)

#### 3. **Weekly Optimization** (2-4 hours)
```sql
-- Weekly optimization commands
OPTIMIZE delta.`/delta/bronze/events/` ZORDER BY (date, event_type);
OPTIMIZE delta.`/delta/silver/processed/` ZORDER BY (timestamp, user_id);

VACUUM delta.`/delta/bronze/events/` RETAIN 168 HOURS;
VACUUM delta.`/delta/silver/processed/` RETAIN 720 HOURS;
```

## Lambda Architecture

### Speed Layer (Hot Path)
- **Stream Processing**: Latency < 1 second
- **In-Memory Cache**: Redis/Cosmos DB, TTL: 1 hour
- **Real-time Views**: Streaming metrics, live dashboards

### Batch Layer (Cold Path)
- **Batch Processing**: Latency in hours
- **Master Dataset**: Complete history, immutable
- **Batch Views**: Pre-computed, accurate

### Serving Layer
- **Query Merger**: Combines speed + batch results
- **Unified API**: Consistent interface for consumers

## Data Processing Layers

### Bronze Layer (Raw Data)
- **Purpose**: Immutable data lake for raw events
- **Format**: Delta Lake with Snappy compression
- **Partitioning**: Date/hour for optimal performance
- **Size**: ~5TB/day average

```python
# Bronze layer write configuration
bronze_options = {
    "delta.autoOptimize.optimizeWrite": "true",
    "delta.autoOptimize.autoCompact": "true",
    "delta.logRetentionDuration": "interval 30 days"
}

df.write \
  .format("delta") \
  .options(**bronze_options) \
  .partitionBy("date", "hour") \
  .mode("append") \
  .save("/delta/bronze/events/")
```

### Silver Layer (Processed Data)
- **Purpose**: Cleaned, validated, enriched data
- **Quality**: 99.8% data quality score
- **AI Enhancement**: Sentiment, entities, key phrases
- **Size**: ~3TB/day after compression

```python
# Silver layer processing
def process_to_silver(bronze_df):
    return bronze_df \
        .filter(col("event_type").isNotNull()) \
        .withColumn("processed_timestamp", current_timestamp()) \
        .withColumn("sentiment_score", 
                   callUDF("analyze_sentiment", col("text_content"))) \
        .withColumn("entities", 
                   callUDF("extract_entities", col("text_content"))) \
        .dropDuplicates(["event_id", "timestamp"])
```

### Gold Layer (Business Ready)
- **Purpose**: Aggregated, business-ready datasets
- **Optimization**: Z-ORDER indexing for fast queries
- **Access**: Power BI Direct Lake mode
- **Size**: ~500GB/day aggregated data

## AI Enrichment Pipeline

### Real-Time AI Processing

```python
# AI enrichment pipeline
from azure.ai.textanalytics import TextAnalyticsClient
from openai import AzureOpenAI

def ai_enrichment_pipeline(df):
    # Sentiment analysis
    df_with_sentiment = df.withColumn(
        "sentiment_analysis",
        call_azure_text_analytics_udf("analyze_sentiment", col("content"))
    )
    
    # Entity recognition
    df_with_entities = df_with_sentiment.withColumn(
        "entities",
        call_azure_text_analytics_udf("recognize_entities", col("content"))
    )
    
    # OpenAI summarization
    df_enriched = df_with_entities.withColumn(
        "ai_summary",
        when(length(col("content")) > 1000,
             call_openai_udf("summarize", col("content")))
    )
    
    return df_enriched
```

### AI Performance Metrics

| AI Service | Throughput | Latency | Accuracy | Cost/1K |
|------------|------------|---------|----------|---------|
| **Sentiment Analysis** | 10K docs/min | ~200ms | 94.2% | $0.001 |
| **Entity Recognition** | 8K docs/min | ~300ms | 91.8% | $0.001 |
| **Language Detection** | 15K docs/min | ~100ms | 98.5% | $0.001 |
| **OpenAI GPT-4** | 1K docs/min | ~2s | 96.1% | $0.030 |
| **Custom Models** | 5K docs/min | ~500ms | 92.7% | $0.005 |

## Performance Optimization

### Query Optimization
```sql
-- Z-ORDER optimization for query patterns
OPTIMIZE delta.`/delta/gold/events/` ZORDER BY (timestamp, user_id, event_type);

-- Partition pruning optimization
SELECT * FROM delta.`/delta/gold/events/`
WHERE date >= '2024-01-01' AND date < '2024-02-01'
  AND event_type = 'purchase';
```

### Caching Strategies
```python
# Strategic DataFrame caching
frequently_accessed_df = spark.read.format("delta").load("/delta/gold/metrics/")
frequently_accessed_df.cache()
frequently_accessed_df.createOrReplaceTempView("cached_metrics")

# Optimize cache usage
spark.catalog.cacheTable("cached_metrics", storageLevel="MEMORY_AND_DISK_SER")
```

### Monitoring & Observability
```python
# Custom metrics tracking
def track_processing_metrics(df, stage_name):
    record_count = df.count()
    partition_count = df.select(spark_partition_id()).distinct().count()
    
    metrics = {
        "stage": stage_name,
        "timestamp": current_timestamp(),
        "record_count": record_count,
        "partition_count": partition_count
    }
    
    log_metrics_to_azure_monitor(metrics)
    return df
```

## Next Steps

1. **[Explore Components](components.md)** - Databricks architecture deep dive
2. **[Review Security](security.md)** - Zero-trust implementation  
3. **[Implementation Guide](../implementation/deployment-guide.md)** - Deploy data flow
4. **[Monitoring Setup](../operations/monitoring.md)** - Configure observability

---

**🎯 Performance Target**: <5 second end-to-end latency for 99% of events while processing 1.2M+ events per second with 99.8% data quality.
