// =============================================================================
// Data API Builder — Frontend Application
// CSA-in-a-Box | Data Mesh Portal
// =============================================================================

class DabApiClient {
  constructor(baseUrl = '/data-api') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.restBase = `${this.baseUrl}/api`;
    this.graphqlUrl = `${this.baseUrl}/graphql`;
  }

  // ─── REST helpers ───────────────────────────────────────────────────────

  async _fetch(path, options = {}) {
    const url = `${this.restBase}${path}`;
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error?.message || err.message || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (e) {
      Toast.error(`API Error: ${e.message}`);
      throw e;
    }
  }

  // ─── Products ───────────────────────────────────────────────────────────

  async fetchProducts({ domain, status, search, orderBy, first, after } = {}) {
    const params = new URLSearchParams();
    const filters = [];
    if (domain) filters.push(`domain eq '${domain}'`);
    if (status) filters.push(`status eq '${status}'`);
    if (search) filters.push(`contains(name, '${search}')`);
    if (filters.length) params.set('$filter', filters.join(' and '));
    if (orderBy) params.set('$orderby', orderBy);
    if (first) params.set('$first', first);
    if (after) params.set('$after', after);
    const qs = params.toString();
    return this._fetch(`/products${qs ? '?' + qs : ''}`);
  }

  async fetchProduct(id) {
    return this._fetch(`/products/id/${id}`);
  }

  async createProduct(data) {
    return this._fetch('/products', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateProduct(id, data) {
    return this._fetch(`/products/id/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteProduct(id) {
    return this._fetch(`/products/id/${id}`, { method: 'DELETE' });
  }

  // ─── Domains & Stats ───────────────────────────────────────────────────

  async fetchDomains() {
    return this._fetch('/domains');
  }

  async fetchDomainStats() {
    return this._fetch('/domain-stats');
  }

  async fetchQualityTrend(productId, days = 30) {
    return this._fetch(`/quality-trend?product_id=${productId}&days=${days}`);
  }

  // ─── Dashboard stats ───────────────────────────────────────────────────

  async fetchStats() {
    const [products, domains] = await Promise.all([
      this.fetchProducts(),
      this.fetchDomains(),
    ]);
    const items = products.value || [];
    const totalProducts = items.length;
    const avgQuality = items.length
      ? (items.reduce((s, p) => s + (p.quality_score || 0), 0) / items.length).toFixed(1)
      : 0;
    const activeDomains = (domains.value || []).filter(d => d.product_count > 0).length;
    return { totalProducts, avgQuality, activeDomains, pendingRequests: '—' };
  }

  // ─── GraphQL ────────────────────────────────────────────────────────────

  async executeGraphQL(query, variables = {}) {
    try {
      const res = await fetch(this.graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      return res.json();
    } catch (e) {
      Toast.error(`GraphQL Error: ${e.message}`);
      throw e;
    }
  }
}

// ─── Toast Notifications ──────────────────────────────────────────────────

class Toast {
  static _container = null;

  static _getContainer() {
    if (!this._container) {
      this._container = document.createElement('div');
      this._container.className = 'toast-container';
      document.body.appendChild(this._container);
    }
    return this._container;
  }

  static _show(message, type) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    this._getContainer().appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  static error(msg) { this._show(msg, 'error'); }
  static success(msg) { this._show(msg, 'success'); }
}

// ─── DOM Rendering Helpers ────────────────────────────────────────────────

function renderStatsCards({ totalProducts, avgQuality, activeDomains, pendingRequests }) {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;
  grid.innerHTML = [
    { value: totalProducts, label: 'Total Products' },
    { value: avgQuality, label: 'Avg Quality Score' },
    { value: activeDomains, label: 'Active Domains' },
    { value: pendingRequests, label: 'Pending Requests' },
  ].map(s => `
    <div class="card stat-card">
      <div class="stat-value">${s.value}</div>
      <div class="stat-label">${s.label}</div>
    </div>
  `).join('');
}

function statusBadge(status) {
  const cls = { active: 'badge-active', draft: 'badge-draft', deprecated: 'badge-deprecated' };
  return `<span class="badge ${cls[status] || ''}">${status}</span>`;
}

function renderProductsTable(products, containerId = 'products-table-body') {
  const tbody = document.getElementById(containerId);
  if (!tbody) return;
  const items = products.value || products || [];
  tbody.innerHTML = items.map(p => `
    <tr data-id="${p.id}" class="product-row" style="cursor:pointer">
      <td>${p.name}</td>
      <td>${p.domain}</td>
      <td>${p.owner_team || '—'}</td>
      <td>${p.quality_score != null ? p.quality_score.toFixed(1) : '—'}</td>
      <td>${statusBadge(p.status)}</td>
      <td>${p.classification}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.product-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      if (typeof showProductDetail === 'function') showProductDetail(id);
    });
  });
}

