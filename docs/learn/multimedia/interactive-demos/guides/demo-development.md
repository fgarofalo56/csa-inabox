# 🛠️ Interactive Demo Development Guide

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Guide](https://img.shields.io/badge/Type-Guide-blue)
![Complexity: Intermediate](https://img.shields.io/badge/Complexity-Intermediate-yellow)

## 📋 Overview

Comprehensive guide for developing interactive demonstrations and code playgrounds for the CSA-in-a-Box documentation. This guide covers architecture, implementation patterns, best practices, and deployment workflows for creating engaging, educational interactive experiences.

## 🎯 Demo Types

### 1. Code Playgrounds

Interactive coding environments where users can write, execute, and experiment with code.

**Examples:**
- SQL Query Playground
- Spark Notebook Sandbox
- Python/PySpark Editor

**Key Features:**
- Syntax highlighting
- Code execution
- Error handling
- Result visualization
- Code sharing/export

### 2. Configuration Wizards

Step-by-step guided experiences for configuring Azure services.

**Examples:**
- Security Configuration Wizard
- Migration Assessment Wizard
- Workspace Setup Wizard

**Key Features:**
- Multi-step workflow
- Validation at each step
- Progress tracking
- Configuration export
- Save/resume capability

### 3. Visual Builders

Drag-and-drop interfaces for designing architectures and workflows.

**Examples:**
- Pipeline Builder
- Data Flow Designer
- Architecture Explorer

**Key Features:**
- Visual canvas
- Component library
- Connection validation
- Auto-layout
- Code generation

### 4. Calculators & Planners

Tools for estimation, planning, and optimization.

**Examples:**
- Cost Calculator
- Resource Planner
- Performance Optimizer

**Key Features:**
- Real-time calculations
- Interactive sliders/inputs
- Visual feedback
- Export results
- Comparison views

### 5. Interactive Visualizations

Dynamic diagrams and visualizations that respond to user input.

**Examples:**
- Data Lineage Explorer
- Monitoring Dashboard Builder
- Schema Designer

**Key Features:**
- Interactive graphics
- Zoom/pan capabilities
- Filtering/searching
- Export/share
- Animation

## 🏗️ Architecture

### Technology Stack

#### Frontend Framework

```javascript
// Recommended: Vanilla JavaScript or lightweight frameworks
// For complex demos, consider React or Vue.js

// Vanilla JS Example Structure
const DemoApp = {
  state: {},
  config: {},
  components: {},

  init() {
    this.setupState();
    this.renderComponents();
    this.attachEventListeners();
  },

  setupState() {
    this.state = {
      // Initialize state
    };
  },

  renderComponents() {
    // Render UI
  },

  attachEventListeners() {
    // Bind events
  }
};
```

#### Component Library

```javascript
// Reusable component base class
class DemoComponent {
  constructor(container, config = {}) {
    this.container = container;
    this.config = {
      theme: 'light',
      responsive: true,
      accessibility: true,
      ...config
    };
    this.state = {};
  }

  // Lifecycle methods
  async init() {
    await this.setup();
    this.render();
    this.attachListeners();
    this.onReady();
  }

  setup() {
    // Initialize component
  }

  render() {
    // Render UI
    this.container.innerHTML = this.template();
  }

  template() {
    // Return HTML template
    return `<div class="demo-component"></div>`;
  }

  attachListeners() {
    // Attach event listeners
  }

  onReady() {
    // Component ready callback
  }

  setState(newState) {
    this.state = { ...this.state, ...newState };
    this.render();
  }

  destroy() {
    // Cleanup
    this.container.innerHTML = '';
  }
}
```

#### Styling Framework

```css
/* CSS Variables for theming */
:root {
  /* Azure theme colors */
  --azure-primary: #0078D4;
  --azure-primary-dark: #004578;
  --azure-secondary: #50E6FF;
  --azure-success: #107C10;
  --azure-warning: #CA5010;
  --azure-error: #D13438;

  /* Neutral colors */
  --gray-10: #FAF9F8;
  --gray-20: #F3F2F1;
  --gray-30: #EDEBE9;
  --gray-40: #E1DFDD;
  --gray-50: #D2D0CE;
  --gray-60: #C8C6C4;
  --gray-70: #A19F9D;
  --gray-80: #605E5C;
  --gray-90: #323130;
  --gray-100: #201F1E;

  /* Typography */
  --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-size-base: 16px;
  --line-height-base: 1.5;

  /* Spacing */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2rem;
  --spacing-xxl: 3rem;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);

  /* Border radius */
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 8px;

  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-base: 250ms ease;
  --transition-slow: 350ms ease;
}

/* Dark theme */
[data-theme="dark"] {
  --gray-10: #201F1E;
  --gray-20: #323130;
  --gray-30: #605E5C;
  --gray-90: #F3F2F1;
  --gray-100: #FAF9F8;
}

/* Base demo styles */
.demo-container {
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
  color: var(--gray-90);
  background: var(--gray-10);
  padding: var(--spacing-xl);
  border-radius: var(--radius-lg);
}

.demo-header {
  margin-bottom: var(--spacing-lg);
  padding-bottom: var(--spacing-md);
  border-bottom: 1px solid var(--gray-30);
}

.demo-content {
  display: grid;
  gap: var(--spacing-lg);
}

.demo-footer {
  margin-top: var(--spacing-xl);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--gray-30);
}
```

### State Management

```javascript
// Simple state manager for demos
class StateManager {
  constructor(initialState = {}) {
    this.state = initialState;
    this.listeners = [];
    this.history = [initialState];
    this.historyIndex = 0;
  }

  getState() {
    return { ...this.state };
  }

  setState(updates) {
    const newState = { ...this.state, ...updates };

    // Add to history
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(newState);
    this.historyIndex++;

    // Update state
    this.state = newState;

    // Notify listeners
    this.listeners.forEach(listener => listener(this.state));

    return this.state;
  }

  subscribe(listener) {
    this.listeners.push(listener);

    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.state = this.history[this.historyIndex];
      this.listeners.forEach(listener => listener(this.state));
      return true;
    }
    return false;
  }

  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.state = this.history[this.historyIndex];
      this.listeners.forEach(listener => listener(this.state));
      return true;
    }
    return false;
  }

  reset() {
    this.state = this.history[0];
    this.historyIndex = 0;
    this.listeners.forEach(listener => listener(this.state));
  }
}

// Usage example
const demoState = new StateManager({
  nodeSize: 'medium',
  nodeCount: 5,
  autoscaling: true,
  estimatedCost: 0
});

// Subscribe to changes
demoState.subscribe((state) => {
  console.log('State updated:', state);
  updateUI(state);
});

// Update state
demoState.setState({ nodeCount: 10 });
demoState.setState({ estimatedCost: 2350 });

// Undo/redo
demoState.undo();
demoState.redo();
```

### Event System

```javascript
// Custom event emitter for demo components
class EventEmitter {
  constructor() {
    this.events = {};
  }

  on(event, callback) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(callback);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (!this.events[event]) return;

    this.events[event] = this.events[event].filter(cb => cb !== callback);
  }

  emit(event, data) {
    if (!this.events[event]) return;

    this.events[event].forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event handler for "${event}":`, error);
      }
    });
  }

  once(event, callback) {
    const wrapper = (data) => {
      callback(data);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }
}

