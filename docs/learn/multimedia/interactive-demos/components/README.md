# 🧩 Interactive Demo Components

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Component Library](https://img.shields.io/badge/Type-Component_Library-blue)
![Components: 25+](https://img.shields.io/badge/Components-25+-purple)

## 📋 Overview

Reusable component library for building interactive demos and code playgrounds in the Cloud Scale Analytics documentation. All components are designed for Azure-first architectures and follow accessibility best practices.

## 🎯 Component Categories

### 📝 Input Components

#### CodeEditor

Monaco-based code editor with Azure Synapse syntax highlighting.

```typescript
import { CodeEditor } from '@csa/demo-components';

const editor = new CodeEditor({
  container: '#editor',
  language: 'python' | 'sql' | 'scala' | 'csharp',
  theme: 'vs-dark' | 'vs-light' | 'azure',
  readOnly: false,
  minimap: true,
  lineNumbers: true,
  initialValue: '# Enter your code here'
});

editor.on('change', (value) => {
  console.log('Code changed:', value);
});
```

**Features:**
- Syntax highlighting for Spark, SQL, Python
- IntelliSense and code completion
- Error detection and linting
- Multiple themes
- Keyboard shortcuts

#### QueryBuilder

Visual query builder for SQL queries.

```typescript
import { QueryBuilder } from '@csa/demo-components';

const builder = new QueryBuilder({
  container: '#query-builder',
  database: 'sample_db',
  tables: ['sales', 'customers', 'products'],
  mode: 'visual' | 'sql' | 'both'
});

builder.on('query-built', (sql) => {
  console.log('Generated SQL:', sql);
});
```

#### ParameterPanel

Input panel for demo parameters and configuration.

```typescript
import { ParameterPanel } from '@csa/demo-components';

const panel = new ParameterPanel({
  container: '#params',
  parameters: [
    {
      name: 'dataSize',
      label: 'Data Size (GB)',
      type: 'slider',
      min: 1,
      max: 100,
      default: 10,
      step: 1
    },
    {
      name: 'region',
      label: 'Azure Region',
      type: 'select',
      options: ['eastus', 'westus', 'westeurope'],
      default: 'eastus'
    },
    {
      name: 'enableCaching',
      label: 'Enable Caching',
      type: 'checkbox',
      default: true
    }
  ]
});

const values = panel.getValues();
```

### 📊 Display Components

#### ResultsGrid

Data grid for displaying query results.

```typescript
import { ResultsGrid } from '@csa/demo-components';

const grid = new ResultsGrid({
  container: '#results',
  columns: [
    { field: 'id', headerName: 'ID', width: 100 },
    { field: 'name', headerName: 'Name', width: 200 },
    { field: 'value', headerName: 'Value', width: 150, type: 'number' }
  ],
  features: {
    sorting: true,
    filtering: true,
    pagination: true,
    export: ['csv', 'json', 'excel']
  }
});

grid.setData(results);
```

#### MetricsDisplay

Real-time metrics visualization.

```typescript
import { MetricsDisplay } from '@csa/demo-components';

const metrics = new MetricsDisplay({
  container: '#metrics',
  metrics: [
    {
      name: 'Execution Time',
      value: '2.5s',
      icon: 'timer',
      trend: 'down',
      trendValue: '-15%'
    },
    {
      name: 'Data Processed',
      value: '1.2 TB',
      icon: 'database',
      trend: 'up',
      trendValue: '+23%'
    }
  ],
  layout: 'horizontal' | 'vertical' | 'grid'
});
```

#### ChartViewer

Interactive chart visualization.

```typescript
import { ChartViewer } from '@csa/demo-components';

const chart = new ChartViewer({
  container: '#chart',
  type: 'line' | 'bar' | 'pie' | 'scatter',
  data: {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
    datasets: [{
      label: 'Sales',
      data: [12, 19, 3, 5, 2],
      backgroundColor: '#0078D4'
    }]
  },
  options: {
    responsive: true,
    animation: true,
    legend: { display: true }
  }
});
```

#### ExecutionPlan

Visual query execution plan viewer.

```typescript
import { ExecutionPlan } from '@csa/demo-components';

const planViewer = new ExecutionPlan({
  container: '#plan',
  plan: executionPlanData,
  interactive: true,
  showMetrics: true,
  highlightBottlenecks: true
});

planViewer.on('node-click', (node) => {
  console.log('Clicked node:', node);
});
```

### 🏗️ Architecture Components

#### DiagramCanvas

Interactive architecture diagram canvas.

```typescript
import { DiagramCanvas } from '@csa/demo-components';

const canvas = new DiagramCanvas({
  container: '#diagram',
  width: 1200,
  height: 800,
  grid: true,
  snap: true,
  zoom: true
});

// Add components
canvas.addComponent({
  id: 'synapse',
  type: 'azure-synapse',
  position: { x: 100, y: 100 },
  properties: {
    name: 'Synapse Workspace',
    region: 'eastus'
  }
});

// Add connections
canvas.addConnection({
  from: 'datalake',
  to: 'synapse',
  type: 'data-flow',
  label: 'Ingestion'
});
```

#### ResourceIcon

Azure resource icon with tooltip.

```typescript
import { ResourceIcon } from '@csa/demo-components';

const icon = new ResourceIcon({
  container: '#icon',
  resource: 'azure-synapse' | 'data-lake' | 'spark-pool',
  size: 'small' | 'medium' | 'large',
  label: 'Azure Synapse Analytics',
  tooltip: {
    title: 'Azure Synapse Analytics',
    description: 'Unified analytics platform',
    showOnHover: true
  }
});
```

#### FlowDiagram

Animated data flow visualization.

```typescript
import { FlowDiagram } from '@csa/demo-components';

const flow = new FlowDiagram({
  container: '#flow',
  nodes: [
    { id: 'source', label: 'Data Source', type: 'input' },
    { id: 'process', label: 'Processing', type: 'process' },
    { id: 'sink', label: 'Destination', type: 'output' }
  ],
  edges: [
    { from: 'source', to: 'process', animated: true },
    { from: 'process', to: 'sink', animated: true }
  ]
});

flow.start(); // Start animation
```

### 🎛️ Control Components

#### ToolBar

Customizable toolbar with actions.

```typescript
import { ToolBar } from '@csa/demo-components';

const toolbar = new ToolBar({
  container: '#toolbar',
  actions: [
    {
      id: 'run',
      icon: 'play',
      label: 'Run',
      shortcut: 'Ctrl+Enter',
      onClick: () => executeCode()
    },
    {
      id: 'stop',
      icon: 'stop',
      label: 'Stop',
      disabled: true
    },
    {
      id: 'clear',
      icon: 'trash',
      label: 'Clear Output'
    }
  ],
  separator: [1, 2] // Add separators after indices
});
```

#### ProgressIndicator

Progress bar and status indicator.

```typescript
import { ProgressIndicator } from '@csa/demo-components';

const progress = new ProgressIndicator({
  container: '#progress',
  type: 'linear' | 'circular' | 'determinate',
  label: 'Processing data...',
  showPercentage: true,
  cancelable: true
});

progress.setProgress(45); // 45%
progress.setStatus('Analyzing results...');
```

#### TabPanel

Tabbed interface for organizing content.

```typescript
import { TabPanel } from '@csa/demo-components';

const tabs = new TabPanel({
  container: '#tabs',
  tabs: [
    {
      id: 'code',
      label: 'Code',
      icon: 'code',
      content: codeEditorElement
    },
    {
      id: 'results',
      label: 'Results',
      icon: 'table',
      content: resultsGridElement
    },
    {
      id: 'plan',
      label: 'Execution Plan',
      icon: 'diagram',
      content: executionPlanElement
    }
  ],
  activeTab: 'code'
});
```

### 📋 Wizard Components

#### StepIndicator

Visual progress indicator for multi-step workflows.

```typescript
import { StepIndicator } from '@csa/demo-components';

const steps = new StepIndicator({
  container: '#steps',
  steps: [
    { id: 'setup', label: 'Setup', status: 'completed' },
    { id: 'config', label: 'Configuration', status: 'current' },
    { id: 'deploy', label: 'Deployment', status: 'pending' },
    { id: 'verify', label: 'Verification', status: 'pending' }
  ],
  orientation: 'horizontal' | 'vertical'
});
```

#### ValidationPanel

Input validation with feedback.

```typescript
import { ValidationPanel } from '@csa/demo-components';

const validator = new ValidationPanel({
  container: '#validation',
  rules: [
    {
      field: 'workspaceName',
      label: 'Workspace Name',
      validations: [
        { type: 'required', message: 'Name is required' },
        { type: 'minLength', value: 3, message: 'Minimum 3 characters' },
        { type: 'pattern', value: /^[a-z0-9-]+$/, message: 'Only lowercase, numbers, hyphens' }
      ]
    }
  ]
});

const isValid = validator.validate();
const errors = validator.getErrors();
```

### 💡 Helper Components

#### TooltipProvider

Context-sensitive tooltips.

```typescript
import { TooltipProvider } from '@csa/demo-components';

const tooltips = new TooltipProvider({
  placement: 'top' | 'bottom' | 'left' | 'right',
  delay: 500,
  maxWidth: 300
});

tooltips.attach('#element', {
  title: 'Spark Pool',
  content: 'Apache Spark pool for big data processing',
  footer: 'Click for more info'
});
```

#### ErrorDisplay

Error message display with details.

```typescript
import { ErrorDisplay } from '@csa/demo-components';

const errorDisplay = new ErrorDisplay({
  container: '#error',
  type: 'error' | 'warning' | 'info',
  dismissible: true,
  actions: [
    {
      label: 'Retry',
      onClick: () => retryOperation()
    },
    {
      label: 'View Details',
      onClick: () => showDetails()
    }
  ]
});

errorDisplay.show({
  title: 'Execution Failed',
  message: 'Query execution encountered an error',
  details: error.stack
});
```

#### LoadingSpinner

Loading indicator.

```typescript
import { LoadingSpinner } from '@csa/demo-components';

const spinner = new LoadingSpinner({
  container: '#loading',
  size: 'small' | 'medium' | 'large',
  type: 'spinner' | 'dots' | 'pulse',
  label: 'Loading data...',
  overlay: true
});

spinner.show();
// ... async operation ...
spinner.hide();
```

## 🎨 Theming

All components support theming:

```typescript
import { ThemeProvider } from '@csa/demo-components';

ThemeProvider.setTheme({
  name: 'azure-light',
  colors: {
    primary: '#0078D4',
    secondary: '#50E6FF',
    success: '#107C10',
    warning: '#FFB900',
    error: '#D13438',
    background: '#FFFFFF',
    surface: '#F5F5F5',
    text: '#323130',
    textSecondary: '#605E5C',
    border: '#EDEBE9'
  },
  fonts: {
    body: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
    code: 'Consolas, "Courier New", monospace'
  },
  borderRadius: '4px',
  shadows: {
    small: '0 2px 4px rgba(0,0,0,0.1)',
    medium: '0 4px 8px rgba(0,0,0,0.15)',
    large: '0 8px 16px rgba(0,0,0,0.2)'
  }
});
```

## ♿ Accessibility

All components follow WCAG 2.1 Level AA standards:

- Keyboard navigation support
- Screen reader compatibility
- Focus management
- ARIA labels and roles
- Color contrast compliance

```typescript
// Enable accessibility features
component.setAccessibility({
  keyboardNav: true,
  screenReaderAnnouncements: true,
  focusManagement: true,
  highContrast: 'auto' // auto, enabled, disabled
});
```

## 📦 Installation

```bash
# NPM
npm install @csa/demo-components

# Yarn
yarn add @csa/demo-components

# CDN
<script src="https://cdn.csa.azure.com/components/v1/demo-components.min.js"></script>
<link rel="stylesheet" href="https://cdn.csa.azure.com/components/v1/demo-components.css">
```

## 🧪 Component Testing

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeEditor } from '@csa/demo-components';

test('code editor updates on change', () => {
  const onChange = jest.fn();
  render(<CodeEditor onChange={onChange} />);

  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'print("test")' } });

  expect(onChange).toHaveBeenCalledWith('print("test")');
});
```

## 📚 Related Resources

- [API Reference](../api/README.md)
- [Interactive Demos](../README.md)
- [Theming Guide](../../production-guide/brand-guidelines.md)
- [Accessibility Standards](../../production-guide/accessibility-standards.md)

## 🔗 Component Gallery

View live component examples: [Component Gallery](https://docs.csa.azure.com/components/gallery)

---

*Last Updated: January 2025 | Version: 1.0.0*
