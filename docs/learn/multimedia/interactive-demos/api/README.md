---
title: "Interactive Demo APIs"
tags:
  - multimedia
  - demos
  - api
---
# 🔌 Interactive Demo APIs

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: API](https://img.shields.io/badge/Type-API-blue)
![Complexity: Intermediate](https://img.shields.io/badge/Complexity-Intermediate-yellow)

## 📋 Overview

API reference for the Interactive Demo framework used throughout the Cloud Scale Analytics documentation. These APIs enable developers to create custom interactive demos, code playgrounds, and hands-on tutorials.

## 🏗️ Core API Components

### InteractiveDemo Class

Base class for all interactive demonstrations.

```typescript
class InteractiveDemo {
  constructor(config: DemoConfig);
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
  dispose(): void;
}
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `DemoConfig` | Yes | Demo configuration object |

**Methods:**

- `initialize()` - Setup demo environment and resources
- `start()` - Begin demo execution
- `stop()` - Pause/stop demo execution
- `reset()` - Reset demo to initial state
- `dispose()` - Clean up resources

### DemoConfig Interface

```typescript
interface DemoConfig {
  containerId: string;
  title: string;
  description?: string;
  theme?: 'light' | 'dark' | 'auto';
  autoStart?: boolean;
  analytics?: boolean;
  accessibility?: {
    announceChanges?: boolean;
    keyboardNav?: boolean;
  };
  azure?: AzureConfig;
}
```

### AzureConfig Interface

```typescript
interface AzureConfig {
  subscriptionId?: string;
  resourceGroup?: string;
  workspace?: string;
  useSimulation?: boolean;
  credentials?: {
    type: 'managed-identity' | 'service-principal' | 'demo';
    clientId?: string;
    tenantId?: string;
  };
}
```

## 🎯 Demo Types

### Code Playground API

Create interactive code execution environments.

```typescript
import { CodePlayground } from '@csa/interactive-demos';

const playground = new CodePlayground({
  containerId: 'playground-container',
  language: 'python' | 'sql' | 'scala',
  runtime: 'spark' | 'synapse-sql' | 'local',
  theme: 'vs-dark',
  editorOptions: {
    fontSize: 14,
    minimap: { enabled: false },
    lineNumbers: 'on'
  }
});

await playground.initialize();
```

**CodePlayground Methods:**

```typescript
class CodePlayground extends InteractiveDemo {
  // Code execution
  executeCode(code: string): Promise<ExecutionResult>;
  executeCell(cellId: string): Promise<ExecutionResult>;

  // Editor control
  setCode(code: string): void;
  getCode(): string;
  insertCode(code: string, position?: number): void;

  // Output handling
  clearOutput(): void;
  appendOutput(content: string, type?: OutputType): void;

  // State management
  saveState(): PlaygroundState;
  loadState(state: PlaygroundState): void;
}
```

**Example Usage:**

```typescript
// Initialize Python Spark playground
const sparkPlayground = new CodePlayground({
  containerId: 'spark-demo',
  language: 'python',
  runtime: 'spark',
  azure: {
    workspace: 'demo-synapse',
    useSimulation: true
  }
});

await sparkPlayground.initialize();

// Execute code
const result = await sparkPlayground.executeCode(`
from pyspark.sql import SparkSession
spark = SparkSession.builder.appName("Demo").getOrCreate()
df = spark.read.parquet("data/sample.parquet")
df.show()
`);

console.log(result.output);
```

### Query Playground API

Interactive SQL query environment.

```typescript
import { QueryPlayground } from '@csa/interactive-demos';

const queryPlayground = new QueryPlayground({
  containerId: 'query-container',
  queryEngine: 'serverless-sql' | 'dedicated-sql' | 'spark-sql',
  database: string,
  schema?: string,
  features: {
    autoComplete: true,
    syntaxHighlight: true,
    queryHistory: true,
    executionPlan: true
  }
});
```

**QueryPlayground Methods:**

```typescript
class QueryPlayground extends InteractiveDemo {
  // Query execution
  executeQuery(sql: string): Promise<QueryResult>;
  explainQuery(sql: string): Promise<QueryPlan>;

  // Schema exploration
  listTables(): Promise<Table[]>;
  describeTable(tableName: string): Promise<TableSchema>;

  // Query history
  getHistory(): Query[];
  saveQuery(name: string, query: string): void;

  // Performance
  analyzePerformance(sql: string): Promise<PerformanceMetrics>;
}
```

### Architecture Explorer API

Interactive architecture visualization.

```typescript
import { ArchitectureExplorer } from '@csa/interactive-demos';

const explorer = new ArchitectureExplorer({
  containerId: 'architecture-container',
  architecture: 'delta-lakehouse' | 'serverless-sql' | 'custom',
  interactive: true,
  components: ComponentConfig[],
  connections: ConnectionConfig[]
});

await explorer.initialize();
```

**ArchitectureExplorer Methods:**

```typescript
class ArchitectureExplorer extends InteractiveDemo {
  // Component management
  addComponent(component: Component): void;
  removeComponent(componentId: string): void;
  updateComponent(componentId: string, updates: Partial<Component>): void;

  // Connection management
  addConnection(from: string, to: string, config?: ConnectionConfig): void;
  removeConnection(connectionId: string): void;

  // Visualization
  zoomTo(componentId: string, level?: number): void;
  highlightPath(from: string, to: string): void;

  // Validation
  validateArchitecture(): ValidationResult;
  suggestImprovements(): Suggestion[];

  // Export
  exportArchitecture(format: 'json' | 'arm' | 'bicep' | 'terraform'): string;
}
```

## 🧮 Calculator API

Cost and resource calculators.

```typescript
import { Calculator } from '@csa/interactive-demos';

const costCalculator = new Calculator({
  containerId: 'calculator-container',
  type: 'cost' | 'performance' | 'capacity',
  region: 'eastus',
  pricing: {
    source: 'azure-retail-api',
    currency: 'USD'
  }
});
```

**Calculator Methods:**

```typescript
class Calculator extends InteractiveDemo {
  // Calculation
  calculate(inputs: CalculatorInputs): CalculationResult;
  recalculate(): CalculationResult;

  // Input management
  setInput(key: string, value: number | string): void;
  getInput(key: string): number | string;
  resetInputs(): void;

  // Results
  getBreakdown(): CostBreakdown | PerformanceBreakdown;
  exportResults(format: 'json' | 'csv' | 'pdf'): string;

  // Recommendations
  getRecommendations(): Recommendation[];
  optimizeConfiguration(): OptimizedConfig;
}
```

**Example - Cost Calculator:**

```typescript
const costCalc = new Calculator({
  containerId: 'cost-calc',
  type: 'cost',
  region: 'eastus'
});

costCalc.setInput('serverlessSqlDataProcessedTB', 10);
costCalc.setInput('dedicatedSqlDWU', 1000);
costCalc.setInput('dedicatedSqlHours', 720);
costCalc.setInput('sparkPoolSize', 'medium');
costCalc.setInput('sparkPoolNodes', 5);

const result = costCalc.calculate();
console.log(`Monthly Cost: $${result.totalCost.toFixed(2)}`);
console.log('Breakdown:', result.breakdown);
```

## 📊 Data Visualization API

Interactive charts and data visualization.

```typescript
import { DataVisualizer } from '@csa/interactive-demos';

const visualizer = new DataVisualizer({
  containerId: 'viz-container',
  type: 'chart' | 'graph' | 'diagram',
  library: 'd3' | 'plotly' | 'chart-js',
  responsive: true
});
```

**DataVisualizer Methods:**

```typescript
class DataVisualizer extends InteractiveDemo {
  // Data management
  setData(data: Dataset): void;
  updateData(updates: Partial<Dataset>): void;

  // Visualization
  render(config: VisualizationConfig): void;
  update(config: Partial<VisualizationConfig>): void;

  // Interaction
  highlight(dataPoints: string[]): void;
  filter(predicate: (item: DataPoint) => boolean): void;
  zoom(range: [number, number]): void;

  // Export
  exportImage(format: 'png' | 'svg'): Blob;
  exportData(format: 'json' | 'csv'): string;
}
```

## 🎮 Interactive Components

### Wizard Component

Step-by-step guided workflows.

```typescript
import { Wizard } from '@csa/interactive-demos';

const setupWizard = new Wizard({
  containerId: 'wizard-container',
  steps: [
    {
      id: 'step1',
      title: 'Environment Setup',
      component: EnvironmentSetupStep,
      validation: async (data) => validateEnvironment(data)
    },
    {
      id: 'step2',
      title: 'Configuration',
      component: ConfigurationStep,
      validation: async (data) => validateConfig(data)
    }
  ],
  allowSkip: false,
  showProgress: true
});
```

### Sandbox Environment

Isolated execution environment for testing.

```typescript
import { Sandbox } from '@csa/interactive-demos';

const sandbox = new Sandbox({
  containerId: 'sandbox-container',
  runtime: 'python' | 'sql' | 'shell',
  isolation: 'process' | 'container' | 'simulation',
  resources: {
    memory: '512MB',
    cpu: '1 core',
    timeout: 30000 // ms
  },
  files: {
    readOnly: ['data/sample.csv'],
    writable: ['output/']
  }
});

await sandbox.initialize();
const result = await sandbox.execute('print("Hello Azure")');
```

## 🔒 Security & Authentication

### Azure Authentication

```typescript
import { AzureAuth } from '@csa/interactive-demos';

// Managed Identity (recommended)
const auth = new AzureAuth({
  type: 'managed-identity'
});

// Service Principal
const auth = new AzureAuth({
  type: 'service-principal',
  credentials: {
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    tenantId: process.env.AZURE_TENANT_ID
  }
});

// Demo Mode (sandbox only)
const auth = new AzureAuth({
  type: 'demo',
  permissions: ['read-only']
});

await auth.authenticate();
const token = await auth.getToken();
```

## 📡 Event System

Subscribe to demo events for custom behavior.

```typescript
// Event types
type DemoEvent =
  | 'initialized'
  | 'started'
  | 'stopped'
  | 'reset'
  | 'error'
  | 'state-changed'
  | 'execution-started'
  | 'execution-completed'
  | 'execution-failed';

// Subscribe to events
demo.on('execution-completed', (result: ExecutionResult) => {
  console.log('Execution finished:', result);
});

demo.on('error', (error: Error) => {
  console.error('Demo error:', error);
});

// Emit custom events
demo.emit('custom-event', { data: 'value' });
```

## 🎨 Theming & Customization

```typescript
interface ThemeConfig {
  colors: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    border: string;
  };
  fonts: {
    body: string;
    code: string;
  };
  spacing: {
    small: string;
    medium: string;
    large: string;
  };
}

// Apply custom theme
demo.setTheme({
  colors: {
    primary: '#0078D4',
    secondary: '#50E6FF',
    background: '#FFFFFF',
    text: '#323130',
    border: '#EDEBE9'
  }
});
```

## 📊 Analytics Integration

```typescript
interface AnalyticsConfig {
  enabled: boolean;
  provider: 'azure-app-insights' | 'google-analytics' | 'custom';
  trackingId?: string;
  events: {
    trackPageviews: boolean;
    trackInteractions: boolean;
    trackErrors: boolean;
  };
}

// Configure analytics
demo.configureAnalytics({
  enabled: true,
  provider: 'azure-app-insights',
  trackingId: process.env.APPINSIGHTS_KEY,
  events: {
    trackPageviews: true,
    trackInteractions: true,
    trackErrors: true
  }
});
```

## 🧪 Testing

```typescript
import { DemoTester } from '@csa/interactive-demos/testing';

describe('Interactive Demo', () => {
  let demo: InteractiveDemo;
  let tester: DemoTester;

  beforeEach(async () => {
    demo = new CodePlayground({ containerId: 'test-container' });
    tester = new DemoTester(demo);
    await tester.initialize();
  });

  test('executes code successfully', async () => {
    const result = await tester.executeCode('print("test")');
    expect(result.success).toBe(true);
    expect(result.output).toContain('test');
  });

  afterEach(async () => {
    await tester.cleanup();
  });
});
```

## 📚 Related Resources

- [Interactive Demos Index](../README.md)
- [Component Library](../components/README.md)
- Development Guide
- [Examples](../../../06-code-examples/README.md)

## 📦 Installation

```bash
# NPM
npm install @csa/interactive-demos

# Yarn
yarn add @csa/interactive-demos

# Azure-hosted CDN
<script src="https://cdn.csa.azure.com/demos/v1/interactive-demos.min.js"></script>
```

## 🔗 API Reference

- [TypeScript Definitions](https://cdn.csa.azure.com/demos/types/index.d.ts)
- [API Documentation](https://docs.csa.azure.com/api/interactive-demos)
- [GitHub Repository](https://github.com/csa-inabox/interactive-demos)

---

*Last Updated: January 2025 | Version: 1.0.0*
