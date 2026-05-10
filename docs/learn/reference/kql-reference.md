# KQL (Kusto Query Language) Reference

[Home](../../README.md) > [Reference](README.md) > KQL Reference

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Documentation](https://img.shields.io/badge/Documentation-Complete-blue)

> Comprehensive reference guide for Kusto Query Language (KQL) used in Azure Data Explorer, Azure Monitor, Azure Synapse Analytics, and Microsoft Sentinel for querying and analyzing cloud-scale data.

---

## Table of Contents

- [Overview](#overview)
- [Query Structure](#query-structure)
- [Tabular Operators](#tabular-operators)
- [Scalar Functions](#scalar-functions)
- [Aggregation Functions](#aggregation-functions)
- [Time Series Analysis](#time-series-analysis)
- [String Operations](#string-operations)
- [JSON Operations](#json-operations)
- [Advanced Patterns](#advanced-patterns)
- [Performance Optimization](#performance-optimization)
- [Common Use Cases](#common-use-cases)

---

## Overview

### What is KQL?

Kusto Query Language (KQL) is a read-only query language optimized for ad-hoc queries on large datasets with fast performance and rich analytics capabilities.

### Where KQL is Used

| Service | Purpose | Data Types |
|---------|---------|------------|
| **Azure Data Explorer** | Primary query engine | Any structured/semi-structured data |
| **Azure Monitor Logs** | Query application and infrastructure logs | Metrics, logs, traces |
| **Azure Synapse Analytics** | Data exploration in Data Explorer pools | Analytics workloads |
| **Microsoft Sentinel** | Security analytics and threat hunting | Security events, logs |
| **Application Insights** | Application telemetry analysis | Performance, usage, errors |

### Basic Query Structure

```kql
TableName
| where TimeGenerated > ago(1h)
| summarize count() by Category
| order by count_ desc
| take 10
```

---

## Query Structure

### Syntax Components

| Component | Purpose | Example |
|-----------|---------|---------|
| **Table reference** | Data source | `AppRequests` |
| **Pipe operator** | Chain operations | `\|` |
| **where** | Filter rows | `where ResponseCode == 200` |
| **project** | Select columns | `project Timestamp, Message` |
| **summarize** | Aggregate data | `summarize count() by Category` |
| **extend** | Add calculated columns | `extend Duration = EndTime - StartTime` |
| **join** | Combine tables | `join kind=inner OtherTable on $left.Id == $right.Id` |

### Query Execution Flow

```text
┌─────────────────────────────────────────────────────────┐
│               KQL Query Execution Flow                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. Table Reference                                     │
│     └─> Identify source table(s)                       │
│                                                          │
│  2. Filter (where)                                      │
│     └─> Reduce dataset early for performance           │
│                                                          │
│  3. Transform (extend, project)                         │
│     └─> Add/select columns                             │
│                                                          │
│  4. Aggregate (summarize)                               │
│     └─> Group and calculate                            │
│                                                          │
│  5. Sort (order by)                                     │
│     └─> Arrange results                                │
│                                                          │
│  6. Limit (take, top)                                   │
│     └─> Control result size                            │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Tabular Operators

### Essential Operators

#### where - Filter Rows

```kql
// Simple filter
AppRequests
| where Timestamp > ago(24h)
| where ResponseCode == 200

// Multiple conditions
AppRequests
| where Timestamp > ago(24h) and ResponseCode == 200 and Duration > 1000

// String matching
AppRequests
| where Url contains "api/products"
| where Url startswith "/api/"
| where Url endswith ".json"
| where Url matches regex @"\/api\/v[0-9]+\/"

// Numeric ranges
AppRequests
| where Duration between (100 .. 5000)
| where ResponseCode in (200, 201, 204)
| where ResponseCode !in (400, 401, 403, 404, 500)

// Date/time filters
AppRequests
| where Timestamp > datetime(2024-12-01) and Timestamp < datetime(2024-12-31)
| where Timestamp > ago(7d)
| where Timestamp > startofday(ago(1d))
```

#### project - Select and Transform Columns

```kql
// Select specific columns
AppRequests
| project Timestamp, Url, Duration, ResponseCode

// Rename columns
AppRequests
| project
    EventTime = Timestamp,
    RequestUrl = Url,
    ResponseTime = Duration

// Calculated columns
AppRequests
| project
    Timestamp,
    Url,
    DurationSeconds = Duration / 1000.0,
    IsSuccess = ResponseCode < 400,
    Category = case(
        ResponseCode < 300, "Success",
        ResponseCode < 400, "Redirect",
        ResponseCode < 500, "Client Error",
        "Server Error"
    )

// Keep only specific columns
AppRequests
| project-away InternalId, SessionId
```

#### extend - Add Calculated Columns

```kql
// Add new columns without removing existing ones
AppRequests
| extend
    DurationSeconds = Duration / 1000.0,
    DurationMinutes = Duration / 60000.0,
    IsSuccess = ResponseCode < 400,
    Hour = datetime_part("Hour", Timestamp),
    DayOfWeek = dayofweek(Timestamp)

// Conditional logic
AppRequests
| extend
    PerformanceCategory = case(
        Duration < 100, "Fast",
        Duration < 1000, "Normal",
        Duration < 5000, "Slow",
        "Very Slow"
    )

// String operations
AppRequests
| extend
    Domain = extract(@"https?://([^/]+)", 1, Url),
    Path = extract(@"https?://[^/]+(.+)", 1, Url),
    UpperUrl = toupper(Url)
```

#### summarize - Aggregate Data

```kql
// Count and group
AppRequests
| summarize
    RequestCount = count(),
    AvgDuration = avg(Duration),
    MaxDuration = max(Duration),
    MinDuration = min(Duration)
    by bin(Timestamp, 1h)

// Multiple aggregations
AppRequests
| summarize
    TotalRequests = count(),
    SuccessRate = countif(ResponseCode < 400) * 100.0 / count(),
    P50Duration = percentile(Duration, 50),
    P95Duration = percentile(Duration, 95),
    P99Duration = percentile(Duration, 99),
    UniqueUsers = dcount(UserId)
    by Url

// Multiple grouping dimensions
AppRequests
| summarize count() by ResponseCode, bin(Timestamp, 1h)

// arg_max and arg_min
AppRequests
| summarize arg_max(Timestamp, *) by UserId  // Most recent request per user
```

#### join - Combine Tables

```kql
// Inner join
AppRequests
| join kind=inner (
    AppExceptions
    | project RequestId, ExceptionType, Message
) on RequestId

// Left outer join
AppRequests
| join kind=leftouter (
    Users
    | project UserId, UserName, Country
) on UserId

// Join types
// - inner: Only matching rows
// - leftouter: All left + matching right
// - rightouter: All right + matching left
// - fullouter: All rows from both
// - leftanti: Left rows without matches
// - rightanti: Right rows without matches
// - leftsemi: Left rows with matches

// Complex join with multiple conditions
AppRequests
| join kind=inner (
    AppDependencies
) on $left.RequestId == $right.RequestId and $left.SessionId == $right.SessionId
```

#### union - Combine Tables Vertically

```kql
// Union multiple tables
union AppRequests, AppExceptions, AppDependencies
| where Timestamp > ago(1h)
| summarize count() by TableName = $table

// Union with specific columns
union
    (AppRequests | project Timestamp, Message = Url, Type = "Request"),
    (AppExceptions | project Timestamp, Message = ExceptionMessage, Type = "Exception")
| order by Timestamp desc
```

---

## Scalar Functions

### String Functions

```kql
AppRequests
| extend
    // Case conversion
    UpperUrl = toupper(Url),
    LowerUrl = tolower(Url),

    // Substring operations
    FirstChar = substring(Url, 0, 1),
    Domain = substring(Url, 0, indexof(Url, "/", 8)),

    // String matching
    ContainsApi = Url contains "api",
    StartsWithHttp = Url startswith "http",
    EndsWithJson = Url endswith ".json",

    // Pattern extraction
    Version = extract(@"\/v(\d+)\/", 1, Url),
    ProductId = extract(@"\/products\/(\d+)", 1, Url),

    // String building
    FullMessage = strcat("Request to ", Url, " took ", Duration, "ms"),
    FormattedUrl = replace_string(Url, "http://", "https://"),

    // String splitting
    PathSegments = split(Url, "/"),
    FirstPathSegment = split(Url, "/")[0]

| project Url, UpperUrl, Domain, Version, FullMessage
```

### DateTime Functions

```kql
AppRequests
| extend
    // Date components
    Year = datetime_part("Year", Timestamp),
    Month = datetime_part("Month", Timestamp),
    Day = datetime_part("Day", Timestamp),
    Hour = datetime_part("Hour", Timestamp),
    Minute = datetime_part("Minute", Timestamp),

    // Date calculations
    DayOfWeek = dayofweek(Timestamp),
    WeekOfYear = week_of_year(Timestamp),
    DayOfYear = dayofyear(Timestamp),

    // Date formatting
    DateOnly = startofday(Timestamp),
    MonthStart = startofmonth(Timestamp),
    WeekStart = startofweek(Timestamp),

    // Date arithmetic
    Tomorrow = Timestamp + 1d,
    LastWeek = Timestamp - 7d,
    NextHour = Timestamp + 1h,

    // Time differences
    HoursSinceStart = datetime_diff("Hour", Timestamp, datetime(2024-01-01)),
    DaysAgo = datetime_diff("Day", now(), Timestamp)

| project Timestamp, Year, Month, Day, Hour, DayOfWeek
```

### Numeric Functions

```kql
AppRequests
| extend
    // Rounding
    RoundedDuration = round(Duration, 2),
    CeilDuration = ceiling(Duration),
    FloorDuration = floor(Duration),

    // Math operations
    DurationLog = log10(Duration),
    DurationSqrt = sqrt(Duration),
    DurationPower = pow(Duration, 2),

    // Absolute value
    AbsDuration = abs(Duration - 1000),

    // Min/Max
    MaxOf = max_of(Duration, 100),
    MinOf = min_of(Duration, 10000)

| project Duration, RoundedDuration, CeilDuration, DurationLog
```

---

## Aggregation Functions

### Common Aggregations

```kql
AppRequests
| summarize
    // Counting
    TotalCount = count(),
    UniqueUrls = dcount(Url),
    ApproxUniqueUsers = dcountif(UserId, ResponseCode == 200),

    // Statistical measures
    AvgDuration = avg(Duration),
    MedianDuration = percentile(Duration, 50),
    StdDevDuration = stdev(Duration),
    VarianceDuration = variance(Duration),

    // Min/Max
    MinDuration = min(Duration),
    MaxDuration = max(Duration),
    MinTimestamp = min(Timestamp),
    MaxTimestamp = max(Timestamp),

    // Summation
    TotalBytes = sum(ResponseSize),

    // Percentiles
    P50 = percentile(Duration, 50),
    P75 = percentile(Duration, 75),
    P90 = percentile(Duration, 90),
    P95 = percentile(Duration, 95),
    P99 = percentile(Duration, 99),

    // Array aggregations
    AllUrls = make_list(Url),
    UniqueUrlsArray = make_set(Url),

    // First/Last
    FirstRequest = arg_min(Timestamp, Url),
    LastRequest = arg_max(Timestamp, Url)

    by bin(Timestamp, 1h)
```

### Advanced Aggregations

```kql
// Weighted average
AppRequests
| summarize WeightedAvg = sum(Duration * RequestCount) / sum(RequestCount)
    by Url

// Moving averages
AppRequests
| summarize AvgDuration = avg(Duration) by bin(Timestamp, 5m)
| order by Timestamp asc
| extend MovingAvg = row_cumsum(AvgDuration) / row_number()

// Running totals
AppRequests
| summarize Count = count() by bin(Timestamp, 1h)
| order by Timestamp asc
| extend RunningTotal = row_cumsum(Count)
```

---

## Time Series Analysis

### Time Binning

```kql
// Various time bins
AppRequests
| summarize count() by bin(Timestamp, 1h)    // Hourly
| summarize count() by bin(Timestamp, 1d)    // Daily
| summarize count() by bin(Timestamp, 1m)    // Minutely
| summarize count() by bin(Timestamp, 5m)    // 5-minute intervals

// Dynamic binning based on time range
let timeRange = 7d;
AppRequests
| where Timestamp > ago(timeRange)
| summarize count() by bin(Timestamp, timeRange / 100)
```

### Time Series Operators

```kql
// make-series: Create time series with gaps filled
AppRequests
| make-series
    RequestCount = count(),
    AvgDuration = avg(Duration)
    on Timestamp
    from ago(7d) to now() step 1h
    by Url

// series_decompose: Trend and seasonality analysis
AppRequests
| make-series RequestCount = count() on Timestamp from ago(30d) to now() step 1h
| extend (baseline, seasonal, trend, residual) = series_decompose(RequestCount)
| render timechart with (title="Request Count Decomposition")

// series_outliers: Detect anomalies
AppRequests
| make-series RequestCount = count() on Timestamp from ago(7d) to now() step 1h
| extend outliers = series_outliers(RequestCount, 1.5)
| mv-expand Timestamp to typeof(datetime), RequestCount to typeof(long), outliers to typeof(double)
| where outliers != 0

// Moving averages
AppRequests
| make-series RequestCount = count() on Timestamp from ago(7d) to now() step 1h
| extend MovingAvg3h = series_fir(RequestCount, repeat(1, 3), true)
| extend MovingAvg6h = series_fir(RequestCount, repeat(1, 6), true)
```

### Time-based Comparisons

```kql
// Compare current period to previous period
let currentWeek = AppRequests
    | where Timestamp > ago(7d)
    | summarize CurrentCount = count() by bin(Timestamp, 1h);
let previousWeek = AppRequests
    | where Timestamp between (ago(14d) .. ago(7d))
    | summarize PreviousCount = count() by bin(Timestamp, 1h)
    | extend Timestamp = Timestamp + 7d;  // Shift timestamps forward
currentWeek
| join kind=inner previousWeek on Timestamp
| extend PercentChange = (CurrentCount - PreviousCount) * 100.0 / PreviousCount
| project Timestamp, CurrentCount, PreviousCount, PercentChange

// Week-over-week comparison
AppRequests
| extend WeekStart = startofweek(Timestamp)
| summarize RequestCount = count() by WeekStart
| order by WeekStart asc
| extend PreviousWeek = prev(RequestCount, 1)
| extend WoWChange = (RequestCount - PreviousWeek) * 100.0 / PreviousWeek
```

---

## String Operations

### Pattern Matching

```kql
AppRequests
| where Url matches regex @"^/api/v\d+/products/\d+$"

AppRequests
| extend ProductId = extract(@"/products/(\d+)", 1, Url)
| where isnotempty(ProductId)

AppRequests
| extend AllMatches = extract_all(@"(\d+)", Url)
```

### String Manipulation

```kql
AppRequests
| extend
    // Replace operations
    SecureUrl = replace_regex(Url, @"apikey=[^&]+", "apikey=***"),
    CleanedMessage = replace_string(Message, "\n", " "),

    // Trimming
    TrimmedUrl = trim_start(@"https?://", Url),
    TrimmedMessage = trim(" \t", Message),

    // Padding
    PaddedId = strcat(repeat("0", 10 - strlen(RequestId)), RequestId),

    // Case conversion
    TitleCaseUrl = to_title_case(Url)
```

---

## JSON Operations

### Parsing JSON

```kql
// Parse JSON column
AppRequests
| extend ParsedProperties = parse_json(Properties)
| extend
    Browser = ParsedProperties.browser,
    OS = ParsedProperties.os,
    Version = ParsedProperties.version

// Dynamic property access
AppRequests
| extend Properties = parse_json(Properties)
| extend Browser = tostring(Properties["browser"])
| extend Dimensions = todynamic(Properties["customDimensions"])

// Extract nested JSON
AppRequests
| extend
    RequestBody = parse_json(RequestBody),
    UserId = parse_json(RequestBody).user.id,
    UserEmail = parse_json(RequestBody).user.email,
    ItemCount = array_length(parse_json(RequestBody).items)

// bag_unpack: Flatten JSON to columns
AppRequests
| extend Properties = parse_json(Properties)
| evaluate bag_unpack(Properties)
```

### Building JSON

```kql
AppRequests
| extend CustomJson = pack(
    "url", Url,
    "duration", Duration,
    "timestamp", Timestamp,
    "metadata", pack("responseCode", ResponseCode, "success", ResponseCode < 400)
)

// Create JSON array
AppRequests
| summarize Urls = make_list(pack("url", Url, "count", count())) by bin(Timestamp, 1h)
```

---

## Advanced Patterns

### Window Functions

```kql
// row_number: Sequential numbering
AppRequests
| partition by UserId (
    order by Timestamp asc
    | extend RequestNumber = row_number()
)

// prev and next: Access adjacent rows
AppRequests
| order by Timestamp asc
| extend
    PreviousDuration = prev(Duration, 1),
    NextDuration = next(Duration, 1),
    DurationChange = Duration - prev(Duration, 1)

// Running calculations
AppRequests
| order by Timestamp asc
| extend
    RunningTotal = row_cumsum(ResponseSize),
    RunningAvg = row_cumsum(Duration) / row_number()
```

### Subqueries and Let Statements

```kql
// let statement: Define variables
let threshold = 1000;
let startTime = ago(24h);
let endTime = now();
AppRequests
| where Timestamp between (startTime .. endTime)
| where Duration > threshold

// let with tabular data
let slowRequests = AppRequests
    | where Duration > 5000
    | project RequestId, Url, Duration;
let errorRequests = AppRequests
    | where ResponseCode >= 500
    | project RequestId, Url, ResponseCode;
slowRequests
| join kind=inner errorRequests on RequestId

// Parameterized functions
let GetTopUrls = (n: long) {
    AppRequests
    | summarize Count = count() by Url
    | top n by Count desc
};
GetTopUrls(10)
```

### Advanced Joins

```kql
// Self-join: Find duplicate requests
AppRequests
| join kind=inner (
    AppRequests
    | project RequestId2 = RequestId, Url2 = Url, Timestamp2 = Timestamp
) on $left.UserId == $right.UserId
| where RequestId != RequestId2
| where Url == Url2
| where Timestamp2 > Timestamp and Timestamp2 < Timestamp + 1m

// Multiple join conditions
AppRequests
| join kind=leftouter (
    AppDependencies
) on $left.RequestId == $right.RequestId and $left.SessionId == $right.SessionId
```

---

## Performance Optimization

### Query Optimization Tips

| Technique | Description | Example |
|-----------|-------------|---------|
| **Filter early** | Use `where` before other operations | `\| where Timestamp > ago(1h)` |
| **Limit columns** | Use `project` to select only needed columns | `\| project Timestamp, Url` |
| **Use materialized views** | Pre-aggregate frequently queried data | `CREATE MATERIALIZED VIEW` |
| **Avoid wildcards** | Don't use `*` in `project` unnecessarily | `\| project Timestamp, Url` not `\| project *` |
| **Partition data** | Use time-based partitioning | `\| where Timestamp > ago(7d)` |
| **Optimize joins** | Join smaller tables first | Use `hint.shufflekey` |
| **Use summarize efficiently** | Aggregate early in query | Summarize before join |

### Performance Patterns

```kql
// BAD: Filter after aggregation
AppRequests
| summarize count() by Url
| where count_ > 100

// GOOD: Filter before aggregation
AppRequests
| where Timestamp > ago(1h)
| summarize count() by Url
| where count_ > 100

// BAD: Multiple scans
AppRequests | where ResponseCode == 200 | count;
AppRequests | where ResponseCode == 500 | count;

// GOOD: Single scan with summarize
AppRequests
| summarize
    SuccessCount = countif(ResponseCode == 200),
    ErrorCount = countif(ResponseCode == 500)

// Use hint.shufflekey for large joins
AppRequests
| join hint.shufflekey=UserId kind=inner (
    Users
) on UserId
```

---

## Common Use Cases

### Application Performance Monitoring

```kql
// Request rate over time
AppRequests
| where Timestamp > ago(24h)
| summarize RequestRate = count() by bin(Timestamp, 5m)
| render timechart

// Error rate tracking
AppRequests
| where Timestamp > ago(24h)
| summarize
    TotalRequests = count(),
    ErrorRequests = countif(ResponseCode >= 500),
    ErrorRate = countif(ResponseCode >= 500) * 100.0 / count()
    by bin(Timestamp, 5m)
| render timechart

// Performance percentiles by endpoint
AppRequests
| where Timestamp > ago(1h)
| summarize
    P50 = percentile(Duration, 50),
    P95 = percentile(Duration, 95),
    P99 = percentile(Duration, 99),
    RequestCount = count()
    by Url
| order by P99 desc
| take 20
```

### Security Analytics

```kql
// Failed login attempts
SigninLogs
| where TimeGenerated > ago(1h)
| where ResultType != "0"  // Failed logins
| summarize FailedAttempts = count() by UserPrincipalName, IPAddress
| where FailedAttempts > 5
| order by FailedAttempts desc

// Unusual access patterns
SecurityEvent
| where TimeGenerated > ago(24h)
| where EventID == 4624  // Successful logon
| summarize LoginCount = count() by Account, Computer, bin(TimeGenerated, 1h)
| where LoginCount > threshold
```

### Infrastructure Monitoring

```kql
// CPU usage across VMs
Perf
| where TimeGenerated > ago(1h)
| where ObjectName == "Processor" and CounterName == "% Processor Time"
| summarize AvgCPU = avg(CounterValue) by Computer, bin(TimeGenerated, 5m)
| render timechart

// Disk space monitoring
Perf
| where TimeGenerated > ago(1h)
| where ObjectName == "LogicalDisk" and CounterName == "% Free Space"
| summarize AvgFreeSpace = avg(CounterValue) by Computer, InstanceName
| where AvgFreeSpace < 20
| order by AvgFreeSpace asc
```

---

## Best Practices

### Query Design Checklist

- [ ] Filter data as early as possible using `where`
- [ ] Use time filters to limit data scan (`where Timestamp > ago(1h)`)
- [ ] Select only required columns with `project`
- [ ] Avoid using `*` in `project` unnecessarily
- [ ] Use appropriate aggregation functions
- [ ] Optimize join order (smaller table first)
- [ ] Use `let` statements for reusable logic
- [ ] Add comments for complex queries
- [ ] Test queries on small time ranges first
- [ ] Monitor query performance and resource usage

### Common Mistakes to Avoid

| Mistake | Impact | Solution |
|---------|--------|----------|
| No time filter | Scans all data | Always filter by time |
| `project *` everywhere | Unnecessary data transfer | Select only needed columns |
| Late filtering | Poor performance | Filter early in query |
| Inefficient joins | High resource usage | Join smaller tables first |
| Missing aggregations | Large result sets | Aggregate before returning |

---

## Related Resources

- [KQL Official Documentation](https://docs.microsoft.com/azure/data-explorer/kusto/query/)
- [Azure Monitor Log Queries](https://docs.microsoft.com/azure/azure-monitor/logs/queries)
- [KQL Quick Reference](https://docs.microsoft.com/azure/data-explorer/kql-quick-reference)
- [Query Best Practices](https://docs.microsoft.com/azure/data-explorer/kusto/query/best-practices)
- [Azure Data Explorer Documentation](https://docs.microsoft.com/azure/data-explorer/)

---

> **Note**: KQL syntax and functions are continuously evolving. Always refer to the [official KQL documentation](https://docs.microsoft.com/azure/data-explorer/kusto/query/) for the latest features and updates.
