# HDInsight Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **HDInsight**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Azure%20HDInsight-blue?style=flat-square)

Best practices for Azure HDInsight clusters.

---

## Overview

This guide covers best practices for:

- Cluster sizing and configuration
- Spark optimization
- Kafka configuration
- HBase tuning
- Cost management

---

## Cluster Configuration

### Node Selection

| Workload | Head Node | Worker Node | Workers |
|----------|-----------|-------------|---------|
| ETL (small) | D12v2 | D4v2 | 4-8 |
| ETL (large) | D14v2 | D14v2 | 8-20 |
| Interactive | D13v2 | D13v2 | 4-8 |
| Streaming | D13v2 | D13v2 | 6-12 |

### Spark Configuration

```python
# Recommended Spark settings
spark_conf = {
    "spark.executor.memory": "8g",
    "spark.executor.cores": "4",
    "spark.dynamicAllocation.enabled": "true",
    "spark.dynamicAllocation.minExecutors": "2",
    "spark.dynamicAllocation.maxExecutors": "20",
    "spark.sql.adaptive.enabled": "true",
    "spark.sql.shuffle.partitions": "200"
}
```

---

## Kafka Best Practices

### Topic Configuration

```bash
# Create topic with appropriate settings
kafka-topics.sh --create \
    --topic events \
    --partitions 12 \
    --replication-factor 3 \
    --config retention.ms=604800000 \
    --config segment.bytes=1073741824
```

### Producer Settings

```properties
# High-throughput producer
acks=1
batch.size=65536
linger.ms=10
compression.type=lz4
buffer.memory=67108864
```

### Consumer Settings

```properties
# Balanced consumer
fetch.min.bytes=1024
fetch.max.wait.ms=500
max.poll.records=500
enable.auto.commit=false
```

---

## HBase Best Practices

### Table Design

```java
// Pre-split regions for even distribution
byte[][] splitKeys = {
    Bytes.toBytes("2"),
    Bytes.toBytes("4"),
    Bytes.toBytes("6"),
    Bytes.toBytes("8")
};

admin.createTable(tableDesc, splitKeys);
```

### Row Key Design

- Avoid hotspotting with salted keys
- Use reverse timestamps for time-series
- Keep row keys short (< 100 bytes)

---

## Cost Optimization

### Auto-scaling

```bash
# Enable autoscale
az hdinsight autoscale create \
    --resource-group rg-hdinsight \
    --cluster-name spark-cluster \
    --type Schedule \
    --days Monday Tuesday Wednesday Thursday Friday \
    --time 08:00 \
    --workernode-count 8

az hdinsight autoscale create \
    --resource-group rg-hdinsight \
    --cluster-name spark-cluster \
    --type Schedule \
    --days Monday Tuesday Wednesday Thursday Friday \
    --time 20:00 \
    --workernode-count 2
```

### Spot Instances

Use spot instances for non-critical workloads to reduce costs by 60-90%.

---

## Monitoring

### Key Metrics

| Metric | Target | Action |
|--------|--------|--------|
| YARN Memory Usage | < 80% | Scale or optimize |
| Container Failures | 0 | Check job configs |
| HDFS Usage | < 70% | Clean up or scale |
| Network I/O | Monitor baseline | Investigate spikes |

---

## Related Documentation

- [HDInsight Tutorials](../../../tutorials/advanced/hdinsight-kafka.md)
- [HDInsight Monitoring](../../../09-monitoring/service-monitoring/hdinsight/README.md)
- [Spark Best Practices](../synapse/spark-best-practices.md)

---

*Last Updated: January 2025*
