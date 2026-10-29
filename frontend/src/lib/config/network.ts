import { env } from '$env/dynamic/public';

const DEFAULT_DEV_API_URL = 'http://localhost:8000';
const isProduction = import.meta.env.PROD;

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function parseHttpUrl(value: string, errorPrefix: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${errorPrefix}: invalid URL "${value}"`);
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`${errorPrefix}: expected http(s) URL but got "${parsed.protocol}"`);
	}

	return parsed;
}

function resolveApiUrl(): string {
	const rawValue = env.PUBLIC_API_URL?.trim() ?? '';
	if (!rawValue) {
		if (isProduction) {
			throw new Error('PUBLIC_API_URL must be set in production and must use https://');
		}
		return DEFAULT_DEV_API_URL;
	}

	const parsed = parseHttpUrl(rawValue, 'PUBLIC_API_URL');
	if (isProduction && parsed.protocol !== 'https:') {
		throw new Error(`PUBLIC_API_URL must use https:// in production (received "${rawValue}")`);
	}

	return trimTrailingSlash(rawValue);
}

function toWebSocketBaseUrl(apiUrl: string): string {
	const parsed = parseHttpUrl(apiUrl, 'API_URL');
	parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';

	if (isProduction && parsed.protocol !== 'wss:') {
		throw new Error('WebSocket base URL must use wss:// in production');
	}

	return trimTrailingSlash(parsed.toString());
}

export const API_URL = resolveApiUrl();
export const WS_BASE_URL = toWebSocketBaseUrl(API_URL);

/** PUBLIC_SHARE_URL as set, or '': the public tier's base URL, which a share's
 * link starts with. The shares page judges it with `shareLinkBase` and shows
 * the bare token when it cannot make a link, so an unset value never stops
 * the app. */
export const PUBLIC_SHARE_URL = env.PUBLIC_SHARE_URL ?? '';
