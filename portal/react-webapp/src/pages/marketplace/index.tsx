/**
 * Data Marketplace page — Browse and search data products.
 */

import React, { useState } from 'react';
import { useDataProducts, useDomains } from '@/hooks/useApi';
import type { DataProduct } from '@/types';

function QualityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 90
      ? 'bg-green-100 text-green-800'
      : pct >= 70
        ? 'bg-yellow-100 text-yellow-800'
        : 'bg-red-100 text-red-800';

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}
    >
      {pct}%
    </span>
  );
}

function ProductCard({ product }: { product: DataProduct }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className="text-lg font-medium text-gray-900">{product.name}</h3>
          <p className="mt-1 text-sm text-gray-500 line-clamp-2">
            {product.description}
          </p>
        </div>
        <QualityBadge score={product.quality_score} />
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs text-gray-500">
        <span className="capitalize bg-gray-100 px-2 py-1 rounded">
          {product.domain}
        </span>
        <span className="uppercase bg-blue-50 px-2 py-1 rounded text-blue-700">
          {product.classification}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div>
          <span className="text-gray-400 text-xs">Freshness</span>
          <p className="font-medium">
            {product.freshness_hours < 24
              ? `${product.freshness_hours}h`
              : `${Math.round(product.freshness_hours / 24)}d`}
          </p>
        </div>
        <div>
          <span className="text-gray-400 text-xs">Completeness</span>
          <p className="font-medium">
            {(product.completeness * 100).toFixed(0)}%
          </p>
        </div>
        <div>
          <span className="text-gray-400 text-xs">Availability</span>
          <p className="font-medium">
            {(product.availability * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-gray-400">
          by {product.owner.team}
        </span>
        <button
          type="button"
          className="text-sm text-brand-600 hover:text-brand-800 font-medium"
        >
          Request Access
        </button>
      </div>
    </div>
  );
}

export default function MarketplacePage() {
  const [search, setSearch] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('');
  const [minQuality, setMinQuality] = useState(0);

  const { data: products, isLoading } = useDataProducts({
    search: search || undefined,
    domain: selectedDomain || undefined,
    min_quality: minQuality || undefined,
  });
  const { data: domains } = useDomains();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Data Marketplace</h1>
        <p className="mt-1 text-sm text-gray-500">
          Discover and request access to curated data products
        </p>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-[250px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search data products..."
            className="w-full px-4 py-2 border border-gray-300 rounded-md text-sm focus:ring-brand-500 focus:border-brand-500"
          />
        </div>
        <select
          value={selectedDomain}
          onChange={(e) => setSelectedDomain(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="">All domains</option>
          {domains?.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name} ({d.product_count})
            </option>
          ))}
        </select>
        <select
          value={minQuality.toString()}
          onChange={(e) => setMinQuality(Number(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="0">Any quality</option>
          <option value="0.9">90%+</option>
          <option value="0.8">80%+</option>
          <option value="0.7">70%+</option>
        </select>
      </div>

      {/* Product Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div role="status" aria-label="Loading">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        </div>
      ) : products && products.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 bg-gray-50 rounded-lg">
          <p className="text-gray-500">No data products found.</p>
          <p className="text-sm text-gray-400 mt-1">
            Try adjusting your search criteria.
          </p>
        </div>
      )}
    </div>
  );
}