// Usage in demo components
class CostCalculator extends EventEmitter {
  constructor() {
    super();
    this.state = {
      serverlessData: 10,
      dedicatedHours: 720,
      sparkNodes: 5
    };
  }

  updateServerlessData(value) {
    this.state.serverlessData = value;
    const cost = this.calculateCost();
    this.emit('costUpdated', { type: 'serverless', cost });
  }

  calculateCost() {
    // Calculation logic
    const total = this.calculateServerlessCost() +
                  this.calculateDedicatedCost() +
                  this.calculateSparkCost();

    this.emit('totalCostUpdated', { total });
    return total;
  }
}

// Using the calculator
const calculator = new CostCalculator();

calculator.on('costUpdated', (data) => {
  console.log(`${data.type} cost: $${data.cost}`);
});

calculator.on('totalCostUpdated', (data) => {
  document.getElementById('total-cost').textContent = `$${data.total}`;
});
```

## 🎨 UI Patterns

### Interactive Controls

```html
<!-- Slider with live feedback -->
<div class="control-group">
  <label for="node-count">
    <span class="control-label">Node Count</span>
    <span class="control-value" id="node-count-value">5</span>
  </label>
  <input
    type="range"
    id="node-count"
    min="3"
    max="50"
    value="5"
    step="1"
    class="slider"
    aria-valuemin="3"
    aria-valuemax="50"
    aria-valuenow="5"
  />
  <div class="slider-markers">
    <span>3</span>
    <span>25</span>
    <span>50</span>
  </div>
