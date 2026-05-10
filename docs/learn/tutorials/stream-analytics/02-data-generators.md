---
title: "Tutorial 2: Data Generators and Simulators"
description: "**Create realistic IoT data generators to simulate sensor streams for testing Stream Analytics queries. Learn data generation patterns, velocity control, and anomaly injection techniques.**"
tags:
  - tutorials
  - stream-analytics
---
# 🎲 Tutorial 2: Data Generators and Simulators

![Tutorial](https://img.shields.io/badge/Tutorial-02_Data_Generators-blue)
![Duration](https://img.shields.io/badge/Duration-20_minutes-green)
![Level](https://img.shields.io/badge/Level-Beginner-brightgreen)

**Create realistic IoT data generators to simulate sensor streams for testing Stream Analytics queries. Learn data generation patterns, velocity control, and anomaly injection techniques.**

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ **Build IoT data simulators** that generate realistic sensor data
- ✅ **Control data velocity** with configurable generation rates
- ✅ **Inject anomalies** for testing detection algorithms
- ✅ **Send data to Event Hubs** programmatically
- ✅ **Monitor data flow** and verify ingestion

## ⏱️ Time Estimate: 20 minutes

- **Simulator Development**: 10 minutes
- **Configuration & Testing**: 5 minutes
- **Validation**: 5 minutes

## 📋 Prerequisites

- [ ] Completed [Tutorial 01: Environment Setup](01-environment-setup.md)
- [ ] Event Hub namespace and hub created
- [ ] Python 3.8+ installed with azure-eventhub package
- [ ] Environment variables configured from Tutorial 01

## 🛠️ Step 1: Create Base Data Generator

### **1.1 Define Sensor Data Schema**

Create a structured schema for IoT sensor data:

```python
# sensor_schema.py
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Any
import json

@dataclass
class SensorReading:
    """Schema for IoT sensor readings"""
    deviceId: str
    deviceType: str
    temperature: float
    humidity: float
    pressure: float
    timestamp: str
    location: Dict[str, Any]

    def to_json(self) -> str:
        """Convert to JSON string for Event Hub"""
        return json.dumps({
            'deviceId': self.deviceId,
            'deviceType': self.deviceType,
            'temperature': round(self.temperature, 2),
            'humidity': round(self.humidity, 2),
            'pressure': round(self.pressure, 2),
            'timestamp': self.timestamp,
            'location': self.location
        })

    @staticmethod
    def generate_normal_reading(device_id: str, device_type: str) -> 'SensorReading':
        """Generate a normal sensor reading"""
        import random
        from datetime import datetime, timezone

        return SensorReading(
            deviceId=device_id,
            deviceType=device_type,
            temperature=random.uniform(65.0, 85.0),  # Normal range
            humidity=random.uniform(30.0, 70.0),      # Normal range
            pressure=random.uniform(980.0, 1020.0),   # Normal range
            timestamp=datetime.now(timezone.utc).isoformat(),
            location={
                'building': f'Building-{random.randint(1, 5)}',
                'floor': random.randint(1, 10),
                'room': f'Room-{random.randint(100, 999)}'
            }
        )
```

### **1.2 Create Simple Data Generator**

Build a basic data generator for continuous streaming:

```python
# simple_generator.py
import os
import time
import asyncio
from azure.eventhub import EventHubProducerClient, EventData
from azure.eventhub.exceptions import EventHubError
from sensor_schema import SensorReading
from datetime import datetime

class SimpleDataGenerator:
    """Basic IoT data generator for Event Hubs"""

    def __init__(self, connection_string: str, eventhub_name: str):
        self.connection_string = connection_string
        self.eventhub_name = eventhub_name
        self.producer = None
        self.is_running = False

    def connect(self):
        """Initialize Event Hub producer connection"""
        try:
            self.producer = EventHubProducerClient.from_connection_string(
                conn_str=self.connection_string,
                eventhub_name=self.eventhub_name
            )
            print(f"✅ Connected to Event Hub: {self.eventhub_name}")
        except EventHubError as e:
            print(f"❌ Connection failed: {e}")
            raise

    def generate_batch(self, device_ids: list, batch_size: int = 10) -> list:
        """Generate a batch of sensor readings"""
        readings = []
        for device_id in device_ids:
            reading = SensorReading.generate_normal_reading(
                device_id=device_id,
                device_type='TempHumiditySensor'
            )
            readings.append(reading)
        return readings[:batch_size]

    def send_batch(self, readings: list):
        """Send batch of readings to Event Hub"""
        try:
            event_data_batch = self.producer.create_batch()

            for reading in readings:
                event_data_batch.add(EventData(reading.to_json()))

            self.producer.send_batch(event_data_batch)
            return len(readings)
        except EventHubError as e:
            print(f"❌ Send failed: {e}")
            return 0

    def run(self, device_count: int = 5, events_per_second: int = 10, duration_seconds: int = 60):
        """Run data generator for specified duration"""
        device_ids = [f"sensor-{str(i).zfill(3)}" for i in range(1, device_count + 1)]

        print(f"\n🚀 Starting data generation...")
        print(f"   Devices: {device_count}")
        print(f"   Rate: {events_per_second} events/second")
        print(f"   Duration: {duration_seconds} seconds")
        print(f"   Total Events: {events_per_second * duration_seconds}\n")

        self.connect()
        self.is_running = True

        total_sent = 0
        start_time = time.time()
        interval = 1.0 / events_per_second

        try:
            while self.is_running and (time.time() - start_time) < duration_seconds:
                readings = self.generate_batch(device_ids, batch_size=1)
                sent = self.send_batch(readings)
                total_sent += sent

                if total_sent % 100 == 0:
                    elapsed = time.time() - start_time
                    rate = total_sent / elapsed if elapsed > 0 else 0
                    print(f"📊 Sent: {total_sent} events | Rate: {rate:.1f} events/sec")

                time.sleep(interval)

        except KeyboardInterrupt:
            print("\n⚠️ Generation stopped by user")
        finally:
            self.close()

        elapsed = time.time() - start_time
        print(f"\n✅ Generation complete!")
        print(f"   Total sent: {total_sent} events")
        print(f"   Elapsed time: {elapsed:.1f} seconds")
        print(f"   Average rate: {total_sent/elapsed:.1f} events/sec")

    def close(self):
        """Close Event Hub connection"""
        if self.producer:
            self.producer.close()
            print("🔌 Connection closed")

# Usage example
if __name__ == "__main__":
    # Load connection string from environment
    connection_string = os.environ.get("STREAM_EH_SEND_CONN")
    eventhub_name = os.environ.get("STREAM_EH_NAME")

    if not connection_string or not eventhub_name:
        print("❌ Error: Environment variables not set")
        print("   Please complete Tutorial 01 first")
        exit(1)

    generator = SimpleDataGenerator(connection_string, eventhub_name)
    generator.run(device_count=5, events_per_second=10, duration_seconds=60)
```

**Expected Output:**

```text
✅ Connected to Event Hub: sensordata

🚀 Starting data generation...
   Devices: 5
   Rate: 10 events/second
   Duration: 60 seconds
   Total Events: 600

📊 Sent: 100 events | Rate: 10.1 events/sec
📊 Sent: 200 events | Rate: 10.0 events/sec
📊 Sent: 300 events | Rate: 10.0 events/sec
📊 Sent: 400 events | Rate: 10.0 events/sec
📊 Sent: 500 events | Rate: 10.0 events/sec
📊 Sent: 600 events | Rate: 10.0 events/sec

✅ Generation complete!
   Total sent: 600 events
   Elapsed time: 60.2 seconds
   Average rate: 10.0 events/sec
🔌 Connection closed
```

## 🎯 Step 2: Advanced Generator with Patterns

### **2.1 Create Pattern-Based Generator**

Implement realistic data patterns (daily cycles, trends):

```python
# advanced_generator.py
import math
import random
from datetime import datetime, timezone
from sensor_schema import SensorReading

class AdvancedDataGenerator:
    """Generator with realistic patterns and trends"""

    def __init__(self):
        self.base_temperature = 72.0
        self.base_humidity = 50.0
        self.base_pressure = 1013.25
        self.time_offset = 0

    def apply_daily_cycle(self, base_value: float, amplitude: float, hour: int) -> float:
        """Apply sinusoidal daily pattern (peak at 2pm, low at 2am)"""
        # Hour 14 (2pm) = peak, hour 2 (2am) = trough
        phase = (hour - 2) * (2 * math.pi / 24)
        variation = amplitude * math.sin(phase)
        return base_value + variation

    def apply_trend(self, base_value: float, trend_rate: float, minutes_elapsed: int) -> float:
        """Apply gradual trend over time"""
        hours_elapsed = minutes_elapsed / 60.0
        return base_value + (trend_rate * hours_elapsed)

    def apply_noise(self, value: float, noise_level: float = 0.5) -> float:
        """Add random noise to value"""
        noise = random.uniform(-noise_level, noise_level)
        return value + noise

    def generate_realistic_reading(
        self,
        device_id: str,
        device_type: str,
        current_hour: int = None,
        minutes_elapsed: int = 0
    ) -> SensorReading:
        """Generate reading with realistic patterns"""

        if current_hour is None:
            current_hour = datetime.now().hour

        # Apply daily cycle (temperature higher in afternoon)
        temp = self.apply_daily_cycle(self.base_temperature, amplitude=8.0, hour=current_hour)
        temp = self.apply_trend(temp, trend_rate=0.1, minutes_elapsed=minutes_elapsed)
        temp = self.apply_noise(temp, noise_level=1.0)

        # Humidity inversely related to temperature
        humidity = self.apply_daily_cycle(self.base_humidity, amplitude=-10.0, hour=current_hour)
        humidity = self.apply_noise(humidity, noise_level=2.0)

        # Pressure has longer-term variations
        pressure = self.apply_trend(self.base_pressure, trend_rate=-0.2, minutes_elapsed=minutes_elapsed)
        pressure = self.apply_noise(pressure, noise_level=5.0)

        return SensorReading(
            deviceId=device_id,
            deviceType=device_type,
            temperature=max(60.0, min(90.0, temp)),  # Clamp to realistic range
            humidity=max(20.0, min(80.0, humidity)),
            pressure=max(950.0, min(1050.0, pressure)),
            timestamp=datetime.now(timezone.utc).isoformat(),
            location={
                'building': f'Building-{random.randint(1, 5)}',
                'floor': random.randint(1, 10),
                'room': f'Room-{random.randint(100, 999)}'
            }
        )
```

### **2.2 Implement Anomaly Injection**

Create controlled anomalies for testing detection:

```python
# anomaly_injector.py
import random
from sensor_schema import SensorReading
from datetime import datetime, timezone

class AnomalyInjector:
    """Inject various anomaly types into sensor data"""

    @staticmethod
    def spike_anomaly(reading: SensorReading, magnitude: float = 3.0) -> SensorReading:
        """Create sudden spike in values"""
        reading.temperature += magnitude * 10
        reading.humidity += magnitude * 5
        return reading

    @staticmethod
    def dropout_anomaly(reading: SensorReading) -> SensorReading:
        """Simulate sensor malfunction (zeros or nulls)"""
        reading.temperature = 0.0
        reading.humidity = 0.0
        reading.pressure = 0.0
        return reading

    @staticmethod
    def drift_anomaly(reading: SensorReading, drift_amount: float = 5.0) -> SensorReading:
        """Gradual sensor drift (calibration issue)"""
        reading.temperature += drift_amount
        return reading

    @staticmethod
    def noise_anomaly(reading: SensorReading, noise_factor: float = 5.0) -> SensorReading:
        """Excessive noise in readings"""
        reading.temperature += random.uniform(-noise_factor, noise_factor)
        reading.humidity += random.uniform(-noise_factor, noise_factor)
        reading.pressure += random.uniform(-noise_factor * 2, noise_factor * 2)
        return reading

    @staticmethod
    def should_inject_anomaly(probability: float = 0.05) -> bool:
        """Determine if anomaly should be injected (default 5% chance)"""
        return random.random() < probability

    @staticmethod
    def inject_random_anomaly(reading: SensorReading, probability: float = 0.05) -> SensorReading:
        """Randomly inject one of several anomaly types"""
        if not AnomalyInjector.should_inject_anomaly(probability):
            return reading

        anomaly_type = random.choice(['spike', 'dropout', 'noise', 'drift'])

        if anomaly_type == 'spike':
            return AnomalyInjector.spike_anomaly(reading)
        elif anomaly_type == 'dropout':
            return AnomalyInjector.dropout_anomaly(reading)
        elif anomaly_type == 'noise':
            return AnomalyInjector.noise_anomaly(reading)
        elif anomaly_type == 'drift':
            return AnomalyInjector.drift_anomaly(reading)

        return reading
```

## 📊 Step 3: Production-Grade Generator

### **3.1 Complete Generator with All Features**

Create comprehensive generator script:

```python
# production_generator.py
import os
import time
import argparse
from simple_generator import SimpleDataGenerator
from advanced_generator import AdvancedDataGenerator
from anomaly_injector import AnomalyInjector
from sensor_schema import SensorReading

class ProductionDataGenerator(SimpleDataGenerator):
    """Production-grade data generator with all features"""

    def __init__(self, connection_string: str, eventhub_name: str, use_patterns: bool = True, inject_anomalies: bool = True, anomaly_rate: float = 0.05):
        super().__init__(connection_string, eventhub_name)
        self.use_patterns = use_patterns
        self.inject_anomalies = inject_anomalies
        self.anomaly_rate = anomaly_rate
        self.advanced_gen = AdvancedDataGenerator() if use_patterns else None
        self.minutes_elapsed = 0
        self.anomaly_count = 0

    def generate_batch(self, device_ids: list, batch_size: int = 10) -> list:
        """Generate batch with patterns and anomalies"""
        readings = []

        for device_id in device_ids[:batch_size]:
            # Generate reading with or without patterns
            if self.use_patterns:
                reading = self.advanced_gen.generate_realistic_reading(
                    device_id=device_id,
                    device_type='TempHumiditySensor',
                    minutes_elapsed=self.minutes_elapsed
                )
            else:
                reading = SensorReading.generate_normal_reading(
                    device_id=device_id,
                    device_type='TempHumiditySensor'
                )

            # Inject anomalies if enabled
            if self.inject_anomalies:
                original_temp = reading.temperature
                reading = AnomalyInjector.inject_random_anomaly(reading, self.anomaly_rate)
                if abs(reading.temperature - original_temp) > 5:
                    self.anomaly_count += 1
                    print(f"⚠️ Anomaly injected for {device_id}")

            readings.append(reading)

        self.minutes_elapsed += 1
        return readings

def main():
    """Main entry point with CLI arguments"""
    parser = argparse.ArgumentParser(description='IoT Data Generator for Stream Analytics')
    parser.add_argument('--devices', type=int, default=10, help='Number of IoT devices')
    parser.add_argument('--rate', type=int, default=10, help='Events per second')
    parser.add_argument('--duration', type=int, default=300, help='Duration in seconds')
    parser.add_argument('--patterns', action='store_true', help='Use realistic patterns')
    parser.add_argument('--anomalies', action='store_true', help='Inject anomalies')
    parser.add_argument('--anomaly-rate', type=float, default=0.05, help='Anomaly probability (0.0-1.0)')

    args = parser.parse_args()

    # Load configuration
    connection_string = os.environ.get("STREAM_EH_SEND_CONN")
    eventhub_name = os.environ.get("STREAM_EH_NAME")

    if not connection_string or not eventhub_name:
        print("❌ Error: Environment variables not set")
        exit(1)

    # Create and run generator
    generator = ProductionDataGenerator(
        connection_string=connection_string,
        eventhub_name=eventhub_name,
        use_patterns=args.patterns,
        inject_anomalies=args.anomalies,
        anomaly_rate=args.anomaly_rate
    )

    generator.run(
        device_count=args.devices,
        events_per_second=args.rate,
        duration_seconds=args.duration
    )

    # Print statistics
    print(f"\n📈 Statistics:")
    print(f"   Anomalies injected: {generator.anomaly_count}")
    print(f"   Anomaly rate: {generator.anomaly_count / (args.rate * args.duration) * 100:.2f}%")

if __name__ == "__main__":
    main()
```

### **3.2 Run Production Generator**

Execute with various configurations:

```powershell
# Basic generation (no patterns or anomalies)
python production_generator.py --devices 5 --rate 10 --duration 60

# With realistic patterns
python production_generator.py --devices 10 --rate 20 --duration 300 --patterns

# With anomaly injection (5% rate)
python production_generator.py --devices 10 --rate 20 --duration 300 --patterns --anomalies --anomaly-rate 0.05

# High-volume testing
python production_generator.py --devices 50 --rate 100 --duration 600 --patterns --anomalies
```

## ✅ Step 4: Verification and Monitoring

### **4.1 Monitor Event Hub Metrics**

Check data ingestion in Azure Portal:

```powershell
# View incoming messages over last 10 minutes
az monitor metrics list \
    --resource "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$env:STREAM_RG/providers/Microsoft.EventHub/namespaces/$env:STREAM_EH_NAMESPACE" \
    --metric IncomingMessages \
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ss") \
    --interval PT1M \
    --output table

# Check for throttling or errors
az monitor metrics list \
    --resource "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$env:STREAM_RG/providers/Microsoft.EventHub/namespaces/$env:STREAM_EH_NAMESPACE" \
    --metric ThrottledRequests \
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ss") \
    --interval PT1M \
    --output table
```

### **4.2 Sample Data Validation**

Create script to read and validate generated data:

```python
# validate_data.py
import os
import json
from azure.eventhub import EventHubConsumerClient

def validate_event(event_data):
    """Validate event schema and values"""
    try:
        data = json.loads(event_data.body_as_str())

        # Check required fields
        required_fields = ['deviceId', 'deviceType', 'temperature', 'humidity', 'pressure', 'timestamp', 'location']
        for field in required_fields:
            if field not in data:
                return False, f"Missing field: {field}"

        # Validate ranges
        if not (0 <= data['temperature'] <= 150):
            return False, f"Temperature out of range: {data['temperature']}"
        if not (0 <= data['humidity'] <= 100):
            return False, f"Humidity out of range: {data['humidity']}"
        if not (800 <= data['pressure'] <= 1200):
            return False, f"Pressure out of range: {data['pressure']}"

        return True, "Valid"
    except Exception as e:
        return False, str(e)

def on_event(partition_context, event):
    valid, message = validate_event(event)
    status = "✅" if valid else "❌"
    print(f"{status} Device: {json.loads(event.body_as_str())['deviceId']} - {message}")
    partition_context.update_checkpoint(event)

# Read last 10 events for validation
connection_string = os.environ.get("STREAM_EH_LISTEN_CONN")
eventhub_name = os.environ.get("STREAM_EH_NAME")

consumer_client = EventHubConsumerClient.from_connection_string(
    conn_str=connection_string,
    consumer_group="$Default",
    eventhub_name=eventhub_name
)

print("📊 Validating recent events...\n")

with consumer_client:
    consumer_client.receive(
        on_event=on_event,
        starting_position="-1"  # Start from end
    )
```

## 🎓 Key Concepts Learned

### **Data Generation Patterns**

- **Simple generation**: Random values within ranges
- **Realistic patterns**: Daily cycles, trends, correlations
- **Anomaly injection**: Controlled anomalies for testing
- **Velocity control**: Configurable event rates

### **Event Hub Integration**

- **Producer patterns**: Batch sending, error handling
- **Connection management**: Proper initialization and cleanup
- **Partition strategies**: How data is distributed
- **Monitoring**: Tracking ingestion metrics

### **Testing Scenarios**

- **Normal operations**: Baseline data for query development
- **High volume**: Load testing and performance validation
- **Anomaly detection**: Testing alert and detection logic
- **Edge cases**: Null values, out-of-range data, malformed events

## 🚀 Next Steps

Your data generator is ready to produce realistic streaming data! Continue to:

**[Tutorial 03: Creating Stream Analytics Job →](03-job-creation.md)**

In the next tutorial, you'll:

- Create your first Stream Analytics job
- Configure inputs from Event Hubs
- Set up outputs to various destinations
- Write your first streaming query

## 📚 Additional Resources

- [Event Hubs Best Practices](https://docs.microsoft.com/azure/event-hubs/event-hubs-programming-guide)
- [Python Event Hub SDK](https://github.com/Azure/azure-sdk-for-python/tree/main/sdk/eventhub)
- [IoT Device Simulation Patterns](https://docs.microsoft.com/azure/iot-hub/iot-hub-raspberry-pi-web-simulator-get-started)

## 🔧 Troubleshooting

### **Issue: Connection Timeout**

**Symptoms:** "EventHubError: Connection timeout"

**Solution:**

```powershell
# Check Event Hub firewall rules
az eventhubs namespace network-rule list \
    --namespace-name $env:STREAM_EH_NAMESPACE \
    --resource-group $env:STREAM_RG

# Add your IP if needed
az eventhubs namespace network-rule add \
    --namespace-name $env:STREAM_EH_NAMESPACE \
    --resource-group $env:STREAM_RG \
    --ip-address "YOUR_IP_ADDRESS"
```

### **Issue: Throttling Errors**

**Symptoms:** "QuotaExceededException: Message size quota exceeded"

**Solution:**

```python
# Reduce batch size or event rate
generator.run(device_count=5, events_per_second=5, duration_seconds=60)

# Or upgrade Event Hub tier
az eventhubs namespace update \
    --name $env:STREAM_EH_NAMESPACE \
    --resource-group $env:STREAM_RG \
    --sku Standard \
    --capacity 2
```

## 💬 Feedback

Was this tutorial helpful?

- ✅ **Completed successfully** - [Continue to Tutorial 03](03-job-creation.md)
- ⚠️ **Had issues** - [Report a problem](https://github.com/fgarofalo56/csa-inabox-docs/issues)
- 💡 **Have suggestions** - [Share feedback](https://github.com/fgarofalo56/csa-inabox-docs/discussions)

---

**Tutorial Progress:** 2 of 11 complete | **Next:** [Stream Analytics Job Creation](03-job-creation.md)

*Last Updated: January 2025*
