import adapter from '@sveltejs/adapter-node';

function parseOrigin(rawUrl) {
	try {
		return new URL(rawUrl).origin;
	} catch {
		return null;
	}
}

function buildConnectSrc() {
	const sources = new Set(["'self'"]);
	const apiOrigin = process.env.PUBLIC_API_URL ? parseOrigin(process.env.PUBLIC_API_URL) : null;
	const isProduction = process.env.NODE_ENV === 'production';

	if (apiOrigin) {
		sources.add(apiOrigin);
		const wsOrigin = apiOrigin.replace(/^http/, 'ws');
		sources.add(wsOrigin);
	}

	if (isProduction) {
		// Build-time env can be absent in some deployment pipelines.
		// Keep production secure while avoiding accidental self-only blocking.
		if (!apiOrigin) {
			sources.add('https:');
			sources.add('wss:');
		}
	} else {
		sources.add('http://localhost:8000');
		sources.add('ws://localhost:8000');
		sources.add('http://127.0.0.1:8000');
		sources.add('ws://127.0.0.1:8000');
		sources.add('http://localhost:5173');
		sources.add('ws://localhost:5173');
		sources.add('http://127.0.0.1:5173');
		sources.add('ws://127.0.0.1:5173');
	}

	return Array.from(sources);
}

// The notebook page mounts an <iframe> whose src points at the control
// plane API (e.g. https://petrify-fly-app.fly.dev/api/notebooks/...).
// Without an explicit frame-src directive, the browser falls back to
// default-src 'self' and blocks the cross-origin iframe.
function buildFrameSrc() {
	const sources = new Set(["'self'"]);
	const apiOrigin = process.env.PUBLIC_API_URL ? parseOrigin(process.env.PUBLIC_API_URL) : null;
	const isProduction = process.env.NODE_ENV === 'production';

	if (apiOrigin) {
		sources.add(apiOrigin);
	}

	if (isProduction) {
		if (!apiOrigin) {
			sources.add('https:');
		}
	} else {
		sources.add('http://localhost:8000');
		sources.add('http://127.0.0.1:8000');
	}

	return Array.from(sources);
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ["'self'"],
				'base-uri': ["'self'"],
				'object-src': ["'none'"],
				'frame-ancestors': ["'none'"],
				'form-action': ["'self'"],
				'script-src': ["'self'"],
				'style-src': ["'self'", "'unsafe-inline'"],
				'img-src': ["'self'", 'data:', 'blob:'],
				'font-src': ["'self'", 'data:'],
				'connect-src': buildConnectSrc(),
				'frame-src': buildFrameSrc(),
			},
		},
	}
};

export default config;