</div>

<script>
const slider = document.getElementById('node-count');
const valueDisplay = document.getElementById('node-count-value');

slider.addEventListener('input', (e) => {
  const value = e.target.value;
  valueDisplay.textContent = value;
  slider.setAttribute('aria-valuenow', value);

  // Trigger recalculation
  updateEstimate({ nodeCount: parseInt(value) });
});
</script>
```

### Progress Indicators

```javascript
// Multi-step wizard with progress
class WizardProgress {
  constructor(container, steps) {
    this.container = container;
    this.steps = steps;
    this.currentStep = 0;
  }

  render() {
    const html = `
      <div class="wizard-progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${this.getProgress()}%"></div>
        </div>
        <div class="progress-steps">
          ${this.steps.map((step, index) => `
            <div class="progress-step ${this.getStepClass(index)}">
              <div class="step-marker">
                ${index < this.currentStep ? '✓' : index + 1}
              </div>
              <div class="step-label">${step}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    this.container.innerHTML = html;
  }

  getStepClass(index) {
    if (index < this.currentStep) return 'completed';
    if (index === this.currentStep) return 'active';
    return 'pending';
  }

  getProgress() {
    return (this.currentStep / (this.steps.length - 1)) * 100;
  }

  next() {
    if (this.currentStep < this.steps.length - 1) {
      this.currentStep++;
      this.render();
    }
  }

  previous() {
    if (this.currentStep > 0) {
      this.currentStep--;
      this.render();
    }
  }

  goToStep(step) {
    if (step >= 0 && step < this.steps.length) {
      this.currentStep = step;
      this.render();
    }
  }
}
```

### Loading States

```javascript
// Loading indicator component
class LoadingIndicator {
  constructor(container) {
    this.container = container;
  }

  show(message = 'Loading...') {
    const html = `
      <div class="loading-overlay" role="status" aria-live="polite">
        <div class="loading-spinner"></div>
        <p class="loading-message">${message}</p>
      </div>
    `;

    this.overlay = document.createElement('div');
    this.overlay.innerHTML = html;
    this.container.appendChild(this.overlay);
  }

  hide() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  updateMessage(message) {
    const messageEl = this.overlay?.querySelector('.loading-message');
    if (messageEl) {
      messageEl.textContent = message;
    }
  }
}

// Usage
const loader = new LoadingIndicator(document.body);

async function executeLongRunningTask() {
  loader.show('Initializing Spark session...');

  try {
    await initialize();
    loader.updateMessage('Loading data...');
    await loadData();
    loader.updateMessage('Processing...');
    await process();
  } finally {
    loader.hide();
  }
}
```

### Error Handling UI

```javascript
// Error notification system
class NotificationManager {
  constructor() {
    this.container = this.createContainer();
    this.notifications = [];
  }

  createContainer() {
    const container = document.createElement('div');
    container.className = 'notification-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
    return container;
  }

  show(message, type = 'info', duration = 5000) {
    const notification = {
      id: Date.now(),
      message,
      type,
      duration
    };

    this.notifications.push(notification);
    this.render();

    if (duration > 0) {
      setTimeout(() => this.dismiss(notification.id), duration);
    }

    return notification.id;
  }

  dismiss(id) {
    this.notifications = this.notifications.filter(n => n.id !== id);
    this.render();
  }

  render() {
    const html = this.notifications.map(n => `
      <div class="notification notification-${n.type}" role="alert">
        <div class="notification-content">
          <span class="notification-icon">${this.getIcon(n.type)}</span>
          <p class="notification-message">${n.message}</p>
        </div>
        <button
          class="notification-close"
          onclick="notificationManager.dismiss(${n.id})"
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
    `).join('');

    this.container.innerHTML = html;
  }

  getIcon(type) {
    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ'
    };
    return icons[type] || icons.info;
  }

  success(message, duration) {
    return this.show(message, 'success', duration);
  }

  error(message, duration = 0) {
    return this.show(message, 'error', duration);
  }

  warning(message, duration) {
    return this.show(message, 'warning', duration);
  }

  info(message, duration) {
    return this.show(message, 'info', duration);
  }
}

