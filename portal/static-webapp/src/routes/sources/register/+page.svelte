<script lang="ts">
	import { registerSource } from '$lib/api';
	import type {
		SourceRegistration,
		SourceType,
		IngestionMode,
		ClassificationLevel,
		TargetFormat
	} from '$lib/types';

	// Wizard step tracking
	let currentStep = $state(1);
	const totalSteps = 3;

	// Form state
	let submitting = $state(false);
	let submitError: string | null = $state(null);
	let submitSuccess = $state(false);

	// Step 1: Source Info
	let sourceName = $state('');
	let sourceType = $state<SourceType>('azure_sql');
	let description = $state('');
	let classification = $state<ClassificationLevel>('internal');
	let environment = $state('dev');
	let ownerName = $state('');
	let ownerEmail = $state('');
	let ownerDomain = $state('');
	let ownerTeam = $state('');
	let tags = $state('');

	// Connection
	let connHost = $state('');
	let connPort = $state<number | undefined>(undefined);
	let connDatabase = $state('');
	let connKeyVaultSecret = $state('');

	// Step 2: Schema & Ingestion
	let ingestionMode = $state<IngestionMode>('full');
	let schedule = $state('');
	let autoDetectSchema = $state(true);
	let targetFormat = $state<TargetFormat>('delta');
	let targetContainer = $state('bronze');
	let targetLandingZone = $state('dlz-default');

	// Source type options
	const sourceTypes: { value: SourceType; label: string }[] = [
		{ value: 'sql_server', label: 'SQL Server' },
		{ value: 'azure_sql', label: 'Azure SQL' },
		{ value: 'cosmos_db', label: 'Cosmos DB' },
		{ value: 'rest_api', label: 'REST API' },
		{ value: 'file_drop', label: 'File Drop' },
		{ value: 'blob_storage', label: 'Blob Storage' },
		{ value: 'event_hub', label: 'Event Hub' },
		{ value: 'kafka', label: 'Kafka' },
		{ value: 'postgres', label: 'PostgreSQL' },
		{ value: 'mysql', label: 'MySQL' },
		{ value: 'oracle', label: 'Oracle' },
		{ value: 'sharepoint', label: 'SharePoint' },
		{ value: 'dynamics365', label: 'Dynamics 365' },
		{ value: 'databricks', label: 'Databricks' },
		{ value: 'snowflake', label: 'Snowflake' },
		{ value: 's3', label: 'Amazon S3' }
	];

	function nextStep() {
		if (currentStep < totalSteps) currentStep++;
	}

	function prevStep() {
		if (currentStep > 1) currentStep--;
	}

	function buildRegistration(): SourceRegistration {
		return {
			source_name: sourceName,
			source_type: sourceType,
			description: description || undefined,
			classification,
			environment,
			owner: {
				name: ownerName,
				email: ownerEmail,
				domain: ownerDomain,
				team: ownerTeam || undefined
			},
			connection: {
				host: connHost || undefined,
				port: connPort,
				database: connDatabase || undefined,
				key_vault_secret_name: connKeyVaultSecret || undefined
			},
			schema_definition: {
				auto_detect: autoDetectSchema
			},
			ingestion: {
				mode: ingestionMode,
				schedule: schedule || undefined,
				parallelism: 1
			},
			target: {
				landing_zone: targetLandingZone,
				container: targetContainer,
				path_pattern: '{domain}/{source_name}/{year}/{month}/{day}',
				format: targetFormat
			},
			tags: tags
				? tags.split(',').map((t) => t.trim()).filter(Boolean)
				: []
		};
	}

	async function handleSubmit() {
		submitting = true;
		submitError = null;
		try {
			await registerSource(buildRegistration());
			submitSuccess = true;
		} catch (e) {
			submitError = e instanceof Error ? e.message : 'Registration failed';
		} finally {
			submitting = false;
		}
	}

	const stepValid = $derived.by(() => {
		switch (currentStep) {
			case 1:
				return !!(sourceName && sourceType && ownerName && ownerEmail && ownerDomain);
			case 2:
				return !!(ingestionMode && targetFormat);
			case 3:
				return true;
			default:
				return false;
		}
	});
</script>

