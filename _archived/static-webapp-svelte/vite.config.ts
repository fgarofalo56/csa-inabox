import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5173,
		proxy: {
			// Proxy /api to the shared FastAPI backend during local dev
			'/api': {
				target: 'http://localhost:8000',
				changeOrigin: true
			}
		}
	}
});