// Global instance
const notificationManager = new NotificationManager();

// Usage
notificationManager.success('Configuration saved successfully');
notificationManager.error('Failed to connect to Spark cluster');
notificationManager.warning('This operation may take several minutes');
```

## 🔌 Integration Patterns

### Azure SDK Integration

```javascript
// Azure service integration example
class AzureSynapseClient {
  constructor(config) {
    this.endpoint = config.endpoint;
    this.apiVersion = config.apiVersion || '2021-06-01-preview';
    this.token = null;
  }

  async authenticate() {
    // In production, use Azure Identity SDK
    // For demo purposes, use mock authentication
    this.token = 'demo-token';
  }

  async executeQuery(query) {
    const url = `${this.endpoint}/sql/query`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          database: 'demo'
        })
      });

      if (!response.ok) {
        throw new Error(`Query failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Query execution error:', error);
      throw error;
    }
  }

  async getSparkPools() {
    // Mock data for demo
    return [
      { name: 'SparkPool1', nodeSize: 'Medium', nodes: 5 },
      { name: 'SparkPool2', nodeSize: 'Large', nodes: 10 }
    ];
  }
}

// Usage in demo
async function initializeDemo() {
  const client = new AzureSynapseClient({
    endpoint: 'https://demo.synapse.azure.com'
  });

  await client.authenticate();

  const pools = await client.getSparkPools();
  populatePoolDropdown(pools);
}
```

### Monaco Editor Integration

```html
<!-- Code editor component -->
<div id="code-editor" style="height: 400px; border: 1px solid #ddd;"></div>

<script src="https://unpkg.com/monaco-editor@latest/min/vs/loader.js"></script>
<script>
require.config({ paths: { vs: 'https://unpkg.com/monaco-editor@latest/min/vs' }});

require(['vs/editor/editor.main'], function() {
  const editor = monaco.editor.create(document.getElementById('code-editor'), {
    value: [
      'SELECT',
      '    Region,',
      '    SUM(SalesAmount) as TotalSales,',
      '    COUNT(*) as OrderCount',
      'FROM Sales',
      'WHERE OrderDate >= \'2024-01-01\'',
      'GROUP BY Region',
      'ORDER BY TotalSales DESC;'
    ].join('\n'),
    language: 'sql',
    theme: 'vs-dark',
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true
  });

  // Add custom actions
  editor.addAction({
    id: 'execute-query',
    label: 'Execute Query',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: function(ed) {
      const query = ed.getValue();
      executeQuery(query);
    }
  });

  // Validation
  monaco.editor.onDidChangeMarkers(([resource]) => {
    const markers = monaco.editor.getModelMarkers({ resource });
    if (markers.length > 0) {
      console.log('Validation errors:', markers);
    }
  });
});
</script>
```

### Chart.js Integration

```javascript
// Data visualization component
class DataVisualizer {
  constructor(canvasId) {
    this.ctx = document.getElementById(canvasId).getContext('2d');
    this.chart = null;
  }

  renderBarChart(data, options = {}) {
    if (this.chart) {
      this.chart.destroy();
    }

    this.chart = new Chart(this.ctx, {
      type: 'bar',
      data: {
        labels: data.labels,
        datasets: [{
          label: options.label || 'Data',
          data: data.values,
          backgroundColor: 'rgba(0, 120, 212, 0.6)',
          borderColor: 'rgba(0, 120, 212, 1)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true
          }
        },
        ...options
      }
    });
  }

  renderLineChart(data, options = {}) {
    if (this.chart) {
      this.chart.destroy();
    }

    this.chart = new Chart(this.ctx, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: data.datasets.map((dataset, index) => ({
          label: dataset.label,
          data: dataset.values,
          borderColor: this.getColor(index),
          backgroundColor: this.getColor(index, 0.1),
          tension: 0.1
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        ...options
      }
    });
  }

  getColor(index, alpha = 1) {
    const colors = [
      `rgba(0, 120, 212, ${alpha})`,    // Azure Blue
      `rgba(16, 124, 16, ${alpha})`,    // Green
      `rgba(202, 80, 16, ${alpha})`,    // Orange
      `rgba(209, 52, 56, ${alpha})`     // Red
    ];
    return colors[index % colors.length];
  }

  updateData(newData) {
    if (!this.chart) return;

    this.chart.data.labels = newData.labels;
    this.chart.data.datasets[0].data = newData.values;
    this.chart.update();
  }

  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }
}

// Usage
const visualizer = new DataVisualizer('myChart');

visualizer.renderBarChart({
  labels: ['North', 'South', 'East', 'West'],
  values: [12500, 19300, 8700, 15400]
}, {
  label: 'Sales by Region'
});
```

## 📦 Export & Share

### Configuration Export

```javascript
// Export demo configuration
class ConfigExporter {
  export(config, format = 'json') {
    const exporters = {
      json: this.exportJSON,
      yaml: this.exportYAML,
      arm: this.exportARM,
      bicep: this.exportBicep,
      terraform: this.exportTerraform
    };

    const exporter = exporters[format];
    if (!exporter) {
      throw new Error(`Unsupported format: ${format}`);
    }

    return exporter.call(this, config);
  }

  exportJSON(config) {
    return JSON.stringify(config, null, 2);
  }

  exportYAML(config) {
    // Simple YAML conversion
    const yamlify = (obj, indent = 0) => {
      const spaces = '  '.repeat(indent);
      return Object.entries(obj).map(([key, value]) => {
        if (typeof value === 'object' && !Array.isArray(value)) {
          return `${spaces}${key}:\n${yamlify(value, indent + 1)}`;
        } else if (Array.isArray(value)) {
          return `${spaces}${key}:\n${value.map(v =>
            `${spaces}  - ${v}`).join('\n')}`;
        } else {
          return `${spaces}${key}: ${value}`;
        }
      }).join('\n');
    };

    return yamlify(config);
  }

  exportARM(config) {
    // Generate ARM template
    return JSON.stringify({
      "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      "contentVersion": "1.0.0.0",
      "parameters": {},
      "resources": this.configToARMResources(config)
    }, null, 2);
  }

  exportBicep(config) {
    // Generate Bicep template
    let bicep = `// Generated Bicep template\n\n`;

    if (config.sparkPool) {
      bicep += `resource sparkPool 'Microsoft.Synapse/workspaces/bigDataPools@2021-06-01' = {\n`;
      bicep += `  name: '${config.sparkPool.name}'\n`;
      bicep += `  properties: {\n`;
      bicep += `    nodeSize: '${config.sparkPool.nodeSize}'\n`;
      bicep += `    nodeCount: ${config.sparkPool.nodeCount}\n`;
      bicep += `    autoscale: {\n`;
      bicep += `      enabled: ${config.sparkPool.autoscaling}\n`;
      bicep += `    }\n`;
      bicep += `  }\n`;
      bicep += `}\n`;
    }

    return bicep;
  }

  exportTerraform(config) {
    // Generate Terraform configuration
    let tf = `# Generated Terraform configuration\n\n`;

    if (config.sparkPool) {
      tf += `resource "azurerm_synapse_spark_pool" "demo" {\n`;
      tf += `  name                 = "${config.sparkPool.name}"\n`;
      tf += `  synapse_workspace_id = var.synapse_workspace_id\n`;
      tf += `  node_size            = "${config.sparkPool.nodeSize}"\n`;
      tf += `  node_count           = ${config.sparkPool.nodeCount}\n`;
      tf += `\n`;
      tf += `  auto_scale {\n`;
      tf += `    enabled = ${config.sparkPool.autoscaling}\n`;
      tf += `  }\n`;
      tf += `}\n`;
    }

    return tf;
  }

  download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
}

