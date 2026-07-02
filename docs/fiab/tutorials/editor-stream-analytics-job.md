# Tutorial: Stream Analytics job editor

> CSA Loom `stream-analytics-job` editor — continuous SQL-style queries over
> real-time streams, managed as real **Azure Stream Analytics** jobs via ARM.
> **No Microsoft Fabric required.**

## What it is

A Stream Analytics job runs continuous SQL-style queries over real-time streams
(Event Hubs, IoT Hub, Blob) writing to Blob, SQL, Power BI, Event Hub, ADX, or
Cosmos. In Loom it is listed and managed via ARM through the Console UAMI; the
query persists to ARM via the transformations endpoint. Stream Analytics is
also the engine Loom Eventstreams compile their operators into.

## When to use it

- You need windowed aggregations, joins, or filters over a live stream with a
  SQL-like language.
- An Eventstream's compiled ASA job needs direct inspection or hand-tuning.
- You route one stream to multiple sinks (ADX + Blob + SQL) from a single job.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Stream Analytics job** (Streaming
   Analytics). The editor opens at `/items/stream-analytics-job/<id>`.
2. **Review job state.** The editor lists ASA jobs via ARM and shows state
   (Starting / Started / Stopping / Stopped) plus last output time.
3. **Edit the query.** Write the Stream Analytics Query Language (SQL-like)
   query; **Save** PUTs it to `/streamingjobs/{name}/transformations`.
4. **Reference inputs and outputs.** Inputs (Event Hubs / IoT Hub / Blob) and
   outputs are shown as references on the job.
5. **Start and stop.** **Start** or **Stop** the job from the editor; if no job
   exists, an honest MessageBar names the bicep module and `LOOM_ASA_RG` /
   `LOOM_ASA_SUB` env vars needed.

## The Azure backend it rides on

- **Resource:** `Microsoft.StreamAnalytics/streamingjobs` ARM REST (list,
  transformations PUT, start/stop) via the Console UAMI.
- **Related:** Eventstream **Validate / Apply to ASA** compiles canvas
  operators into this same job type.

## No Fabric required

Azure Stream Analytics is a first-class Azure service; no Fabric capacity,
workspace, or OneLake is involved.

## Learn more

- Stream Analytics introduction:
  <https://learn.microsoft.com/azure/stream-analytics/stream-analytics-introduction>
