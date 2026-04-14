<script lang="ts">
	import '../app.css';

	let { children } = $props();

	let sidebarOpen = $state(true);

	const navItems = [
		{ href: '/', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
		{ href: '/sources', label: 'Sources', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
		{ href: '/sources/register', label: 'Register Source', icon: 'M12 4v16m8-8H4' },
		{ href: '/marketplace', label: 'Marketplace', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
		{ href: '/pipelines', label: 'Pipelines', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
		{ href: '/access', label: 'Access Requests', icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' }
	];

	/** Check if the path matches the current location. */
	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/';
		return pathname.startsWith(href);
	}
</script>

<div class="flex h-screen overflow-hidden">
	<!-- Sidebar -->
	<aside
		class="flex w-64 flex-col border-r border-gray-200 bg-white transition-transform duration-200 {sidebarOpen
			? 'translate-x-0'
			: '-translate-x-full'} lg:translate-x-0"
	>
		<!-- Logo -->
		<div class="flex h-16 items-center gap-3 border-b border-gray-200 px-6">
			<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-azure-500 text-white">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
				</svg>
			</div>
			<div>
				<h1 class="text-base font-semibold text-gray-900">CSA Portal</h1>
				<p class="text-xs text-gray-500">Data Onboarding</p>
			</div>
		</div>

		<!-- Navigation -->
		<nav class="flex-1 space-y-1 px-3 py-4">
			{#each navItems as item}
				{@const active = isActive(item.href, typeof window !== 'undefined' ? window.location.pathname : '/')}
				<a
					href={item.href}
					class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors {active
						? 'bg-azure-50 text-azure-700'
						: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}"
				>
					<svg class="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
					</svg>
					{item.label}
				</a>
			{/each}
		</nav>

		<!-- Footer -->
		<div class="border-t border-gray-200 p-4">
			<div class="flex items-center gap-3">
				<div class="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-sm font-medium text-gray-600">
					U
				</div>
				<div class="flex-1 truncate">
					<p class="text-sm font-medium text-gray-700">Portal User</p>
					<a href="/.auth/logout" class="text-xs text-gray-500 hover:text-azure-600">Sign out</a>
				</div>
			</div>
		</div>
	</aside>

	<!-- Main Content -->
	<main class="flex flex-1 flex-col overflow-y-auto">
		<!-- Top bar (mobile) -->
		<header class="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6 lg:hidden">
			<button
				type="button"
				onclick={() => (sidebarOpen = !sidebarOpen)}
				class="rounded-md p-2 text-gray-600 hover:bg-gray-100"
			>
				<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
			<h1 class="text-lg font-semibold text-gray-900">CSA Portal</h1>
			<div></div>
		</header>

		<!-- Page Content -->
		<div class="flex-1 p-6">
			{@render children()}
		</div>
	</main>
</div>
