<script lang="ts">
	import { onMount } from 'svelte';
	import { listDataProducts, listDomains } from '$lib/api';
	import type { DataProduct } from '$lib/types';

	let products: DataProduct[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	// Filters
	let searchQuery = $state('');
	let filterDomain = $state('');
	let domains: { name: string; product_count: number }[] = $state([]);

	onMount(async () => {
		await Promise.all([loadProducts(), loadDomains()]);
	});

	async function loadProducts() {
		loading = true;
		error = null;
		try {
			products = await listDataProducts({
				domain: filterDomain || undefined,
				search: searchQuery || undefined
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load data products';
		} finally {
			loading = false;
		}
	}

	async function loadDomains() {
		try {
			domains = await listDomains();
		} catch {
			// Non-critical — domain filter just won't populate
		}
	}

	function qualityBadge(score: number): { class: string; label: string } {
		if (score >= 90) return { class: 'badge-green', label: 'Excellent' };
		if (score >= 75) return { class: 'badge-blue', label: 'Good' };
		if (score >= 50) return { class: 'badge-yellow', label: 'Fair' };
		return { class: 'badge-red', label: 'Poor' };
	}

	function formatFreshness(hours: number): string {
		if (hours < 1) return `${Math.round(hours * 60)}m`;
		if (hours < 24) return `${Math.round(hours)}h`;
		return `${Math.round(hours / 24)}d`;
	}

	function handleSearch() {
		loadProducts();
	}
</script>

<svelte:head>
	<title>Marketplace | CSA Portal</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page Header -->
	<div>
		<h2 class="text-2xl font-bold text-gray-900">Data Marketplace</h2>
		<p class="mt-1 text-sm text-gray-500">Discover and request access to curated data products</p>
	</div>

	<!-- Search & Filters -->
	<div class="card">
		<div class="flex flex-wrap gap-4">
			<div class="flex-1">
				<div class="relative">
					<svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
					<input
						type="text"
						placeholder="Search data products..."
						bind:value={searchQuery}
						onkeydown={(e) => { if (e.key === 'Enter') handleSearch(); }}
						class="input-field pl-10"
					/>
				</div>
			</div>
			<div class="w-48">
				<select
					bind:value={filterDomain}
					onchange={() => loadProducts()}
					class="input-field"
				>
					<option value="">All Domains</option>
					{#each domains as d}
						<option value={d.name}>{d.name} ({d.product_count})</option>
					{/each}
				</select>
			</div>
			<button type="button" onclick={handleSearch} class="btn-primary">Search</button>
		</div>
	</div>

	<!-- Product Grid -->
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<div class="h-8 w-8 animate-spin rounded-full border-4 border-azure-200 border-t-azure-500"></div>
		</div>
	{:else if error}
		<div class="card border-red-200 bg-red-50">
			<p class="text-sm text-red-700">{error}</p>
			<button type="button" onclick={() => loadProducts()} class="mt-2 text-sm font-medium text-red-800 underline">
				Retry
			</button>
		</div>
	{:else if products.length === 0}
		<div class="card py-12 text-center">
			<svg class="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
			</svg>
			<h3 class="mt-4 text-sm font-medium text-gray-900">No data products found</h3>
			<p class="mt-1 text-sm text-gray-500">
				{searchQuery ? 'Try adjusting your search criteria.' : 'No data products have been published yet.'}
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
			{#each products as product}
				{@const quality = qualityBadge(product.quality_score)}
				<div class="card flex flex-col transition-shadow hover:shadow-md">
					<!-- Header -->
					<div class="mb-3 flex items-start justify-between">
						<div>
							<h3 class="text-base font-semibold text-gray-900">{product.name}</h3>
							<p class="text-xs text-gray-500">{product.domain}</p>
						</div>
						<span class={quality.class}>{quality.label}</span>
					</div>

					<!-- Description -->
					<p class="mb-4 flex-1 text-sm text-gray-600 line-clamp-2">{product.description}</p>

					<!-- Metrics -->
					<div class="mb-4 grid grid-cols-3 gap-2 rounded-lg bg-gray-50 p-3">
						<div class="text-center">
							<p class="text-lg font-bold text-gray-900">{product.quality_score.toFixed(0)}</p>
							<p class="text-xs text-gray-500">Quality</p>
						</div>
						<div class="text-center">
							<p class="text-lg font-bold text-gray-900">{formatFreshness(product.freshness_hours)}</p>
							<p class="text-xs text-gray-500">Freshness</p>
						</div>
						<div class="text-center">
							<p class="text-lg font-bold text-gray-900">{(product.completeness * 100).toFixed(0)}%</p>
							<p class="text-xs text-gray-500">Complete</p>
						</div>
					</div>

					<!-- Tags -->
					{@const tagKeys = Object.keys(product.tags)}
					{#if tagKeys.length > 0}
						<div class="mb-4 flex flex-wrap gap-1">
							{#each tagKeys.slice(0, 4) as key}
								<span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{key}: {product.tags[key]}</span>
							{/each}
							{#if tagKeys.length > 4}
								<span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">+{tagKeys.length - 4}</span>
							{/if}
						</div>
					{/if}

					<!-- Footer -->
					<div class="flex items-center justify-between border-t border-gray-100 pt-3">
						<div class="text-xs text-gray-500">
							<span class="badge-blue">{product.classification.toUpperCase()}</span>
						</div>
						<a
							href="/access?product_id={product.id}"
							class="text-sm font-medium text-azure-600 hover:text-azure-700"
						>
							Request Access &rarr;
						</a>
					</div>
				</div>
			{/each}
		</div>
		<p class="text-sm text-gray-500">{products.length} data product{products.length !== 1 ? 's' : ''}</p>
	{/if}
</div>
