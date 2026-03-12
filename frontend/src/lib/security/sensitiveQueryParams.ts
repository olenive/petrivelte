import { goto } from '$app/navigation';

type ParamMap<T extends string> = Record<T, string>;

/**
 * Capture selected query params and then remove them from the URL using
 * history replacement semantics (no new history entry).
 */
export async function captureAndStripSearchParams<T extends string>(
	url: URL,
	keys: readonly T[],
): Promise<ParamMap<T>> {
	const values = Object.fromEntries(
		keys.map((key) => [key, url.searchParams.get(key) ?? '']),
	) as ParamMap<T>;

	const cleanedUrl = new URL(url.toString());
	let changed = false;
	for (const key of keys) {
		if (cleanedUrl.searchParams.has(key)) {
			cleanedUrl.searchParams.delete(key);
			changed = true;
		}
	}

	if (changed) {
		const target = `${cleanedUrl.pathname}${cleanedUrl.search}${cleanedUrl.hash}`;
		await goto(target, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	return values;
}
