# ⚡ Performance Optimization for Interactive Demos

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Guide](https://img.shields.io/badge/Type-Guide-blue)
![Impact: High](https://img.shields.io/badge/Impact-High-red)

## 📋 Overview

Performance optimization guide for interactive demonstrations and code playgrounds. This guide covers techniques, patterns, and best practices for building fast, responsive, and efficient interactive experiences that maintain excellent user experience across all devices and network conditions.

## 🎯 Performance Goals

### Core Web Vitals Targets

| Metric | Target | Maximum |
|:-------|:-------|:--------|
| **First Contentful Paint (FCP)** | < 1.0s | < 1.8s |
| **Largest Contentful Paint (LCP)** | < 2.0s | < 2.5s |
| **First Input Delay (FID)** | < 50ms | < 100ms |
| **Cumulative Layout Shift (CLS)** | < 0.05 | < 0.1 |
| **Time to Interactive (TTI)** | < 3.0s | < 5.0s |
| **Total Blocking Time (TBT)** | < 150ms | < 300ms |

### Additional Metrics

- **Bundle Size**: < 200KB (gzipped)
- **Time to First Byte (TTFB)**: < 600ms
- **Speed Index**: < 3.0s
- **Frame Rate**: 60 FPS (16.67ms per frame)
- **Memory Usage**: < 50MB baseline

## 🚀 Loading Performance

### Code Splitting

```javascript
// Dynamic imports for code splitting
class DemoLoader {
  constructor() {
    this.loadedModules = new Map();
  }

  async loadModule(moduleName) {
    // Check cache first
    if (this.loadedModules.has(moduleName)) {
      return this.loadedModules.get(moduleName);
    }

    // Dynamic import
    let module;
    switch (moduleName) {
      case 'chart':
        module = await import(/* webpackChunkName: "chart" */ './chart-module.js');
        break;
      case 'editor':
        module = await import(/* webpackChunkName: "editor" */ './editor-module.js');
        break;
      case 'calculator':
        module = await import(/* webpackChunkName: "calculator" */ './calculator-module.js');
        break;
      default:
        throw new Error(`Unknown module: ${moduleName}`);
    }

    // Cache the module
    this.loadedModules.set(moduleName, module);
    return module;
  }

  async loadOnDemand(trigger, moduleName) {
    // Load module when user interacts
    trigger.addEventListener('click', async () => {
      const module = await this.loadModule(moduleName);
      module.default.init(trigger);
    }, { once: true });
  }
}

// Usage
const loader = new DemoLoader();

// Load chart library only when needed
document.getElementById('show-chart-btn').addEventListener('click', async () => {
  const { ChartVisualizer } = await loader.loadModule('chart');
  const chart = new ChartVisualizer('chart-container');
  chart.render(data);
}, { once: true });
```

### Resource Preloading

```html
<!-- Preload critical resources -->
<head>
  <!-- Preload fonts -->
  <link rel="preload" href="/fonts/segoe-ui.woff2" as="font" type="font/woff2" crossorigin>

  <!-- Preload critical CSS -->
  <link rel="preload" href="/css/demo-critical.css" as="style">

  <!-- Preload critical scripts -->
  <link rel="preload" href="/js/demo-core.js" as="script">

  <!-- DNS prefetch for external resources -->
  <link rel="dns-prefetch" href="https://cdn.jsdelivr.net">

  <!-- Preconnect to API endpoints -->
  <link rel="preconnect" href="https://api.azure.com" crossorigin>

  <!-- Critical CSS inline -->
  <style>
    /* Inline critical above-the-fold CSS */
    .demo-container { /* ... */ }
    .demo-header { /* ... */ }
  </style>

  <!-- Defer non-critical CSS -->
  <link rel="stylesheet" href="/css/demo-full.css" media="print" onload="this.media='all'">
</head>
```

### Lazy Loading

```javascript
// Lazy load images and components
class LazyLoader {
  constructor() {
    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersection(entries),
      {
        rootMargin: '50px',
        threshold: 0.01
      }
    );
  }

  observe(element) {
    this.observer.observe(element);
  }

  handleIntersection(entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        this.loadElement(entry.target);
        this.observer.unobserve(entry.target);
      }
    });
  }

  loadElement(element) {
    // Load images
    if (element.tagName === 'IMG') {
      const src = element.dataset.src;
      if (src) {
        element.src = src;
        element.removeAttribute('data-src');
      }
    }

    // Load components
    if (element.dataset.component) {
      this.loadComponent(element);
    }
  }

  async loadComponent(element) {
    const componentName = element.dataset.component;
    const module = await import(/* webpackChunkName: "[request]" */ `./components/${componentName}.js`);
    const component = new module.default(element);
    await component.init();
  }
}

// Initialize lazy loader
const lazyLoader = new LazyLoader();

// Lazy load images
document.querySelectorAll('img[data-src]').forEach(img => {
  lazyLoader.observe(img);
});

// Lazy load components
document.querySelectorAll('[data-component]').forEach(el => {
  lazyLoader.observe(el);
});
```

## 🎨 Rendering Performance

### Virtual Scrolling

```javascript
// Virtual scrolling for large lists
class VirtualScroller {
  constructor(container, items, options = {}) {
    this.container = container;
    this.items = items;
    this.options = {
      itemHeight: 50,
      overscan: 3,
      ...options
    };

    this.scrollTop = 0;
    this.visibleStart = 0;
    this.visibleEnd = 0;

    this.init();
  }

  init() {
    this.setupContainer();
    this.attachScrollListener();
    this.render();
  }

  setupContainer() {
    this.container.style.overflow = 'auto';
    this.container.style.position = 'relative';
    this.container.style.height = `${this.options.containerHeight}px`;

    // Create spacer for total height
    this.spacer = document.createElement('div');
    this.spacer.style.height = `${this.items.length * this.options.itemHeight}px`;
    this.container.appendChild(this.spacer);

    // Create viewport for visible items
    this.viewport = document.createElement('div');
    this.viewport.style.position = 'absolute';
    this.viewport.style.top = '0';
    this.viewport.style.left = '0';
    this.viewport.style.right = '0';
    this.container.appendChild(this.viewport);
  }

  attachScrollListener() {
    this.container.addEventListener('scroll', () => {
      this.scrollTop = this.container.scrollTop;
      this.render();
    });
  }

  render() {
    const containerHeight = this.container.clientHeight;

    // Calculate visible range
    const start = Math.floor(this.scrollTop / this.options.itemHeight);
    const end = Math.ceil((this.scrollTop + containerHeight) / this.options.itemHeight);

    // Add overscan
    this.visibleStart = Math.max(0, start - this.options.overscan);
    this.visibleEnd = Math.min(this.items.length, end + this.options.overscan);

    // Only update if range changed significantly
    if (this.shouldUpdate()) {
      this.updateViewport();
    }
  }

  shouldUpdate() {
    return Math.abs(this.lastStart - this.visibleStart) > 1 ||
           Math.abs(this.lastEnd - this.visibleEnd) > 1;
  }

  updateViewport() {
    this.lastStart = this.visibleStart;
    this.lastEnd = this.visibleEnd;

    // Clear viewport
    this.viewport.innerHTML = '';

    // Position viewport
    this.viewport.style.transform = `translateY(${this.visibleStart * this.options.itemHeight}px)`;

    // Render visible items
    const fragment = document.createDocumentFragment();

    for (let i = this.visibleStart; i < this.visibleEnd; i++) {
      const item = this.renderItem(this.items[i], i);
      fragment.appendChild(item);
    }

    this.viewport.appendChild(fragment);
  }

  renderItem(data, index) {
    const div = document.createElement('div');
    div.className = 'virtual-item';
    div.style.height = `${this.options.itemHeight}px`;
    div.textContent = data;
    div.dataset.index = index;
    return div;
  }
}

// Usage
const items = Array.from({ length: 10000 }, (_, i) => `Item ${i + 1}`);
const scroller = new VirtualScroller(
  document.getElementById('list-container'),
  items,
  {
    itemHeight: 50,
    containerHeight: 400,
    overscan: 5
  }
);
```

### RequestAnimationFrame

```javascript
// Smooth animations using RAF
class AnimationScheduler {
  constructor() {
    this.tasks = new Set();
    this.isRunning = false;
  }

  schedule(callback) {
    this.tasks.add(callback);

    if (!this.isRunning) {
      this.start();
    }

    // Return cancel function
    return () => this.tasks.delete(callback);
  }

  start() {
    this.isRunning = true;
    this.tick();
  }

  tick() {
    // Execute all tasks
    this.tasks.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Animation task error:', error);
      }
    });

    // Continue if there are tasks
    if (this.tasks.size > 0) {
      requestAnimationFrame(() => this.tick());
    } else {
      this.isRunning = false;
    }
  }

  scheduleOnce(callback) {
    const wrapped = () => {
      callback();
      this.tasks.delete(wrapped);
    };
    this.schedule(wrapped);
  }
}

// Global scheduler
const scheduler = new AnimationScheduler();

// Example: Smooth value interpolation
function animateValue(element, start, end, duration) {
  const startTime = performance.now();

  const update = () => {
    const currentTime = performance.now();
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Easing function
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;

    const current = start + (end - start) * eased;
    element.textContent = Math.round(current);

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  };

  requestAnimationFrame(update);
}

// Usage
animateValue(document.getElementById('cost-value'), 0, 2350, 1000);
```

### Debouncing and Throttling

```javascript
// Utility functions for performance
class PerformanceUtils {
  // Debounce - wait for pause in events
  static debounce(func, wait) {
    let timeoutId;

    return function debounced(...args) {
      clearTimeout(timeoutId);

      timeoutId = setTimeout(() => {
        func.apply(this, args);
      }, wait);
    };
  }

  // Throttle - limit execution frequency
  static throttle(func, limit) {
    let inThrottle;

    return function throttled(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;

        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
    };
  }

  // Request Animation Frame throttle
  static rafThrottle(func) {
    let rafId = null;

    return function throttled(...args) {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          func.apply(this, args);
          rafId = null;
        });
      }
    };
  }
}

// Usage examples

// Debounce search input
const searchInput = document.getElementById('search');
const handleSearch = PerformanceUtils.debounce((value) => {
  console.log('Searching for:', value);
  performSearch(value);
}, 300);

searchInput.addEventListener('input', (e) => {
  handleSearch(e.target.value);
});

// Throttle scroll events
const handleScroll = PerformanceUtils.throttle(() => {
  console.log('Scroll position:', window.scrollY);
  updateScrollIndicator();
}, 100);

window.addEventListener('scroll', handleScroll);

// RAF throttle for resize
const handleResize = PerformanceUtils.rafThrottle(() => {
  console.log('Window resized:', window.innerWidth);
  updateLayout();
});

window.addEventListener('resize', handleResize);
```

## 💾 Data Management

### Memoization

```javascript
// Memoize expensive calculations
class MemoCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  memoize(fn) {
    return (...args) => {
      const key = JSON.stringify(args);

      if (this.cache.has(key)) {
        return this.cache.get(key);
      }

      const result = fn(...args);

      // Implement LRU eviction
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      this.cache.set(key, result);
      return result;
    };
  }

  clear() {
    this.cache.clear();
  }
}

// Usage
const memoCache = new MemoCache();

const calculateCost = memoCache.memoize((nodeSize, nodeCount, hours) => {
  console.log('Calculating cost...'); // Only logs on cache miss

  const rates = {
    small: 0.10,
    medium: 0.20,
    large: 0.40
  };

  return rates[nodeSize] * nodeCount * hours;
});

// First call - computes
console.log(calculateCost('medium', 5, 720)); // Calculates

// Second call with same args - cached
console.log(calculateCost('medium', 5, 720)); // Returns cached value

// Different args - computes
console.log(calculateCost('large', 10, 720)); // Calculates
```

### Data Pagination

```javascript
// Paginated data loading
class DataPaginator {
  constructor(dataSource, pageSize = 50) {
    this.dataSource = dataSource;
    this.pageSize = pageSize;
    this.currentPage = 0;
    this.cache = new Map();
    this.totalItems = 0;
  }

  async loadPage(page) {
    // Check cache
    if (this.cache.has(page)) {
      return this.cache.get(page);
    }

    // Load from data source
    const offset = page * this.pageSize;
    const data = await this.dataSource.fetch(offset, this.pageSize);

    // Update total
    if (data.total !== undefined) {
      this.totalItems = data.total;
    }

    // Cache the page
    this.cache.set(page, data.items);

    return data.items;
  }

  async next() {
    const maxPage = Math.ceil(this.totalItems / this.pageSize) - 1;

    if (this.currentPage < maxPage) {
      this.currentPage++;
      return await this.loadPage(this.currentPage);
    }

    return null;
  }

  async previous() {
    if (this.currentPage > 0) {
      this.currentPage--;
      return await this.loadPage(this.currentPage);
    }

    return null;
  }

  async goToPage(page) {
    this.currentPage = page;
    return await this.loadPage(page);
  }

  getTotalPages() {
    return Math.ceil(this.totalItems / this.pageSize);
  }

  clearCache() {
    this.cache.clear();
  }
}

// Usage
const dataSource = {
  async fetch(offset, limit) {
    const response = await fetch(`/api/data?offset=${offset}&limit=${limit}`);
    return await response.json();
  }
};

const paginator = new DataPaginator(dataSource, 50);

// Load first page
const items = await paginator.loadPage(0);
renderItems(items);

// Next page
document.getElementById('next-btn').addEventListener('click', async () => {
  const items = await paginator.next();
  if (items) {
    renderItems(items);
  }
});
```

### Caching Strategy

```javascript
// Multi-layer caching
class CacheManager {
  constructor() {
    this.memoryCache = new Map();
    this.storageCache = window.localStorage;
    this.ttl = 5 * 60 * 1000; // 5 minutes
  }

  set(key, value, ttl = this.ttl) {
    const item = {
      value,
      expires: Date.now() + ttl
    };

    // Memory cache
    this.memoryCache.set(key, item);

    // Storage cache (with error handling)
    try {
      this.storageCache.setItem(key, JSON.stringify(item));
    } catch (error) {
      console.warn('Storage cache failed:', error);
    }
  }

  get(key) {
    // Try memory cache first
    let item = this.memoryCache.get(key);

    // Try storage cache
    if (!item) {
      try {
        const stored = this.storageCache.getItem(key);
        if (stored) {
          item = JSON.parse(stored);
          // Restore to memory cache
          this.memoryCache.set(key, item);
        }
      } catch (error) {
        console.warn('Storage cache read failed:', error);
      }
    }

    // Check expiration
    if (item) {
      if (Date.now() < item.expires) {
        return item.value;
      } else {
        this.delete(key);
      }
    }

    return null;
  }

  delete(key) {
    this.memoryCache.delete(key);
    try {
      this.storageCache.removeItem(key);
    } catch (error) {
      console.warn('Storage cache delete failed:', error);
    }
  }

  clear() {
    this.memoryCache.clear();
    try {
      const keys = Object.keys(this.storageCache);
      keys.forEach(key => this.storageCache.removeItem(key));
    } catch (error) {
      console.warn('Storage cache clear failed:', error);
    }
  }

  async getOrFetch(key, fetchFn, ttl) {
    // Try cache first
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    // Fetch and cache
    const value = await fetchFn();
    this.set(key, value, ttl);
    return value;
  }
}

// Usage
const cache = new CacheManager();

async function getSparkPools() {
  return await cache.getOrFetch(
    'spark-pools',
    async () => {
      const response = await fetch('/api/spark-pools');
      return await response.json();
    },
    10 * 60 * 1000 // 10 minutes
  );
}
```

## 🔧 Bundle Optimization

### Tree Shaking

```javascript
// package.json
{
  "sideEffects": false,
  "module": "dist/demo.esm.js"
}

// webpack.config.js
module.exports = {
  mode: 'production',
  optimization: {
    usedExports: true,
    minimize: true,
    sideEffects: true
  }
};

// Use ES6 imports for tree shaking
import { calculateCost } from './utils';

// Avoid default exports when possible
export const calculateCost = () => { /* ... */ };
export const formatCurrency = () => { /* ... */ };
```

### Compression

```javascript
// webpack.config.js
const CompressionPlugin = require('compression-webpack-plugin');

module.exports = {
  plugins: [
    new CompressionPlugin({
      algorithm: 'gzip',
      test: /\.(js|css|html|svg)$/,
      threshold: 10240,
      minRatio: 0.8
    }),
    new CompressionPlugin({
      algorithm: 'brotliCompress',
      test: /\.(js|css|html|svg)$/,
      threshold: 10240,
      minRatio: 0.8
    })
  ]
};
```

### Asset Optimization

```javascript
// Image optimization
const ImageMinimizerPlugin = require('image-minimizer-webpack-plugin');

module.exports = {
  plugins: [
    new ImageMinimizerPlugin({
      minimizer: {
        implementation: ImageMinimizerPlugin.imageminGenerate,
        options: {
          plugins: [
            ['imagemin-mozjpeg', { quality: 80 }],
            ['imagemin-pngquant', { quality: [0.65, 0.90] }],
            ['imagemin-svgo', {
              plugins: [{
                name: 'removeViewBox',
                active: false
              }]
            }]
          ]
        }
      }
    })
  ]
};
```

## 📊 Performance Monitoring

### Performance API

```javascript
// Performance monitoring
class PerformanceMonitor {
  constructor() {
    this.marks = new Map();
    this.measures = [];
  }

  mark(name) {
    performance.mark(name);
    this.marks.set(name, performance.now());
  }

  measure(name, startMark, endMark) {
    if (!endMark) {
      endMark = `${startMark}-end`;
      this.mark(endMark);
    }

    performance.measure(name, startMark, endMark);

    const measure = performance.getEntriesByName(name, 'measure')[0];
    this.measures.push({
      name,
      duration: measure.duration,
      timestamp: Date.now()
    });

    return measure.duration;
  }

  getMetrics() {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByType('paint');

    return {
      // Navigation Timing
      dns: navigation.domainLookupEnd - navigation.domainLookupStart,
      tcp: navigation.connectEnd - navigation.connectStart,
      request: navigation.responseStart - navigation.requestStart,
      response: navigation.responseEnd - navigation.responseStart,
      domProcessing: navigation.domComplete - navigation.domLoading,
      totalTime: navigation.loadEventEnd - navigation.fetchStart,

      // Paint Timing
      fcp: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
      lcp: this.getLCP(),

      // Custom measures
      customMeasures: this.measures
    };
  }

  getLCP() {
    return new Promise((resolve) => {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        resolve(lastEntry.startTime);
      }).observe({ entryTypes: ['largest-contentful-paint'] });

      // Timeout after 5 seconds
      setTimeout(() => resolve(null), 5000);
    });
  }

  getCLS() {
    return new Promise((resolve) => {
      let clsScore = 0;

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsScore += entry.value;
          }
        }
      }).observe({ entryTypes: ['layout-shift'] });

      // Resolve after page interaction stops
      setTimeout(() => resolve(clsScore), 5000);
    });
  }

  async reportMetrics() {
    const metrics = this.getMetrics();
    metrics.cls = await this.getCLS();

    // Send to analytics
    if (window.gtag) {
      window.gtag('event', 'performance_metrics', metrics);
    }

    console.table(metrics);
    return metrics;
  }
}

// Usage
const monitor = new PerformanceMonitor();

// Mark important events
monitor.mark('demo-start');
// ... demo initialization
monitor.mark('demo-ready');
monitor.measure('demo-initialization', 'demo-start', 'demo-ready');

// Report on page load
window.addEventListener('load', async () => {
  await monitor.reportMetrics();
});
```

### Real User Monitoring (RUM)

```javascript
// RUM integration
class RUMCollector {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.data = {
      pageUrl: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
      metrics: {},
      errors: []
    };

    this.init();
  }

  init() {
    this.collectMetrics();
    this.trackErrors();
    this.trackInteractions();

    // Send on page unload
    window.addEventListener('beforeunload', () => {
      this.send();
    });
  }

  collectMetrics() {
    if (window.PerformanceObserver) {
      // Observe LCP
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        this.data.metrics.lcp = entries[entries.length - 1].startTime;
      }).observe({ entryTypes: ['largest-contentful-paint'] });

      // Observe FID
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        this.data.metrics.fid = entries[0].processingStart - entries[0].startTime;
      }).observe({ entryTypes: ['first-input'] });

      // Observe CLS
      let clsScore = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsScore += entry.value;
          }
        }
        this.data.metrics.cls = clsScore;
      }).observe({ entryTypes: ['layout-shift'] });
    }
  }

  trackErrors() {
    window.addEventListener('error', (event) => {
      this.data.errors.push({
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        timestamp: Date.now()
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      this.data.errors.push({
        type: 'unhandledRejection',
        reason: event.reason?.toString(),
        timestamp: Date.now()
      });
    });
  }

  trackInteractions() {
    ['click', 'input', 'scroll'].forEach(eventType => {
      document.addEventListener(eventType, () => {
        if (!this.data.metrics.firstInteraction) {
          this.data.metrics.firstInteraction = performance.now();
        }
      }, { once: true, passive: true });
    });
  }

  send() {
    // Use sendBeacon for reliable delivery
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(this.data)], {
        type: 'application/json'
      });
      navigator.sendBeacon(this.endpoint, blob);
    } else {
      // Fallback to fetch with keepalive
      fetch(this.endpoint, {
        method: 'POST',
        body: JSON.stringify(this.data),
        headers: { 'Content-Type': 'application/json' },
        keepalive: true
      }).catch(error => console.error('RUM send failed:', error));
    }
  }
}

// Initialize RUM
const rum = new RUMCollector('/api/rum');
```

## 📚 Resources

### Performance Tools

- [Lighthouse](https://developers.google.com/web/tools/lighthouse)
- [WebPageTest](https://www.webpagetest.org/)
- [Chrome DevTools Performance](https://developer.chrome.com/docs/devtools/performance/)
- [webpack Bundle Analyzer](https://github.com/webpack-contrib/webpack-bundle-analyzer)

### Documentation

- [Web Performance Working Group](https://www.w3.org/webperf/)
- [MDN Web Performance](https://developer.mozilla.org/en-US/docs/Web/Performance)
- [Web.dev Performance](https://web.dev/performance/)
- [Azure Front Door Performance](https://docs.microsoft.com/en-us/azure/frontdoor/front-door-performance)

---

*Last Updated: January 2025 | Version: 1.0.0*
