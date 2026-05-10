---
title: "Kafka Streaming on HDInsight"
description: "__Build real-time streaming pipelines with Kafka on HDInsight. Learn topics, producers, consumers, and Spark integration.__"
tags:
  - tutorials
  - advanced
---
# 🌊 Kafka Streaming on HDInsight

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Advanced-red)
![Duration](https://img.shields.io/badge/Duration-90--120_minutes-blue)

__Build real-time streaming pipelines with Kafka on HDInsight. Learn topics, producers, consumers, and Spark integration.__

## 🎯 Learning Objectives

- Create Kafka topics
- Implement producers and consumers
- Process streams with Spark Structured Streaming
- Handle exactly-once semantics
- Monitor and troubleshoot

## 📋 Prerequisites

- [ ] __HDInsight Kafka cluster__
- [ ] __Event Hubs knowledge__
- [ ] __Spark Structured Streaming__

## 📡 Kafka Basics

```bash
# Create topic
kafka-topics.sh --create \
  --topic events \
  --partitions 3 \
  --replication-factor 2 \
  --bootstrap-server broker1:9092

# Produce messages
kafka-console-producer.sh \
  --topic events \
  --bootstrap-server broker1:9092

# Consume messages
kafka-console-consumer.sh \
  --topic events \
  --from-beginning \
  --bootstrap-server broker1:9092
```

## 🔥 Spark Streaming

```python
# Read from Kafka
df = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker1:9092") \
    .option("subscribe", "events") \
    .load()

# Process stream
query = df.selectExpr("CAST(value AS STRING)") \
    .writeStream \
    .format("console") \
    .start()
```

## 📚 Resources

- [Kafka Documentation](https://kafka.apache.org/documentation/)
- [Spark Kafka Integration](https://spark.apache.org/docs/latest/structured-streaming-kafka-integration.html)

---

*Last Updated: January 2025*
