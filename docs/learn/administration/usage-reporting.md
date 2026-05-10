# Documentation Usage Reporting Guide

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Version](https://img.shields.io/badge/Version-1.0.0-blue)

This guide provides instructions for generating, analyzing, and presenting documentation usage reports to understand adoption and guide improvement efforts.

## Table of Contents

- [Overview](#overview)
- [Key Metrics Definitions](#key-metrics-definitions)
- [Report Types](#report-types)
- [Generating Usage Reports](#generating-usage-reports)
- [Report Templates](#report-templates)
- [Dashboard Recommendations](#dashboard-recommendations)
- [Analysis Techniques](#analysis-techniques)
- [Best Practices](#best-practices)

## Overview

Regular usage reporting helps stakeholders understand:

- Documentation adoption and engagement
- User behavior and navigation patterns
- Content effectiveness and gaps
- ROI of documentation efforts
- Areas requiring improvement

### Report Frequency

| Report Type | Frequency | Audience |
|-------------|-----------|----------|
| Real-time Dashboard | Continuous | Documentation team |
| Weekly Summary | Weekly | Documentation team |
| Monthly Report | Monthly | Team leads, stakeholders |
| Quarterly Review | Quarterly | Management, leadership |
| Annual Analysis | Yearly | Executive leadership |

## Key Metrics Definitions

### User Metrics

#### Total Users

__Definition:__ Unique individuals who visited the documentation site during the reporting period.

__Calculation:__ Count of unique user identifiers (anonymized)

__Benchmark:__ Monitor growth trends month-over-month

__GA4 Path:__ Reports > User Attributes > Overview

#### New vs Returning Users

__Definition:__ Ratio of first-time visitors to repeat visitors

__Calculation:__

- New Users: Users visiting for the first time
- Returning Users: Users who have visited before

__Benchmark:__

- Healthy ratio: 60% new / 40% returning
- Growing product: Higher new user percentage
- Mature product: Higher returning user percentage

__GA4 Path:__ Reports > User Attributes > User acquisition

#### Active Users

__Definition:__ Users who engaged with the documentation (not just landed and left)

__Calculation:__ Users with at least one engaged session

__Benchmark:__ > 70% of total users should be active

__GA4 Path:__ Reports > Engagement > Overview

### Session Metrics

#### Total Sessions

__Definition:__ Number of distinct visits to the documentation site

__Calculation:__ Each visit counts as one session (30-minute timeout between sessions)

__Benchmark:__ Monitor growth trends

__GA4 Path:__ Reports > Acquisition > Overview

#### Average Session Duration

__Definition:__ Average time users spend on the documentation site per visit

__Calculation:__ Total session duration / Total sessions

__Benchmark:__

- Excellent: > 5 minutes
- Good: 3-5 minutes
- Needs improvement: < 3 minutes

__GA4 Path:__ Reports > Engagement > Pages and screens

#### Sessions per User

__Definition:__ Average number of sessions per unique user

__Calculation:__ Total sessions / Total users

__Benchmark:__

- Excellent: > 2.5
- Good: 1.5-2.5
- Needs improvement: < 1.5

__GA4 Path:__ Reports > User Attributes > Overview

### Engagement Metrics

#### Pages per Session

__Definition:__ Average number of pages viewed in a single session

__Calculation:__ Total page views / Total sessions

__Benchmark:__

- Excellent: > 4 pages
- Good: 2-4 pages
- Needs improvement: < 2 pages

__GA4 Path:__ Reports > Engagement > Pages and screens

#### Bounce Rate

__Definition:__ Percentage of sessions where user left after viewing only one page

__Calculation:__ (Single-page sessions / Total sessions) × 100

__Benchmark:__

- Excellent: < 40%
- Good: 40-60%
- Needs improvement: > 60%

__GA4 Path:__ Reports > Engagement > Pages and screens

#### Average Engagement Time

__Definition:__ Average time users actively engaged with content

__Calculation:__ Total engagement time / Total users

__Benchmark:__

- Excellent: > 3 minutes
- Good: 2-3 minutes
- Needs improvement: < 2 minutes

__GA4 Path:__ Reports > Engagement > Overview

### Content Metrics

#### Page Views

__Definition:__ Total number of pages viewed

__Calculation:__ Sum of all page loads (including repeat views)

__Benchmark:__ Monitor trends and compare to unique page views

__GA4 Path:__ Reports > Engagement > Pages and screens

#### Unique Page Views

__Definition:__ Number of sessions where a specific page was viewed at least once

__Calculation:__ Deduplicated page views per session

__Benchmark:__ Higher unique views indicate diverse content consumption

__GA4 Path:__ Reports > Engagement > Pages and screens

#### Exit Rate

__Definition:__ Percentage of page views that were the last in a session

__Calculation:__ (Exits from page / Total page views for that page) × 100

__Benchmark:__

- High exit rate on tutorial completion pages is normal
- High exit rate on overview pages needs investigation

__GA4 Path:__ Reports > Engagement > Pages and screens

#### Search Queries

__Definition:__ Terms users search for within the documentation

__Calculation:__ Count of site search queries

__Benchmark:__ Frequent searches indicate content gaps or navigation issues

__GA4 Path:__ Reports > Engagement > Site search (requires setup)

### Feedback Metrics

#### Feedback Response Rate

__Definition:__ Percentage of page views that resulted in feedback submission

__Calculation:__ (Total feedback submissions / Total page views) × 100

__Benchmark:__

- Excellent: > 5%
- Good: 2-5%
- Needs improvement: < 2%

__Tracking:__ Custom event in GA4 or dedicated feedback system

#### Helpful Rating

__Definition:__ Percentage of positive feedback responses

__Calculation:__ (Positive feedback / Total feedback) × 100

__Benchmark:__

- Excellent: > 80%
- Good: 60-80%
- Needs improvement: < 60%

__Tracking:__ Custom event in GA4

### Technical Metrics

#### Browser Distribution

__Definition:__ Breakdown of users by web browser

__Benchmark:__ Ensure major browsers (Chrome, Firefox, Safari, Edge) are supported

__GA4 Path:__ Reports > Tech > Tech details

#### Device Category

__Definition:__ Distribution across desktop, mobile, and tablet devices

__Benchmark:__

- Technical documentation: 70% desktop typical
- Quick reference: Higher mobile usage acceptable

__GA4 Path:__ Reports > Tech > Tech details

#### Operating System

__Definition:__ Distribution of operating systems

__Benchmark:__ Ensure content renders correctly on all major OS platforms

__GA4 Path:__ Reports > Tech > Tech details

## Report Types

### Executive Summary (1 Page)

__Audience:__ Senior leadership, executives

__Frequency:__ Monthly or quarterly

__Content:__

- High-level metrics (users, sessions, growth)
- Key achievements and milestones
- Top 3 insights
- Recommended actions
- Visual charts and graphs

__Format:__ PDF or PowerPoint slide

### Detailed Analytics Report

__Audience:__ Documentation team, product managers

__Frequency:__ Monthly

__Content:__

- All key metrics with trends
- Page-level analysis
- User behavior patterns
- Content performance breakdown
- Feedback analysis
- Recommendations with data support

__Format:__ PDF report with charts

### Quarterly Business Review

__Audience:__ Stakeholders, management

__Frequency:__ Quarterly

__Content:__

- Quarter-over-quarter comparison
- Goal progress tracking
- Content ROI analysis
- User satisfaction trends
- Strategic recommendations
- Resource requirements

__Format:__ Presentation deck

### Ad-Hoc Analysis

__Audience:__ Documentation team

__Frequency:__ As needed

__Content:__

- Specific question or hypothesis
- Detailed data analysis
- Findings and conclusions
- Action items

__Format:__ Memo or short report

## Generating Usage Reports

### Prerequisites

- Access to Google Analytics 4
- Documentation analytics configured
- Proper permissions assigned
- Report templates ready

### Step-by-Step Report Generation

#### 1. Define Report Parameters

```text
Report Period: [Start Date] to [End Date]
Comparison Period: [Previous Period]
Audience: [Target audience]
Format: [PDF/PowerPoint/Excel]
```

#### 2. Export Data from GA4

__Option A: Standard Reports__

1. Navigate to Reports in GA4
2. Select relevant report (e.g., Pages and screens)
3. Set date range
4. Click Export (PDF or CSV)
5. Save exported file

__Option B: Explorations (Custom Reports)__

1. Navigate to Explore in GA4
2. Create or select exploration
3. Configure dimensions and metrics
4. Set date range and filters
5. Export data

__Option C: Data API (Automated)__

```python
# Example: Using GA4 Data API
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import (
    DateRange,
    Dimension,
    Metric,
    RunReportRequest,
)

def run_ga4_report(property_id, start_date, end_date):
    """Generate GA4 report programmatically"""
    client = BetaAnalyticsDataClient()

    request = RunReportRequest(
        property=f"properties/{property_id}",
        dimensions=[
            Dimension(name="pagePath"),
            Dimension(name="pageTitle"),
        ],
        metrics=[
            Metric(name="screenPageViews"),
            Metric(name="averageSessionDuration"),
            Metric(name="bounceRate"),
        ],
        date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
    )

    response = client.run_report(request)
    return response

# Usage
report = run_ga4_report("YOUR_PROPERTY_ID", "2024-01-01", "2024-01-31")
```

#### 3. Analyze Data

- Calculate key metrics
- Identify trends and patterns
- Compare to previous periods
- Highlight anomalies
- Generate insights

#### 4. Create Visualizations

- Use charts for trends
- Tables for detailed data
- Heatmaps for user journeys
- Dashboards for overviews

#### 5. Write Narrative

- Summarize findings
- Provide context
- Explain implications
- Make recommendations

#### 6. Review and Distribute

- Proofread report
- Verify data accuracy
- Format for audience
- Distribute via appropriate channels

## Report Templates

### Monthly Usage Report Template

```markdown
# Documentation Usage Report
## [Month Year]

### Executive Summary

- **Total Users:** [Number] ([+/- %] vs previous month)
- **Total Sessions:** [Number] ([+/- %] vs previous month)
- **Top Page:** [Page Name] ([Number] views)
- **Key Insight:** [1-2 sentence insight]

### User Metrics

| Metric | This Month | Last Month | Change |
|--------|------------|------------|--------|
| Total Users | [Number] | [Number] | [+/- %] |
| New Users | [Number] | [Number] | [+/- %] |
| Returning Users | [Number] | [Number] | [+/- %] |

### Engagement Metrics

| Metric | This Month | Last Month | Change |
|--------|------------|------------|--------|
| Sessions | [Number] | [Number] | [+/- %] |
| Avg Session Duration | [Time] | [Time] | [+/- %] |
| Pages per Session | [Number] | [Number] | [+/- %] |
| Bounce Rate | [Percentage] | [Percentage] | [+/- %] |

### Top Content

| Page | Views | Avg Time | Bounce Rate |
|------|-------|----------|-------------|
| 1. [Page Title] | [Number] | [Time] | [%] |
| 2. [Page Title] | [Number] | [Time] | [%] |
| 3. [Page Title] | [Number] | [Time] | [%] |
| 4. [Page Title] | [Number] | [Time] | [%] |
| 5. [Page Title] | [Number] | [Time] | [%] |

### User Feedback

- **Feedback Submissions:** [Number]
- **Helpful Rating:** [%] positive
- **Top Feedback Themes:**
  - [Theme 1]
  - [Theme 2]
  - [Theme 3]

### Insights & Observations

1. **[Insight Title]**
   - [Description]
   - [Data supporting insight]
   - [Implication]

2. **[Insight Title]**
   - [Description]
   - [Data supporting insight]
   - [Implication]

### Recommendations

1. **[Recommendation 1]**
   - Action: [What to do]
   - Priority: [High/Medium/Low]
   - Owner: [Team/Person]

2. **[Recommendation 2]**
   - Action: [What to do]
   - Priority: [High/Medium/Low]
   - Owner: [Team/Person]

### Next Month's Focus

- [Focus area 1]
- [Focus area 2]
- [Focus area 3]

---
Report Generated: [Date]
Report Period: [Start Date] - [End Date]
Prepared By: [Name/Team]
```

### Quarterly Review Template

```markdown
# Quarterly Documentation Review
## Q[Number] [Year]

### Quarter Highlights

- **Achievement 1:** [Description and impact]
- **Achievement 2:** [Description and impact]
- **Achievement 3:** [Description and impact]

### Quarterly Metrics Summary

| Metric | Q[N] | Q[N-1] | YoY | Target | Status |
|--------|------|--------|-----|--------|--------|
| Total Users | [N] | [N] | [%] | [N] | [✅/⚠️/❌] |
| Sessions | [N] | [N] | [%] | [N] | [✅/⚠️/❌] |
| Avg Session Duration | [T] | [T] | [%] | [T] | [✅/⚠️/❌] |
| Pages per Session | [N] | [N] | [%] | [N] | [✅/⚠️/❌] |
| Helpful Rating | [%] | [%] | [%] | [%] | [✅/⚠️/❌] |

### Content Performance Analysis

**Top Performing Content**
- [Content 1]: [Why it performed well]
- [Content 2]: [Why it performed well]
- [Content 3]: [Why it performed well]

**Underperforming Content**
- [Content 1]: [Why it underperformed]
- [Content 2]: [Why it underperformed]
- [Content 3]: [Why it underperformed]

### User Journey Analysis

**Common Entry Points**
1. [Page]: [%] of sessions
2. [Page]: [%] of sessions
3. [Page]: [%] of sessions

**Popular Pathways**
1. [Page 1] → [Page 2] → [Page 3]
2. [Page 1] → [Page 2] → [Page 3]
3. [Page 1] → [Page 2] → [Page 3]

**Exit Points**
1. [Page]: [%] exit rate
2. [Page]: [%] exit rate
3. [Page]: [%] exit rate

### Goals Achievement

| Goal | Target | Actual | Status | Notes |
|------|--------|--------|--------|-------|
| [Goal 1] | [N] | [N] | [✅/⚠️/❌] | [Notes] |
| [Goal 2] | [N] | [N] | [✅/⚠️/❌] | [Notes] |
| [Goal 3] | [N] | [N] | [✅/⚠️/❌] | [Notes] |

### Strategic Recommendations

1. **[Strategic Area 1]**
   - Current State: [Description]
   - Desired State: [Description]
   - Actions Required: [List]
   - Timeline: [Timeframe]
   - Resources Needed: [List]

2. **[Strategic Area 2]**
   - Current State: [Description]
   - Desired State: [Description]
   - Actions Required: [List]
   - Timeline: [Timeframe]
   - Resources Needed: [List]

### Next Quarter Objectives

1. [Objective 1]
   - Key Results: [Measurable outcomes]
   - Owner: [Team/Person]

2. [Objective 2]
   - Key Results: [Measurable outcomes]
   - Owner: [Team/Person]

---
Report Generated: [Date]
Report Period: Q[N] [Year] ([Start Date] - [End Date])
Prepared By: [Name/Team]
```

## Dashboard Recommendations

### Google Analytics 4 Dashboards

#### Dashboard 1: Overview Dashboard

__Purpose:__ High-level metrics at a glance

__Widgets:__

1. Total Users (last 30 days)
2. Total Sessions (last 30 days)
3. User Growth Trend (line chart)
4. Top 10 Pages (table)
5. Engagement Rate (scorecard)
6. Average Session Duration (scorecard)
7. Device Category Breakdown (pie chart)
8. User Acquisition by Source (table)

#### Dashboard 2: Content Performance Dashboard

__Purpose:__ Detailed content analysis

__Widgets:__

1. Page Views by Page (table with sparklines)
2. Average Time on Page (table)
3. Bounce Rate by Page (table)
4. Exit Rate by Page (table)
5. Page Value (if e-commerce tracking enabled)
6. Content Grouping Performance
7. Search Queries (if site search configured)

#### Dashboard 3: User Behavior Dashboard

__Purpose:__ Understanding user journeys

__Widgets:__

1. New vs Returning Users (line chart)
2. Session Duration Distribution (histogram)
3. Pages per Session Distribution (histogram)
4. User Flow Visualization
5. Landing Pages (table)
6. Exit Pages (table)
7. Geography Map
8. Browser and OS Distribution

#### Dashboard 4: Feedback & Satisfaction Dashboard

__Purpose:__ User satisfaction monitoring

__Widgets:__

1. Feedback Submission Rate (trend)
2. Helpful vs Not Helpful Ratio (pie chart)
3. Feedback by Page (table)
4. Sentiment Analysis (if configured)
5. Issue Tracking Integration
6. Response Time to Feedback

### Third-Party Dashboard Tools

#### Option 1: Google Data Studio (Looker Studio)

__Pros:__

- Free
- Native GA4 integration
- Customizable
- Shareable

__Setup:__

1. Go to [Looker Studio](https://lookerstudio.google.com/)
2. Create new report
3. Add GA4 as data source
4. Build custom visualizations
5. Share with stakeholders

#### Option 2: Tableau

__Pros:__

- Powerful visualizations
- Advanced analytics
- Enterprise features
- Interactive dashboards

__Setup:__

1. Connect Tableau to GA4 via connector
2. Import data
3. Create worksheets and dashboards
4. Publish to Tableau Server/Online

#### Option 3: Power BI

__Pros:__

- Microsoft integration
- Enterprise ready
- Advanced analytics
- Azure integration

__Setup:__

1. Use GA4 connector for Power BI
2. Import data
3. Create visualizations
4. Publish to Power BI Service

#### Option 4: Custom Dashboard

__Tech Stack:__

- Frontend: React + Chart.js or D3.js
- Backend: Python Flask/FastAPI
- Database: PostgreSQL
- Data Pipeline: GA4 API + Python scripts

__Benefits:__

- Full customization
- Real-time updates
- Integration with other tools
- Branded experience

## Analysis Techniques

### Trend Analysis

__Purpose:__ Identify patterns over time

__Methods:__

- Moving averages
- Seasonal decomposition
- Year-over-year comparison
- Month-over-month comparison

__Example:__

```python
import pandas as pd
import matplotlib.pyplot as plt

# Load data
df = pd.read_csv('ga4_export.csv')
df['date'] = pd.to_datetime(df['date'])

# Calculate 7-day moving average
df['users_ma7'] = df['users'].rolling(window=7).mean()

# Plot trend
plt.figure(figsize=(12, 6))
plt.plot(df['date'], df['users'], label='Daily Users', alpha=0.5)
plt.plot(df['date'], df['users_ma7'], label='7-Day Moving Average', linewidth=2)
plt.xlabel('Date')
plt.ylabel('Users')
plt.title('User Trend Analysis')
plt.legend()
plt.show()
```

### Cohort Analysis

__Purpose:__ Track user behavior by cohort

__Dimensions:__

- Acquisition date
- First visited page
- User source/medium
- Device type

__Metrics:__

- Retention rate
- Return visit frequency
- Lifetime value

### Segmentation Analysis

__Purpose:__ Understand different user groups

__Segments:__

- New vs Returning Users
- By geographic region
- By device type
- By traffic source
- By engagement level

### Content Gap Analysis

__Purpose:__ Identify missing or underperforming content

__Method:__

1. Analyze search queries
2. Review high-bounce pages
3. Examine low time-on-page content
4. Check competitor documentation
5. Survey user needs

### Path Analysis

__Purpose:__ Understand user navigation patterns

__Tools:__

- GA4 Path Exploration
- Funnel analysis
- Custom user flow diagrams

__Insights:__

- Common learning paths
- Drop-off points
- Unexpected navigation patterns

## Best Practices

### Regular Review Cadence

- __Daily:__ Monitor real-time dashboard for anomalies
- __Weekly:__ Review key metrics and trends
- __Monthly:__ Generate and distribute full report
- __Quarterly:__ Conduct deep analysis and strategic planning
- __Annually:__ Comprehensive review and goal setting

### Data Quality

- Validate metrics regularly
- Check for tracking issues
- Audit analytics configuration
- Remove bot traffic
- Ensure data accuracy

### Actionable Insights

- Focus on actionable metrics
- Tie insights to business goals
- Provide clear recommendations
- Assign owners to action items
- Track implementation progress

### Stakeholder Communication

- Tailor reports to audience
- Use clear visualizations
- Avoid jargon
- Highlight key takeaways
- Provide context for numbers

### Continuous Improvement

- Test and iterate on reports
- Gather feedback on reporting
- Refine metrics and KPIs
- Automate where possible
- Stay current with analytics trends

## Additional Resources

### Google Analytics 4

- [GA4 Reporting Guide](https://support.google.com/analytics/answer/9212670)
- [GA4 Explorations](https://support.google.com/analytics/answer/9327923)
- [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1)

### Data Visualization

- [Data Visualization Best Practices](https://www.tableau.com/learn/articles/data-visualization-tips)
- [Chart Selection Guide](https://www.data-to-viz.com/)
- [Color Theory for Data Viz](https://blog.datawrapper.de/colors/)

### Analysis Techniques

- [Cohort Analysis Guide](https://mixpanel.com/topics/cohort-analysis/)
- [Segmentation Best Practices](https://www.optimizely.com/optimization-glossary/segmentation/)
- [Statistical Significance Calculator](https://www.optimizely.com/sample-size-calculator/)

## Getting Help

- Review [Analytics Setup Guide](../guides/analytics-setup.md)
- Check [Google Analytics Help Center](https://support.google.com/analytics)
- Consult with data analytics team
- Join [GA4 Community](https://www.en.advertisercommunity.com/t5/Google-Analytics-4/ct-p/Google-Analytics)

---

Last Updated: 2025-12-09
Version: 1.0.0
Maintainer: CSA Documentation Team