<svelte:head>
	<title>Register Source | CSA Portal</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<!-- Page Header -->
	<div>
		<h2 class="text-2xl font-bold text-gray-900">Register Data Source</h2>
		<p class="mt-1 text-sm text-gray-500">Onboard a new data source to the platform</p>
	</div>

	{#if submitSuccess}
		<!-- Success State -->
		<div class="card border-green-200 bg-green-50 text-center">
			<svg class="mx-auto h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<h3 class="mt-4 text-lg font-semibold text-green-900">Source Registered Successfully</h3>
			<p class="mt-2 text-sm text-green-700">
				Your source <strong>{sourceName}</strong> has been submitted for provisioning.
			</p>
			<div class="mt-6 flex justify-center gap-4">
				<a href="/sources" class="btn-primary">View Sources</a>
				<button type="button" onclick={() => { submitSuccess = false; currentStep = 1; }} class="btn-secondary">
					Register Another
				</button>
			</div>
		</div>
	{:else}
		<!-- Step Indicator -->
		<div class="flex items-center justify-between">
			{#each ['Source Info', 'Schema & Ingestion', 'Review'] as stepLabel, i}
				{@const stepNum = i + 1}
				<div class="flex items-center {i < totalSteps - 1 ? 'flex-1' : ''}">
					<div class="flex items-center gap-2">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium {stepNum <= currentStep
								? 'bg-azure-500 text-white'
								: 'bg-gray-200 text-gray-600'}"
						>
							{stepNum}
						</div>
						<span class="text-sm font-medium {stepNum <= currentStep ? 'text-azure-700' : 'text-gray-500'}">
							{stepLabel}
						</span>
					</div>
					{#if i < totalSteps - 1}
						<div class="mx-4 h-0.5 flex-1 {stepNum < currentStep ? 'bg-azure-500' : 'bg-gray-200'}"></div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Form -->
		<form onsubmit={(e) => { e.preventDefault(); if (currentStep === totalSteps) handleSubmit(); else nextStep(); }}>
			<!-- Step 1: Source Info -->
			{#if currentStep === 1}
				<div class="card space-y-6">
					<h3 class="text-lg font-semibold text-gray-900">Source Information</h3>

					<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
						<div>
							<label for="sourceName" class="label-field">Source Name *</label>
							<input id="sourceName" type="text" bind:value={sourceName} required class="input-field mt-1" placeholder="e.g., hr-employee-data" />
						</div>
						<div>
							<label for="sourceType" class="label-field">Source Type *</label>
							<select id="sourceType" bind:value={sourceType} class="input-field mt-1">
								{#each sourceTypes as st}
									<option value={st.value}>{st.label}</option>
								{/each}
							</select>
						</div>
					</div>

					<div>
						<label for="description" class="label-field">Description</label>
						<textarea id="description" bind:value={description} rows={3} class="input-field mt-1" placeholder="Describe the data source and its purpose..."></textarea>
					</div>

					<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
						<div>
							<label for="classification" class="label-field">Classification *</label>
							<select id="classification" bind:value={classification} class="input-field mt-1">
								<option value="public">Public</option>
								<option value="internal">Internal</option>
								<option value="confidential">Confidential</option>
								<option value="restricted">Restricted</option>
								<option value="cui">CUI</option>
								<option value="fouo">FOUO</option>
							</select>
						</div>
						<div>
							<label for="environment" class="label-field">Environment</label>
							<select id="environment" bind:value={environment} class="input-field mt-1">
								<option value="dev">Development</option>
								<option value="staging">Staging</option>
								<option value="prod">Production</option>
								<option value="gov-dev">Gov Development</option>
								<option value="gov-prod">Gov Production</option>
							</select>
						</div>
					</div>

					<hr class="border-gray-200" />
					<h4 class="text-base font-medium text-gray-900">Owner Information</h4>

					<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
						<div>
							<label for="ownerName" class="label-field">Owner Name *</label>
							<input id="ownerName" type="text" bind:value={ownerName} required class="input-field mt-1" />
						</div>
						<div>
							<label for="ownerEmail" class="label-field">Owner Email *</label>
							<input id="ownerEmail" type="email" bind:value={ownerEmail} required class="input-field mt-1" />
						</div>
						<div>
							<label for="ownerDomain" class="label-field">Domain *</label>
							<input id="ownerDomain" type="text" bind:value={ownerDomain} required class="input-field mt-1" placeholder="e.g., Finance, HR, Engineering" />
						</div>
						<div>
							<label for="ownerTeam" class="label-field">Team</label>
							<input id="ownerTeam" type="text" bind:value={ownerTeam} class="input-field mt-1" />
						</div>
					</div>

					<hr class="border-gray-200" />
					<h4 class="text-base font-medium text-gray-900">Connection</h4>

					<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
						<div>
							<label for="connHost" class="label-field">Host / Endpoint</label>
							<input id="connHost" type="text" bind:value={connHost} class="input-field mt-1" placeholder="server.database.windows.net" />
						</div>
						<div>
							<label for="connPort" class="label-field">Port</label>
							<input id="connPort" type="number" bind:value={connPort} class="input-field mt-1" placeholder="1433" />
						</div>
						<div>
							<label for="connDatabase" class="label-field">Database</label>
							<input id="connDatabase" type="text" bind:value={connDatabase} class="input-field mt-1" />
						</div>
						<div>
							<label for="connKeyVault" class="label-field">Key Vault Secret Name</label>
							<input id="connKeyVault" type="text" bind:value={connKeyVaultSecret} class="input-field mt-1" placeholder="sql-conn-string-secret" />
						</div>
					</div>

					<div>
						<label for="tags" class="label-field">Tags (comma-separated)</label>
						<input id="tags" type="text" bind:value={tags} class="input-field mt-1" placeholder="finance, quarterly, automated" />
					</div>
				</div>
			{/if}

			<!-- Step 2: Schema & Ingestion -->
			{#if currentStep === 2}
				<div class="card space-y-6">
					<h3 class="text-lg font-semibold text-gray-900">Schema & Ingestion</h3>

					<div>
						<label class="flex items-center gap-3">
							<input type="checkbox" bind:checked={autoDetectSchema} class="h-4 w-4 rounded border-gray-300 text-azure-500 focus:ring-azure-500" />
							<span class="text-sm font-medium text-gray-700">Auto-detect schema</span>
						</label>
						<p class="mt-1 ml-7 text-xs text-gray-500">Let the platform automatically discover the schema from the source.</p>
					</div>

					<hr class="border-gray-200" />
					<h4 class="text-base font-medium text-gray-900">Ingestion Configuration</h4>

					<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
						<div>
							<label for="ingestionMode" class="label-field">Ingestion Mode *</label>
							<select id="ingestionMode" bind:value={ingestionMode} class="input-field mt-1">
								<option value="full">Full Load</option>
								<option value="incremental">Incremental</option>
								<option value="cdc">Change Data Capture (CDC)</option>
								<option value="streaming">Streaming</option>
							</select>
						</div>
						<div>
							<label for="schedule" class="label-field">Schedule (cron)</label>
							<input id="schedule" type="text" bind:value={schedule} class="input-field mt-1" placeholder="0 */6 * * *" />
							<p class="mt-1 text-xs text-gray-500">Leave empty for manual triggers only.</p>
						</div>
					</div>

					<hr class="border-gray-200" />
					<h4 class="text-base font-medium text-gray-900">Target Configuration</h4>

					<div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
						<div>
							<label for="targetFormat" class="label-field">Target Format *</label>
							<select id="targetFormat" bind:value={targetFormat} class="input-field mt-1">
								<option value="delta">Delta</option>
								<option value="parquet">Parquet</option>
								<option value="csv">CSV</option>
								<option value="json">JSON</option>
								<option value="avro">Avro</option>
							</select>
						</div>
						<div>
							<label for="targetContainer" class="label-field">Container</label>
							<input id="targetContainer" type="text" bind:value={targetContainer} class="input-field mt-1" />
						</div>
						<div>
							<label for="targetLandingZone" class="label-field">Landing Zone</label>
							<input id="targetLandingZone" type="text" bind:value={targetLandingZone} class="input-field mt-1" />
						</div>
					</div>
				</div>
			{/if}

			<!-- Step 3: Review -->
			{#if currentStep === 3}
				<div class="card space-y-6">
					<h3 class="text-lg font-semibold text-gray-900">Review Registration</h3>
					<p class="text-sm text-gray-500">Please review your source registration before submitting.</p>

					<div class="divide-y divide-gray-200 rounded-lg border border-gray-200">
						<div class="grid grid-cols-2 gap-4 p-4">
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Source Name</p>
								<p class="text-sm font-medium text-gray-900">{sourceName}</p>
							</div>
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Source Type</p>
								<p class="text-sm text-gray-900">{sourceTypes.find((s) => s.value === sourceType)?.label}</p>
							</div>
						</div>
						<div class="grid grid-cols-2 gap-4 p-4">
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Classification</p>
								<p class="text-sm text-gray-900">{classification.toUpperCase()}</p>
							</div>
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Environment</p>
								<p class="text-sm text-gray-900">{environment}</p>
							</div>
						</div>
						<div class="grid grid-cols-2 gap-4 p-4">
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Owner</p>
								<p class="text-sm text-gray-900">{ownerName}</p>
								<p class="text-xs text-gray-500">{ownerEmail}</p>
							</div>
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Domain</p>
								<p class="text-sm text-gray-900">{ownerDomain}</p>
							</div>
						</div>
						<div class="grid grid-cols-2 gap-4 p-4">
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Ingestion Mode</p>
								<p class="text-sm text-gray-900">{ingestionMode}</p>
							</div>
							<div>
								<p class="text-xs font-medium uppercase text-gray-500">Target Format</p>
								<p class="text-sm text-gray-900">{targetFormat}</p>
							</div>
						</div>
						{#if connHost}
							<div class="grid grid-cols-2 gap-4 p-4">
								<div>
									<p class="text-xs font-medium uppercase text-gray-500">Connection</p>
									<p class="text-sm text-gray-900">{connHost}{connPort ? `:${connPort}` : ''}</p>
								</div>
								<div>
									<p class="text-xs font-medium uppercase text-gray-500">Database</p>
									<p class="text-sm text-gray-900">{connDatabase || '—'}</p>
								</div>
							</div>
						{/if}
					</div>

					{#if submitError}
						<div class="rounded-md border border-red-200 bg-red-50 p-4">
							<p class="text-sm text-red-700">{submitError}</p>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Navigation Buttons -->
			<div class="mt-6 flex justify-between">
				{#if currentStep > 1}
					<button type="button" onclick={prevStep} class="btn-secondary">
						Back
					</button>
				{:else}
					<div></div>
				{/if}
				<button type="submit" disabled={!stepValid || submitting} class="btn-primary">
					{#if submitting}
						<div class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
						Submitting...
					{:else if currentStep === totalSteps}
						Register Source
					{:else}
						Continue
					{/if}
				</button>
			</div>
		</form>
	{/if}
</div>
