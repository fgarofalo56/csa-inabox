<script lang="ts">
	import { onMount } from 'svelte';
	import { listSources } from '$lib/api';
	import type { SourceRecord, SourceStatus } from '$lib/types';

	let sources: SourceRecord[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	// Filters
	let searchQuery = $state('');
	let filterDomain = $state('');
	let filterStatus = $state('');

	onMount(async () => {
		await loadSources();
	});

	async function loadSources() {
		loading = true;
		error = null;
		try {
			sources = await listSources({
				domain: filterDomain || undefined,
				status: filterStatus || undefined
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load sources';
		} finally {
			loading = false;
		}
	}

	const filteredSources = $derived(
		sources.filter((s) => {
			if (!searchQuery) return true;
			const q = searchQuery.toLowerCase();
			return (
				s.name.toLowerCase().includes(q) ||
				s.source_type.toLowerCase().includes(q) ||
				s.owner.team.toLowerCase().includes(q) ||
				(s.description && s.description.toLowerCase().includes(q))
			);
		})
	);

	const domains = $derived([...new Set(sources.map((s) => s.owner.team))].sort());

	function statusBadgeClass(status: SourceStatus): string {
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

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatSourceType(type: string): string {
		return type
			.split('_')
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
	}
</script>

<svelte:head>
	<title>Sources | CSA Portal</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-2xl font-bold text-gray-900">Data Sources</h2>
			<p class="mt-1 text-sm text-gray-500">Manage registered data sources</p>
		</div>
		<a href="/sources/register" class="btn-primary">
			<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
			</svg>
			Register Source
		</a>
	</div>

	<!-- Filters -->
	<div class="card">
		<div class="flex flex-wrap gap-4">
			<!-- Search -->
			<div class="flex-1">
				<label for="search" class="sr-only">Search sources</label>
				<div class="relative">
					<svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
					<input
						id="search"
						type="text"
						placeholder="Search sources by name, type, or domain..."
						bind:value={searchQuery}
						class="input-field pl-10"
					/>
				</div>
			</div>

			<!-- Domain Filter -->
			<div class="w-48">
				<select
					bind:value={filterDomain}
					onchange={() => loadSources()}
					class="input-field"
				>
					<option value="">All Domains</option>
					{#each domains as domain}
						<option value={domain}>{domain}</option>
					{/each}
				</select>
			</div>

			<!-- Status Filter -->
			<div class="w-40">
				<select
					bind:value={filterStatus}
					onchange={() => loadSources()}
					class="input-field"
				>
					<option value="">All Statuses</option>
					<option value="pending">Pending</option>
					<option value="provisioning">Provisioning</option>
					<option value="active">Active</option>
					<option value="paused">Paused</option>
					<option value="error">Error</option>
					<option value="decommissioned">Decommissioned</option>
				</select>
			</div>
		</div>
	</div>

	<!-- Sources Table -->
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<div class="h-8 w-8 animate-spin rounded-full border-4 border-azure-200 border-t-azure-500"></div>
		</div>
	{:else if error}
		<div class="card border-red-200 bg-red-50">
			<p class="text-sm text-red-700">{error}</p>
			<button type="button" onclick={() => loadSources()} class="mt-2 text-sm font-medium text-red-800 underline">
				Retry
			</button>
		</div>
	{:else if filteredSources.length === 0}
		<div class="card py-12 text-center">
			<svg class="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
				<path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
			</svg>
			<h3 class="mt-4 text-sm font-medium text-gray-900">No sources found</h3>
			<p class="mt-1 text-sm text-gray-500">
				{searchQuery ? 'Try adjusting your search criteria.' : 'Get started by registering your first data source.'}
			</p>
			{#if !searchQuery}
				<a href="/sources/register" class="btn-primary mt-4">Register Source</a>
			{/if}
		</div>
	{:else}
		<div class="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
			<table class="min-w-full divide-y divide-gray-200">
				<thead class="bg-gray-50">
					<tr>
						<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Source</th>
						<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
						<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Team</th>
						<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Classification</th>
						<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
						<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-gray-200">
					{#each filteredSources as source}
						<tr class="transition-colors hover:bg-gray-50">
							<td class="px-6 py-4">
								<div>
									<p class="text-sm font-medium text-gray-900">{source.name}</p>
									{#if source.description}
										<p class="text-xs text-gray-500 line-clamp-1">{source.description}</p>
									{/if}
								</div>
							</td>
							<td class="px-6 py-4 text-sm text-gray-600">{formatSourceType(source.source_type)}</td>
							<td class="px-6 py-4 text-sm text-gray-600">{source.owner.team}</td>
							<td class="px-6 py-4">
								<span class="badge-blue">{source.classification.toUpperCase()}</span>
							</td>
							<td class="px-6 py-4">
								<span class={statusBadgeClass(source.status)}>{source.status}</span>
							</td>
							<td class="px-6 py-4 text-sm text-gray-500">{formatDate(source.created_at)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="text-sm text-gray-500">{filteredSources.length} source{filteredSources.length !== 1 ? 's' : ''}</p>
	{/if}
</div>