// Usage
const exporter = new ConfigExporter();
const config = demoState.getState();

// Export as JSON
const json = exporter.export(config, 'json');
exporter.download(json, 'synapse-config.json', 'application/json');

// Export as Bicep
const bicep = exporter.export(config, 'bicep');
exporter.download(bicep, 'synapse-config.bicep', 'text/plain');
```

### Share Functionality

```javascript
// Share demo state via URL
class ShareManager {
  encodeState(state) {
    const json = JSON.stringify(state);
    return btoa(json);
  }

  decodeState(encoded) {
    const json = atob(encoded);
    return JSON.parse(json);
  }

  generateShareURL(state) {
    const encoded = this.encodeState(state);
    const url = new URL(window.location.href);
    url.searchParams.set('config', encoded);
    return url.toString();
  }

  loadFromURL() {
    const url = new URL(window.location.href);
    const encoded = url.searchParams.get('config');

    if (encoded) {
      try {
        return this.decodeState(encoded);
      } catch (error) {
        console.error('Failed to load shared configuration:', error);
      }
    }

    return null;
  }

  copyToClipboard(text) {
    return navigator.clipboard.writeText(text)
      .then(() => {
        notificationManager.success('Link copied to clipboard');
        return true;
      })
      .catch((error) => {
        console.error('Failed to copy:', error);
        notificationManager.error('Failed to copy link');
        return false;
      });
  }

