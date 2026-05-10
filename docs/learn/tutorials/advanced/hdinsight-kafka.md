---
title: "Kafka on HDInsight"
description: "__Deploy and manage Kafka on HDInsight. Learn cluster setup, topic management, and high availability.__"
tags:
  - tutorials
  - advanced
---
# 📨 Kafka on HDInsight

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Advanced-red)
![Duration](https://img.shields.io/badge/Duration-75--90_minutes-blue)

__Deploy and manage Kafka on HDInsight. Learn cluster setup, topic management, and high availability.__

## 🎯 Learning Objectives

- Create Kafka cluster on HDInsight
- Configure topics and partitions
- Implement producers and consumers
- Ensure high availability
- Monitor cluster health

## 📋 Prerequisites

- [ ] __Azure subscription__
- [ ] __Understanding of messaging systems__
- [ ] __Event streaming concepts__

## 🚀 Create Kafka Cluster

```bash
# Azure CLI
az hdinsight create \
  --name kafka-cluster \
  --resource-group rg-kafka \
  --type kafka \
  --component-version Kafka=2.4 \
  --cluster-tier standard \
  --worker-node-count 3 \
  --worker-node-data-disks-per-node 2
```

## 📡 Topic Management

```bash
# List brokers
cat /etc/hosts | grep wn

# Create topic
kafka-topics.sh --create \
  --topic orders \
  --partitions 3 \
  --replication-factor 2 \
  --bootstrap-server wn0:9092

# Describe topic
kafka-topics.sh --describe \
  --topic orders \
  --bootstrap-server wn0:9092
```

## 💻 Python Producer/Consumer

```python
# Producer
from kafka import KafkaProducer
import json

producer = KafkaProducer(
    bootstrap_servers=['broker1:9092'],
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)

producer.send('orders', {'order_id': 1, 'amount': 99.99})
producer.flush()
```

```python
# Consumer
from kafka import KafkaConsumer

consumer = KafkaConsumer(
    'orders',
    bootstrap_servers=['broker1:9092'],
    auto_offset_reset='earliest',
    value_deserializer=lambda m: json.loads(m.decode('utf-8'))
)

for message in consumer:
    print(message.value)
```

## 📚 Resources

- [Kafka on HDInsight](https://learn.microsoft.com/azure/hdinsight/kafka/apache-kafka-introduction)
- [Kafka Documentation](https://kafka.apache.org/)

---

*Last Updated: January 2025*
