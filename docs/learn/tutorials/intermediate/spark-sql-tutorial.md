# 🔍 Spark SQL Tutorial

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)
![Duration](https://img.shields.io/badge/Duration-60--75_minutes-blue)

__Master Spark SQL for distributed data processing. Learn advanced queries, optimization, and best practices.__

## 🎯 Learning Objectives

- Write efficient Spark SQL queries
- Use window functions and CTEs
- Optimize query performance
- Work with complex data types
- Implement data quality checks

## 📋 Prerequisites

- [ ] __Spark cluster__ - Databricks or HDInsight
- [ ] __SQL knowledge__ - Advanced SQL concepts
- [ ] __Understanding of DataFrames__

## 📊 Advanced Queries

```sql
-- Window functions
SELECT
    customer_id,
    order_date,
    amount,
    SUM(amount) OVER (
        PARTITION BY customer_id
        ORDER BY order_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) as running_total,
    ROW_NUMBER() OVER (
        PARTITION BY customer_id
        ORDER BY amount DESC
    ) as purchase_rank
FROM orders;
```

## 🎯 Performance Tips

- Use Catalyst optimizer
- Enable adaptive query execution
- Broadcast small tables
- Partition large tables

## 📚 Resources

- [Spark SQL Guide](https://spark.apache.org/sql/)
- [Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)

---

*Last Updated: January 2025*
