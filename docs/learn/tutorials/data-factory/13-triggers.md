---
title: "Pipeline Triggers & Scheduling"
description: "__Master pipeline scheduling with schedule triggers, tumbling window triggers, and event-based triggers for automated data workflows.__"
tags:
  - tutorials
  - data-factory
---
# ⏰ Pipeline Triggers & Scheduling

![Tutorial](https://img.shields.io/badge/Tutorial-Pipeline_Triggers-blue)
![Duration](https://img.shields.io/badge/Duration-20_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Master pipeline scheduling with schedule triggers, tumbling window triggers, and event-based triggers for automated data workflows.__

## 📋 Table of Contents

- [Trigger Types](#trigger-types)
- [Schedule Trigger](#schedule-trigger)
- [Tumbling Window Trigger](#tumbling-window-trigger)
- [Event-Based Trigger](#event-based-trigger)
- [Next Steps](#next-steps)

## 🎯 Trigger Types

| Trigger Type | Use Case | Backfill | Dependency |
|--------------|----------|----------|------------|
| __Schedule__ | Fixed time execution | No | No |
| __Tumbling Window__ | Time-series processing | Yes | Yes |
| __Storage Event__ | File arrival | No | No |
| __Custom Event__ | External events | No | No |

## 📅 Schedule Trigger

Execute pipelines at specific times.

### Daily Trigger

```json
{
  "name": "DailyMidnightTrigger",
  "properties": {
    "type": "ScheduleTrigger",
    "typeProperties": {
      "recurrence": {
        "frequency": "Day",
        "interval": 1,
        "startTime": "2025-01-01T00:00:00Z",
        "timeZone": "UTC",
        "schedule": {
          "hours": [0],
          "minutes": [0]
        }
      }
    },
    "pipelines": [
      {
        "pipelineReference": {
          "referenceName": "DailyETLPipeline",
          "type": "PipelineReference"
        },
        "parameters": {
          "ProcessDate": "@trigger().scheduledTime"
        }
      }
    ]
  }
}
```

### Hourly Trigger

```json
{
  "name": "HourlyTrigger",
  "properties": {
    "type": "ScheduleTrigger",
    "typeProperties": {
      "recurrence": {
        "frequency": "Hour",
        "interval": 1,
        "startTime": "2025-01-01T00:00:00Z"
      }
    }
  }
}
```

## 🔄 Tumbling Window Trigger

Process data in fixed-size, non-overlapping time windows.

```json
{
  "name": "HourlyTumblingWindowTrigger",
  "properties": {
    "type": "TumblingWindowTrigger",
    "typeProperties": {
      "frequency": "Hour",
      "interval": 1,
      "startTime": "2025-01-01T00:00:00Z",
      "maxConcurrency": 3,
      "retryPolicy": {
        "count": 3,
        "intervalInSeconds": 30
      }
    },
    "pipeline": {
      "pipelineReference": {
        "referenceName": "IncrementalLoadPipeline",
        "type": "PipelineReference"
      },
      "parameters": {
        "WindowStart": "@trigger().outputs.windowStartTime",
        "WindowEnd": "@trigger().outputs.windowEndTime"
      }
    }
  }
}
```

## 📁 Event-Based Trigger

Trigger based on file arrival or custom events.

### Storage Event Trigger

```json
{
  "name": "BlobEventTrigger",
  "properties": {
    "type": "BlobEventsTrigger",
    "typeProperties": {
      "blobPathBeginsWith": "/input/data/blobs/",
      "blobPathEndsWith": ".csv",
      "ignoreEmptyBlobs": true,
      "events": ["Microsoft.Storage.BlobCreated"],
      "scope": "/subscriptions/xxx/resourceGroups/xxx/providers/Microsoft.Storage/storageAccounts/xxx"
    },
    "pipelines": [
      {
        "pipelineReference": {
          "referenceName": "ProcessNewFilePipeline",
          "type": "PipelineReference"
        },
        "parameters": {
          "FilePath": "@triggerBody().folderPath",
          "FileName": "@triggerBody().fileName"
        }
      }
    ]
  }
}
```

## 📚 Additional Resources

- [Trigger Documentation](https://docs.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers)
- [Tumbling Window Triggers](https://docs.microsoft.com/azure/data-factory/how-to-create-tumbling-window-trigger)

## 🚀 Next Steps

__→ [14. Dependency Management](14-dependency-management.md)__

---

__Module Progress__: 13 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