function renderDomainFilter(domains) {
  const sel = document.getElementById('domain-filter');
  if (!sel) return;
  const items = domains.value || domains || [];
  sel.innerHTML = '<option value="">All Domains</option>' +
    items.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
}

// ─── Page Initializers ────────────────────────────────────────────────────

const api = new DabApiClient();

async function initDashboard() {
  try {
    const stats = await api.fetchStats();
    renderStatsCards(stats);
  } catch { /* toast already shown */ }
}

async function initProducts() {
  try {
    const [products, domains] = await Promise.all([
      api.fetchProducts({ orderBy: 'quality_score desc' }),
      api.fetchDomains(),
    ]);
    renderProductsTable(products);
    renderDomainFilter(domains);
  } catch { /* toast already shown */ }
}

// ─── Search & Filter Handlers ─────────────────────────────────────────────

function setupFilters() {
  const searchInput = document.getElementById('search-input');
  const domainFilter = document.getElementById('domain-filter');

  let debounceTimer;
  const applyFilters = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const search = searchInput?.value || '';
      const domain = domainFilter?.value || '';
      try {
        const products = await api.fetchProducts({
          search: search || undefined,
          domain: domain || undefined,
          orderBy: 'quality_score desc',
        });
        renderProductsTable(products);
      } catch { /* toast already shown */ }
    }, 300);
  };

  searchInput?.addEventListener('input', applyFilters);
  domainFilter?.addEventListener('change', applyFilters);
}

// ─── GraphQL Explorer ─────────────────────────────────────────────────────

const EXAMPLE_QUERIES = {
  'All Products': `{
  dataProducts(first: 10) {
    items {
      id name domain quality_score status
    }
  }
}`,
  'Product with Quality Metrics': `{
  dataProduct_by_pk(id: 1) {
    name domain quality_score
    qualityMetrics {
      items { date quality_score completeness }
    }
  }
}`,
  'Products by Domain': `{
  dataProducts(filter: { domain: { eq: "finance" } }) {
    items {
      id name quality_score owner_team
    }
  }
}`,
};

function initExplorer() {
  const queryEditor = document.getElementById('query-editor');
  const resultsPanel = document.getElementById('results-panel');
  const exampleSelect = document.getElementById('example-queries');
  const executeBtn = document.getElementById('execute-btn');

  if (exampleSelect) {
    Object.keys(EXAMPLE_QUERIES).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      exampleSelect.appendChild(opt);
    });
    exampleSelect.addEventListener('change', () => {
      if (queryEditor && EXAMPLE_QUERIES[exampleSelect.value]) {
        queryEditor.value = EXAMPLE_QUERIES[exampleSelect.value];
      }
    });
  }

  executeBtn?.addEventListener('click', async () => {
    const query = queryEditor?.value;
    if (!query) return;
    resultsPanel.textContent = 'Executing...';
    try {
      const result = await api.executeGraphQL(query);
      resultsPanel.textContent = JSON.stringify(result, null, 2);
    } catch (e) {
      resultsPanel.textContent = `Error: ${e.message}`;
    }
  });

  // Load first example
  if (queryEditor) queryEditor.value = EXAMPLE_QUERIES['All Products'];
}

// ─── Auto-init based on page ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'dashboard') initDashboard();
  if (page === 'products') { initProducts(); setupFilters(); }
  if (page === 'explorer') initExplorer();
});
