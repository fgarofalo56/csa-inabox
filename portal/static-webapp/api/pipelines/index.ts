/**
 * Azure Function proxy for /api/pipelines.
 * Forwards requests to the shared backend API.
 */

import type { AzureFunction, Context, HttpRequest } from '@azure/functions';

const API_BASE_URL = process.env.BACKEND_API_URL || 'http://localhost:8000';

const pipelinesProxy: AzureFunction = async function (
	context: Context,
	req: HttpRequest
): Promise<void> {
	const restOfPath = context.bindingData.restOfPath || '';
	const targetUrl = `${API_BASE_URL}/api/v1/pipelines${restOfPath ? '/' + restOfPath : ''}`;

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
		context.log.error('Failed to proxy request to backend:', error);
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

export default pipelinesProxy;
