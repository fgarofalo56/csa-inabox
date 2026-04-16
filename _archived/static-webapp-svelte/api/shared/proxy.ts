/**
 * Shared proxy helper for Azure Functions that forward requests to the backend API.
 *
 * All proxy functions (sources, pipelines, marketplace, access) are identical
 * except for the backend path prefix. This module eliminates that duplication.
 *
 * SWA managed functions require individual folders per function, so we cannot
 * consolidate into a single catch-all function without potentially breaking
 * SWA routing. Instead, each function delegates to this shared helper.
 */

import type { AzureFunction, Context, HttpRequest } from '@azure/functions';

const API_BASE_URL = process.env.BACKEND_API_URL || 'http://localhost:8000';

/**
 * Creates an Azure Function that proxies requests to a backend API path.
 *
 * @param backendPathPrefix - The backend path segment, e.g. "sources", "pipelines"
 */
export function createProxyFunction(backendPathPrefix: string): AzureFunction {
	return async function (context: Context, req: HttpRequest): Promise<void> {
		const restOfPath = context.bindingData.restOfPath || '';
		const targetUrl = `${API_BASE_URL}/api/v1/${backendPathPrefix}${restOfPath ? '/' + restOfPath : ''}`;

		const queryString = new URLSearchParams(req.query as Record<string, string>).toString();
		const fullUrl = queryString ? `${targetUrl}?${queryString}` : targetUrl;

		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};

			if (req.headers.authorization) {
				headers['Authorization'] = req.headers.authorization;
			}

			const fetchOptions: RequestInit = {
				method: req.method || 'GET',
				headers,
			};

			if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
				fetchOptions.body = JSON.stringify(req.body);
			}

			const response = await fetch(fullUrl, fetchOptions);
			const responseBody = await response.text();

			context.res = {
				status: response.status,
				headers: {
					'Content-Type': response.headers.get('content-type') || 'application/json',
				},
				body: responseBody,
			};
		} catch (error) {
			context.log.error(`Failed to proxy request to backend (${backendPathPrefix}):`, error);
			context.res = {
				status: 502,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					error: 'Bad Gateway',
					message: 'Failed to connect to the backend API.',
				}),
			};
		}
	};
}
