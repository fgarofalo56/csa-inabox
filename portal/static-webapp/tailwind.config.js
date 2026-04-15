/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				// Azure-inspired palette
				azure: {
					50: '#eff6ff',
					100: '#dbeafe',
					200: '#bfdbfe',
					300: '#93c5fd',
					400: '#60a5fa',
					500: '#0078d4', // Azure primary blue
					600: '#0063b1',
					700: '#004e8c',
					800: '#003a6a',
					900: '#002747'
				}
			},
			fontFamily: {
				sans: ['"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif']
			}
		}
	},
	plugins: []
};
