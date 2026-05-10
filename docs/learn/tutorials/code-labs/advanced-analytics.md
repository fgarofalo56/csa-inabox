# 🎯 Advanced Analytics with Azure Synapse Lab

![Lab](https://img.shields.io/badge/Lab-Advanced_Analytics-blue)
![Duration](https://img.shields.io/badge/Duration-3--4_hours-green)
![Level](https://img.shields.io/badge/Level-Advanced-red)
![Interactive](https://img.shields.io/badge/Format-Interactive-orange)

Master advanced analytics patterns using Azure Synapse Analytics. Learn complex data transformations, statistical analysis, machine learning integration, and production-grade analytics pipelines.

## 🎯 Learning Objectives

By completing this lab, you will be able to:

- ✅ **Implement complex analytics** using advanced SQL and Spark techniques
- ✅ **Build statistical models** for predictive and prescriptive analytics
- ✅ **Integrate machine learning** models into analytics pipelines
- ✅ **Create real-time dashboards** with streaming analytics
- ✅ **Optimize query performance** for large-scale data processing
- ✅ **Design production-ready** analytics solutions with monitoring

## ⏱️ Time Estimate: 3-4 hours

- **Setup & Configuration**: 30 minutes
- **Statistical Analysis**: 60 minutes
- **ML Integration**: 90 minutes
- **Real-Time Analytics**: 60 minutes
- **Production Patterns**: 45 minutes

## 📋 Prerequisites

### **Knowledge Requirements**

- Proficiency in SQL and Python
- Understanding of statistical concepts
- Familiarity with PySpark DataFrames
- Basic machine learning concepts
- Completed [PySpark Fundamentals Lab](pyspark-fundamentals.md)

### **Technical Requirements**

- Azure Synapse workspace with Spark pool
- Azure Machine Learning workspace
- Power BI or equivalent visualization tool
- Sample datasets loaded and accessible

## 🧪 Lab Environment Setup

### **Azure Synapse Configuration**

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.window import Window
import pandas as pd
import numpy as np

# Initialize Spark session with advanced configurations
spark = SparkSession.builder \
    .appName("Advanced Analytics Lab") \
    .config("spark.sql.adaptive.enabled", "true") \
    .config("spark.sql.adaptive.coalescePartitions.enabled", "true") \
    .config("spark.dynamicAllocation.enabled", "true") \
    .config("spark.shuffle.service.enabled", "true") \
    .config("spark.sql.execution.arrow.pyspark.enabled", "true") \
    .getOrCreate()

print(f"Spark Version: {spark.version}")
print(f"Python Version: {spark.sparkContext.pythonVer}")
```

### **Data Sources Configuration**

```python
# Configure data lake storage
storage_account = "your_storage_account"
container = "analytics-data"
mount_point = f"abfss://{container}@{storage_account}.dfs.core.windows.net/"

# Load datasets
sales_df = spark.read.parquet(f"{mount_point}/sales/")
customers_df = spark.read.parquet(f"{mount_point}/customers/")
products_df = spark.read.parquet(f"{mount_point}/products/")
events_df = spark.read.parquet(f"{mount_point}/events/")

print(f"Sales records: {sales_df.count():,}")
print(f"Customer records: {customers_df.count():,}")
print(f"Product records: {products_df.count():,}")
```

## 📊 Module 1: Advanced Statistical Analysis (60 minutes)

### **Exercise 1.1: Time Series Analysis**

```python
# Prepare time series data
daily_sales = sales_df \
    .withColumn("date", to_date("transaction_time")) \
    .groupBy("date", "category") \
    .agg(
        sum("amount").alias("daily_revenue"),
        count("*").alias("transaction_count"),
        countDistinct("customer_id").alias("unique_customers")
    ) \
    .orderBy("date")

# Calculate moving averages
window_7day = Window.partitionBy("category") \
    .orderBy("date") \
    .rowsBetween(-6, 0)

window_30day = Window.partitionBy("category") \
    .orderBy("date") \
    .rowsBetween(-29, 0)

time_series_df = daily_sales \
    .withColumn("ma_7day", avg("daily_revenue").over(window_7day)) \
    .withColumn("ma_30day", avg("daily_revenue").over(window_30day)) \
    .withColumn("std_7day", stddev("daily_revenue").over(window_7day)) \
    .withColumn("upper_bound", col("ma_7day") + (2 * col("std_7day"))) \
    .withColumn("lower_bound", col("ma_7day") - (2 * col("std_7day")))

time_series_df.show(10)
```

### **Exercise 1.2: Anomaly Detection**

```python
# Statistical anomaly detection using z-scores
from pyspark.sql.functions import mean as _mean, stddev as _stddev

def detect_anomalies(df, metric_col, threshold=3.0):
    """
    Detect anomalies using z-score method
    """
    stats = df.agg(
        _mean(col(metric_col)).alias("mean"),
        _stddev(col(metric_col)).alias("stddev")
    ).collect()[0]

    mean_val = stats["mean"]
    stddev_val = stats["stddev"]

    anomalies_df = df \
        .withColumn("z_score",
                   (col(metric_col) - mean_val) / stddev_val) \
        .withColumn("is_anomaly",
                   abs(col("z_score")) > threshold) \
        .withColumn("anomaly_severity",
                   when(abs(col("z_score")) > 4, "Critical")
                   .when(abs(col("z_score")) > 3, "High")
                   .when(abs(col("z_score")) > 2, "Medium")
                   .otherwise("Normal"))

    return anomalies_df

# Apply anomaly detection
anomalies = detect_anomalies(time_series_df, "daily_revenue", threshold=3.0)
critical_anomalies = anomalies.filter(col("is_anomaly") == True)

print(f"Total anomalies detected: {critical_anomalies.count()}")
critical_anomalies.select("date", "category", "daily_revenue", "z_score", "anomaly_severity").show()
```

### **Exercise 1.3: Cohort Analysis**

```python
# Customer cohort analysis
cohort_df = sales_df \
    .withColumn("order_month", date_trunc("month", "transaction_time")) \
    .groupBy("customer_id") \
    .agg(min("order_month").alias("cohort_month"))

# Calculate cohort metrics
cohort_analysis = sales_df \
    .withColumn("order_month", date_trunc("month", "transaction_time")) \
    .join(cohort_df, "customer_id") \
    .withColumn("cohort_age",
               months_between(col("order_month"), col("cohort_month"))) \
    .groupBy("cohort_month", "cohort_age") \
    .agg(
        countDistinct("customer_id").alias("active_customers"),
        sum("amount").alias("revenue"),
        avg("amount").alias("avg_order_value")
    )

# Calculate retention rates
cohort_sizes = cohort_df.groupBy("cohort_month").count().withColumnRenamed("count", "cohort_size")

retention_df = cohort_analysis \
    .join(cohort_sizes, "cohort_month") \
    .withColumn("retention_rate",
               (col("active_customers") / col("cohort_size")) * 100) \
    .orderBy("cohort_month", "cohort_age")

retention_df.show(20)
```

## 🤖 Module 2: Machine Learning Integration (90 minutes)

### **Exercise 2.1: Feature Engineering for ML**

```python
from pyspark.ml.feature import VectorAssembler, StandardScaler
from pyspark.ml import Pipeline

# Create comprehensive customer features
customer_features = sales_df \
    .groupBy("customer_id") \
    .agg(
        # Monetary features
        sum("amount").alias("total_spent"),
        avg("amount").alias("avg_order_value"),
        max("amount").alias("max_purchase"),

        # Frequency features
        count("*").alias("purchase_count"),
        countDistinct(date_trunc("month", "transaction_time")).alias("active_months"),

        # Recency features
        datediff(current_date(), max("transaction_time")).alias("days_since_last_purchase"),

        # Behavioral features
        countDistinct("category").alias("category_diversity"),
        countDistinct("product_id").alias("product_diversity")
    ) \
    .join(customers_df, "customer_id")

# Add derived features
ml_features = customer_features \
    .withColumn("purchase_frequency",
               col("purchase_count") / greatest(col("active_months"), lit(1))) \
    .withColumn("avg_monthly_spend",
               col("total_spent") / greatest(col("active_months"), lit(1))) \
    .withColumn("engagement_score",
               (col("purchase_count") * col("category_diversity")) /
               (col("days_since_last_purchase") + 1))

# Prepare feature vector
feature_cols = [
    "total_spent", "avg_order_value", "purchase_count",
    "days_since_last_purchase", "category_diversity",
    "purchase_frequency", "avg_monthly_spend", "engagement_score"
]

assembler = VectorAssembler(inputCols=feature_cols, outputCol="features_raw")
scaler = StandardScaler(inputCol="features_raw", outputCol="features")

pipeline = Pipeline(stages=[assembler, scaler])
model = pipeline.fit(ml_features)
scaled_features = model.transform(ml_features)

scaled_features.select("customer_id", "features").show(5, truncate=False)
```

### **Exercise 2.2: Customer Segmentation with K-Means**

```python
from pyspark.ml.clustering import KMeans
from pyspark.ml.evaluation import ClusteringEvaluator

# Train K-Means model
kmeans = KMeans(k=5, seed=42, featuresCol="features")
kmeans_model = kmeans.fit(scaled_features)

# Make predictions
predictions = kmeans_model.transform(scaled_features)

# Evaluate clustering
evaluator = ClusteringEvaluator(featuresCol="features", metricName="silhouette")
silhouette = evaluator.evaluate(predictions)
print(f"Silhouette Score: {silhouette:.4f}")

# Analyze segments
segment_analysis = predictions \
    .groupBy("prediction") \
    .agg(
        count("*").alias("customer_count"),
        avg("total_spent").alias("avg_total_spent"),
        avg("purchase_count").alias("avg_purchases"),
        avg("days_since_last_purchase").alias("avg_recency"),
        avg("engagement_score").alias("avg_engagement")
    ) \
    .orderBy("prediction")

segment_analysis.show()

# Assign segment labels
segment_labels = {
    0: "High Value Active",
    1: "Moderate Engaged",
    2: "At Risk",
    3: "New Customers",
    4: "Churned"
}

labeled_segments = predictions \
    .withColumn("segment_name",
               when(col("prediction") == 0, segment_labels[0])
               .when(col("prediction") == 1, segment_labels[1])
               .when(col("prediction") == 2, segment_labels[2])
               .when(col("prediction") == 3, segment_labels[3])
               .otherwise(segment_labels[4]))

labeled_segments.select("customer_id", "segment_name", "total_spent", "purchase_count").show(10)
```

### **Exercise 2.3: Churn Prediction Model**

```python
from pyspark.ml.classification import RandomForestClassifier
from pyspark.ml.evaluation import BinaryClassificationEvaluator

# Create churn labels (customers with no purchase in 90 days)
churn_threshold = 90
churn_df = ml_features \
    .withColumn("is_churned",
               when(col("days_since_last_purchase") > churn_threshold, 1.0)
               .otherwise(0.0))

# Prepare training data
training_data = model.transform(churn_df).select("features", "is_churned")

# Split data
train_df, test_df = training_data.randomSplit([0.8, 0.2], seed=42)

# Train Random Forest model
rf = RandomForestClassifier(
    labelCol="is_churned",
    featuresCol="features",
    numTrees=100,
    maxDepth=5,
    seed=42
)

rf_model = rf.fit(train_df)

# Make predictions
predictions = rf_model.transform(test_df)

# Evaluate model
evaluator = BinaryClassificationEvaluator(labelCol="is_churned", metricName="areaUnderROC")
auc = evaluator.evaluate(predictions)
print(f"AUC-ROC Score: {auc:.4f}")

# Feature importance
feature_importance = pd.DataFrame({
    'feature': feature_cols,
    'importance': rf_model.featureImportances.toArray()
}).sort_values('importance', ascending=False)

print("\nFeature Importance:")
print(feature_importance)
```

## 📈 Module 3: Real-Time Analytics (60 minutes)

### **Exercise 3.1: Streaming Data Processing**

```python
from pyspark.sql.types import StructType, StructField, StringType, DoubleType, TimestampType

# Define schema for streaming data
stream_schema = StructType([
    StructField("transaction_id", StringType(), True),
    StructField("customer_id", StringType(), True),
    StructField("product_id", StringType(), True),
    StructField("amount", DoubleType(), True),
    StructField("timestamp", TimestampType(), True)
])

# Read streaming data
stream_df = spark.readStream \
    .schema(stream_schema) \
    .format("json") \
    .option("maxFilesPerTrigger", 1) \
    .load(f"{mount_point}/streaming/transactions/")

# Apply streaming transformations
enriched_stream = stream_df \
    .withColumn("hour", hour("timestamp")) \
    .withColumn("day_of_week", dayofweek("timestamp")) \
    .withColumn("is_high_value", col("amount") > 100)

# Windowed aggregations
windowed_stats = enriched_stream \
    .withWatermark("timestamp", "10 minutes") \
    .groupBy(
        window("timestamp", "5 minutes"),
        "product_id"
    ) \
    .agg(
        count("*").alias("transaction_count"),
        sum("amount").alias("total_revenue"),
        avg("amount").alias("avg_amount")
    )

# Write to console for testing
query = windowed_stats.writeStream \
    .outputMode("update") \
    .format("console") \
    .option("truncate", False) \
    .start()
```

### **Exercise 3.2: Real-Time Anomaly Detection**

```python
def detect_streaming_anomalies(batch_df, batch_id):
    """
    Process each streaming batch for anomaly detection
    """
    if batch_df.isEmpty():
        return

    # Calculate baseline statistics
    stats = batch_df.agg(
        avg("amount").alias("mean"),
        stddev("amount").alias("stddev")
    ).collect()[0]

    mean_amount = stats["mean"]
    stddev_amount = stats["stddev"]

    # Detect anomalies
    anomalies = batch_df \
        .withColumn("z_score", (col("amount") - mean_amount) / stddev_amount) \
        .filter(abs(col("z_score")) > 3)

    if anomalies.count() > 0:
        print(f"\n=== Batch {batch_id}: {anomalies.count()} anomalies detected ===")
        anomalies.show()

        # Write to alerts table
        anomalies.write \
            .mode("append") \
            .format("delta") \
            .save(f"{mount_point}/alerts/transaction_anomalies/")

# Apply to streaming data
stream_query = enriched_stream.writeStream \
    .foreachBatch(detect_streaming_anomalies) \
    .start()
```

### **Exercise 3.3: Live Dashboard Metrics**

```python
# Calculate real-time KPIs
real_time_kpis = enriched_stream \
    .withWatermark("timestamp", "5 minutes") \
    .groupBy(window("timestamp", "1 minute")) \
    .agg(
        count("*").alias("transactions_per_minute"),
        sum("amount").alias("revenue_per_minute"),
        avg("amount").alias("avg_transaction_value"),
        sum(when(col("is_high_value"), 1).otherwise(0)).alias("high_value_transactions")
    ) \
    .withColumn("conversion_rate",
               (col("high_value_transactions") / col("transactions_per_minute")) * 100)

# Write to Delta for Power BI consumption
dashboard_query = real_time_kpis.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", f"{mount_point}/checkpoints/dashboard/") \
    .start(f"{mount_point}/dashboard/real_time_kpis/")
```

## 🏭 Module 4: Production Analytics Patterns (45 minutes)

### **Exercise 4.1: Incremental Processing Pattern**

```python
from delta.tables import DeltaTable

def process_incremental_data(source_path, target_path, watermark_col="updated_at"):
    """
    Process only new/updated records using Delta Lake
    """
    # Read last processed watermark
    try:
        target_table = DeltaTable.forPath(spark, target_path)
        last_watermark = target_table.toDF() \
            .agg(max(watermark_col).alias("max_timestamp")) \
            .collect()[0]["max_timestamp"]
    except:
        last_watermark = "1900-01-01"

    # Read incremental data
    incremental_df = spark.read.parquet(source_path) \
        .filter(col(watermark_col) > last_watermark)

    if incremental_df.count() > 0:
        # Apply transformations
        processed_df = incremental_df \
            .withColumn("processing_timestamp", current_timestamp()) \
            .withColumn("data_quality_score",
                       when(col("amount").isNotNull() & (col("amount") > 0), 1.0)
                       .otherwise(0.0))

        # Merge into target
        if DeltaTable.isDeltaTable(spark, target_path):
            target_table.alias("target") \
                .merge(
                    processed_df.alias("source"),
                    "target.transaction_id = source.transaction_id"
                ) \
                .whenMatchedUpdateAll() \
                .whenNotMatchedInsertAll() \
                .execute()
        else:
            processed_df.write.format("delta").save(target_path)

        print(f"Processed {incremental_df.count()} incremental records")
    else:
        print("No new data to process")

# Execute incremental processing
process_incremental_data(
    f"{mount_point}/raw/transactions/",
    f"{mount_point}/processed/transactions/"
)
```

### **Exercise 4.2: Data Quality Framework**

```python
class DataQualityValidator:
    """
    Comprehensive data quality validation framework
    """

    def __init__(self, df, table_name):
        self.df = df
        self.table_name = table_name
        self.results = []

    def check_null_values(self, columns):
        """Check for null values in critical columns"""
        for col_name in columns:
            null_count = self.df.filter(col(col_name).isNull()).count()
            total_count = self.df.count()
            null_pct = (null_count / total_count) * 100

            self.results.append({
                "check": "null_values",
                "column": col_name,
                "null_count": null_count,
                "null_percentage": null_pct,
                "status": "PASS" if null_pct < 5 else "FAIL"
            })

    def check_duplicates(self, key_columns):
        """Check for duplicate records"""
        total_count = self.df.count()
        distinct_count = self.df.select(key_columns).distinct().count()
        duplicate_count = total_count - distinct_count

        self.results.append({
            "check": "duplicates",
            "column": ",".join(key_columns),
            "duplicate_count": duplicate_count,
            "status": "PASS" if duplicate_count == 0 else "FAIL"
        })

    def check_value_range(self, column, min_val, max_val):
        """Check if values are within expected range"""
        out_of_range = self.df.filter(
            (col(column) < min_val) | (col(column) > max_val)
        ).count()

        self.results.append({
            "check": "value_range",
            "column": column,
            "out_of_range_count": out_of_range,
            "status": "PASS" if out_of_range == 0 else "FAIL"
        })

    def get_report(self):
        """Generate quality report"""
        return spark.createDataFrame(self.results)

# Apply data quality checks
validator = DataQualityValidator(sales_df, "sales")
validator.check_null_values(["transaction_id", "customer_id", "amount"])
validator.check_duplicates(["transaction_id"])
validator.check_value_range("amount", 0, 10000)

quality_report = validator.get_report()
quality_report.show(truncate=False)

# Save quality metrics
quality_report.write \
    .mode("append") \
    .format("delta") \
    .partitionBy("check") \
    .save(f"{mount_point}/data_quality/reports/")
```

### **Exercise 4.3: Performance Optimization**

```python
# Optimize table with Z-ordering and compaction
from delta.tables import DeltaTable

target_table = DeltaTable.forPath(spark, f"{mount_point}/processed/transactions/")

# Optimize with Z-ordering
target_table.optimize() \
    .where("date >= '2024-01-01'") \
    .executeZOrderBy("customer_id", "category")

# Vacuum old files
target_table.vacuum(168)  # 7 days retention

# Enable auto-optimize
spark.sql(f"""
    ALTER TABLE delta.`{mount_point}/processed/transactions/`
    SET TBLPROPERTIES (
        'delta.autoOptimize.optimizeWrite' = 'true',
        'delta.autoOptimize.autoCompact' = 'true'
    )
""")

# Create statistics for query optimization
spark.sql(f"""
    ANALYZE TABLE delta.`{mount_point}/processed/transactions/`
    COMPUTE STATISTICS FOR COLUMNS customer_id, category, amount
""")
```

## 🎯 Challenge Projects

### **Challenge 1: Build Recommendation Engine**

```python
"""
Create a product recommendation system:
1. Calculate product affinity using collaborative filtering
2. Implement association rule mining
3. Generate personalized recommendations for each customer
4. Evaluate recommendation quality
"""

def build_recommendation_engine(sales_df, customers_df, products_df):
    """
    Your implementation here
    """
    pass
```

### **Challenge 2: Predictive Demand Forecasting**

```python
"""
Build a demand forecasting model:
1. Prepare time series data by product and location
2. Engineer features including seasonality, trends, events
3. Train forecasting model (Prophet, ARIMA, or ML model)
4. Generate forecasts for next 30 days
5. Calculate confidence intervals
"""

def forecast_demand(sales_df, horizon_days=30):
    """
    Your implementation here
    """
    pass
```

### **Challenge 3: Customer Lifetime Value Prediction**

```python
"""
Predict customer lifetime value (CLV):
1. Calculate historical CLV for existing customers
2. Engineer predictive features
3. Train regression model
4. Predict CLV for new customers
5. Segment customers by predicted value
"""

def predict_customer_lifetime_value(sales_df, customers_df):
    """
    Your implementation here
    """
    pass
```

## ✅ Lab Validation

### **Automated Testing**

```python
def run_advanced_analytics_tests():
    """
    Validate lab implementations
    """
    tests_passed = 0
    total_tests = 0

    # Test 1: Time series analysis
    try:
        assert "ma_7day" in time_series_df.columns
        assert "std_7day" in time_series_df.columns
        tests_passed += 1
        print("✅ Test 1: Time series analysis")
    except:
        print("❌ Test 1 Failed")
    finally:
        total_tests += 1

    # Test 2: ML model training
    try:
        assert rf_model is not None
        assert auc > 0.6
        tests_passed += 1
        print("✅ Test 2: ML model performance")
    except:
        print("❌ Test 2 Failed")
    finally:
        total_tests += 1

    # Test 3: Data quality
    try:
        quality_failures = quality_report.filter(col("status") == "FAIL").count()
        assert quality_failures == 0
        tests_passed += 1
        print("✅ Test 3: Data quality")
    except:
        print("❌ Test 3 Failed")
    finally:
        total_tests += 1

    print(f"\n📊 Tests: {tests_passed}/{total_tests} passed")
    return tests_passed == total_tests

run_advanced_analytics_tests()
```

## 🎓 Knowledge Assessment

### **Concept Check**

```python
"""
Answer these questions:

1. When should you use batch processing vs. streaming analytics?

2. How do you handle late-arriving data in streaming scenarios?

3. What are the trade-offs between model complexity and interpretability?

4. How do you monitor and maintain ML models in production?

5. What strategies ensure data quality in analytics pipelines?
"""
```

## 🎉 Congratulations

You've completed the Advanced Analytics Lab! You now have the skills to:

- Design and implement complex analytics solutions
- Build and deploy machine learning models
- Create real-time analytics pipelines
- Ensure data quality and performance optimization
- Apply production-grade patterns and practices

## 🚀 Next Steps

1. **Advanced Topics**:
   - [ML Pipeline Integration Lab](ml-pipeline-lab.md)
   - [Streaming Analytics Deep Dive](streaming-analytics.md)
   - [Data Security Lab](data-security-lab.md)

2. **Certification Paths**:
   - DP-203: Azure Data Engineer Associate
   - DP-100: Azure Data Scientist Associate

3. **Real-World Application**:
   - Apply these patterns to your organization's data
   - Build custom analytics solutions
   - Share knowledge with your team

## 📚 Additional Resources

- [Azure Synapse Analytics Documentation](https://docs.microsoft.com/azure/synapse-analytics/)
- [MLflow Documentation](https://mlflow.org/docs/latest/index.html)
- [Delta Lake Best Practices](https://docs.delta.io/latest/best-practices.html)

---

*Lab Version: 1.0*
*Last Updated: January 2025*
*Advanced Analytics for Production Systems*
