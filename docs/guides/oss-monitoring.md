[← OSS Alternatives](../../csa_platform/oss_alternatives/README.md)

# OSS Stack Monitoring Guide

> **Last Updated:** 2026-04-22 | **Status:** Active | **Audience:** Platform Engineers, SREs

> [!NOTE]
> **TL;DR:** Deploy Prometheus + Grafana via kube-prometheus-stack to monitor the OSS data platform on AKS. Includes per-service exporters, key metrics, alerting rules, and a sample Grafana dashboard.

## Table of Contents

- [Monitoring Architecture](#monitoring-architecture)
- [Prometheus + Grafana Deployment](#prometheus--grafana-deployment)
- [Service Exporters](#service-exporters)
- [Key Metrics per Service](#key-metrics-per-service)
- [Alerting Rules](#alerting-rules)
- [Sample Grafana Dashboard](#sample-grafana-dashboard)

---

## Monitoring Architecture

```
┌─────────────────────────────────────────────────┐
│                    AKS Cluster                  │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Atlas   │  │  Trino   │  │  OpenSearch   │  │
│  │ :21000   │  │ :8080    │  │  :9200        │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │ /metrics     │ /v1/...       │ _nodes   │
│       ▼              ▼               ▼          │
│  ┌──────────────────────────────────────────┐   │
│  │          Prometheus (scrape)             │   │
│  │          + AlertManager                  │   │
│  └─────────────────┬────────────────────────┘   │
│                    │                            │
│  ┌─────────────────▼────────────────────────┐   │
│  │             Grafana                      │   │
│  │        Dashboards + Alerts               │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Prometheus + Grafana Deployment

Install the community kube-prometheus-stack Helm chart:

```bash
# Add Helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install kube-prometheus-stack
helm install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --set grafana.adminPassword="<secure-password>" \
    --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
    --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
    --set grafana.service.type=LoadBalancer \
    --values monitoring-values.yaml
```

### monitoring-values.yaml (overrides)

```yaml
prometheus:
  prometheusSpec:
    retention: 30d
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: managed-csi
          resources:
            requests:
              storage: 50Gi
    additionalScrapeConfigs:
      - job_name: atlas
        metrics_path: /api/atlas/admin/metrics
        static_configs:
          - targets: ["csa-oss-atlas:21000"]
      - job_name: trino
        metrics_path: /v1/info
        static_configs:
          - targets: ["csa-oss-trino:8080"]
      - job_name: superset
        metrics_path: /health
        static_configs:
          - targets: ["csa-oss-superset:8088"]

grafana:
  persistence:
    enabled: true
    size: 10Gi
    storageClassName: managed-csi
```

---

## Service Exporters

### Apache Atlas

Atlas exposes metrics at `/api/atlas/admin/metrics`. Use a ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: atlas-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: atlas
  endpoints:
    - port: http
      path: /api/atlas/admin/metrics
      interval: 30s
```

### Trino

Trino has a built-in JMX exporter. Deploy the Prometheus JMX exporter as a sidecar:

```yaml
# Add to Trino coordinator pod spec
- name: jmx-exporter
  image: bitnami/jmx-exporter:0.20.0
  ports:
    - containerPort: 9404
  env:
    - name: SERVICE_PORT
      value: "9404"
  volumeMounts:
    - name: jmx-config
      mountPath: /etc/jmx-exporter/config.yaml
      subPath: config.yaml
```

### Apache NiFi

NiFi exposes metrics via the Reporting Task API. Deploy the `PrometheusReportingTask`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nifi-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: nifi
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

### Apache Superset

Superset uses StatsD for metrics. Deploy a StatsD-to-Prometheus exporter:

```yaml
# statsd-exporter sidecar for Superset
- name: statsd-exporter
  image: prom/statsd-exporter:v0.26.0
  ports:
    - containerPort: 9102
      name: metrics
    - containerPort: 9125
      protocol: UDP
      name: statsd
```

### OpenSearch

OpenSearch exposes metrics at `/_nodes/stats` and `/_cluster/health`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: opensearch-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: opensearch
  endpoints:
    - port: http
      path: /_prometheus/metrics
      interval: 30s
      scheme: https
      tlsConfig:
        insecureSkipVerify: true
```

---

## Key Metrics per Service

### Atlas
| Metric | Description | Warning | Critical |
|---|---|---|---|
| `atlas_entity_count` | Total entities in catalog | - | - |
| `atlas_api_latency_ms` | REST API response time | > 500ms | > 2000ms |
| `atlas_jvm_heap_used` | JVM heap utilization | > 80% | > 95% |

### Trino
| Metric | Description | Warning | Critical |
|---|---|---|---|
| `trino_running_queries` | Active query count | > 50 | > 100 |
| `trino_queued_queries` | Queued queries | > 10 | > 50 |
| `trino_blocked_queries` | Blocked queries | > 5 | > 20 |
| `trino_failed_queries_total` | Cumulative failures | rate > 5/min | rate > 20/min |
| `trino_worker_memory_used_bytes` | Worker memory | > 80% | > 95% |

### Superset
| Metric | Description | Warning | Critical |
|---|---|---|---|
| `superset_query_duration_seconds` | Query execution time | > 30s | > 120s |
| `superset_cache_hit_ratio` | Cache effectiveness | < 60% | < 30% |
| `superset_active_async_queries` | Async query backlog | > 20 | > 50 |

### OpenSearch
| Metric | Description | Warning | Critical |
|---|---|---|---|
| `opensearch_cluster_health_status` | Cluster health | yellow | red |
| `opensearch_jvm_mem_heap_used_percent` | JVM heap | > 80% | > 95% |
| `opensearch_fs_total_available_in_bytes` | Disk space | < 20% free | < 10% free |
| `opensearch_search_query_time_in_millis` | Search latency | > 500ms | > 2000ms |
| `opensearch_indexing_index_total` | Indexing rate | - | drop > 50% |

### Airflow
| Metric | Description | Warning | Critical |
|---|---|---|---|
| `airflow_scheduler_heartbeat` | Scheduler alive | miss 2 | miss 5 |
| `airflow_dag_processing_total_parse_time` | DAG parse time | > 30s | > 120s |
| `airflow_ti_failures` | Task instance failures | > 5/hour | > 20/hour |

---

## Alerting Rules

```yaml
# prometheus-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: csa-oss-alerts
  namespace: monitoring
spec:
  groups:
    - name: csa-oss-critical
      rules:
        - alert: OpenSearchClusterRed
          expr: opensearch_cluster_health_status{color="red"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "OpenSearch cluster is RED"
            description: "Cluster {{ $labels.cluster }} has been in RED state for 5 minutes."

        - alert: TrinoWorkerDown
          expr: up{job="trino", component="worker"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Trino worker is down"

        - alert: HighDiskUsage
          expr: (1 - node_filesystem_avail_bytes / node_filesystem_size_bytes) * 100 > 90
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Disk usage above 90% on {{ $labels.instance }}"

        - alert: HighMemoryUsage
          expr: container_memory_working_set_bytes / container_spec_memory_limit_bytes > 0.95
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} memory usage above 95%"

        - alert: AirflowSchedulerDown
          expr: absent(airflow_scheduler_heartbeat) == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Airflow scheduler heartbeat missing"

        - alert: TrinoQueryLatencyHigh
          expr: histogram_quantile(0.95, rate(trino_query_execution_time_seconds_bucket[5m])) > 120
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Trino p95 query latency above 2 minutes"
```

---

## Sample Grafana Dashboard

Import the following JSON as a Grafana dashboard. It provides an overview panel for all OSS services:

```json
{
  "dashboard": {
    "title": "CSA OSS Stack Overview",
    "uid": "csa-oss-overview",
    "tags": ["csa", "oss"],
    "timezone": "browser",
    "panels": [
      {
        "title": "Service Health",
        "type": "stat",
        "gridPos": {"h": 4, "w": 24, "x": 0, "y": 0},
        "targets": [
          {"expr": "up{job=~\"atlas|trino|superset|opensearch|airflow\"}", "legendFormat": "{{job}}"}
        ],
        "fieldConfig": {
          "defaults": {
            "mappings": [
              {"type": "value", "options": {"0": {"text": "DOWN", "color": "red"}, "1": {"text": "UP", "color": "green"}}}
            ]
          }
        }
      },
      {
        "title": "Trino — Active Queries",
        "type": "timeseries",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 4},
        "targets": [
          {"expr": "trino_running_queries", "legendFormat": "Running"},
          {"expr": "trino_queued_queries", "legendFormat": "Queued"}
        ]
      },
      {
        "title": "OpenSearch — Cluster Health",
        "type": "timeseries",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 4},
        "targets": [
          {"expr": "opensearch_cluster_health_active_shards", "legendFormat": "Active Shards"},
          {"expr": "opensearch_cluster_health_relocating_shards", "legendFormat": "Relocating"}
        ]
      },
      {
        "title": "Memory Usage by Service",
        "type": "timeseries",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 12},
        "targets": [
          {"expr": "container_memory_working_set_bytes{container=~\"atlas|trino|superset|opensearch|airflow\"} / 1024 / 1024 / 1024", "legendFormat": "{{container}} (GB)"}
        ]
      },
      {
        "title": "Disk Usage (PVCs)",
        "type": "bargauge",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 12},
        "targets": [
          {"expr": "(1 - kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes) * 100", "legendFormat": "{{persistentvolumeclaim}}"}
        ],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "steps": [
                {"value": 0, "color": "green"},
                {"value": 70, "color": "yellow"},
                {"value": 90, "color": "red"}
              ]
            },
            "unit": "percent"
          }
        }
      }
    ],
    "refresh": "30s",
    "time": {"from": "now-6h", "to": "now"}
  }
}
```

To import: Grafana UI → Dashboards → Import → paste JSON → Load.

---

## Related Documentation

- [OSS Migration Playbook](./oss-migration-playbook.md)
- [OSS Alternatives README](../../csa_platform/oss_alternatives/README.md)
- [Deploy Script](../../scripts/deploy-oss-stack.sh)
