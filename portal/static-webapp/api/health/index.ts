import type { AzureFunction, Context, HttpRequest } from '@azure/functions';

const healthCheck: AzureFunction = async function (
	context: Context,
	req: HttpRequest
): Promise<void> {
	context.res = {
		status: 200,
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			status: 'healthy',
			timestamp: new Date().toISOString(),
			version: '1.0.0',
			runtime: 'azure-functions',
			uptime: process.uptime()
		})
	};
};

export default healthCheck;