  async share(state) {
    const shareUrl = this.generateShareURL(state);

    // Use Web Share API if available
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Azure Synapse Configuration',
          text: 'Check out my Azure Synapse configuration',
          url: shareUrl
        });
        return true;
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Share failed:', error);
        }
      }
    }

    // Fallback to clipboard
    return this.copyToClipboard(shareUrl);
  }
}

// Usage
const shareManager = new ShareManager();

document.getElementById('share-btn').addEventListener('click', async () => {
  const state = demoState.getState();
  await shareManager.share(state);
});

// Load shared configuration on page load
window.addEventListener('DOMContentLoaded', () => {
  const sharedState = shareManager.loadFromURL();
  if (sharedState) {
    demoState.setState(sharedState);
    notificationManager.info('Loaded shared configuration');
  }
});
```

## 🧪 Testing

### Unit Testing

```javascript
// Unit tests for demo components
describe('StateManager', () => {
  let stateManager;

  beforeEach(() => {
    stateManager = new StateManager({ count: 0 });
  });

  test('should initialize with initial state', () => {
    expect(stateManager.getState()).toEqual({ count: 0 });
  });

  test('should update state', () => {
    stateManager.setState({ count: 5 });
    expect(stateManager.getState()).toEqual({ count: 5 });
  });

  test('should notify listeners on state change', () => {
    const listener = jest.fn();
    stateManager.subscribe(listener);
    stateManager.setState({ count: 10 });
    expect(listener).toHaveBeenCalledWith({ count: 10 });
  });

  test('should support undo', () => {
    stateManager.setState({ count: 5 });
    stateManager.setState({ count: 10 });
    stateManager.undo();
    expect(stateManager.getState()).toEqual({ count: 5 });
  });

  test('should support redo', () => {
    stateManager.setState({ count: 5 });
    stateManager.undo();
    stateManager.redo();
    expect(stateManager.getState()).toEqual({ count: 5 });
  });
});
```

### Integration Testing

```javascript
// Integration tests with Puppeteer
const puppeteer = require('puppeteer');

describe('Cost Calculator Demo', () => {
  let browser;
  let page;

  beforeAll(async () => {
    browser = await puppeteer.launch();
    page = await browser.newPage();
    await page.goto('http://localhost:8000/demos/cost-calculator');
  });

  afterAll(async () => {
    await browser.close();
  });

  test('should display default cost', async () => {
    const cost = await page.$eval('#total-cost', el => el.textContent);
    expect(cost).toBe('$2,350');
  });

  test('should update cost when slider changes', async () => {
    await page.evaluate(() => {
      document.getElementById('node-count').value = 10;
      document.getElementById('node-count').dispatchEvent(new Event('input'));
    });

    await page.waitForTimeout(100);

    const cost = await page.$eval('#total-cost', el => el.textContent);
    expect(cost).not.toBe('$2,350');
  });

  test('should be keyboard accessible', async () => {
    await page.keyboard.press('Tab');
    const focusedElement = await page.evaluate(() => document.activeElement.id);
    expect(focusedElement).toBeTruthy();
  });
});
```

## 📚 Resources

### Documentation

- [Demo Development Guide](./demo-development.md)
- [Accessibility Guidelines](./accessibility.md)
- [Performance Best Practices](./performance.md)
- [Component Library](../components/README.md)

### External Resources

- [Monaco Editor Documentation](https://microsoft.github.io/monaco-editor/)
- [Chart.js Documentation](https://www.chartjs.org/)
- [Azure SDK for JavaScript](https://docs.microsoft.com/en-us/javascript/api/overview/azure/)
- [Web Components](https://developer.mozilla.org/en-US/docs/Web/Web_Components)

---

*Last Updated: January 2025 | Version: 1.0.0*
