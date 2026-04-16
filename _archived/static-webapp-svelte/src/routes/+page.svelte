<script lang="ts">
	import { onMount } from 'svelte';
	import { getStats, listSources } from '$lib/api';
	import type { PlatformStats, SourceRecord } from '$lib/types';

	let stats: PlatformStats | null = $state(null);
	let recentSources: SourceRecord[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	onMount(async () => {
		try {
			const [statsResult, sourcesResult] = await Promise.allSettled([
				getStats(),
				listSources()
			]);

			if (statsResult.status === 'fulfilled') {
				stats = statsResult.value;
			}
			if (sourcesResult.status === 'fulfilled') {
				recentSources = sourcesResult.value.slice(0, 5);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load dashboard';
		} finally {
			loading = false;
		}
	});

	const statCards = $derived([
		{
			label: 'Registered Sources',
			value: stats?.registered_sources ?? 0,
			icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
			color: 'bg-blue-50 text-blue-600'
		},
		{
			label: 'Active Pipelines',
			value: stats?.active_pipelines ?? 0,
			icon: 'M13 10V3L4 14h7v7l9-11h-7z',
			color: 'bg-green-50 text-green-600'
		},
		{
			label: 'Data Products',
			value: stats?.data_products ?? 0,
			icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
			color: 'bg-purple-50 text-purple-600'
		},
		{
			label: 'Pending Requests',
			value: stats?.pending_access_requests ?? 0,
			icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
			color: 'bg-amber-50 text-amber-600'
		}
	]);

	function statusBadgeClass(status: string): string {
		switch (status) {
			case 'active':
				return 'badge-green';
			case 'pending':
			case 'provisioning':
				return 'badge-yellow';
			case 'error':
				return 'badge-red';
			case 'paused':
			case 'decommissioned':
				return 'badge-gray';
			default:
				return 'badge-blue';
		}
	}
</script>

<svelte:head>
	<title>Dashboard | CSA Portal</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page Header -->
	<div>
		<h2 class="text-2xl font-bold text-gray-900">Dashboard</h2>
		<p class="mt-1 text-sm text-gray-500">Overview of your data onboarding platform</p>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<div class="h-8 w-8 animate-spin rounded-full border-4 border-azure-200 border-t-azure-500"></div>
		</div>
	{:else if error}
		<div class="card border-red-200 bg-red-50">
			<p class="text-sm text-red-700">{error}</p>
		</div>
	{:else}
		<!-- Stat Cards -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each statCards as card}
				<div class="card flex items-center gap-4">
					<div class="flex h-12 w-12 items-center justify-center rounded-lg {card.color}">
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d={card.icon} />
						</svg>
					</div>
					<div>
						<p class="text-2xl font-bold text-gray-900">{card.value}</p>
						<p class="text-sm text-gray-500">{card.label}</p>
					</div>
				</div>
			{/each}
		</div>

		<!-- Recent Activity -->
		<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
			<!-- Recent Sources -->
			<div class="card">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="text-lg font-semibold text-gray-900">Recent Sources</h3>
					<a href="/sources" class="text-sm text-azure-600 hover:text-azure-700">View all</a>
				</div>
				{#if recentSources.length === 0}
					<p class="py-8 text-center text-sm text-gray-500">No sources registered yet.</p>
				{:else}
					<div class="divide-y divide-gray-100">
						{#each recentSources as source}
							<div class="flex items-center justify-between py-3">
								<div>
									<p class="text-sm font-medium text-gray-900">{source.name}</p>
									<p class="text-xs text-gray-500">
										{source.source_type.replace('_', ' ')} &middot; {source.owner.team}
									</p>
								</div>
								<span class={statusBadgeClass(source.status)}>{source.status}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Quick Actions -->
			<div class="card">
				<h3 class="mb-4 text-lg font-semibold text-gray-900">Quick Actions</h3>
				<div class="space-y-3">
					<a href="/sources/register" class="flex items-center gap-3 rounded-lg border border-gray-200 p-4 transition-colors hover:border-azure-300 hover:bg-azure-50">
						<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-azure-100 text-azure-600">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
							</svg>
						</div>
						<div>
							<p class="text-sm font-medium text-gray-900">Register a New Source</p>
							<p class="text-xs text-gray-500">Onboard a new data source to the platform</p>
						</div>
					</a>
					<a href="/marketplace" class="flex items-center gap-3 rounded-lg border border-gray-200 p-4 transition-colors hover:border-azure-300 hover:bg-azure-50">
						<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 text-purple-600">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
							</svg>
						</div>
						<div>
							<p class="text-sm font-medium text-gray-900">Browse Data Products</p>
							<p class="text-xs text-gray-500">Discover and request access to data products</p>
						</div>
					</a>
					<a href="/access" class="flex items-center gap-3 rounded-lg border border-gray-200 p-4 transition-colors hover:border-azure-300 hover:bg-azure-50">
						<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
							</svg>
						</div>
						<div>
							<p class="text-sm font-medium text-gray-900">Review Access Requests</p>
							<p class="text-xs text-gray-500">Approve or deny pending access requests</p>
						</div>
					</a>
				</div>
			</div>
		</div>
	{/if}
</div>
